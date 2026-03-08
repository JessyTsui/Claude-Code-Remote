/**
 * Alert Workflow
 * Manages the full lifecycle of PagerDuty alert investigations:
 *   detect → deduplicate → PD ack → Claude session → post results → feedback timer → cleanup
 *
 * Persists workflows to SQLite so they survive restarts.
 */

const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Logger = require('../../core/logger');

class AlertWorkflow {
    constructor(app, db, config = {}) {
        this.app = app;
        this.db = db;
        this.config = config;
        this.logger = new Logger('AlertWorkflow');

        // In-memory tracking for active workflows
        // Map<messageTs, { channelId, threadTs, sessionName, incidentId, feedbackTimer }>
        this.activeWorkflows = new Map();

        // Track PD incident IDs to prevent duplicate investigations
        this.trackedIncidents = new Set();

        this._initWorkflowTable();
        this._loadReportsDir();
    }

    _initWorkflowTable() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS alert_workflows (
                message_ts    TEXT PRIMARY KEY,
                channel_id    TEXT NOT NULL,
                thread_ts     TEXT NOT NULL,
                session_name  TEXT,
                incident_id   TEXT,
                status        TEXT NOT NULL DEFAULT 'pending',
                repo_path     TEXT,
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL
            )
        `);

        this._wfStmts = {
            insert: this.db.prepare(`
                INSERT OR IGNORE INTO alert_workflows
                (message_ts, channel_id, thread_ts, session_name, incident_id, status, repo_path, created_at, updated_at)
                VALUES (@message_ts, @channel_id, @thread_ts, @session_name, @incident_id, @status, @repo_path, @created_at, @updated_at)
            `),
            update: this.db.prepare(`
                UPDATE alert_workflows SET session_name=@session_name, status=@status, updated_at=@updated_at
                WHERE message_ts=@message_ts
            `),
            get: this.db.prepare('SELECT * FROM alert_workflows WHERE message_ts = ?'),
            getActive: this.db.prepare("SELECT * FROM alert_workflows WHERE status IN ('pending','investigating','discussing')"),
            delete: this.db.prepare('DELETE FROM alert_workflows WHERE message_ts = ?'),
            deleteOld: this.db.prepare('DELETE FROM alert_workflows WHERE updated_at < ?')
        };

        // Clean workflows older than 7 days
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        this._wfStmts.deleteOld.run(weekAgo);
    }

    _loadReportsDir() {
        this.reportsDir = path.join(__dirname, '../../data/reports');
        if (!fs.existsSync(this.reportsDir)) {
            fs.mkdirSync(this.reportsDir, { recursive: true });
        }
    }

    // ─── Deduplication ─────────────────────────────────────────────

    isActive(messageTs) {
        return this.activeWorkflows.has(messageTs);
    }

    isIncidentTracked(incidentId) {
        if (!incidentId) return false;
        // Check in-memory
        if (this.trackedIncidents.has(incidentId)) return true;
        // Check DB
        const rows = this.db.prepare(
            "SELECT 1 FROM alert_workflows WHERE incident_id = ? AND status != 'completed' LIMIT 1"
        ).get(incidentId);
        return !!rows;
    }

    // ─── PagerDuty API ────────────────────────────────────────────

    async acknowledgePagerDuty(incidentId) {
        const token = this.config.pagerdutyApiToken;
        const fromEmail = this.config.pagerdutyFromEmail;
        if (!token || !incidentId) return null;

        try {
            // Check current status
            const statusRes = await axios.get(
                `https://api.pagerduty.com/incidents/${incidentId}`,
                {
                    headers: {
                        'Authorization': `Token token=${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const status = statusRes.data?.incident?.status;
            this.logger.info(`PD incident ${incidentId} status: ${status}`);

            if (status === 'acknowledged' || status === 'resolved') {
                return { skipped: true, status };
            }

            // Acknowledge
            await axios.put(
                `https://api.pagerduty.com/incidents/${incidentId}`,
                {
                    incident: {
                        type: 'incident_reference',
                        status: 'acknowledged'
                    }
                },
                {
                    headers: {
                        'Authorization': `Token token=${token}`,
                        'Content-Type': 'application/json',
                        'From': fromEmail
                    }
                }
            );

            this.logger.info(`PD incident ${incidentId} acknowledged`);
            return { skipped: false, status: 'acknowledged' };
        } catch (error) {
            this.logger.error(`PD API error for ${incidentId}: ${error.message}`);
            return null;
        }
    }

    // ─── Claude Session Management ────────────────────────────────

    _generateSessionName(channelId, threadTs) {
        const suffix = threadTs.replace('.', '').slice(-6);
        return `alert-${channelId.slice(-4)}-${suffix}`;
    }

    async _createTmuxSession(sessionName, repoPath, claudeCmd) {
        try {
            execSync('which tmux', { stdio: 'ignore' });
        } catch {
            this.logger.error('tmux is not installed');
            return false;
        }

        // Kill existing session with same name if any
        try {
            execSync(`tmux has-session -t ${sessionName} 2>/dev/null`);
            execSync(`tmux kill-session -t ${sessionName}`);
        } catch {
            // Session doesn't exist
        }

        return new Promise((resolve) => {
            const { buildTmuxCommand } = require('../../utils/tmux-helper');
            const cmd = buildTmuxCommand(sessionName, repoPath, claudeCmd);
            this.logger.info(`Creating alert tmux session: ${cmd}`);

            exec(cmd, (error) => {
                if (error) {
                    this.logger.error(`Failed to create tmux session: ${error.message}`);
                    resolve(false);
                    return;
                }
                setTimeout(() => resolve(true), 3000);
            });
        });
    }

    _isTmuxSessionAlive(sessionName) {
        try {
            execSync(`tmux has-session -t ${sessionName} 2>/dev/null`);
            return true;
        } catch {
            return false;
        }
    }

    _killTmuxSession(sessionName) {
        try {
            execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`);
            this.logger.info(`Killed tmux session: ${sessionName}`);
        } catch {
            // Already dead
        }
    }

    async _injectCommand(sessionName, command) {
        return new Promise((resolve, reject) => {
            exec(`tmux send-keys -t ${sessionName} C-u`, (clearErr) => {
                if (clearErr) {
                    reject(new Error(`Failed to clear input: ${clearErr.message}`));
                    return;
                }

                setTimeout(() => {
                    const escaped = command.replace(/'/g, "'\"'\"'");
                    exec(`tmux send-keys -t ${sessionName} -l '${escaped}'`, (sendErr) => {
                        if (sendErr) {
                            reject(new Error(`Failed to send command: ${sendErr.message}`));
                            return;
                        }

                        setTimeout(() => {
                            exec(`tmux send-keys -t ${sessionName} C-m`, (enterErr) => {
                                if (enterErr) {
                                    reject(new Error(`Failed to send enter: ${enterErr.message}`));
                                    return;
                                }
                                resolve();
                            });
                        }, 200);
                    });
                }, 200);
            });
        });
    }

    _captureOutput(sessionName) {
        try {
            return execSync(`tmux capture-pane -t ${sessionName} -p -S -500`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
        } catch {
            return '';
        }
    }

    // ─── Response Polling ────────────────────────────────────────

    _pollForCompletion(sessionName, baselineOutput = '') {
        return new Promise((resolve) => {
            let lastOutput = this._captureOutput(sessionName);
            let stableCount = 0;
            let attempts = 0;
            const maxAttempts = 600; // 10 minutes
            const stableThreshold = 3;

            const interval = setInterval(() => {
                attempts++;

                if (!this._isTmuxSessionAlive(sessionName)) {
                    clearInterval(interval);
                    resolve({ completed: true, output: lastOutput, baselineOutput, timedOut: false, sessionDied: true });
                    return;
                }

                if (attempts > maxAttempts) {
                    clearInterval(interval);
                    resolve({ completed: false, output: lastOutput, baselineOutput, timedOut: true });
                    return;
                }

                const currentOutput = this._captureOutput(sessionName);

                if (currentOutput === lastOutput) {
                    stableCount++;
                } else {
                    stableCount = 0;
                    lastOutput = currentOutput;
                }

                if (stableCount >= stableThreshold) {
                    const lines = currentOutput.trimEnd().split('\n');
                    const tailLines = lines.slice(-10);
                    const hasPrompt = tailLines.some(l => {
                        const trimmed = l.trim();
                        return trimmed === '❯' || trimmed === '>' ||
                               trimmed.match(/^[>❯]\s*$/) ||
                               trimmed.includes('│ >') || trimmed.includes('│ ❯');
                    });

                    const isWorking =
                        currentOutput.includes('Clauding') ||
                        currentOutput.includes('Working') ||
                        currentOutput.includes('Processing') ||
                        currentOutput.includes('⏳') ||
                        currentOutput.includes('Thinking');

                    if (hasPrompt && !isWorking) {
                        clearInterval(interval);
                        resolve({ completed: true, output: currentOutput, baselineOutput, timedOut: false });
                        return;
                    }

                    // Auto-approve confirmation dialogs
                    if (currentOutput.includes('Do you want to proceed?') ||
                        currentOutput.includes('(y/n)') ||
                        currentOutput.includes('1. Yes')) {
                        this._autoApprove(sessionName, currentOutput);
                        stableCount = 0;
                    }
                }
            }, 1000);
        });
    }

    _autoApprove(sessionName, output) {
        this.logger.info(`Auto-approving confirmation in ${sessionName}`);

        if (output.includes('2. Yes, and don\'t ask again')) {
            exec(`tmux send-keys -t ${sessionName} '2'`, () => {
                setTimeout(() => exec(`tmux send-keys -t ${sessionName} Enter`), 300);
            });
        } else if (output.includes('1. Yes')) {
            exec(`tmux send-keys -t ${sessionName} '1'`, () => {
                setTimeout(() => exec(`tmux send-keys -t ${sessionName} Enter`), 300);
            });
        } else if (output.includes('(y/n)') || output.includes('[Y/n]')) {
            exec(`tmux send-keys -t ${sessionName} 'y'`, () => {
                setTimeout(() => exec(`tmux send-keys -t ${sessionName} Enter`), 300);
            });
        }
    }

    // ─── Report Extraction ───────────────────────────────────────

    /**
     * Extract model/context/cost metadata from Claude CLI status bar.
     * Returns a formatted string like "Model: Opus 4.6 | Ctx: 44.8% | In: 56 Out: 6.8k | Cost: $1.33"
     * or null if not found.
     */
    _extractSessionMetadata(output) {
        const lines = output.split('\n');
        let modelInfo = null;
        let ctxInfo = null;

        for (const line of lines) {
            const trimmed = line.trim();
            // Match the status bar line: "Model: Opus 4.6↗ mainCtx(u): 44.8% | In: 56Out: 6.8k | Cost: $1.33"
            if (trimmed.startsWith('Model:') || trimmed.match(/Ctx\(u\):/)) {
                // This could be one line or split across lines
                if (trimmed.startsWith('Model:')) modelInfo = trimmed;
                if (trimmed.match(/Ctx\(u\):/) || trimmed.match(/Cost: \$/)) ctxInfo = trimmed;
            }
        }

        // Try to find a single combined line
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('Model:') && (trimmed.includes('Ctx') || trimmed.includes('Cost'))) {
                return trimmed;
            }
        }

        // Combine separate matches
        if (modelInfo && ctxInfo && modelInfo !== ctxInfo) {
            return `${modelInfo} | ${ctxInfo}`;
        }
        return modelInfo || ctxInfo || null;
    }

    /**
     * Extract only the final assistant response using diff-based approach.
     * 1. Diff baseline vs current to get only new lines
     * 2. Split into blocks separated by tool calls
     * 3. Return the last assistant text block (the final response)
     */
    _extractFinalResponse(baselineOutput, currentOutput) {
        const baseLines = (baselineOutput || '').split('\n');
        const currentLines = currentOutput.split('\n');

        // Find where output diverges from baseline
        let diffStart = 0;
        for (let i = 0; i < Math.min(baseLines.length, currentLines.length); i++) {
            if (baseLines[i] !== currentLines[i]) {
                diffStart = i;
                break;
            }
            diffStart = i + 1;
        }

        const newLines = currentLines.slice(diffStart);

        // Filter out CLI chrome and UI elements
        const filtered = newLines.filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            if (trimmed === '>' || trimmed === '❯') return false;
            if (trimmed.match(/^[>❯]\s*$/)) return false;
            if (trimmed.match(/^[─━═▪▐▛▜▝▘]+/) || trimmed.match(/^[─━═▪]+$/)) return false;
            if (trimmed.startsWith('Model:') || trimmed.includes('bypass permissions')) return false;
            if (trimmed.match(/^⏵/) && trimmed.includes('permissions')) return false;
            if (trimmed.match(/Ctx\(u\):/) || trimmed.match(/Cost: \$/)) return false;
            if (trimmed.includes('│ >') || trimmed.includes('│ ❯')) return false;
            return true;
        });

        // Split into blocks: tool calls vs assistant text
        // Tool call lines match patterns like: 🔵 ToolName(args), ⚫ ToolName(...), └ output, … +N lines
        const isToolLine = (line) => {
            const t = line.trim();
            // Tool call header: circle emoji + ToolName(args) or ToolName - description (MCP)
            if (t.match(/^[🔵⚫⬤●○◉🟢🟡🟠🔴⭕]\s*.+\(.*\)/)) return true;
            if (t.match(/^[🔵⚫⬤●○◉🟢🟡🟠🔴⭕]\s*\S+\s*-\s*.+\(MCP\)/)) return true;
            // Tool output: └ or indented under tool
            if (t.startsWith('└') || t.startsWith('╰')) return true;
            // Collapsed output: … +N lines (ctrl+o to expand)
            if (t.match(/^…\s*\+\d+\s*lines/)) return true;
            // Skill loading
            if (t.match(/^[🔵⚫⬤●○◉🟢🟡🟠🔴⭕]\s*Skill\(/)) return true;
            return false;
        };

        // Walk backwards from the end to find the last assistant text block
        // (everything after the last tool call)
        let lastToolIdx = -1;
        for (let i = filtered.length - 1; i >= 0; i--) {
            if (isToolLine(filtered[i])) {
                lastToolIdx = i;
                break;
            }
        }

        // Extract text after the last tool call
        const finalBlock = filtered.slice(lastToolIdx + 1);
        const finalResponse = finalBlock.join('\n').trim();

        if (finalResponse) {
            this.logger.info(`Extracted final response: ${finalResponse.length} chars (from ${filtered.length} diff lines)`);
            return finalResponse;
        }

        // Fallback: return all filtered lines if no tool calls detected
        this.logger.warn('No final response block found, using full diff');
        return filtered.join('\n').trim();
    }

    _extractSummary(fullReport) {
        // Extract header + first section up to second --- separator
        const lines = fullReport.split('\n');
        let separatorCount = 0;
        const summaryLines = [];

        for (const line of lines) {
            if (line.trim().match(/^-{3,}$/)) {
                separatorCount++;
                if (separatorCount >= 2) break;
            }
            summaryLines.push(line);
        }

        const summary = summaryLines.join('\n').trim();
        // If no separators found, take first 2000 chars
        if (separatorCount === 0 && summary.length > 2000) {
            return summary.substring(0, 2000) + '\n...(truncated)';
        }
        return summary;
    }

    _rewriteApiErrors(text) {
        // Rewrite common API errors into user-friendly messages
        if (text.includes('ECONNREFUSED') || text.includes('ENOTFOUND')) {
            return text.replace(/Error:.*?(ECONNREFUSED|ENOTFOUND).*?\n/g,
                'Connection to external service failed. The service may be temporarily unavailable.\n');
        }
        if (text.includes('429') || text.includes('rate limit')) {
            return text.replace(/Error:.*?(429|rate limit).*?\n/gi,
                'Rate limited by external service. Please retry later.\n');
        }
        return text;
    }

    _saveReport(threadTs, fullReport) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const safeTs = threadTs.replace('.', '-');
        const filename = `${timestamp}-${safeTs}.md`;
        const filePath = path.join(this.reportsDir, filename);
        fs.writeFileSync(filePath, fullReport);
        this.logger.info(`Report saved: ${filePath}`);
        return filePath;
    }

    /**
     * Split a long message into chunks that fit within Slack's message size limit.
     * Splits at paragraph boundaries (\n\n), then line boundaries (\n), then hard split.
     */
    _chunkResponse(text, maxLength = 3500) {
        if (text.length <= maxLength) return [text];

        const chunks = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }

            let splitAt = remaining.lastIndexOf('\n\n', maxLength);
            if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLength);
            if (splitAt <= 0) splitAt = maxLength;

            chunks.push(remaining.substring(0, splitAt));
            remaining = remaining.substring(splitAt).replace(/^\n+/, '');
        }

        return chunks;
    }

    // ─── Slack Helpers ──────────────────────────────────────────

    async _getPermalink(channelId, messageTs) {
        try {
            const result = await this.app.client.chat.getPermalink({
                channel: channelId,
                message_ts: messageTs
            });
            return result.permalink;
        } catch (error) {
            this.logger.error(`Failed to get permalink: ${error.message}`);
            return null;
        }
    }

    async _postMessage(channelId, threadTs, text) {
        try {
            const result = await this.app.client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text
            });
            return result.ts;
        } catch (error) {
            this.logger.error(`Failed to post message: ${error.message}`);
            return null;
        }
    }

    async _updateMessage(channelId, ts, text) {
        try {
            await this.app.client.chat.update({
                channel: channelId,
                ts,
                text
            });
        } catch (error) {
            this.logger.error(`Failed to update message: ${error.message}`);
        }
    }

    async _uploadFile(channelId, threadTs, filePath, filename, title) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            await this.app.client.files.uploadV2({
                channel_id: channelId,
                thread_ts: threadTs,
                content,
                filename,
                title
            });
        } catch (error) {
            this.logger.error(`Failed to upload file: ${error.message}`);
        }
    }

    // ─── Main Workflow ──────────────────────────────────────────

    /**
     * Start an alert investigation workflow.
     * @param {Object} params
     * @param {string} params.channelId - Slack channel ID where the alert was posted
     * @param {string} params.messageTs - Timestamp of the alert message
     * @param {string} params.text - Alert message text
     * @param {string} [params.incidentId] - PagerDuty incident ID
     * @param {boolean} [params.force=false] - Skip PagerDuty acknowledgment check
     * @param {Array} [params.files] - Slack message file attachments
     * @returns {Object} { started: boolean, reason?: string }
     */
    async startAlertWorkflow({ channelId, messageTs, text, incidentId, force = false, files }) {
        // 1. Deduplication — check messageTs
        if (this.isActive(messageTs)) {
            this.logger.info(`Skipping duplicate workflow for messageTs=${messageTs}`);
            return { started: false, reason: 'already_active' };
        }

        // 2. Deduplication — check PD incident ID
        if (this.isIncidentTracked(incidentId)) {
            this.logger.info(`Skipping duplicate incident ${incidentId}`);
            return { started: false, reason: 'incident_tracked' };
        }

        const threadTs = messageTs; // Reply in the alert's thread
        const sessionName = this._generateSessionName(channelId, threadTs);
        const repoPath = this.config.repoPath || process.cwd();

        // 3. Persist to SQLite
        const now = Date.now();
        this._wfStmts.insert.run({
            message_ts: messageTs,
            channel_id: channelId,
            thread_ts: threadTs,
            session_name: sessionName,
            incident_id: incidentId || null,
            status: 'pending',
            repo_path: repoPath,
            created_at: now,
            updated_at: now
        });

        // Track in-memory
        this.activeWorkflows.set(messageTs, {
            channelId,
            threadTs,
            sessionName,
            incidentId,
            feedbackTimer: null
        });
        if (incidentId) this.trackedIncidents.add(incidentId);

        this.logger.info(`Starting alert workflow: messageTs=${messageTs} incident=${incidentId || 'unknown'} session=${sessionName}`);
        this.logger.info(`Original Slack message:\n${text}`);

        // 4. Acknowledge PagerDuty (skip entirely in force mode)
        if (!force && incidentId && this.config.pagerdutyApiToken) {
            const pdResult = await this.acknowledgePagerDuty(incidentId);
            if (pdResult?.skipped) {
                this.logger.info(`PD incident ${incidentId} already ${pdResult.status} — aborting workflow`);
                this._cleanup(messageTs);
                return { started: false, reason: `pd_already_${pdResult.status}` };
            }
        }

        // 5. Post "Investigating..." message
        const investigatingTs = await this._postMessage(channelId, threadTs,
            ':mag: Investigating alert... Starting Claude session.');

        // 6. Download attached images from Slack
        const imagePaths = await this._downloadSlackImages(files, sessionName);
        const imageInstruction = imagePaths.length > 0
            ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
            : '';

        // 7. Build prompt
        const alertSkill = this.config.alertSkill;
        const permalink = await this._getPermalink(channelId, messageTs);

        let prompt;
        if (alertSkill && permalink) {
            prompt = `/${alertSkill} ${permalink}${imageInstruction}`;
        } else if (alertSkill) {
            prompt = `/${alertSkill} Alert: ${text.substring(0, 500)}${imageInstruction}`;
        } else if (permalink) {
            prompt = `Investigate this PagerDuty alert: ${permalink}${imageInstruction}`;
        } else {
            prompt = `Investigate this PagerDuty alert: ${text.substring(0, 500)}${imageInstruction}`;
        }

        // 8. Create interactive tmux session, then inject the prompt via send-keys
        const claudeCmd = this.config.claudeCommand || 'claude --dangerously-skip-permissions';
        const created = await this._createTmuxSession(sessionName, repoPath, claudeCmd);
        if (!created) {
            await this._updateMessage(channelId, investigatingTs,
                ':x: Failed to start Claude session. Is tmux installed?');
            this._cleanup(messageTs);
            return { started: false, reason: 'tmux_failed' };
        }

        // Capture baseline before injecting prompt (for diff-based extraction later)
        const baselineOutput = this._captureOutput(sessionName);

        // Inject the prompt into the interactive session
        await this._injectCommand(sessionName, prompt);
        this.logger.info(`Injected prompt into ${sessionName}: ${prompt.substring(0, 100)}`);

        // Update DB status
        this._wfStmts.update.run({
            message_ts: messageTs,
            session_name: sessionName,
            status: 'investigating',
            updated_at: Date.now()
        });

        // 9. Poll for completion (non-blocking)
        this._runInvestigation(messageTs, channelId, threadTs, sessionName, investigatingTs, baselineOutput);

        return { started: true, channelId, messageTs };
    }

    async _runInvestigation(messageTs, channelId, threadTs, sessionName, investigatingTs, baselineOutput = '') {
        try {
            const result = await this._pollForCompletion(sessionName, baselineOutput);

            let fullReport;
            if (result.completed || result.timedOut) {
                fullReport = this._extractFinalResponse(result.baselineOutput, result.output);
                if (result.timedOut && !fullReport) {
                    fullReport = 'Investigation timed out after 10 minutes.';
                }
            }

            if (!fullReport) {
                fullReport = 'No report generated. The Claude session may have encountered an issue.';
            }

            // Extract session metadata (model, context, cost) before rewriting
            const sessionMetadata = this._extractSessionMetadata(result.output);

            // Rewrite API errors
            fullReport = this._rewriteApiErrors(fullReport);

            // Append session metadata to report
            if (sessionMetadata) {
                fullReport += `\n\n---\n_${sessionMetadata}_`;
            }

            // Extract summary
            const summary = this._extractSummary(fullReport);

            // Save full report
            const reportPath = this._saveReport(threadTs, fullReport);

            // Post summary in chunks to avoid msg_too_long
            const chunks = this._chunkResponse(summary);

            // Update "Investigating..." message with first chunk
            if (investigatingTs && chunks.length > 0) {
                try {
                    await this.app.client.chat.update({
                        channel: channelId,
                        ts: investigatingTs,
                        text: chunks[0]
                    });
                } catch (error) {
                    if (error.message?.includes('msg_too_long')) {
                        const truncated = chunks[0].substring(0, 3500) + '\n\n_(truncated — see full report below)_';
                        await this._updateMessage(channelId, investigatingTs, truncated);
                    } else {
                        this.logger.error(`Failed to update message: ${error.message}`);
                    }
                }
            }

            // Post remaining chunks as thread replies
            for (let i = 1; i < chunks.length; i++) {
                try {
                    await this.app.client.chat.postMessage({
                        channel: channelId,
                        thread_ts: threadTs,
                        text: chunks[i]
                    });
                } catch (error) {
                    if (error.message?.includes('msg_too_long')) {
                        const truncated = chunks[i].substring(0, 3500) + '\n\n_(truncated)_';
                        await this._postMessage(channelId, threadTs, truncated);
                    } else {
                        this.logger.error(`Failed to post chunk ${i}: ${error.message}`);
                    }
                }
            }

            // Upload full report as file
            const reportFilename = path.basename(reportPath);
            await this._uploadFile(channelId, threadTs, reportPath, reportFilename, 'Full Investigation Report');

            this.logger.info(`Investigation complete for ${messageTs}`);

            // Start feedback timer
            this._startFeedbackTimer(messageTs);

        } catch (error) {
            this.logger.error(`Investigation error for ${messageTs}: ${error.message}`);
            if (investigatingTs) {
                await this._updateMessage(channelId, investigatingTs,
                    `:warning: Investigation encountered an error: ${error.message}`);
            }
            this._cleanup(messageTs);
        }
    }

    // ─── Feedback Timer & Cleanup ────────────────────────────────

    _startFeedbackTimer(messageTs) {
        const wf = this.activeWorkflows.get(messageTs);
        if (!wf) return;

        const timeoutMs = this.config.alertFeedbackTimeoutMs || 300000; // 5 min default

        this._wfStmts.update.run({
            message_ts: messageTs,
            session_name: wf.sessionName,
            status: 'discussing',
            updated_at: Date.now()
        });

        wf.feedbackTimer = setTimeout(async () => {
            this.logger.info(`Feedback timeout for ${messageTs} — cleaning up`);
            try {
                await this.app.client.reactions.add({
                    channel: wf.channelId,
                    timestamp: messageTs,
                    name: 'white_check_mark',
                });
            } catch (e) {
                this.logger.warn(`Failed to add timeout reaction: ${e.message}`);
            }
            this._cleanup(messageTs);
        }, timeoutMs);

        this.logger.info(`Feedback timer started for ${messageTs} (${timeoutMs}ms)`);
    }

    /**
     * Handle /exit command from owner in a workflow thread.
     */
    async handleExit(messageTs) {
        const wf = this.activeWorkflows.get(messageTs);
        if (!wf) return false;

        this.logger.info(`/exit received for workflow ${messageTs}`);
        await this._injectCommand(wf.sessionName, '/exit');
        // Give it a moment to process
        await new Promise(r => setTimeout(r, 2000));
        this._cleanup(messageTs);
        return true;
    }

    /**
     * Handle follow-up messages in a workflow thread (resets feedback timer).
     */
    async handleFollowUp(messageTs, command) {
        const wf = this.activeWorkflows.get(messageTs);
        if (!wf) return false;

        // Reset feedback timer
        if (wf.feedbackTimer) {
            clearTimeout(wf.feedbackTimer);
        }

        // If tmux session is alive, inject the command and poll for response
        if (this._isTmuxSessionAlive(wf.sessionName)) {
            const baselineOutput = this._captureOutput(wf.sessionName);
            await this._injectCommand(wf.sessionName, command);

            // Poll for response and post to Slack (non-blocking)
            this._pollAndPostFollowUp(messageTs, wf, baselineOutput);
            return true;
        }

        return false;
    }

    async _pollAndPostFollowUp(messageTs, wf, baselineOutput) {
        try {
            const result = await this._pollForCompletion(wf.sessionName, baselineOutput);
            const response = this._extractFinalResponse(result.baselineOutput, result.output);

            if (response) {
                const chunks = this._chunkResponse(response);
                for (const chunk of chunks) {
                    try {
                        await this.app.client.chat.postMessage({
                            channel: wf.channelId,
                            thread_ts: wf.threadTs,
                            text: chunk
                        });
                    } catch (error) {
                        if (error.message?.includes('msg_too_long')) {
                            await this._postMessage(wf.channelId, wf.threadTs,
                                chunk.substring(0, 3500) + '\n\n_(truncated)_');
                        } else {
                            this.logger.error(`Failed to post follow-up chunk: ${error.message}`);
                        }
                    }
                }
                this.logger.info(`Follow-up response posted for ${messageTs} (${response.length} chars)`);
            }

            this._startFeedbackTimer(messageTs);
        } catch (error) {
            this.logger.error(`Follow-up poll error for ${messageTs}: ${error.message}`);
        }
    }

    _cleanup(messageTs) {
        const wf = this.activeWorkflows.get(messageTs);
        if (!wf) return;

        // Clear feedback timer
        if (wf.feedbackTimer) {
            clearTimeout(wf.feedbackTimer);
        }

        // Kill tmux session
        if (wf.sessionName) {
            this._killTmuxSession(wf.sessionName);
        }

        // Remove from tracking
        if (wf.incidentId) {
            this.trackedIncidents.delete(wf.incidentId);
        }
        this.activeWorkflows.delete(messageTs);

        // Update DB
        this._wfStmts.update.run({
            message_ts: messageTs,
            session_name: wf.sessionName || '',
            status: 'completed',
            updated_at: Date.now()
        });

        // Clean up downloaded images
        const imageDir = path.join('/tmp', `alert-${wf.sessionName}`);
        if (fs.existsSync(imageDir)) {
            try {
                fs.rmSync(imageDir, { recursive: true });
                this.logger.info(`Cleaned up image dir: ${imageDir}`);
            } catch (e) {
                this.logger.warn(`Failed to clean image dir ${imageDir}: ${e.message}`);
            }
        }

        this.logger.info(`Workflow cleaned up: ${messageTs}`);
    }

    /**
     * Download image files from a Slack message to a temp directory.
     * @param {Array} files - Slack message files array
     * @param {string} sessionName - Used to create a unique temp directory
     * @returns {string[]} Array of downloaded file paths
     */
    async _downloadSlackImages(files, sessionName) {
        if (!files || files.length === 0) return [];

        const imageFiles = files.filter(f => f.mimetype?.startsWith('image/'));
        if (imageFiles.length === 0) return [];

        const imageDir = path.join('/tmp', `alert-${sessionName}`);
        fs.mkdirSync(imageDir, { recursive: true });

        const downloaded = [];
        for (const file of imageFiles) {
            try {
                const filePath = path.join(imageDir, file.name || `image-${Date.now()}.png`);
                const response = await axios.get(file.url_private_download, {
                    headers: { Authorization: `Bearer ${this.config.botToken}` },
                    responseType: 'arraybuffer'
                });
                fs.writeFileSync(filePath, response.data);
                downloaded.push(filePath);
                this.logger.info(`Downloaded Slack image: ${filePath} (${file.mimetype})`);
            } catch (e) {
                this.logger.warn(`Failed to download Slack file ${file.name}: ${e.message}`);
            }
        }
        return downloaded;
    }

    // ─── Restart Recovery ────────────────────────────────────────

    /**
     * Recover active workflows from DB after restart.
     * If tmux session still alive → re-add to in-memory tracking.
     * If tmux session dead → start new tmux and resume old Claude session.
     */
    async recoverWorkflows() {
        const rows = this._wfStmts.getActive.all();
        if (rows.length === 0) {
            this.logger.info('No active workflows to recover');
            return;
        }

        this.logger.info(`Recovering ${rows.length} active workflow(s)...`);

        for (const row of rows) {
            const { message_ts, channel_id, thread_ts, session_name, incident_id, status, repo_path } = row;

            if (session_name && this._isTmuxSessionAlive(session_name)) {
                // Tmux still alive — re-track
                this.activeWorkflows.set(message_ts, {
                    channelId: channel_id,
                    threadTs: thread_ts,
                    sessionName: session_name,
                    incidentId: incident_id,
                    feedbackTimer: null
                });
                if (incident_id) this.trackedIncidents.add(incident_id);
                this.logger.info(`Recovered live workflow: ${session_name} (${status})`);

                // If it was investigating, re-poll
                if (status === 'investigating') {
                    this._runInvestigation(message_ts, channel_id, thread_ts, session_name, null);
                } else if (status === 'discussing') {
                    this._startFeedbackTimer(message_ts);
                }
            } else {
                // Tmux session dead — try to resume Claude session in new tmux
                this.logger.info(`Tmux session ${session_name} dead — attempting resume`);
                const rPath = repo_path || this.config.repoPath || process.cwd();
                const claudeBaseCmd = this.config.claudeCommand || 'claude --dangerously-skip-permissions';
                // Resume with --resume flag to pick up the old session
                const resumeCmd = `${claudeBaseCmd} --resume`;

                const created = await this._createTmuxSession(session_name, rPath, resumeCmd);
                if (created) {
                    this.activeWorkflows.set(message_ts, {
                        channelId: channel_id,
                        threadTs: thread_ts,
                        sessionName: session_name,
                        incidentId: incident_id,
                        feedbackTimer: null
                    });
                    if (incident_id) this.trackedIncidents.add(incident_id);
                    this.logger.info(`Resumed workflow in new tmux: ${session_name}`);

                    await this._postMessage(channel_id, thread_ts,
                        ':recycle: Agent restarted — resumed investigation session.');

                    if (status === 'investigating') {
                        this._runInvestigation(message_ts, channel_id, thread_ts, session_name, null);
                    } else {
                        this._startFeedbackTimer(message_ts);
                    }
                } else {
                    this.logger.warn(`Failed to resume workflow ${session_name} — marking completed`);
                    this._wfStmts.update.run({
                        message_ts,
                        session_name: session_name || '',
                        status: 'completed',
                        updated_at: Date.now()
                    });
                }
            }
        }
    }

    // ─── URL Parsing ────────────────────────────────────────────

    /**
     * Parse a Slack message URL into channelId and messageTs.
     */
    static parseSlackUrl(url) {
        const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
        if (!match) return null;

        const channelId = match[1];
        const rawTs = match[2];
        const messageTs = rawTs.slice(0, -6) + '.' + rawTs.slice(-6);
        return { channelId, messageTs };
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    cleanupAll() {
        for (const [messageTs] of this.activeWorkflows) {
            this._cleanup(messageTs);
        }
    }
}

module.exports = AlertWorkflow;
