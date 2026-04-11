/**
 * Slack Socket Mode Handler
 * Listens for messages via Slack Socket Mode, manages Claude tmux sessions,
 * and relays responses back to Slack threads.
 * Sessions are persisted to SQLite so conversations survive agent restarts.
 */

const { App } = require('@slack/bolt');
const { exec, execSync } = require('child_process');
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Logger = require('../../core/logger');
const AlertMonitor = require('./alert-monitor');
const DelayAlertMonitor = require('./delay-alert-monitor');
const { runDailySummary, parseChannelsConfig } = require('../../services/daily-summary');

class SlackSocketHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('SlackSocket');

        // Polling state per session (in-memory only, rebuilt on start)
        this.pollers = new Map();
        this.sessionTimers = new Map(); // sessionKey -> setTimeout handle

        this.app = new App({
            token: config.botToken,
            appToken: config.appToken,
            socketMode: true,
            logLevel: 'error'
        });

        this.httpPort = config.httpPort || 9999;
        this.httpServer = null;

        // Connection state tracking
        this.connected = false;
        this._healthCheckInterval = null;

        // WebSocket error resilience
        this._wsErrors = [];                  // timestamps of recent WS errors
        this._wsErrorWindowMs = 120000;       // 2-minute sliding window
        this._wsRestarting = false;           // prevent concurrent restarts
        this._wsEscalationLevel = 0;         // 0=none, 1=warn, 2=restart, 3=notify, 4=exit
        this._lastOwnerNotifyTs = 0;          // cooldown for owner DM
        this._ownerNotifyCooldownMs = 300000; // 5 min cooldown
        this._startedAt = Date.now();         // for uptime reporting
        this._wsRestartWindowMs = 600000;     // 10 min window for restart tracking
        this._wsRestartStateFile = path.join(__dirname, '../../data/ws-restart-state.json');
        this._wsRestartTimestamps = this._loadRestartState(); // persisted across process restarts

        this._initDb();

        // Alert monitoring
        this.alertMonitor = new AlertMonitor(this.app, config);
        this.trackedIncidents = new Map(); // incidentId → { channelId, messageTs }

        // Delay alert monitoring
        this.delayAlertMonitor = new DelayAlertMonitor(this.app, this.db, config);

        this._setupListeners();
        this._setupHttpServer();
    }

    // ─── SQLite ──────────────────────────────────────────────────────

    _initDb() {
        const dbDir = path.join(__dirname, '../../data');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const dbPath = this.config.dbPath || path.join(dbDir, 'slack-sessions.db');
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                session_key   TEXT PRIMARY KEY,
                session_name  TEXT NOT NULL,
                channel_id    TEXT NOT NULL,
                thread_ts     TEXT NOT NULL,
                repo_path     TEXT NOT NULL,
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL,
                last_bot_ts   TEXT
            )
        `);

        // Migrate: add columns if missing (existing DBs)
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN last_bot_ts TEXT');
        } catch {
            // Column already exists
        }
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN alert_message_ts TEXT');
        } catch {
            // Column already exists
        }
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN last_user_id TEXT');
        } catch {
            // Column already exists
        }
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN claude_session_id TEXT');
        } catch {
            // Column already exists
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_claude_session_id ON sessions(claude_session_id)');

        this._stmts = {
            upsert: this.db.prepare(`
                INSERT INTO sessions (session_key, session_name, channel_id, thread_ts, repo_path, created_at, updated_at, alert_message_ts)
                VALUES (@session_key, @session_name, @channel_id, @thread_ts, @repo_path, @created_at, @updated_at, @alert_message_ts)
                ON CONFLICT(session_key) DO UPDATE SET
                    updated_at = @updated_at,
                    claude_session_id = NULL
            `),
            get: this.db.prepare('SELECT * FROM sessions WHERE session_key = ?'),
            all: this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC'),
            delete: this.db.prepare('DELETE FROM sessions WHERE session_key = ?'),
            deleteOld: this.db.prepare('DELETE FROM sessions WHERE updated_at < ?'),
            touch: this.db.prepare('UPDATE sessions SET updated_at = ? WHERE session_key = ?'),
            updateLastBotTs: this.db.prepare('UPDATE sessions SET last_bot_ts = ?, updated_at = ? WHERE session_key = ?'),
            updateLastUserId: this.db.prepare('UPDATE sessions SET last_user_id = ?, updated_at = ? WHERE session_key = ?'),
            deleteByNameExcept: this.db.prepare('DELETE FROM sessions WHERE session_name = ? AND session_key != ?'),
            getByClaudeSessionId: this.db.prepare('SELECT * FROM sessions WHERE claude_session_id = ? LIMIT 1'),
            updateClaudeSessionId: this.db.prepare('UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE session_key = ?')
        };

        // Clean up sessions older than 7 days
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const deleted = this._stmts.deleteOld.run(weekAgo);
        if (deleted.changes > 0) {
            this.logger.info(`Cleaned up ${deleted.changes} expired sessions from DB`);
        }
    }

    _saveSession(session) {
        const sessionKey = `${session.channelId}-${session.threadTs}`;
        // Remove stale DB entries with the same tmux session name (from timed-out sessions
        // whose threadTs produced the same 6-digit suffix). Without this, the hook's
        // session_name lookup could return the old/wrong thread.
        this._stmts.deleteByNameExcept.run(session.sessionName, sessionKey);
        this._stmts.upsert.run({
            session_key: sessionKey,
            session_name: session.sessionName,
            channel_id: session.channelId,
            thread_ts: session.threadTs,
            repo_path: session.repoPath,
            created_at: session.createdAt,
            updated_at: Date.now(),
            alert_message_ts: session.alertMessageTs || null
        });
    }

    _getSession(sessionKey) {
        const row = this._stmts.get.get(sessionKey);
        if (!row) return null;
        return {
            sessionName: row.session_name,
            channelId: row.channel_id,
            threadTs: row.thread_ts,
            repoPath: row.repo_path,
            createdAt: row.created_at,
            lastBotTs: row.last_bot_ts || null,
            alertMessageTs: row.alert_message_ts || null,
            lastUserId: row.last_user_id || null,
            claudeSessionId: row.claude_session_id || null
        };
    }

    _getAllSessions() {
        return this._stmts.all.all().map(row => ({
            sessionKey: row.session_key,
            sessionName: row.session_name,
            channelId: row.channel_id,
            threadTs: row.thread_ts,
            repoPath: row.repo_path,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            alertMessageTs: row.alert_message_ts || null,
            claudeSessionId: row.claude_session_id || null
        }));
    }

    _deleteSession(sessionKey) {
        this._stmts.delete.run(sessionKey);
    }

    _touchSession(sessionKey) {
        this._stmts.touch.run(Date.now(), sessionKey);
    }

    /**
     * On startup, check which DB sessions still have a live tmux session.
     * Remove dead ones.
     */
    async _reconcileSessions() {
        const sessions = this._getAllSessions();
        let alive = 0;
        let removed = 0;

        for (const s of sessions) {
            if (this._isTmuxSessionAlive(s.sessionName)) {
                alive++;
                this._startSessionTimeout(s.sessionKey);
                this.logger.info(`Recovered session: ${s.sessionName} (channel ${s.channelId}) — timeout set`);
            } else {
                // Swap alert reactions for dead alert sessions
                const row = this._stmts.get.get(s.sessionKey);
                if (row?.alert_message_ts) {
                    await this._removeReaction(s.channelId, row.alert_message_ts, 'eyes');
                    await this._addReaction(s.channelId, row.alert_message_ts, 'white_check_mark');
                    this.logger.info(`Alert session ${s.sessionName} dead — swapped reactions`);
                }
                this._deleteSession(s.sessionKey);
                this._clearSessionTimeout(s.sessionKey);
                removed++;
            }
        }

        this.logger.info(`Session reconciliation: ${alive} alive, ${removed} stale removed`);

        // Kill orphan tmux sessions not tracked in DB
        try {
            const tmuxList = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null").toString().trim();
            if (tmuxList) {
                const dbSessionNames = new Set(sessions.map(s => s.sessionName));
                const orphans = tmuxList.split('\n').filter(name => name.startsWith('slack-') && !dbSessionNames.has(name));
                for (const name of orphans) {
                    try {
                        execSync(`tmux kill-session -t ${name} 2>/dev/null`);
                        this.logger.info(`Killed orphan tmux session: ${name}`);
                    } catch (_) {}
                }
                if (orphans.length > 0) {
                    this.logger.info(`Killed ${orphans.length} orphan tmux sessions not in DB`);
                }
            }
        } catch (_) { /* no tmux server running */ }
    }

    _isTmuxSessionAlive(sessionName) {
        try {
            execSync(`tmux has-session -t ${sessionName} 2>/dev/null`);
            return true;
        } catch {
            return false;
        }
    }

    // ─── Slack Image Download ─────────────────────────────────────────

    /**
     * Download image files from a Slack message to a temp directory.
     * @param {Array} files - Slack message files array
     * @param {string} dirName - Directory name under /tmp for storing images
     * @returns {string[]} Array of downloaded file paths
     */
    async _downloadSlackImages(files, dirName) {
        if (!files || files.length === 0) return [];

        const imageFiles = files.filter(f => f.mimetype?.startsWith('image/'));
        if (imageFiles.length === 0) return [];

        const imageDir = path.join('/tmp', dirName);
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

    // ─── Reaction Helpers ──────────────────────────────────────────────

    async _addReaction(channelId, messageTs, name) {
        try {
            await this.app.client.reactions.add({ channel: channelId, timestamp: messageTs, name });
        } catch (error) {
            if (!error.message?.includes('already_reacted')) {
                this.logger.error(`Failed to add reaction ${name}: ${error.message}`);
            }
        }
    }

    async _removeReaction(channelId, messageTs, name) {
        try {
            await this.app.client.reactions.remove({ channel: channelId, timestamp: messageTs, name });
        } catch (error) {
            if (!error.message?.includes('no_reaction')) {
                this.logger.error(`Failed to remove reaction ${name}: ${error.message}`);
            }
        }
    }

    // ─── PagerDuty API ──────────────────────────────────────────────

    async _acknowledgePagerDuty(incidentId) {
        const token = this.config.pagerdutyApiToken;
        const fromEmail = this.config.pagerdutyFromEmail;
        if (!token || !incidentId) return null;

        try {
            const statusRes = await axios.get(
                `https://api.pagerduty.com/incidents/${incidentId}`,
                { headers: { 'Authorization': `Token token=${token}`, 'Content-Type': 'application/json' } }
            );
            const status = statusRes.data?.incident?.status;
            this.logger.info(`PD incident ${incidentId} status: ${status}`);

            if (status === 'acknowledged' || status === 'resolved') {
                return { skipped: true, status };
            }

            await axios.put(
                `https://api.pagerduty.com/incidents/${incidentId}`,
                { incident: { type: 'incident_reference', status: 'acknowledged' } },
                { headers: { 'Authorization': `Token token=${token}`, 'Content-Type': 'application/json', 'From': fromEmail } }
            );
            this.logger.info(`PD incident ${incidentId} acknowledged`);
            return { skipped: false, status: 'acknowledged' };
        } catch (error) {
            this.logger.error(`PD API error for ${incidentId}: ${error.message}`);
            return null;
        }
    }

    // ─── Thread Context ─────────────────────────────────────────────

    /**
     * Fetch thread messages from Slack, optionally only those after a given timestamp.
     * @param {string} channelId - The Slack channel ID
     * @param {string} threadTs - The thread root timestamp
     * @param {string|null} sinceTs - Only return messages after this timestamp (exclusive)
     * @returns {Array<{user: string, text: string, ts: string}>}
     */
    async _fetchThreadMessages(channelId, threadTs, sinceTs = null, { includeBotMessages = true } = {}) {
        const messages = [];
        let cursor;

        do {
            const result = await this.app.client.conversations.replies({
                channel: channelId,
                ts: threadTs,
                limit: 200,
                ...(cursor ? { cursor } : {})
            });

            for (const msg of (result.messages || [])) {
                if (sinceTs && parseFloat(msg.ts) <= parseFloat(sinceTs)) continue;
                // Optionally skip bot messages (for live session injection — no context needed)
                if (!includeBotMessages && (msg.bot_id || (msg.app_id && !msg.user))) continue;

                const isBot = !!(msg.bot_id || (msg.app_id && !msg.user));
                let text = msg.text || '';

                // Fetch file attachments via Gemini (skip for bot messages to avoid re-describing our own uploads)
                if (!isBot && msg.files && msg.files.length > 0) {
                    const fileContents = await this._fetchFileContents(msg.files);
                    if (fileContents) {
                        text += '\n' + fileContents;
                    }
                }

                messages.push({
                    user: msg.user || (isBot ? 'EnzoBot' : 'unknown'),
                    text,
                    ts: msg.ts,
                    isBot
                });
            }

            cursor = result.response_metadata?.next_cursor;
        } while (cursor);

        return messages;
    }

    /**
     * Fetch file attachments from Slack and describe/summarize via Gemini.
     * All file types go through Gemini — images get vision description,
     * text/code files get summarized. Skips files >10MB.
     */
    async _fetchFileContents(files) {
        if (!files || files.length === 0) return null;

        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            this.logger.warn('GEMINI_API_KEY not set, skipping file content extraction');
            return null;
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const parts = [];

        for (const file of files) {
            if (!file.mimetype || file.size > 10000000) continue;

            try {
                const response = await axios.get(file.url_private_download, {
                    headers: { Authorization: `Bearer ${this.config.botToken}` },
                    responseType: 'arraybuffer'
                });
                const base64 = Buffer.from(response.data).toString('base64');

                const result = await model.generateContent([
                    { text: `Describe this file concisely for a software engineer. For images: what it shows, key details, any visible text. For code/text/logs: summarize the content and key points. File: ${file.name} (${file.mimetype}). Keep it under 300 words.` },
                    { inlineData: { mimeType: file.mimetype, data: base64 } }
                ]);

                const description = result.response.text().trim();
                parts.push(`[Attached: ${file.name}]\n${description}`);
                this.logger.info(`Gemini described ${file.name} (${file.mimetype}, ${file.size}b): ${description.substring(0, 80)}...`);
            } catch (e) {
                this.logger.warn(`Failed to process file ${file.name}: ${e.message}`);
            }
        }

        return parts.length > 0 ? parts.join('\n\n') : null;
    }

    /**
     * Resolve a Slack user ID to a display name. Caches results in memory.
     */
    async _resolveUserName(userId) {
        if (!this._userCache) this._userCache = new Map();
        if (this._userCache.has(userId)) return this._userCache.get(userId);

        try {
            const result = await this.app.client.users.info({ user: userId });
            const name = result.user?.profile?.display_name
                || result.user?.profile?.real_name
                || result.user?.name
                || userId;
            this._userCache.set(userId, name);
            return name;
        } catch {
            this._userCache.set(userId, userId);
            return userId;
        }
    }

    /**
     * Format thread messages into a context string for Claude.
     * Replaces <@UXXXX> mentions with display names.
     */
    async _formatThreadContext(messages) {
        // Collect all unique user IDs (from messages and mentions)
        const userIds = new Set();
        for (const msg of messages) {
            userIds.add(msg.user);
            const mentions = msg.text.match(/<@([A-Z0-9]+)>/g) || [];
            for (const m of mentions) {
                userIds.add(m.replace(/<@|>/g, ''));
            }
        }

        // Resolve all names in parallel
        const nameMap = new Map();
        await Promise.all([...userIds].map(async (id) => {
            nameMap.set(id, await this._resolveUserName(id));
        }));

        // Format each message
        const lines = messages.map(msg => {
            let text = msg.text;
            // Replace <@UXXXX> with display names
            text = text.replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${nameMap.get(id) || id}`);
            const name = nameMap.get(msg.user) || msg.user;
            return `${name}: ${text}`;
        });

        return lines.join('\n');
    }

    /**
     * Summarize a long thread using Gemini Flash for concise context injection.
     * For very large threads, truncates to last ~800KB to stay within Gemini's limits.
     * Falls back to raw formatted messages if Gemini is unavailable.
     */
    async _summarizeThreadContext(messages) {
        const formatted = await this._formatThreadContext(messages);
        try {
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) {
                this.logger.warn('GEMINI_API_KEY not set, using raw thread context');
                return formatted;
            }

            // Truncate if too large — keep last ~800KB (Gemini Flash handles ~1M tokens)
            const maxChars = 800000;
            let content = formatted;
            if (content.length > maxChars) {
                content = '... (earlier messages truncated)\n\n' + content.slice(-maxChars);
                this.logger.info(`Thread truncated from ${formatted.length} to ${maxChars} chars for Gemini`);
            }

            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const result = await model.generateContent(
                `Summarize this Slack thread conversation concisely. Focus on: what was requested, what was done, current state, and any pending items. Keep it under 500 words.\n\n${content}`
            );
            const summary = result.response.text();
            this.logger.info(`Thread summarized: ${messages.length} messages → ${summary.length} chars`);
            return `Previous conversation summary:\n${summary}`;
        } catch (err) {
            this.logger.warn(`Gemini summarization failed, using raw context: ${err.message}`);
            return formatted;
        }
    }

    /**
     * Detect the project path from thread history using Gemini.
     * Looks for "start from X project" patterns and path mentions in the conversation.
     */
    async _detectProjectFromThread(messages) {
        try {
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) return null;

            const formatted = await this._formatThreadContext(messages);
            const repoRoot = this.config.repoRoot || '';

            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const result = await model.generateContent(
                `From this Slack thread, identify the project directory path that was being used for the Claude Code session.
Look for patterns like:
- "start claude from X project"
- "Starting Claude session in /path/to/..."
- Any file paths mentioned that indicate the project root

The repo root is: ${repoRoot}

Return ONLY the absolute directory path, nothing else. If you cannot determine it, return "unknown".

Thread:
${formatted}`
            );
            const detected = result.response.text().trim();
            if (detected && detected !== 'unknown' && detected.startsWith('/')) {
                this.logger.info(`Gemini detected project from thread: ${detected}`);
                return detected;
            }
        } catch (err) {
            this.logger.warn(`Gemini project detection failed: ${err.message}`);
        }
        return null;
    }

    /**
     * Update the last bot response timestamp for a session.
     */
    _updateLastBotTs(sessionKey, ts) {
        this._stmts.updateLastBotTs.run(ts, Date.now(), sessionKey);
    }

    _updateLastUserId(sessionKey, userId) {
        this._stmts.updateLastUserId.run(userId, Date.now(), sessionKey);
    }

    // ─── Slack Event Listeners ───────────────────────────────────────

    _setupConnectionMonitor() {
        const receiver = this.app.receiver;
        if (!receiver || !receiver.client) {
            this.logger.warn('Cannot attach connection monitor: no Socket Mode receiver');
            return;
        }

        const client = receiver.client;

        client.on('connected', () => {
            this.connected = true;
            this.logger.info('Socket Mode connected');
            // Reset in-memory error state immediately
            this._wsErrors = [];
            this._wsEscalationLevel = 0;

            // Clear persisted restart state after 5 min of stable connection.
            // If WS breaks again before 5 min, the restart count is preserved
            // so the escalation can reach NOTIFY/EXIT stages.
            if (this._wsStabilityTimer) clearTimeout(this._wsStabilityTimer);
            this._wsStabilityTimer = setTimeout(() => {
                if (this.connected) {
                    this._clearRestartState();
                    this.logger.info('WebSocket stable for 5min — cleared restart state');
                }
            }, 300000); // 5 min
        });

        client.on('disconnected', () => {
            this.connected = false;
            this.logger.warn('Socket Mode disconnected');
            this._recordWsError('disconnected', 'Socket Mode disconnected');
        });

        client.on('error', (error) => {
            this.logger.warn(`Socket Mode error: ${error.message}`);
            this._recordWsError('error', error.message);
        });

        client.on('close', (code, reason) => {
            this.connected = false;
            this.logger.warn(`Socket Mode closed: code=${code} reason=${reason || 'none'}`);
            this._recordWsError('close', `code=${code} reason=${reason || 'none'}`);
        });

        client.on('reconnecting', () => {
            this.logger.info('Socket Mode reconnecting...');
        });
    }

    _startHealthCheck() {
        if (this._healthCheckInterval) return;
        let consecutiveFailures = 0;
        let consecutiveWsDown = 0;
        const MAX_FAILURES = 3;
        const MAX_WS_DOWN = 5; // 5 checks * 60s = 5 min of WS down while HTTP works

        this._healthCheckInterval = setInterval(async () => {
            try {
                await this.app.client.auth.test();
                consecutiveFailures = 0;

                // Detect blind spot: HTTP OK but WebSocket down
                if (!this.connected) {
                    consecutiveWsDown++;
                    this.logger.warn(`Health check OK but WebSocket down (${consecutiveWsDown}/${MAX_WS_DOWN})`);

                    if (consecutiveWsDown >= MAX_WS_DOWN) {
                        this.logger.warn(`WebSocket down for ${consecutiveWsDown}min despite healthy HTTP — escalating`);
                        this._recordWsError('health_check', `WebSocket down for ${consecutiveWsDown}min while HTTP OK`);
                        consecutiveWsDown = 0;
                    }
                } else {
                    if (consecutiveWsDown > 0) {
                        this.logger.info('WebSocket recovered (health check confirmed)');
                    }
                    consecutiveWsDown = 0;
                }
            } catch (err) {
                consecutiveFailures++;
                consecutiveWsDown = 0; // HTTP also broken — different issue
                this.connected = false;
                if (consecutiveFailures === MAX_FAILURES) {
                    this.logger.warn(`Health check failed ${MAX_FAILURES}x — forcing full restart`);
                    try {
                        await this.app.stop();
                        await this.app.start();
                        this.connected = true;
                        this._setupConnectionMonitor(); // re-attach to new receiver.client
                        consecutiveFailures = 0;
                        this.logger.info('Bolt app restarted successfully via health check');
                    } catch (restartErr) {
                        this.logger.error(`Health check restart failed: ${restartErr.message}`);
                        this._recordWsError('health_check_restart_fail', restartErr.message);
                        consecutiveFailures = 0;
                    }
                }
            }
        }, 60000);
    }

    // ─── WebSocket Error Resilience ────────────────────────────────────

    _loadRestartState() {
        try {
            if (fs.existsSync(this._wsRestartStateFile)) {
                const data = JSON.parse(fs.readFileSync(this._wsRestartStateFile, 'utf8'));
                const cutoff = Date.now() - this._wsRestartWindowMs;
                const timestamps = (data.timestamps || []).filter(ts => ts > cutoff);
                if (timestamps.length > 0) {
                    this.logger.info(`Loaded ${timestamps.length} recent restart(s) from previous process`);
                }
                return timestamps;
            }
        } catch (err) {
            this.logger.warn(`Failed to load restart state: ${err.message}`);
        }
        return [];
    }

    _saveRestartState() {
        try {
            const cutoff = Date.now() - this._wsRestartWindowMs;
            this._wsRestartTimestamps = this._wsRestartTimestamps.filter(ts => ts > cutoff);
            fs.writeFileSync(this._wsRestartStateFile, JSON.stringify({
                timestamps: this._wsRestartTimestamps,
                updatedAt: new Date().toISOString()
            }));
        } catch (err) {
            this.logger.warn(`Failed to save restart state: ${err.message}`);
        }
    }

    _clearRestartState() {
        this._wsRestartTimestamps = [];
        try {
            if (fs.existsSync(this._wsRestartStateFile)) {
                fs.unlinkSync(this._wsRestartStateFile);
            }
        } catch (err) {
            // ignore
        }
    }

    _getRestartsInWindow() {
        const cutoff = Date.now() - this._wsRestartWindowMs;
        this._wsRestartTimestamps = this._wsRestartTimestamps.filter(ts => ts > cutoff);
        return this._wsRestartTimestamps.length;
    }

    _recordWsError(source, message) {
        const now = Date.now();
        this._wsErrors.push(now);

        // Prune events older than the window
        const cutoff = now - this._wsErrorWindowMs;
        this._wsErrors = this._wsErrors.filter(ts => ts > cutoff);

        const count = this._wsErrors.length;
        const restartsInWindow = this._getRestartsInWindow();

        // Escalation uses levels to ensure each stage fires exactly once per incident.
        // On successful connection (stable), levels and restart state reset.
        //
        // Stages 1-2 are based on error count within the current process.
        // Stages 3-4 are based on restart count (persisted to file), so they
        // survive process restarts and catch the restart loop scenario.

        // Stage 1: WARN (5+ errors in 2 min)
        if (count >= 5 && this._wsEscalationLevel < 1) {
            this._wsEscalationLevel = 1;
            this.logger.warn(`WebSocket flapping: ${count} errors in ${this._wsErrorWindowMs / 1000}s [restarts in 10min: ${restartsInWindow}] (latest: ${source}: ${message})`);
        }

        // Stage 2: RESTART Bolt app (10+ errors in 2 min)
        if (count >= 10 && this._wsEscalationLevel < 2) {
            this._wsEscalationLevel = 2;
            this.logger.warn(`WebSocket critical: ${count} errors in window — forcing Bolt restart (restart #${restartsInWindow + 1} in 10min)`);
            this._attemptWsRecoveryRestart();
        }

        // Stage 3: NOTIFY owner (2+ restarts in 10 min — restart loop detected)
        if (restartsInWindow >= 2 && this._wsEscalationLevel < 3) {
            this._wsEscalationLevel = 3;
            this.logger.warn(`WebSocket restart loop: ${restartsInWindow} restarts in 10min — notifying owner`);
            this._notifyOwnerWsFailure(count, false, restartsInWindow);
        }

        // Stage 4: EXIT process (3+ restarts in 10 min — unrecoverable)
        if (restartsInWindow >= 3 && this._wsEscalationLevel < 4) {
            this._wsEscalationLevel = 4;
            this.logger.error(`WebSocket unrecoverable: ${restartsInWindow} restarts in 10min — exiting process`);
            this._notifyOwnerWsFailure(count, true, restartsInWindow).finally(() => {
                process.exit(1);
            });
        }
    }

    async _attemptWsRecoveryRestart() {
        if (this._wsRestarting) {
            this.logger.debug('WebSocket recovery restart already in progress — skipping');
            return;
        }

        this._wsRestarting = true;

        // Record this restart attempt to file (survives process restarts)
        this._wsRestartTimestamps.push(Date.now());
        this._saveRestartState();

        const restartsInWindow = this._getRestartsInWindow();
        this.logger.warn(`WebSocket recovery restart attempt (${restartsInWindow} in last 10min)`);

        try {
            await this.app.stop();
            await new Promise(r => setTimeout(r, 2000));
            await this.app.start();
            this.connected = true;
            this._setupConnectionMonitor(); // re-attach events to new receiver.client
            this._wsErrors = [];
            // Reset escalation level so _recordWsError can re-evaluate stages.
            // Restart timestamps are NOT reset here — they persist in the file.
            // If WS breaks again quickly, the restart count will trigger NOTIFY/EXIT.
            // Timestamps only clear after 5 min of stable connection (see 'connected' handler).
            this._wsEscalationLevel = 0;
            this.logger.info('WebSocket recovery restart succeeded');
        } catch (err) {
            this.logger.error(`WebSocket recovery restart failed: ${err.message}`);
            if (restartsInWindow >= 2) {
                this.logger.error(`${restartsInWindow} restart failures in 10min — notifying owner and exiting`);
                await this._notifyOwnerWsFailure(this._wsErrors.length, true, restartsInWindow);
                process.exit(1);
            }
        } finally {
            this._wsRestarting = false;
        }
    }

    async _notifyOwnerWsFailure(errorCount, isExiting = false, restartsInWindow = 0) {
        const ownerId = this.config.ownerUserId;
        if (!ownerId) {
            this.logger.warn('Cannot notify owner: SLACK_OWNER_USER_ID not configured');
            return;
        }

        const now = Date.now();
        if (!isExiting && now - this._lastOwnerNotifyTs < this._ownerNotifyCooldownMs) {
            this.logger.debug('Owner notification skipped (cooldown)');
            return;
        }
        this._lastOwnerNotifyTs = now;

        const uptimeMin = Math.round((now - this._startedAt) / 60000);
        const restarts = restartsInWindow || this._getRestartsInWindow();
        const action = isExiting
            ? 'Process is exiting for PM2/systemd restart.'
            : 'Restart loop detected — please check the agent.';

        const text = [
            `:rotating_light: *WebSocket Connection Failure*`,
            `*Errors:* ${errorCount} in the last ${this._wsErrorWindowMs / 1000}s`,
            `*Restarts in last 10min:* ${restarts}`,
            `*Uptime:* ${uptimeMin} minutes`,
            `*Action:* ${action}`,
        ].join('\n');

        try {
            await this.app.client.chat.postMessage({
                channel: ownerId,
                text,
            });
            this.logger.info('Owner notified of WebSocket failure via DM');
        } catch (err) {
            this.logger.error(`Failed to notify owner: ${err.message}`);
        }
    }

    async _notifyOwnerIncidentWebhook(incidentId, incidentData, { alreadyAcked = false, permalink = null } = {}) {
        const ownerId = this.config.ownerUserId;
        if (!ownerId) return;

        // If no permalink provided, try to look it up from tracked data
        if (!permalink) {
            const tracked = this.trackedIncidents.get(incidentId);
            if (tracked?.channelId && tracked?.messageTs) {
                permalink = await this._getPermalink(tracked.channelId, tracked.messageTs);
            }
        }

        const title = incidentData?.title || incidentData?.summary || incidentId;
        const urgency = incidentData?.urgency ? ` (${incidentData.urgency})` : '';
        const status = alreadyAcked
            ? 'Already acknowledged via Slack — investigation in progress'
            : 'New incident — starting investigation via webhook';
        const lines = [
            `:bell: *PagerDuty Webhook Received*`,
            `*Incident:* ${title}${urgency}`,
            `*Status:* ${status}`,
        ];
        if (permalink) {
            lines.push(`*Slack thread:* ${permalink}`);
        }

        try {
            await this.app.client.chat.postMessage({
                channel: ownerId,
                text: lines.join('\n'),
            });
            this.logger.info(`Owner notified: incident ${incidentId} webhook (alreadyAcked=${alreadyAcked})`);
        } catch (err) {
            this.logger.error(`Failed to notify owner of incident ${incidentId}: ${err.message}`);
        }
    }

    async _notifyOwnerDelayAlert(dagName, taskName, count, { permalink = null } = {}) {
        const ownerId = this.config.ownerUserId;
        if (!ownerId) return;

        const lines = [
            `:warning: *Airflow Delay Alert — Investigation Started*`,
            `*DAG:* ${dagName}`,
            `*Task:* ${taskName}`,
            `*Alerts:* ${count} in window (threshold reached)`,
        ];
        if (permalink) {
            lines.push(`*Slack thread:* ${permalink}`);
        }

        try {
            await this.app.client.chat.postMessage({
                channel: ownerId,
                text: lines.join('\n'),
            });
            this.logger.info(`Owner notified: delay alert for ${dagName}`);
        } catch (err) {
            this.logger.error(`Failed to notify owner of delay alert ${dagName}: ${err.message}`);
        }
    }

    _setupListeners() {
        const mode = this.config.appMode || 'all';

        this.app.event('app_mention', async ({ event, say }) => {
            try {
                // Dedup: both app_mention and message events fire for the same @mention
                if (!this._handledMentionTs) this._handledMentionTs = new Set();
                if (this._handledMentionTs.has(event.ts)) return;
                this._handledMentionTs.add(event.ts);

                // cloud mode: only handle mentions in monitored channels (alert threads)
                // local mode: only handle mentions in non-monitored channels (main chat)
                // This prevents duplicate responses when both instances receive the same event
                if (mode === 'cloud' || mode === 'local') {
                    const channelId = event.channel;
                    const isMonitorChannel = this.alertMonitor.isMonitoredChannel(channelId) || this.delayAlertMonitor.isMonitoredChannel(channelId);
                    if (mode === 'cloud' && !isMonitorChannel) {
                        this.logger.info(`App mode=cloud: ignoring mention in non-monitor channel ${channelId}`);
                        return;
                    }
                    if (mode === 'local' && isMonitorChannel) {
                        this.logger.info(`App mode=local: ignoring mention in monitor channel ${channelId}`);
                        return;
                    }
                }
                await this._handleMention(event, say);
            } catch (err) {
                if (err.message && (err.message.includes('no active connection') || err.message.includes('client is not ready'))) {
                    this.logger.warn(`Mention handler failed (disconnected): ${err.message}`);
                } else {
                    throw err;
                }
            }
        });

        // Monitor channels + delay alerts: enabled in 'cloud' and 'all' modes
        if (mode !== 'local') {
            this.app.event('message', async ({ event, say }) => {
                try {
                    // Handle @mentions that arrive as 'message' instead of 'app_mention'
                    // (happens when multiple Socket Mode connections exist, or with Assistants API)
                    if (!event.subtype && event.text && event.text.includes(`<@`) && !event.bot_id) {
                        // Resolve bot user ID lazily
                        if (!this._botUserId) {
                            try {
                                this._botUserId = (await this.app.client.auth.test()).user_id;
                            } catch { /* ignore */ }
                        }
                        if (this._botUserId && event.text.includes(`<@${this._botUserId}>`)) {
                            // Dedup: skip if app_mention already handled this event
                            if (!this._handledMentionTs) this._handledMentionTs = new Set();
                            if (this._handledMentionTs.has(event.ts)) return;
                            this._handledMentionTs.add(event.ts);
                            // Prevent unbounded growth
                            if (this._handledMentionTs.size > 200) {
                                const arr = [...this._handledMentionTs];
                                this._handledMentionTs = new Set(arr.slice(-100));
                            }
                            this.logger.info(`Message-as-mention fallback for ts=${event.ts}`);
                            await this._handleMention(event, say);
                            return;
                        }
                    }
                    await this._handleMonitoredMessage(event);
                    await this._handleDelayAlertMessage(event);
                } catch (err) {
                    if (err.message && (err.message.includes('no active connection') || err.message.includes('client is not ready'))) {
                        this.logger.warn(`Message handler failed (disconnected): ${err.message}`);
                    } else {
                        throw err;
                    }
                }
            });
        } else {
            this.logger.info('App mode=local: monitor channels and delay alerts disabled');
        }
    }

    async _handleMonitoredMessage(event) {
        // Filter out message edits and subtypes (joins, topic changes, etc.)
        if (event.subtype) return;

        // Skip thread replies — PD sends status updates as thread replies
        if (event.thread_ts && event.thread_ts !== event.ts) return;

        const channelId = event.channel;
        if (!this.alertMonitor.isMonitoredChannel(channelId)) return;

        // Detect PagerDuty messages
        if (!this.alertMonitor.isPagerDutyMessage(event)) return;

        // Skip status notifications (Acknowledged, Resolved)
        if (this.alertMonitor.isStatusNotification(event)) {
            this.logger.info(`Skipping PD status notification in ${channelId}: ${(event.text || '').substring(0, 80)}`);
            return;
        }

        const messageTs = event.ts;
        const text = event.text || '';
        const incidentId = this.alertMonitor.extractIncidentId(event);

        this.logger.info(`PagerDuty alert detected in ${channelId}: incident=${incidentId || 'unknown'} ts=${messageTs}`);

        // Dedup by incident ID
        if (incidentId && this.trackedIncidents.has(incidentId)) {
            this.logger.info(`Skipping duplicate incident ${incidentId}`);
            return;
        }

        // Dedup by session key (already being investigated in this thread)
        const sessionKey = `${channelId}-${messageTs}`;
        if (this._getSession(sessionKey)) {
            this.logger.info(`Skipping: session already exists for ${sessionKey}`);
            return;
        }

        if (incidentId) this.trackedIncidents.set(incidentId, { channelId, messageTs });

        // PD acknowledge
        if (incidentId && this.config.pagerdutyApiToken) {
            const pdResult = await this._acknowledgePagerDuty(incidentId);
            if (pdResult?.skipped) {
                this.logger.info(`PD incident ${incidentId} already ${pdResult.status} — skipping`);
                if (incidentId) this.trackedIncidents.delete(incidentId);
                return;
            }
        }

        // React with eyes
        await this._addReaction(channelId, messageTs, 'eyes');

        // Download attached images
        const imagePaths = await this._downloadSlackImages(event.files, `alert-${messageTs.replace('.', '')}`);
        const imageInstruction = imagePaths.length > 0
            ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
            : '';

        // Build prompt — use "execute skill" so Claude invokes the skill directly
        const permalink = await this._getPermalink(channelId, messageTs);
        const alertSkill = this.config.alertSkill;
        let prompt;
        if (alertSkill && permalink) {
            prompt = `execute ${alertSkill} skill with argument ${permalink}${imageInstruction}`;
        } else if (alertSkill) {
            prompt = `execute ${alertSkill} skill with argument Alert: ${text.substring(0, 500)}${imageInstruction}`;
        } else if (permalink) {
            prompt = `Investigate this PagerDuty alert: ${permalink}${imageInstruction}`;
        } else {
            prompt = `Investigate this PagerDuty alert: ${text.substring(0, 500)}${imageInstruction}`;
        }

        // Use the regular command flow — messageTs as threadTs (replies go in alert thread)
        await this._processCommand(channelId, messageTs, prompt, null, messageTs, messageTs);
    }

    async _handleDelayAlertMessage(event) {
        // Allow bot_message (Airflow-Bot posts via integration), filter edits/deletes/etc.
        if (event.subtype && event.subtype !== 'bot_message') return;

        const channelId = event.channel;
        if (!this.delayAlertMonitor.isMonitoredChannel(channelId)) return;

        // Detect Airflow delay alerts
        if (!this.delayAlertMonitor.isAirflowDelayAlert(event)) {
            this.logger.debug(`Delay monitor: message in monitored channel not an Airflow alert, skipping ts=${event.ts}`);
            return;
        }

        const alertInfo = this.delayAlertMonitor.extractAlertInfo(event);
        if (!alertInfo) {
            this.logger.warn(`Delay monitor: detected Airflow alert but failed to extract task/dag, ts=${event.ts}`);
            return;
        }

        // Check task pattern match
        if (!this.delayAlertMonitor.matchesTaskPattern(alertInfo.task)) return;

        const messageTs = event.ts;

        // Increment counter (persisted to SQLite) — incrementCounter logs the N/threshold progress
        const { count, triggered } = this.delayAlertMonitor.incrementCounter(alertInfo.dag, channelId, messageTs);

        if (!triggered) {
            this.logger.info(`Delay alert ${count}/${this.delayAlertMonitor.threshold}: dag=${alertInfo.dag} task=${alertInfo.task} — waiting for more`);
            return;
        }

        // Threshold reached — trigger investigation
        this.logger.info(`Delay alert ${count}/${this.delayAlertMonitor.threshold}: dag=${alertInfo.dag} task=${alertInfo.task} — threshold reached, starting investigation`);

        // Dedup: check if we already have a session for this message
        const sessionKey = `${channelId}-${messageTs}`;
        if (this._getSession(sessionKey)) {
            this.logger.info(`Skipping: session already exists for ${sessionKey}`);
            return;
        }

        // React with eyes on the triggering message
        await this._addReaction(channelId, messageTs, 'eyes');

        // Download attached images (if any — Airflow alerts are usually text-only)
        const imagePaths = await this._downloadSlackImages(event.files, `delay-alert-${messageTs.replace('.', '')}`);
        const imageInstruction = imagePaths.length > 0
            ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
            : '';

        // Build prompt — use "execute skill" so Claude invokes the skill directly
        const text = event.text || '';
        const permalink = await this._getPermalink(channelId, messageTs);
        const skill = this.delayAlertMonitor.skill;
        let prompt;
        if (skill && permalink) {
            prompt = `execute ${skill} skill with argument ${permalink}${imageInstruction}`;
        } else if (skill) {
            prompt = `execute ${skill} skill with argument Alert: ${text.substring(0, 500)}${imageInstruction}`;
        } else if (permalink) {
            prompt = `Investigate this Airflow delay alert: ${permalink}${imageInstruction}`;
        } else {
            prompt = `Investigate this Airflow delay alert: ${text.substring(0, 500)}${imageInstruction}`;
        }

        // Reset counter after triggering (so it can accumulate again)
        this.delayAlertMonitor.resetCounter(alertInfo.dag);

        // DM owner that investigation is starting
        this._notifyOwnerDelayAlert(alertInfo.dag, alertInfo.task, count, { permalink }).catch(err =>
            this.logger.error(`Failed to notify owner of delay alert: ${err.message}`)
        );

        // Use the regular command flow — messageTs as threadTs
        await this._processCommand(channelId, messageTs, prompt, null, messageTs, messageTs);
    }

    async _getPermalink(channelId, messageTs) {
        try {
            const result = await this.app.client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
            return result.permalink;
        } catch (error) {
            this.logger.error(`Failed to get permalink: ${error.message}`);
            return null;
        }
    }

    async _handleMention(event, say) {
        const userId = event.user;
        const channelId = event.channel;
        const threadTs = event.thread_ts || event.ts;
        const rawText = event.text || '';

        this.logger.info(`Mention received | user=${userId} channel=${channelId} thread=${threadTs} text="${rawText.substring(0, 100)}"`);

        if (!this._isOwner(userId) && !this.alertMonitor.isMonitoredChannel(channelId)) {
            await say({ text: `Sorry, I can only respond to my owner to save Claude's API tokens. 🙏`, thread_ts: threadTs });
            return;
        }

        let text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

        // Download any attached images and append file paths to the message
        const imagePaths = await this._downloadSlackImages(event.files, `slack-${channelId}-${threadTs.replace('.', '')}`);
        if (imagePaths.length > 0) {
            const imageRef = `\nAttached images (read these files for visual context): ${imagePaths.join(' ')}`;
            text = text ? text + imageRef : `Please analyze these images: ${imagePaths.join(' ')}`;
        }

        if (!text) {
            await say({ text: 'Please provide a message after mentioning me.', thread_ts: threadTs });
            return;
        }

        await this._processCommand(channelId, threadTs, text, say, event.ts, null, userId);
    }

    // ─── Command Processing ──────────────────────────────────────────

    async _processCommand(channelId, threadTs, command, say, messageTs, alertMessageTs = null, userId = null) {
        // Create a say function if one wasn't provided (e.g. alert triggers)
        if (!say) {
            say = async (msg) => {
                await this.app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, ...msg });
            };
        }
        const sessionKey = `${channelId}-${threadTs}`;
        let session = this._getSession(sessionKey);
        let threadContext = null; // Will hold formatted thread messages to prepend

        // Guard: slash commands on dead/missing sessions
        const isLiveSession = session && this._isTmuxSessionAlive(session.sessionName);
        if (command.startsWith('/') && !isLiveSession && !(command === '/exit' && session)) {
            const cmd = command.split(/\s/)[0];
            await say({ text: `Session expired. \`${cmd}\` requires an active session — send a message first to start a new one, then use \`${cmd}\`.`, thread_ts: threadTs });
            return;
        }

        try {
            if (session && this._isTmuxSessionAlive(session.sessionName)) {
                // Tmux alive — Claude already has full context, just inject the raw command
                this._touchSession(sessionKey);
                if (userId) this._updateLastUserId(sessionKey, userId);
                this._clearSessionTimeout(sessionKey); // User sent a message — bot is now processing, don't timeout while user waits
                // No thread context needed — Claude is already in the conversation
                this.logger.info(`Existing live session ${session.sessionName}, injecting command directly`);
            } else if (session && !this._isTmuxSessionAlive(session.sessionName)) {
                // Session in DB but tmux died — recreate with original repo path
                this.logger.warn(`Tmux session ${session.sessionName} is dead, recreating in ${session.repoPath}...`);
                await say({ text: `Resuming Claude session in \`${session.repoPath}\`... :rocket:`, thread_ts: threadTs });

                const created = await this._createTmuxSession(
                    session.sessionName,
                    session.repoPath,
                    this.config.claudeCommand || 'claude --dangerously-skip-permissions',
                    sessionKey
                );
                if (!created) {
                    await say({ text: 'Failed to create Claude session. Is tmux installed?', thread_ts: threadTs });
                    this._deleteSession(sessionKey);
                    return;
                }
                this._touchSession(sessionKey);
                // Reset claude_session_id so the new session's SessionStart hook can register.
                // Without this, COALESCE preserves the dead session's ID and the Stop hook
                // rejects the new session as a "subagent".
                this._stmts.updateClaudeSessionId.run(null, Date.now(), sessionKey);
                if (userId) this._updateLastUserId(sessionKey, userId);

                // Fetch thread context — summarize with Gemini if long
                const allMessages = await this._fetchThreadMessages(channelId, threadTs);
                if (allMessages.length > 10) {
                    threadContext = await this._summarizeThreadContext(allMessages);
                    this.logger.info(`Summarized thread context (recreated session): ${allMessages.length} messages`);
                } else if (allMessages.length > 0) {
                    threadContext = await this._formatThreadContext(allMessages);
                    this.logger.info(`Full thread context (recreated session): ${allMessages.length} messages`);
                }
            } else {
                // Brand new conversation
                const sessionName = this._generateSessionName(channelId, threadTs);
                const claudeCmd = this.config.claudeCommand || 'claude --dangerously-skip-permissions';

                // Resolve repo path — check for project name patterns
                // Supported: "start [claude] from root" (uses SLACK_REPO_ROOT directly),
                //            "project XXX from root", "start [claude] from XXX project",
                //            "start [claude] from XXX", "start [claude] in XXX project", etc.
                let repoPath = this.config.repoPath || process.cwd();
                const rootMatch = command.match(/start\s+(?:claude\s+)?(?:from|in)\s+root\s*$/i);
                const projectMatch = !rootMatch && (
                    command.match(
                        /(?:start\s+(?:claude\s+)?(?:from|in)\s+)?project\s+(\S+)(?:\s+from\s+root)?/i
                    ) || command.match(
                        /start\s+(?:claude\s+)?(?:from|in)\s+(\S+?)(?:\s+project)?\s*$/i
                    )
                );
                if (rootMatch) {
                    if (this.config.repoRoot) {
                        repoPath = this.config.repoRoot;
                        command = command.replace(/start\s+(?:claude\s+)?(?:from|in)\s+root\s*$/i, '').trim();
                        this.logger.info(`Using repo root: ${repoPath}`);
                    } else {
                        await say({ text: '`SLACK_REPO_ROOT` is not configured. Set it in `.env`.', thread_ts: threadTs });
                        return;
                    }
                } else if (projectMatch && this.config.repoRoot) {
                    const projectName = projectMatch[1];
                    const candidatePath = path.join(this.config.repoRoot, projectName);
                    if (fs.existsSync(candidatePath)) {
                        repoPath = candidatePath;
                        // Strip the project resolution part so Claude gets a clean prompt
                        command = command
                            .replace(/(?:start\s+(?:claude\s+)?(?:from|in)\s+)?project\s+\S+(?:\s+from\s+root)?[,.]?\s*/i, '')
                            .replace(/start\s+(?:claude\s+)?(?:from|in)\s+\S+?(?:\s+project)?\s*$/i, '')
                            .trim();
                        this.logger.info(`Resolved project "${projectName}" to ${repoPath}`);
                    } else {
                        await say({ text: `Project folder not found: \`${candidatePath}\``, thread_ts: threadTs });
                        return;
                    }
                } else if (projectMatch && !this.config.repoRoot) {
                    await say({ text: '`SLACK_REPO_ROOT` is not configured. Set it in `.env` to use project switching.', thread_ts: threadTs });
                    return;
                }

                // If no project detected from command, check if this is a thread continuation
                // and use Gemini to detect the project from thread history
                let prefetchedMessages = null;
                if (!rootMatch && !projectMatch && this.config.repoRoot) {
                    prefetchedMessages = await this._fetchThreadMessages(channelId, threadTs);
                    if (prefetchedMessages.length > 1) {
                        const detectedPath = await this._detectProjectFromThread(prefetchedMessages);
                        if (detectedPath && fs.existsSync(detectedPath)) {
                            repoPath = detectedPath;
                            this.logger.info(`Gemini detected project path: ${repoPath}`);
                        }
                    }
                }

                // If command was fully consumed by project pattern, default to "hi"
                if (!command) {
                    command = 'hi';
                }

                if (!alertMessageTs) {
                    await say({ text: `Starting Claude session in \`${repoPath}\`... :rocket:`, thread_ts: threadTs });
                }

                const created = await this._createTmuxSession(sessionName, repoPath, claudeCmd, sessionKey);
                if (!created) {
                    if (alertMessageTs) {
                        await this._removeReaction(channelId, alertMessageTs, 'eyes');
                        await this._addReaction(channelId, alertMessageTs, 'x');
                    } else {
                        await say({ text: 'Failed to create Claude session. Is tmux installed?', thread_ts: threadTs });
                    }
                    return;
                }

                session = {
                    sessionName,
                    channelId,
                    threadTs,
                    repoPath,
                    createdAt: Date.now(),
                    alertMessageTs: alertMessageTs || null
                };
                this._saveSession(session);
                if (userId) this._updateLastUserId(`${channelId}-${threadTs}`, userId);

                // Fetch thread context — summarize with Gemini if this is a continuation
                const allMessages = prefetchedMessages || await this._fetchThreadMessages(channelId, threadTs);
                if (allMessages.length > 10) {
                    threadContext = await this._summarizeThreadContext(allMessages);
                    this.logger.info(`Summarized thread context (new session): ${allMessages.length} messages`);
                } else if (allMessages.length > 0) {
                    threadContext = await this._formatThreadContext(allMessages);
                    this.logger.info(`Full thread context (new session): ${allMessages.length} messages`);
                }

                this.logger.info(`New session created: ${sessionName} for channel ${channelId}`);
                // Don't start timeout yet — bot is processing the first command. Timeout starts when bot responds.
            }

            // Handle /exit — clean up session
            if (command === '/exit') {
                if (this._isTmuxSessionAlive(session.sessionName)) {
                    try {
                        await this._injectCommand(session.sessionName, command);
                    } catch {
                        // Expected — /exit kills the session before Enter-retry finishes
                    }
                }
                this._deleteSession(sessionKey);
                this._clearSessionTimeout(sessionKey);
                const pollKey = session.sessionName;
                if (this.pollers.has(pollKey)) {
                    clearInterval(this.pollers.get(pollKey).interval);
                    this.pollers.delete(pollKey);
                }
                // Swap alert reactions if this was an alert session
                if (session.alertMessageTs) {
                    await this._removeReaction(channelId, session.alertMessageTs, 'eyes');
                    await this._addReaction(channelId, session.alertMessageTs, 'white_check_mark');
                }
                await this.app.client.reactions.add({
                    channel: channelId,
                    timestamp: messageTs,
                    name: 'white_check_mark',
                });
                return;
            }

            // Build the full command with thread context if available
            let fullCommand = command;
            if (threadContext) {
                fullCommand = `Here is the Slack thread discussion for context:\n\n---\n${threadContext}\n---\n\nMy request: ${command}`;
            }

            // Inject the command into the tmux session
            try {
                await this._injectCommand(session.sessionName, fullCommand);
            } catch (injectError) {
                this.logger.error(`Injection failed for ${session.sessionName}: ${injectError.message}`);
                if (session.alertMessageTs) {
                    await this._removeReaction(channelId, session.alertMessageTs, 'eyes');
                    await this._addReaction(channelId, session.alertMessageTs, 'x');
                }
                await say({ text: `:warning: ${injectError.message}. Try sending your message again.`, thread_ts: threadTs });
                // Restart session timeout so it gets cleaned up
                this._startSessionTimeout(sessionKey);
                return;
            }
            this.logger.info(`Command injected into ${session.sessionName}: ${fullCommand.substring(0, 120)}`);

            // Commands like /compact don't produce a standard response — just confirm
            // Skip confirmation for alert sessions (eyes reaction is sufficient)
            if (command.startsWith('/') && !session.alertMessageTs) {
                // Parse skill name and argument for a cleaner confirmation
                const slashMatch = command.match(/^\/(\S+)\s+(.*)/s);
                if (slashMatch) {
                    const skillName = slashMatch[1];
                    const argument = slashMatch[2].trim();
                    await say({ text: `Execute skill \`${skillName}\` with argument \`${argument}\``, thread_ts: threadTs });
                } else {
                    await say({ text: `Sent \`${command}\` to Claude session.`, thread_ts: threadTs });
                }
            }

            // Regular sessions: response posting is handled by claude-hook-notify.js (Stop hook)
            // which reads the transcript for clean markdown output.
            // Alert sessions: also start the poller for stall detection + nudge logic.
            // The hook handles final posting, but the poller nudges Claude if it stalls
            // mid-investigation (sits at prompt without completing the report).
            if (session.alertMessageTs) {
                this._pollForResponse(session, say, sessionKey);
            }

        } catch (error) {
            this.logger.error('Error processing command:', error.message);
            await say({ text: `Error: ${error.message}`, thread_ts: threadTs });
        }
    }

    // ─── Tmux Management ─────────────────────────────────────────────

    _generateSessionName(channelId, threadTs) {
        const suffix = threadTs.replace('.', '').slice(-12);
        return `slack-${channelId.slice(-4)}-${suffix}`;
    }

    _ensureTmuxServer() {
        try {
            execSync('tmux list-sessions 2>/dev/null', { stdio: 'ignore' });
        } catch {
            // No server running — start one with a detached keepalive session
            try {
                execSync('tmux new-session -d -s _keepalive', { stdio: 'ignore' });
                this.logger.info('Started tmux server (no existing server found)');
            } catch (e) {
                this.logger.warn(`Failed to start tmux server: ${e.message}`);
            }
        }
    }

    async _createTmuxSession(sessionName, repoPath, claudeCmd, sessionKey = null) {
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
            const cmd = buildTmuxCommand(sessionName, repoPath, claudeCmd, sessionKey);
            this.logger.info(`Creating tmux session: ${cmd}`);

            exec(cmd, (error) => {
                if (error) {
                    this.logger.error(`Failed to create tmux session: ${error.message}`);
                    resolve(false);
                    return;
                }
                // Poll for Claude Code readiness instead of hardcoded wait
                const maxWaitMs = 30000;
                const pollIntervalMs = 1000;
                let elapsed = 0;
                const poll = () => {
                    elapsed += pollIntervalMs;
                    try {
                        const output = execSync(`tmux capture-pane -t ${sessionName} -p -S -50`, {
                            encoding: 'utf8',
                            stdio: ['ignore', 'pipe', 'ignore']
                        });
                        // Claude Code shows ) or ❯ or > as input prompt when ready
                        if (/^[)❯>]\s*$/m.test(output)) {
                            this.logger.info(`Claude Code ready after ${elapsed}ms`);
                            resolve(true);
                            return;
                        }
                    } catch {
                        // capture failed, keep polling
                    }
                    if (elapsed >= maxWaitMs) {
                        this.logger.warn(`Claude Code readiness timeout after ${maxWaitMs}ms, proceeding anyway`);
                        resolve(true);
                        return;
                    }
                    setTimeout(poll, pollIntervalMs);
                };
                // Initial delay before first poll
                setTimeout(poll, pollIntervalMs);
            });
        });
    }

    async _injectCommand(sessionName, command) {
        const os = require('os');
        const tmpFile = path.join(os.tmpdir(), `claude-inject-${sessionName}-${Date.now()}.txt`);
        try {
            // Write command to temp file to avoid shell argument length limits
            fs.writeFileSync(tmpFile, command);

            // Paste with verification — Claude Code renders ❯ before its TUI input handler
            // finishes initializing. If we paste during that window, tcsetattr(TCSAFLUSH)
            // flushes the pty buffer and our paste is silently lost. Retry until it lands.
            const pasteMaxAttempts = 5;
            let pasteLanded = false;
            for (let attempt = 0; attempt < pasteMaxAttempts; attempt++) {
                // Clear current input
                execSync(`tmux send-keys -t ${sessionName} C-u`);
                await new Promise(r => setTimeout(r, 200));

                // Load text into tmux paste buffer and paste it
                execSync(`tmux load-buffer ${tmpFile}`);
                execSync(`tmux paste-buffer -t ${sessionName}`);

                // Wait for Claude Code to process the bracketed paste
                const baseDelay = 1000;
                const perLineDelay = Math.min(command.split('\n').length * 100, 3000);
                await new Promise(r => setTimeout(r, baseDelay + perLineDelay));

                // Verify paste appeared in the pane — check multiple indicators:
                // 1. Claude shows "[Pasted text" banner for multi-line pastes
                // 2. The first line of the command appears in the visible pane
                // 3. Claude already started working (paste + auto-submit succeeded)
                const output = this._captureOutput(sessionName);
                const firstLine = command.split('\n')[0].substring(0, 40);
                const workingIndicators = ['brewing', 'thinking', 'working', 'clauding',
                    'flibbertigibbeting', 'esc to interrupt', '● skill(', 'crunching'];
                const outputLower = output.toLowerCase();
                const isAlreadyWorking = workingIndicators.some(ind => outputLower.includes(ind));
                if (output.includes('Pasted text') || output.includes(firstLine) || isAlreadyWorking) {
                    if (attempt > 0) {
                        this.logger.info(`Paste landed on attempt ${attempt + 1} for ${sessionName}${isAlreadyWorking ? ' (already working)' : ''}`);
                    }
                    pasteLanded = true;
                    break;
                }
                this.logger.warn(`Paste not detected (attempt ${attempt + 1}/${pasteMaxAttempts}), retrying for ${sessionName}`);
                // Increasing backoff — give TUI more time to finish initialization
                await new Promise(r => setTimeout(r, 1000 + attempt * 500));
            }

            if (!pasteLanded) {
                throw new Error(`Paste failed after ${pasteMaxAttempts} attempts — Claude may not be ready`);
            }

            // Send Enter and verify Claude started processing.
            const workingIndicators = ['brewing', 'thinking', 'working', 'clauding',
                'flibbertigibbeting', 'esc to interrupt', '● skill(', 'crunching'];
            const maxAttempts = 5;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                execSync(`tmux send-keys -t ${sessionName} Enter`);
                // Longer wait on later attempts — give Claude Code more time to process
                const waitMs = 1500 + attempt * 1000;
                await new Promise(r => setTimeout(r, waitMs));

                const output = this._captureOutput(sessionName);
                const isWorking = workingIndicators.some(ind => output.toLowerCase().includes(ind));
                // Also check if Claude already finished (prompt visible again) — means it
                // processed the command very quickly (e.g. "hi") before we could detect working state
                const hasPrompt = /^[)❯>]\s*$/m.test(output);
                if (isWorking) {
                    if (attempt > 0) {
                        this.logger.info(`Enter accepted on attempt ${attempt + 1} for ${sessionName}`);
                    }
                    return;
                }
                if (hasPrompt && attempt >= 1) {
                    // Prompt visible after at least 2 Enter attempts — Claude likely processed
                    // the command quickly and is waiting for the next one. The Stop hook
                    // already fired (or will fire), so don't keep retrying.
                    this.logger.info(`Prompt visible after Enter attempt ${attempt + 1} — Claude likely already responded for ${sessionName}`);
                    return;
                }
                this.logger.warn(`Enter not confirmed (attempt ${attempt + 1}/${maxAttempts}), retrying for ${sessionName}`);
            }
            // After all retries, check one final time — if Claude shows prompt, it processed the command
            const finalOutput = this._captureOutput(sessionName);
            const finalHasPrompt = /^[)❯>]\s*$/m.test(finalOutput);
            if (finalHasPrompt) {
                this.logger.info(`Prompt visible after all Enter attempts — Claude likely already responded for ${sessionName}`);
                return;
            }
            this.logger.error(`Enter may not have been accepted after ${maxAttempts} attempts for ${sessionName}`);
        } finally {
            // Clean up temp file
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    }

    _captureOutput(sessionName) {
        try {
            return execSync(`tmux capture-pane -t ${sessionName} -p -S -200`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
        } catch {
            return '';
        }
    }

    // ─── Response Polling ────────────────────────────────────────────

    _pollForResponse(session, say, sessionKey = null) {
        const { sessionName, threadTs } = session;
        const pollKey = sessionName;
        const isAlertSession = !!session.alertMessageTs;
        let isFirstResponse = isAlertSession; // only true for the very first response of an alert
        let alertBuffer = '';
        let alertAccumulationCount = 0;
        let alertStallCount = 0;   // consecutive cycles where Claude is idle with no new output
        let alertNudgeCount = 0;   // how many nudges we've sent (cap at 2)
        const ALERT_STALL_THRESHOLD = 3; // stall cycles before nudging (~30s with 8s stable threshold)
        const ALERT_MAX_NUDGES = 2;
        const alertStableThreshold = 8; // 8s stability for alert first response (vs 3s regular)

        if (this.pollers.has(pollKey)) {
            clearInterval(this.pollers.get(pollKey).interval);
        }

        let baselineOutput = this._captureOutput(sessionName);
        let lastOutput = baselineOutput;
        let stableCount = 0;
        let attempts = 0;
        let processing = false;
        const maxAttempts = Math.ceil((this.config.pollerTimeoutMs || 1800000) / 1000); // default 30 min
        const stableThreshold = 3;

        const interval = setInterval(async () => {
            if (processing) return;

            // Stop if tmux session died
            if (!this._isTmuxSessionAlive(sessionName)) {
                clearInterval(interval);
                this.pollers.delete(pollKey);
                // Don't post here — the Stop hook handles alert posting from the clean transcript.
                if (alertBuffer) {
                    this.logger.info(`Alert buffer discarded (${alertBuffer.length} chars) on tmux death for ${sessionName} — hook will post`);
                }
                this.logger.info(`Poller stopped: tmux session ${sessionName} is dead`);
                return;
            }

            attempts++;

            if (attempts > maxAttempts) {
                clearInterval(interval);
                this.pollers.delete(pollKey);
                this.logger.warn(`Poller timeout after ${maxAttempts}s for ${sessionName} (alert=${isAlertSession})`);
                try {
                    if (alertBuffer) {
                        // Don't post here — the Stop hook handles alert posting from the clean transcript.
                        this.logger.info(`Alert buffer discarded (${alertBuffer.length} chars) on timeout for ${sessionName} — hook will post`);
                    } else if (!isAlertSession) {
                        await say({ text: 'Claude session timed out. Send another message to continue.', thread_ts: threadTs });
                    }
                } catch (err) {
                    this.logger.error(`Failed to send timeout/flush message: ${err.message}`);
                }
                // Kill unresponsive tmux — will be recreated on next user message
                try {
                    execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`);
                    this.logger.info(`Killed tmux session ${sessionName} after poller timeout`);
                } catch (_) { /* already dead */ }
                if (sessionKey) {
                    this._clearSessionTimeout(sessionKey);
                    const sess = this._getSession(sessionKey);
                    if (sess?.alertMessageTs) {
                        await this._removeReaction(sess.channelId, sess.alertMessageTs, 'eyes').catch(() => {});
                        await this._addReaction(sess.channelId, sess.alertMessageTs, 'white_check_mark').catch(() => {});
                    }
                }
                return;
            }

            const currentOutput = this._captureOutput(sessionName);

            if (currentOutput === lastOutput) {
                stableCount++;
            } else {
                stableCount = 0;
                lastOutput = currentOutput;
            }

            if (stableCount >= (isAlertSession && isFirstResponse ? alertStableThreshold : stableThreshold)) {
                const lines = currentOutput.trimEnd().split('\n');

                // Check last 10 lines for a bare prompt (❯ or >)
                // The prompt line may not be last due to Claude CLI status bar
                const tailLines = lines.slice(-10);
                const hasPrompt = tailLines.some(l => {
                    const trimmed = l.trim();
                    return trimmed === '❯' || trimmed === '>' ||
                           trimmed.match(/^[>❯]\s*$/) ||
                           trimmed.includes('│ >') || trimmed.includes('│ ❯');
                });

                // Only check tail lines for working indicators — old history
                // in the 200-line tmux buffer would cause false positives.
                // Case-insensitive: OMC status bar uses lowercase ("thinking")
                // while Claude Code native UI uses capitalized ("Thinking").
                // IMPORTANT: Exclude OMC status bar lines (contain "[OMC#") from
                // isWorking check — the status bar can show stale "thinking" even
                // when Claude is idle at the prompt, which blocks stall detection.
                const nonStatusLines = tailLines.filter(l => !l.includes('[OMC#'));
                const tailText = nonStatusLines.join(' ').toLowerCase();
                const isWorking =
                    tailText.includes('clauding') ||
                    tailText.includes('working') ||
                    tailText.includes('processing') ||
                    tailText.includes('⏳') ||
                    tailText.includes('thinking') ||
                    tailText.includes('crunching');

                if (attempts % 10 === 0) {
                    const lastFiveLines = lines.slice(-5).map(l => l.trim()).join(' | ');
                    this.logger.info(`Poll #${attempts} | stable=${stableCount} hasPrompt=${hasPrompt} isWorking=${isWorking} | last5: ${lastFiveLines}`);
                }

                if (isAlertSession && isWorking && attempts % 30 === 0) {
                    this.logger.info(`Alert poll #${attempts} | Claude still working in ${sessionName}`);
                }

                if (hasPrompt && !isWorking) {
                    // Skip extraction if output hasn't changed since last baseline reset
                    if (baselineOutput === currentOutput) {
                        // Stall detection: Claude is idle at prompt with no new output.
                        // If an alert investigation is in progress but incomplete, nudge Claude to continue.
                        if (isAlertSession && isFirstResponse && alertBuffer && alertNudgeCount < ALERT_MAX_NUDGES) {
                            alertStallCount++;
                            if (alertStallCount >= ALERT_STALL_THRESHOLD) {
                                alertStallCount = 0;
                                alertNudgeCount++;
                                this.logger.info(`Alert stall detected for ${sessionName} — sending nudge ${alertNudgeCount}/${ALERT_MAX_NUDGES}`);
                                try {
                                    const nudge = alertNudgeCount === 1
                                        ? 'You stopped before completing the investigation. Continue with the remaining steps and provide your final report including the "## Recommended Action" section.'
                                        : 'Please finish the investigation now. Output your final report with a "## Recommended Action" section summarizing what happened and what to do.';
                                    await this._injectCommand(sessionName, nudge);
                                    // Reset baseline so the poller picks up the new output
                                    baselineOutput = this._captureOutput(sessionName);
                                    lastOutput = baselineOutput;
                                } catch (err) {
                                    this.logger.error(`Failed to nudge alert session ${sessionName}: ${err.message}`);
                                }
                            }
                        }
                        stableCount = 0;
                        return;
                    }

                    // Reset stall counter when we get new output
                    alertStallCount = 0;

                    const response = this._extractResponse(baselineOutput, currentOutput);

                    if (!response && isAlertSession) {
                        this.logger.warn(`Alert extraction returned empty for ${sessionName} (baseline=${baselineOutput.length} chars, current=${currentOutput.length} chars)`);
                    }

                    if (response) {
                        // Alert first response: accumulate until completion marker or fallback
                        if (isAlertSession && isFirstResponse) {
                            alertBuffer += (alertBuffer ? '\n' : '') + response;
                            alertAccumulationCount++;

                            // Use stricter marker detection to avoid matching intermediate narration
                            // (e.g. "Recommended Action: Investigation directory created...").
                            // Real reports use markdown headings (## Recommended Action) or bold (**Recommended Action:**)
                            // and are substantially longer than one-line status messages.
                            const MIN_ALERT_BUFFER_LEN = 500;
                            const hasCompletionMarker = alertBuffer.length >= MIN_ALERT_BUFFER_LEN
                                && /(?:^|\n)(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:/im.test(alertBuffer);

                            if (hasCompletionMarker || alertAccumulationCount >= 5) {
                                // Completion detected — stop poller. Posting is handled by
                                // claude-hook-notify.js (Stop hook) which reads the clean transcript.
                                const reason = hasCompletionMarker ? 'completion marker found' : `fallback after ${alertAccumulationCount} cycles`;
                                this.logger.info(`Alert poller done (${reason}): ${alertBuffer.length} chars for ${sessionName} — hook will post`);
                                clearInterval(interval);
                                this.pollers.delete(pollKey);
                                return;
                            } else {
                                this.logger.info(`Alert accumulating cycle ${alertAccumulationCount} (${alertBuffer.length} chars) for ${sessionName}, waiting for completion marker`);
                            }

                            // Always reset baseline so next diff is incremental
                            baselineOutput = currentOutput;
                            lastOutput = currentOutput;
                            stableCount = 0;
                            attempts = 0;
                            return;
                        }

                        // Regular session or subsequent alert responses
                        processing = true;
                        try {
                            const sessionStats = this._extractSessionStats(currentOutput);
                            this.logger.info(`Response extracted (${response.length} chars): "${response.substring(0, 200)}"`);

                            await this._sendResponse(say, threadTs, response, sessionStats);
                            this.logger.info(`Response sent to Slack thread ${threadTs}`);

                            // Track last bot response timestamp for thread context
                            if (sessionKey) {
                                const nowTs = String(Date.now() / 1000);
                                this._updateLastBotTs(sessionKey, nowTs);
                                this._startSessionTimeout(sessionKey);
                            }
                        } catch (err) {
                            this.logger.error(`Failed to send response to Slack: ${err.message}`);
                        } finally {
                            processing = false;
                        }
                    }

                    // Reset baseline and continue polling for local terminal input
                    baselineOutput = currentOutput;
                    lastOutput = currentOutput;
                    stableCount = 0;
                    attempts = 0;
                    return;
                }

                if (currentOutput.includes('Do you want to proceed?') ||
                    currentOutput.includes('(y/n)') ||
                    currentOutput.includes('1. Yes')) {
                    this._autoApprove(sessionName, currentOutput);
                    stableCount = 0;
                }
            }
        }, 1000);

        this.pollers.set(pollKey, { interval, session });
    }

    _startSessionTimeout(sessionKey) {
        // Clear any existing timer
        if (this.sessionTimers.has(sessionKey)) {
            clearTimeout(this.sessionTimers.get(sessionKey));
        }

        const session = this._getSession(sessionKey);
        const isAlert = !!session?.alertMessageTs;
        const defaultTimeout = isAlert ? (this.config.pollerTimeoutMs || 1800000) : 300000; // 30min for alerts (matches poller), 5min for regular
        const configTimeout = this.config.sessionInactivityTimeoutMs;
        // For alerts, use the longer default unless config explicitly exceeds it
        const timeoutMs = isAlert ? Math.max(configTimeout || 0, defaultTimeout) : (configTimeout || defaultTimeout);
        const timer = setTimeout(async () => {
            const session = this._getSession(sessionKey);
            if (!session) {
                this.sessionTimers.delete(sessionKey);
                return;
            }

            const minutes = Math.round(timeoutMs / 60000);
            this.logger.info(`Session ${session.sessionName} timed out after ${minutes}min of inactivity`);

            // Kill tmux session
            try {
                execSync(`tmux kill-session -t ${session.sessionName} 2>/dev/null`);
            } catch (_) { /* already dead */ }

            // Stop poller
            if (this.pollers.has(session.sessionName)) {
                clearInterval(this.pollers.get(session.sessionName).interval);
                this.pollers.delete(session.sessionName);
            }

            // Notify user/channel about session timeout
            try {
                const isAlertWithUserChat = session.alertMessageTs && session.lastUserId;
                const mention = session.lastUserId ? `<@${session.lastUserId}> ` : '';

                if (session.alertMessageTs) {
                    // Alert session: swap reactions
                    await this._removeReaction(session.channelId, session.alertMessageTs, 'eyes');
                    await this._addReaction(session.channelId, session.alertMessageTs, 'white_check_mark');
                }

                if (!session.alertMessageTs || isAlertWithUserChat) {
                    // Regular session or alert+user hybrid: send timeout notice
                    await this.app.client.chat.postMessage({
                        channel: session.channelId,
                        text: `${mention}Session timed out after ${minutes}min of inactivity. Send a message to resume.`,
                        thread_ts: session.threadTs
                    });
                }
            } catch (err) {
                this.logger.warn(`Failed to send timeout notice: ${err.message}`);
            }

            // Keep DB record — repo_path and alert_message_ts preserved for session resumption.
            // Stale entries are cleaned up by the 7-day startup cleanup.
            this.sessionTimers.delete(sessionKey);
        }, timeoutMs);

        this.sessionTimers.set(sessionKey, timer);
    }

    _clearSessionTimeout(sessionKey) {
        if (this.sessionTimers.has(sessionKey)) {
            clearTimeout(this.sessionTimers.get(sessionKey));
            this.sessionTimers.delete(sessionKey);
        }
    }

    _startSessionSweep() {
        const SWEEP_INTERVAL = 15 * 60 * 1000; // 15 minutes
        this._sweepInterval = setInterval(() => {
            const sessions = this._getAllSessions();
            let orphaned = 0;
            let dead = 0;
            for (const s of sessions) {
                if (this._isTmuxSessionAlive(s.sessionName)) {
                    if (!this.sessionTimers.has(s.sessionKey)) {
                        this._startSessionTimeout(s.sessionKey);
                        orphaned++;
                        this.logger.info(`Sweep: started timeout for orphaned session ${s.sessionName}`);
                    }
                } else {
                    if (s.alertMessageTs) {
                        this._removeReaction(s.channelId, s.alertMessageTs, 'eyes').catch(() => {});
                        this._addReaction(s.channelId, s.alertMessageTs, 'white_check_mark').catch(() => {});
                    }
                    this._deleteSession(s.sessionKey);
                    this._clearSessionTimeout(s.sessionKey);
                    dead++;
                }
            }
            if (orphaned > 0 || dead > 0) {
                this.logger.info(`Session sweep: ${orphaned} orphaned timers started, ${dead} dead sessions cleaned`);
            }
        }, SWEEP_INTERVAL);
    }

    /**
     * After startup, scan recent messages in all relevant channels for @mentions
     * that the bot never replied to. Replays them as if they just arrived.
     * Covers events dropped during restart / Socket Mode reconnection.
     */
    async _replayMissedMentions() {
        const LOOKBACK_S = 300; // 5 minutes
        const oldest = String((Date.now() / 1000) - LOOKBACK_S);

        // Resolve bot user ID
        if (!this._botUserId) {
            try {
                this._botUserId = (await this.app.client.auth.test()).user_id;
            } catch { return; }
        }
        const botId = this._botUserId;

        // Collect channels to scan: main channel + monitor channels
        const channels = new Set();
        if (this.config.channelId) channels.add(this.config.channelId);
        for (const ch of this.alertMonitor.monitoredChannelIds || []) channels.add(ch);

        let replayed = 0;

        for (const channelId of channels) {
            try {
                // Fetch recent channel messages
                const result = await this.app.client.conversations.history({
                    channel: channelId,
                    oldest,
                    limit: 50
                });

                // Collect thread_ts values that have bot mentions
                const threadsToCheck = new Set();
                for (const msg of result.messages || []) {
                    // Top-level @mention
                    if (msg.text?.includes(`<@${botId}>`) && !msg.bot_id && msg.user) {
                        threadsToCheck.add(msg.ts);
                    }
                    // Thread reply that bubbled up — check the thread
                    if (msg.reply_count > 0 && msg.latest_reply) {
                        threadsToCheck.add(msg.ts);
                    }
                }

                for (const threadTs of threadsToCheck) {
                    try {
                        const replies = await this.app.client.conversations.replies({
                            channel: channelId,
                            ts: threadTs,
                            oldest,
                            limit: 50
                        });

                        const messages = replies.messages || [];
                        // Find the last @mention of the bot from a human user
                        let lastMention = null;
                        for (const msg of messages) {
                            if (msg.text?.includes(`<@${botId}>`) && !msg.bot_id && msg.user) {
                                lastMention = msg;
                            }
                        }
                        if (!lastMention) continue;

                        // Check if bot replied after this mention
                        const botRepliedAfter = messages.some(msg =>
                            (msg.bot_id || msg.user === botId) &&
                            parseFloat(msg.ts) > parseFloat(lastMention.ts)
                        );
                        if (botRepliedAfter) continue;

                        // Missed mention — replay it
                        this.logger.info(`Replaying missed mention: user=${lastMention.user} channel=${channelId} thread=${threadTs} ts=${lastMention.ts}`);
                        const say = async (msgObj) => {
                            await this.app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, ...msgObj });
                        };
                        await this._handleMention(lastMention, say);
                        replayed++;
                    } catch (err) {
                        this.logger.warn(`Failed to check thread ${threadTs} in ${channelId}: ${err.message}`);
                    }
                }
            } catch (err) {
                this.logger.warn(`Failed to scan channel ${channelId} for missed mentions: ${err.message}`);
            }
        }

        this.logger.info(`[startup] replayMissedMentions: ${replayed} replayed`);
    }

    _extractResponse(baselineOutput, currentOutput) {
        const baseLines = baselineOutput.split('\n');
        const currentLines = currentOutput.split('\n');

        let newLines;
        const bufferScrolled = baseLines.length > 0 && currentLines.length > 0 && baseLines[0] !== currentLines[0];

        if (!bufferScrolled) {
            // Top-down diff: reliable when buffer hasn't scrolled (first lines match).
            let diffStart = 0;
            for (let i = 0; i < Math.min(baseLines.length, currentLines.length); i++) {
                if (baseLines[i] !== currentLines[i]) {
                    diffStart = i;
                    break;
                }
                diffStart = i + 1;
            }

            if (diffStart < baseLines.length) {
                newLines = currentLines.slice(diffStart);
            } else if (currentLines.length > baseLines.length) {
                newLines = currentLines.slice(baseLines.length);
            } else {
                newLines = []; // Identical output
            }
        } else {
            // Buffer scrolled — use anchor-based diff.
            // Find the last occurrence of baseline's tail in current output.
            let baseTrimEnd = baseLines.length;
            while (baseTrimEnd > 0 && baseLines[baseTrimEnd - 1].trim() === '') baseTrimEnd--;
            const trimmedBaseLines = baseLines.slice(0, baseTrimEnd);

            const anchorSize = Math.min(5, trimmedBaseLines.length);
            const baselineTail = trimmedBaseLines.slice(-anchorSize);

            let anchorEnd = -1;
            for (let i = 0; i <= currentLines.length - anchorSize; i++) {
                let match = true;
                for (let j = 0; j < anchorSize; j++) {
                    if (currentLines[i + j] !== baselineTail[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    anchorEnd = i + anchorSize;
                }
            }

            if (anchorEnd >= 0) {
                newLines = currentLines.slice(anchorEnd);
            } else {
                // Anchor completely scrolled out of buffer — use entire buffer as response.
                // This happens when Claude's output exceeds the 200-line tmux capture window.
                this.logger?.info?.(`Anchor lost (buffer scrolled past baseline) — using full buffer (${currentLines.length} lines)`);
                newLines = currentLines;
            }
        }
        const responseLines = newLines.filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            if (trimmed === '>' || trimmed === '❯') return false;
            if (trimmed.match(/^[>❯]\s*$/)) return false;
            // Filter Claude CLI chrome/status bar lines
            if (trimmed.match(/^[─━═▪▐▛▜▝▘]+/) || trimmed.match(/^[─━═▪]+$/)) return false;
            if (trimmed.startsWith('Model:') || trimmed.includes('bypass permissions')) return false;
            if (trimmed.match(/^⏵/) && trimmed.includes('permissions')) return false;
            if (trimmed.match(/Ctx\(u\):/) || trimmed.match(/Cost: \$/)) return false;
            return true;
        });

        return responseLines.join('\n').trim();
    }

    _extractSessionStats(output) {
        const stats = {};
        const lines = output.split('\n');
        for (const line of lines) {
            // Match: Model: Opus 4.6⎇ mainCtx(u): 12.2% | In: 73Out: 1.9k | Cost: $0.24
            const modelMatch = line.match(/Model:\s*(.+?)(?:⎇|$)/);
            if (modelMatch) stats.model = modelMatch[1].trim();

            const ctxMatch = line.match(/Ctx\(u\):\s*([\d.]+%)/);
            if (ctxMatch) stats.context = ctxMatch[1];

            const inMatch = line.match(/In:\s*([\d,.]+[kmb]?)/i);
            if (inMatch) stats.tokensIn = inMatch[1];

            const outMatch = line.match(/Out:\s*([\d,.]+[kmb]?)/i);
            if (outMatch) stats.tokensOut = outMatch[1];

            const costMatch = line.match(/Cost:\s*(\$[\d.]+)/);
            if (costMatch) stats.cost = costMatch[1];
        }
        return Object.keys(stats).length > 0 ? stats : null;
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

    async _sendResponse(say, threadTs, response, stats) {
        const codeWrap = '```\n';
        const codeWrapEnd = '\n```';
        const maxLen = 3000 - codeWrap.length - codeWrapEnd.length; // Slack section block text limit is 3000
        const statsLine = stats
            ? `\n_${stats.model || ''} · Ctx: ${stats.context || '?'} · In: ${stats.tokensIn || '?'} Out: ${stats.tokensOut || '?'}_`
            : '';

        if (response.length <= maxLen) {
            const blocks = [
                { type: 'section', text: { type: 'mrkdwn', text: codeWrap + response + codeWrapEnd } }
            ];
            if (statsLine) {
                blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine.trim() }] });
            }
            await say({ text: response, thread_ts: threadTs, blocks });
        } else {
            const chunks = [];
            for (let i = 0; i < response.length; i += maxLen) {
                chunks.push(response.substring(i, i + maxLen));
            }
            for (let i = 0; i < chunks.length; i++) {
                const blocks = [
                    { type: 'section', text: { type: 'mrkdwn', text: codeWrap + chunks[i] + codeWrapEnd } }
                ];
                // Add stats to the last chunk only
                if (i === chunks.length - 1 && statsLine) {
                    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine.trim() }] });
                }
                await say({ text: chunks[i], thread_ts: threadTs, blocks });
            }
        }
    }

    /**
     * Extract the Recommended Action section from an alert investigation response.
     * Looks for text between "Recommended Action:" and the next "---" or section boundary.
     */
    _extractRecommendedAction(response) {
        // Match "Recommended Action:" followed by content, up to next "---" or "##" or "**"
        const match = response.match(/Recommended Action:\s*([\s\S]*?)(?:\n\s*---|\n\n##|\n\n\*\*)/i);
        if (match) {
            return match[1].trim();
        }
        // Fallback: take first paragraph after "Recommended Action:", or first 500 chars
        const paraMatch = response.match(/Recommended Action:\s*(.+(?:\n(?!\n).+)*)/i);
        if (paraMatch) {
            return paraMatch[1].trim();
        }
        return response.substring(0, 500).trim();
    }

    /**
     * Send alert summary: Recommended Action as Slack message + full report as file upload.
     */
    async _sendAlertSummary(say, threadTs, response, stats) {
        // Validate content quality: reject intermediate narration / partial output.
        // Real investigation reports are 500+ chars and contain a proper "Recommended Action" heading.
        const MIN_REPORT_LEN = 500;
        const isValidReport = response && response.length >= MIN_REPORT_LEN
            && /(?:^|\n)(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:/im.test(response);

        if (!isValidReport) {
            this.logger.warn(`Alert summary rejected: content doesn't look like a real report (${(response || '').length} chars) — posting incomplete notice`);
            await say({ text: ':warning: Investigation incomplete — Claude exited before producing a report.', thread_ts: threadTs });

            // Upload raw Claude output so owner can debug what happened (tmux is gone by now)
            if (response) {
                try {
                    const channelId = this._getChannelForThread(threadTs);
                    await this.app.client.filesUploadV2({
                        channel_id: channelId || this.config.channelId,
                        thread_ts: threadTs,
                        content: response,
                        filename: `alert-raw-output-${Date.now()}.txt`,
                        title: 'Raw Claude Output (debug)',
                        initial_comment: '_Raw Claude output attached for debugging._',
                    });
                } catch (err) {
                    this.logger.error(`Failed to upload raw debug output: ${err.message}`);
                }
            }
            return;
        }

        const summary = this._extractRecommendedAction(response);
        const statsLine = stats
            ? `\n_${stats.model || ''} · Ctx: ${stats.context || '?'} · In: ${stats.tokensIn || '?'} Out: ${stats.tokensOut || '?'}_`
            : '';

        // Post the summary (Recommended Action only), truncate to stay under 3000-char block limit
        const maxSummaryLen = 2970; // 3000 limit minus "*Recommended Action:* " prefix
        const trimmedSummary = summary.length > maxSummaryLen
            ? summary.substring(0, maxSummaryLen) + '…' : summary;
        const blocks = [
            { type: 'section', text: { type: 'mrkdwn', text: `*Recommended Action:* ${trimmedSummary}` } }
        ];
        if (statsLine) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine.trim() }] });
        }
        await say({ text: `Recommended Action: ${summary}`, thread_ts: threadTs, blocks });

        // Upload full report as a text file
        try {
            const channelId = this._getChannelForThread(threadTs);
            await this.app.client.filesUploadV2({
                channel_id: channelId || this.config.channelId,
                thread_ts: threadTs,
                content: response,
                filename: `alert-investigation-${Date.now()}.txt`,
                title: 'Full Investigation Report',
                initial_comment: '_Full investigation details attached._',
            });
        } catch (err) {
            this.logger.error(`Failed to upload alert report file: ${err.message}`);
            // Fallback: send full response as regular messages
            await this._sendResponse(say, threadTs, response, stats);
        }
    }

    /**
     * Look up the channel ID for a given thread timestamp from stored sessions.
     */
    _getChannelForThread(threadTs) {
        try {
            const row = this.db.prepare('SELECT channel_id FROM sessions WHERE thread_ts = ?').get(threadTs);
            return row ? row.channel_id : null;
        } catch { return null; }
    }

    _isOwner(userId) {
        const ownerId = this.config.ownerUserId;
        if (!ownerId) return true; // No owner set = allow all (backwards compat)
        return userId === ownerId;
    }

    // ─── HTTP Server ─────────────────────────────────────────────────

    _setupHttpServer() {
        const httpApp = express();
        // Capture raw body for PagerDuty HMAC verification (must be before generic json parser)
        httpApp.use('/pagerduty', express.json({
            verify: (req, _res, buf) => { req.rawBody = buf; }
        }));
        httpApp.use(express.json());

        const swaggerDoc = {
            openapi: '3.0.0',
            info: {
                title: 'Claude Code Remote - Slack Agent API',
                version: '1.0.0',
                description: 'HTTP API for managing the Slack-based Claude Code Remote agent'
            },
            servers: [{ url: `http://localhost:${this.httpPort}` }],
            paths: {
                '/': {
                    get: {
                        summary: 'Health check',
                        responses: {
                            '200': {
                                description: 'Service status',
                                content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, service: { type: 'string' }, uptime: { type: 'number' }, sessions: { type: 'number' } } } } }
                            }
                        }
                    }
                },
                '/delete-message': {
                    post: {
                        summary: 'Delete a Slack message by URL',
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://wego.slack.com/archives/C0AJ3JPRA9L/p1772808507330479?thread_ts=1772802618.748569&cid=C0AJ3JPRA9L' } } } } }
                        },
                        responses: {
                            '200': { description: 'Message deleted successfully' },
                            '400': { description: 'Invalid URL format' },
                            '500': { description: 'Failed to delete message' }
                        }
                    }
                },
                '/remove-reaction': {
                    post: {
                        summary: 'Remove all bot reactions from a Slack message',
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://wego.slack.com/archives/C0AJ3JPRA9L/p1772808507330479?thread_ts=1772802618.748569&cid=C0AJ3JPRA9L' } } } } }
                        },
                        responses: {
                            '200': { description: 'Reactions removed successfully', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, channel: { type: 'string' }, ts: { type: 'string' }, removed: { type: 'array', items: { type: 'string' } } } } } } },
                            '400': { description: 'Missing or invalid URL' },
                            '500': { description: 'Failed to remove reactions' }
                        }
                    }
                },
                '/trigger-alert': {
                    post: {
                        summary: 'Manually trigger an alert investigation session',
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://wego.slack.com/archives/C07DEF456/p1709123456789012' } } } } }
                        },
                        responses: {
                            '200': { description: 'Investigation started', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, channelId: { type: 'string' }, messageTs: { type: 'string' } } } } } },
                            '400': { description: 'Missing/invalid URL or bad JSON' },
                            '405': { description: 'Wrong HTTP method' },
                            '409': { description: 'Session already exists for this message' },
                            '503': { description: 'Slack app not initialized yet' }
                        }
                    }
                },
                '/trigger-delay-alert': {
                    post: {
                        summary: 'Manually trigger a delay alert investigation session',
                        description: 'Bypasses counter/threshold — immediately starts a delay alert investigation using the configured delay skill.',
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://wego.slack.com/archives/CPP5EH3A8/p1775389830277889' } } } } }
                        },
                        responses: {
                            '200': { description: 'Investigation started', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, channelId: { type: 'string' }, messageTs: { type: 'string' }, skill: { type: 'string' } } } } } },
                            '400': { description: 'Missing/invalid URL or bad JSON' },
                            '409': { description: 'Session already exists for this message' },
                            '503': { description: 'Slack app not initialized yet' }
                        }
                    }
                },
                '/sessions': {
                    get: {
                        summary: 'List active Claude tmux sessions',
                        responses: {
                            '200': {
                                description: 'Active sessions',
                                content: { 'application/json': { schema: { type: 'object', properties: { sessions: { type: 'array', items: { type: 'object' } } } } } }
                            }
                        }
                    },
                    delete: {
                        summary: 'Kill all Claude tmux sessions and clean up',
                        description: 'Kills all tmux sessions, stops pollers, clears timers, and deletes DB records.',
                        responses: {
                            '200': {
                                description: 'Sessions killed',
                                content: { 'application/json': { schema: { type: 'object', properties: { killed: { type: 'number' }, already_dead: { type: 'number' } } } } }
                            }
                        }
                    }
                },
                '/delay-counters': {
                    get: {
                        summary: 'Show delay alert counters',
                        description: 'Returns current alert counters per DAG with count, threshold, and time remaining in window.',
                        responses: {
                            '200': {
                                description: 'Delay alert counters',
                                content: { 'application/json': { schema: { type: 'object', properties: { threshold: { type: 'number' }, windowMs: { type: 'number' }, counters: { type: 'array', items: { type: 'object', properties: { dag: { type: 'string' }, count: { type: 'number' }, threshold: { type: 'number' }, firstSeen: { type: 'string' }, windowRemainingMs: { type: 'number' }, channelId: { type: 'string' } } } } } } } }
                            }
                        }
                    }
                },
                '/daily-summary': {
                    post: {
                        summary: 'Manually trigger daily channel summary',
                        responses: {
                            '200': { description: 'Summary triggered', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, channels: { type: 'number' } } } } } },
                            '400': { description: 'No channels configured' },
                            '500': { description: 'Failed to run summary' }
                        }
                    }
                }
            }
        };

        const swaggerUi = require('swagger-ui-express');
        httpApp.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

        httpApp.get('/', (req, res) => {
            const sessions = this._getAllSessions();
            const aliveSessions = sessions.filter(s => this._isTmuxSessionAlive(s.sessionName));
            const recentErrors = this._wsErrors.filter(ts => ts > Date.now() - this._wsErrorWindowMs).length;
            const status = this.connected && recentErrors < 5
                ? 'ok'
                : (recentErrors >= 10 ? 'critical' : 'degraded');
            res.json({
                status,
                service: 'claude-code-remote-slack',
                socketConnected: this.connected,
                wsErrorsInWindow: recentErrors,
                wsRestartsIn10min: this._getRestartsInWindow(),
                uptime: process.uptime(),
                sessions: aliveSessions.length,
                totalSessionsInDb: sessions.length
            });
        });

        httpApp.post('/delete-message', async (req, res) => {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: 'url is required' });
            }

            const parsed = this._parseSlackUrl(url);
            if (!parsed) {
                return res.status(400).json({ error: 'Invalid Slack message URL' });
            }

            try {
                const { WebClient } = require('@slack/web-api');
                const web = new WebClient(this.config.botToken);
                await web.chat.delete({
                    channel: parsed.channel,
                    ts: parsed.ts
                });
                this.logger.info(`Deleted message: channel=${parsed.channel} ts=${parsed.ts}`);
                res.json({ ok: true, channel: parsed.channel, ts: parsed.ts });
            } catch (error) {
                this.logger.error('Failed to delete message:', error.message);
                res.status(500).json({ error: error.message });
            }
        });

        httpApp.post('/remove-reaction', async (req, res) => {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: 'url is required' });
            }

            const parsed = this._parseSlackUrl(url);
            if (!parsed) {
                return res.status(400).json({ error: 'Invalid Slack message URL' });
            }

            try {
                const { WebClient } = require('@slack/web-api');
                const web = new WebClient(this.config.botToken);

                // Fetch reactions on the message
                const result = await web.reactions.get({
                    channel: parsed.channel,
                    timestamp: parsed.ts,
                    full: true
                });

                const botUserId = (await web.auth.test()).user_id;
                const reactions = result.message?.reactions || [];
                const botReactions = reactions.filter(r => r.users?.includes(botUserId));

                // Remove all reactions added by the bot
                const removed = [];
                for (const reaction of botReactions) {
                    await web.reactions.remove({
                        channel: parsed.channel,
                        timestamp: parsed.ts,
                        name: reaction.name
                    });
                    removed.push(reaction.name);
                }

                this.logger.info(`Removed ${removed.length} reaction(s) from channel=${parsed.channel} ts=${parsed.ts}: ${removed.join(', ')}`);
                res.json({ ok: true, channel: parsed.channel, ts: parsed.ts, removed });
            } catch (error) {
                this.logger.error('Failed to remove reaction:', error.message);
                res.status(500).json({ error: error.message });
            }
        });

        // ─── Trigger Alert ─────────────────────────────────────
        httpApp.post('/trigger-alert', async (req, res) => {
            if (!this.app) {
                return res.status(503).json({ error: 'Slack app not initialized yet' });
            }

            const { url } = req.body || {};
            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid "url" field. Provide a Slack message permalink.' });
            }

            const parsed = this._parseSlackUrl(url);
            if (!parsed) {
                return res.status(400).json({ error: 'Invalid Slack message URL format. Expected: https://<workspace>.slack.com/archives/<channel>/p<timestamp>' });
            }

            const channelId = parsed.channel;
            const messageTs = parsed.ts;
            this.logger.info(`Trigger-alert received: channelId=${channelId} messageTs=${messageTs}`);

            // Check for duplicate
            const sessionKey = `${channelId}-${messageTs}`;
            if (this._getSession(sessionKey)) {
                this.logger.warn(`Trigger-alert skipped: session already exists for ${sessionKey}`);
                return res.status(409).json({ error: 'Session already exists for this message', channelId, messageTs });
            }

            try {
                // Fetch the message from Slack
                const historyResult = await this.app.client.conversations.history({
                    channel: channelId,
                    latest: messageTs,
                    inclusive: true,
                    limit: 1
                });

                const message = historyResult.messages?.[0];
                if (!message) {
                    return res.status(400).json({ error: 'Could not fetch message from Slack' });
                }

                const text = message.text || '';
                const incidentId = this.alertMonitor.extractIncidentId(message);

                // React with eyes
                await this._addReaction(channelId, messageTs, 'eyes');

                // Download images
                const imagePaths = await this._downloadSlackImages(message.files, `alert-${messageTs.replace('.', '')}`);
                const imageInstruction = imagePaths.length > 0
                    ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
                    : '';

                // Build prompt — use "execute skill" so Claude invokes the skill directly
                const permalink = await this._getPermalink(channelId, messageTs);
                const alertSkill = this.config.alertSkill;
                let prompt;
                if (alertSkill && permalink) {
                    prompt = `execute ${alertSkill} skill with argument ${permalink}${imageInstruction}`;
                } else if (alertSkill) {
                    prompt = `execute ${alertSkill} skill with argument Alert: ${text.substring(0, 500)}${imageInstruction}`;
                } else if (permalink) {
                    prompt = `Investigate this alert: ${permalink}${imageInstruction}`;
                } else {
                    prompt = `Investigate this alert: ${text.substring(0, 500)}${imageInstruction}`;
                }

                // Use the regular command flow
                await this._processCommand(channelId, messageTs, prompt, null, messageTs, messageTs);
                res.json({ status: 'investigating', channelId, messageTs });
            } catch (error) {
                this.logger.error(`Trigger alert error: ${error.message}`);
                res.status(500).json({ error: error.message });
            }
        });

        httpApp.post('/trigger-delay-alert', async (req, res) => {
            if (!this.app) {
                return res.status(503).json({ error: 'Slack app not initialized yet' });
            }

            const { url } = req.body || {};
            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid "url" field. Provide a Slack message permalink.' });
            }

            const parsed = this._parseSlackUrl(url);
            if (!parsed) {
                return res.status(400).json({ error: 'Invalid Slack message URL format. Expected: https://<workspace>.slack.com/archives/<channel>/p<timestamp>' });
            }

            const channelId = parsed.channel;
            const messageTs = parsed.ts;
            this.logger.info(`Trigger-delay-alert received: channelId=${channelId} messageTs=${messageTs}`);

            // Check for duplicate
            const sessionKey = `${channelId}-${messageTs}`;
            if (this._getSession(sessionKey)) {
                this.logger.warn(`Trigger-delay-alert skipped: session already exists for ${sessionKey}`);
                return res.status(409).json({ error: 'Session already exists for this message', channelId, messageTs });
            }

            try {
                // Fetch the message from Slack
                const historyResult = await this.app.client.conversations.history({
                    channel: channelId,
                    latest: messageTs,
                    inclusive: true,
                    limit: 1
                });

                const message = historyResult.messages?.[0];
                if (!message) {
                    return res.status(400).json({ error: 'Could not fetch message from Slack' });
                }

                const text = message.text || '';

                // React with eyes
                await this._addReaction(channelId, messageTs, 'eyes');

                // Download images
                const imagePaths = await this._downloadSlackImages(message.files, `delay-alert-${messageTs.replace('.', '')}`);
                const imageInstruction = imagePaths.length > 0
                    ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
                    : '';

                // Build prompt using the delay alert skill
                const permalink = await this._getPermalink(channelId, messageTs);
                const skill = this.delayAlertMonitor.skill;
                let prompt;
                if (skill && permalink) {
                    prompt = `execute ${skill} skill with argument ${permalink}${imageInstruction}`;
                } else if (skill) {
                    prompt = `execute ${skill} skill with argument Alert: ${text.substring(0, 500)}${imageInstruction}`;
                } else if (permalink) {
                    prompt = `Investigate this Airflow delay alert: ${permalink}${imageInstruction}`;
                } else {
                    prompt = `Investigate this Airflow delay alert: ${text.substring(0, 500)}${imageInstruction}`;
                }

                // DM owner that investigation is starting (manual trigger)
                const alertInfo = this.delayAlertMonitor.extractAlertInfo(message);
                this._notifyOwnerDelayAlert(
                    alertInfo?.dag || 'manual-trigger',
                    alertInfo?.task || 'N/A',
                    0,
                    { permalink }
                ).catch(err =>
                    this.logger.error(`Failed to notify owner of delay alert: ${err.message}`)
                );

                // Use the regular command flow
                await this._processCommand(channelId, messageTs, prompt, null, messageTs, messageTs);
                res.json({ status: 'investigating', channelId, messageTs, skill: skill || 'none' });
            } catch (error) {
                this.logger.error(`Trigger delay alert error: ${error.message}`);
                res.status(500).json({ error: error.message });
            }
        });

        httpApp.get('/delay-counters', (req, res) => {
            const now = Date.now();
            const rows = this.delayAlertMonitor.getAllCounters();
            const threshold = this.delayAlertMonitor.threshold;
            const windowMs = this.delayAlertMonitor.windowMs;
            const counters = rows.map(r => {
                const elapsed = now - r.first_seen_at;
                const remaining = Math.max(0, windowMs - elapsed);
                return {
                    dag: r.dag_name,
                    count: r.count,
                    threshold,
                    progress: `${r.count}/${threshold}`,
                    firstSeen: new Date(r.first_seen_at).toISOString(),
                    windowRemainingMs: remaining,
                    windowRemaining: `${Math.round(remaining / 60000)}m`,
                    expired: remaining === 0,
                    channelId: r.channel_id,
                };
            });
            res.json({ threshold, windowMs, counters });
        });

        httpApp.get('/sessions', (req, res) => {
            const sessions = this._getAllSessions().map(s => ({
                ...s,
                tmuxAlive: this._isTmuxSessionAlive(s.sessionName),
                createdAt: new Date(s.createdAt).toISOString(),
                updatedAt: new Date(s.updatedAt).toISOString()
            }));
            res.json({ sessions });
        });

        httpApp.delete('/sessions', (req, res) => {
            const sessions = this._getAllSessions();
            let killed = 0;
            let alreadyDead = 0;

            for (const s of sessions) {
                // Kill tmux
                if (this._isTmuxSessionAlive(s.sessionName)) {
                    try { execSync(`tmux kill-session -t ${s.sessionName} 2>/dev/null`); } catch (_) {}
                    killed++;
                } else {
                    alreadyDead++;
                }

                // Stop poller
                if (this.pollers.has(s.sessionName)) {
                    clearInterval(this.pollers.get(s.sessionName).interval);
                    this.pollers.delete(s.sessionName);
                }

                // Clear timer
                this._clearSessionTimeout(s.sessionKey);

                // Swap alert reactions
                if (s.alertMessageTs) {
                    this._removeReaction(s.channelId, s.alertMessageTs, 'eyes').catch(() => {});
                    this._addReaction(s.channelId, s.alertMessageTs, 'white_check_mark').catch(() => {});
                }

                // Delete DB record
                this._deleteSession(s.sessionKey);
            }

            this.logger.info(`DELETE /sessions: ${killed} killed, ${alreadyDead} already dead, ${sessions.length} DB records removed`);
            res.json({ killed, already_dead: alreadyDead });
        });

        // ─── Daily Summary ────────────────────────────────────
        httpApp.post('/daily-summary', async (req, res) => {
            const channels = parseChannelsConfig(this.config.dailySummaryChannels);
            if (channels.length === 0) {
                return res.status(400).json({ error: 'No DAILY_SUMMARY_CHANNELS configured' });
            }

            res.json({ status: 'triggered', channels: channels.length });

            // Run async (don't block the HTTP response)
            runDailySummary({
                channels,
                ownerUserId: this.config.ownerUserId,
                model: this.config.dailySummaryModel || 'sonnet',
                xoxcToken: this.config.xoxcToken,
                xoxdToken: this.config.xoxdToken,
                slackClient: this.app.client,
                deliveryChannelId: this.config.channelId,
            }).catch(err => this.logger.error(`Daily summary error: ${err.message}`));
        });

        // ─── PagerDuty Webhook (fallback for Socket Mode) ──────────
        httpApp.post('/pagerduty/webhook', async (req, res) => {
            // Verify HMAC signature
            if (!this._verifyPagerDutySignature(req)) {
                this.logger.warn('PD webhook rejected: invalid signature');
                return res.status(401).json({ error: 'Invalid signature' });
            }

            const event = req.body?.event;

            // Only handle incident.triggered
            if (!event || event.event_type !== 'incident.triggered') {
                return res.status(200).json({ status: 'ignored', reason: event?.event_type || 'unknown' });
            }

            const incidentId = event.data?.id;
            if (!incidentId) {
                return res.status(200).json({ status: 'ignored', reason: 'no incident ID' });
            }

            // Dedup — skip if Socket Mode already handled it, but notify owner
            if (this.trackedIncidents.has(incidentId)) {
                this.logger.info(`PD webhook: incident ${incidentId} already tracked — skipping`);
                res.status(200).json({ status: 'skipped', incidentId });
                // Notify owner with link to the Slack message we already acked
                this._notifyOwnerIncidentWebhook(incidentId, event.data, { alreadyAcked: true }).catch(err =>
                    this.logger.error(`Failed to notify owner of incident webhook: ${err.message}`)
                );
                return;
            }

            this.logger.info(`PD webhook: new incident ${incidentId}`);

            // Respond immediately — process async
            res.status(200).json({ status: 'accepted', incidentId });

            // Async: find Slack message and trigger investigation
            try {
                this.trackedIncidents.set(incidentId, {}); // placeholder until we find the Slack message

                const found = await this._findPagerDutySlackMessage(incidentId);
                if (!found) {
                    this.logger.error(`PD webhook: Slack message not found for ${incidentId} after retries`);
                    this.trackedIncidents.delete(incidentId);
                    return;
                }

                const { channelId, message } = found;
                const messageTs = message.ts;
                this.trackedIncidents.set(incidentId, { channelId, messageTs });

                // Race check — Socket Mode may have handled it while we searched
                const sessionKey = `${channelId}-${messageTs}`;
                if (this._getSession(sessionKey)) {
                    this.logger.info(`PD webhook: session already exists for ${sessionKey}`);
                    this._notifyOwnerIncidentAcked(incidentId, event.data).catch(err =>
                        this.logger.error(`Failed to notify owner of acked incident: ${err.message}`)
                    );
                    return;
                }

                // Acknowledge PD
                if (this.config.pagerdutyApiToken) {
                    const pdResult = await this._acknowledgePagerDuty(incidentId);
                    if (pdResult?.skipped) {
                        this.logger.info(`PD webhook: incident ${incidentId} already ${pdResult.status}`);
                        this._notifyOwnerIncidentAcked(incidentId, event.data).catch(err =>
                            this.logger.error(`Failed to notify owner of acked incident: ${err.message}`)
                        );
                        this.trackedIncidents.delete(incidentId);
                        return;
                    }
                }

                // React with eyes
                await this._addReaction(channelId, messageTs, 'eyes');

                // Download attached images
                const imagePaths = await this._downloadSlackImages(message.files, `alert-${messageTs.replace('.', '')}`);
                const imageInstruction = imagePaths.length > 0
                    ? ` Attached images (read these files for visual context): ${imagePaths.join(' ')}`
                    : '';

                // Build prompt
                const permalink = await this._getPermalink(channelId, messageTs);
                const text = message.text || '';
                const alertSkill = this.config.alertSkill;
                let prompt;
                if (alertSkill && permalink) {
                    prompt = `execute ${alertSkill} skill with argument ${permalink}${imageInstruction}`;
                } else if (alertSkill) {
                    prompt = `execute ${alertSkill} skill with argument Alert: ${text.substring(0, 500)}${imageInstruction}`;
                } else {
                    prompt = `Investigate this PagerDuty alert: ${(permalink || text).substring(0, 500)}${imageInstruction}`;
                }

                await this._processCommand(channelId, messageTs, prompt, null, messageTs, messageTs);
                this.logger.info(`PD webhook: investigation started for ${incidentId}`);

                // Notify owner that webhook triggered a new investigation
                this._notifyOwnerIncidentWebhook(incidentId, event.data, { permalink }).catch(err =>
                    this.logger.error(`Failed to notify owner of incident webhook: ${err.message}`)
                );
            } catch (err) {
                this.logger.error(`PD webhook error for ${incidentId}: ${err.message}`);
                this.trackedIncidents.delete(incidentId);
            }
        });

        this._httpApp = httpApp;
    }

    _verifyPagerDutySignature(req) {
        const secret = this.config.pagerdutyWebhookSecret;
        if (!secret) return true; // No secret configured — allow all
        const signature = req.headers['x-pagerduty-signature'];
        if (!signature) return false;
        const crypto = require('crypto');
        const expected = 'v1=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
        try {
            return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
        } catch {
            return false;
        }
    }

    async _findPagerDutySlackMessage(incidentId) {
        const channelIds = [...this.alertMonitor.monitoredChannelIds];
        if (channelIds.length === 0) return null;

        const delays = [2000, 5000, 10000];
        for (let attempt = 0; attempt < delays.length + 1; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, delays[attempt - 1]));

            for (const channelId of channelIds) {
                try {
                    const result = await this.app.client.conversations.history({
                        channel: channelId,
                        limit: 20,
                        oldest: String((Date.now() / 1000 - 120).toFixed(6)),
                    });
                    for (const msg of (result.messages || [])) {
                        if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;
                        if (this.alertMonitor.extractIncidentId(msg) === incidentId) {
                            this.logger.info(`PD webhook: found Slack message for ${incidentId} in ${channelId} (attempt ${attempt + 1})`);
                            return { channelId, message: msg };
                        }
                    }
                } catch (err) {
                    this.logger.error(`PD webhook: search error in ${channelId}: ${err.message}`);
                }
            }
        }
        return null;
    }

    _parseSlackUrl(url) {
        try {
            const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
            if (!match) return null;

            const channel = match[1];
            const rawTs = match[2];
            const ts = rawTs.slice(0, -6) + '.' + rawTs.slice(-6);

            return { channel, ts };
        } catch {
            return null;
        }
    }

    // ─── Lifecycle ───────────────────────────────────────────────────

    async start() {
        const t0 = Date.now();

        // Re-initialize DB if it was closed (e.g. after stop() during daily restart)
        if (!this.db || !this.db.open) {
            this._initDb();
            // Re-init delay alert monitor's DB reference and counters table
            this.delayAlertMonitor.db = this.db;
            this.delayAlertMonitor._initCountersTable();
        }

        // Ensure tmux server is running — without a server, session creation fails.
        // This can happen after a service restart when no tmux sessions exist.
        this._ensureTmuxServer();

        // Reconcile DB sessions with live tmux sessions
        await this._reconcileSessions();
        this._startSessionSweep();
        this.logger.info(`[startup] reconcileSessions: ${Date.now() - t0}ms`);

        const t1 = Date.now();
        await this.app.start();
        this.connected = true;
        this._setupConnectionMonitor();
        this._startHealthCheck();
        this.logger.info(`[startup] Slack Socket Mode connected: ${Date.now() - t1}ms`);

        // Resolve monitored channels
        const t2 = Date.now();
        await this.alertMonitor.resolveMonitorChannels();
        await this.delayAlertMonitor.resolveMonitorChannels();
        this.logger.info(`[startup] resolveMonitorChannels: ${Date.now() - t2}ms`);

        this.httpServer = this._httpApp.listen(this.httpPort, () => {
            this.logger.info(`[startup] HTTP API on port ${this.httpPort}`);
            this.logger.info(`[startup] total: ${Date.now() - t0}ms`);
        });

        // Check for missed mentions after connection stabilizes
        setTimeout(() => this._replayMissedMentions().catch(err =>
            this.logger.error(`Failed to replay missed mentions: ${err.message}`)
        ), 3000);
    }

    async stop() {
        if (this._sweepInterval) {
            clearInterval(this._sweepInterval);
            this._sweepInterval = null;
        }

        if (this._healthCheckInterval) {
            clearInterval(this._healthCheckInterval);
            this._healthCheckInterval = null;
        }

        if (this._wsStabilityTimer) {
            clearTimeout(this._wsStabilityTimer);
            this._wsStabilityTimer = null;
        }

        if (this.httpServer) {
            await new Promise(resolve => this.httpServer.close(resolve));
            this.httpServer = null;
        }

        for (const [key, poller] of this.pollers) {
            clearInterval(poller.interval);
        }
        this.pollers.clear();

        for (const [, timer] of this.sessionTimers) {
            clearTimeout(timer);
        }
        this.sessionTimers.clear();

        // NOTE: We do NOT kill tmux sessions on stop.
        // They persist so conversations can resume after restart.

        if (this.db) {
            this.db.close();
        }

        await this.app.stop();
        this.logger.info('Slack Socket Mode disconnected (tmux sessions preserved)');
    }
}

module.exports = SlackSocketHandler;
