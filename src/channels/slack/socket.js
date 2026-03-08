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
const AlertWorkflow = require('./alert-workflow');

class SlackSocketHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('SlackSocket');

        // Polling state per session (in-memory only, rebuilt on start)
        this.pollers = new Map();

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
        this._reconnectTimer = null;
        this._reconnectDelay = 30000; // 30s watchdog

        this._initDb();

        // Alert monitoring
        this.alertMonitor = new AlertMonitor(this.app, config);
        this.alertWorkflow = new AlertWorkflow(this.app, this.db, config);

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

        // Migrate: add last_bot_ts column if missing (existing DBs)
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN last_bot_ts TEXT');
        } catch {
            // Column already exists
        }

        this._stmts = {
            upsert: this.db.prepare(`
                INSERT INTO sessions (session_key, session_name, channel_id, thread_ts, repo_path, created_at, updated_at)
                VALUES (@session_key, @session_name, @channel_id, @thread_ts, @repo_path, @created_at, @updated_at)
                ON CONFLICT(session_key) DO UPDATE SET updated_at = @updated_at
            `),
            get: this.db.prepare('SELECT * FROM sessions WHERE session_key = ?'),
            all: this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC'),
            delete: this.db.prepare('DELETE FROM sessions WHERE session_key = ?'),
            deleteOld: this.db.prepare('DELETE FROM sessions WHERE updated_at < ?'),
            touch: this.db.prepare('UPDATE sessions SET updated_at = ? WHERE session_key = ?'),
            updateLastBotTs: this.db.prepare('UPDATE sessions SET last_bot_ts = ?, updated_at = ? WHERE session_key = ?')
        };

        // Clean up sessions older than 7 days
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const deleted = this._stmts.deleteOld.run(weekAgo);
        if (deleted.changes > 0) {
            this.logger.info(`Cleaned up ${deleted.changes} expired sessions from DB`);
        }
    }

    _saveSession(session) {
        this._stmts.upsert.run({
            session_key: `${session.channelId}-${session.threadTs}`,
            session_name: session.sessionName,
            channel_id: session.channelId,
            thread_ts: session.threadTs,
            repo_path: session.repoPath,
            created_at: session.createdAt,
            updated_at: Date.now()
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
            lastBotTs: row.last_bot_ts || null
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
            updatedAt: row.updated_at
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
    _reconcileSessions() {
        const sessions = this._getAllSessions();
        let alive = 0;
        let removed = 0;

        for (const s of sessions) {
            if (this._isTmuxSessionAlive(s.sessionName)) {
                alive++;
                this.logger.info(`Recovered session: ${s.sessionName} (channel ${s.channelId})`);
            } else {
                this._deleteSession(s.sessionKey);
                removed++;
            }
        }

        this.logger.info(`Session reconciliation: ${alive} alive, ${removed} stale removed`);
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

    // ─── Thread Context ─────────────────────────────────────────────

    /**
     * Fetch thread messages from Slack, optionally only those after a given timestamp.
     * @param {string} channelId - The Slack channel ID
     * @param {string} threadTs - The thread root timestamp
     * @param {string|null} sinceTs - Only return messages after this timestamp (exclusive)
     * @returns {Array<{user: string, text: string, ts: string}>}
     */
    async _fetchThreadMessages(channelId, threadTs, sinceTs = null) {
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
                // Skip the thread root if sinceTs is not set (it's the first message)
                // but include it for full context on first mention
                if (sinceTs && parseFloat(msg.ts) <= parseFloat(sinceTs)) continue;
                // Skip bot's own messages
                if (msg.bot_id || (msg.app_id && !msg.user)) continue;
                messages.push({
                    user: msg.user || 'unknown',
                    text: msg.text || '',
                    ts: msg.ts
                });
            }

            cursor = result.response_metadata?.next_cursor;
        } while (cursor);

        return messages;
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
     * Update the last bot response timestamp for a session.
     */
    _updateLastBotTs(sessionKey, ts) {
        this._stmts.updateLastBotTs.run(ts, Date.now(), sessionKey);
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
            this._clearReconnectTimer();
        });

        client.on('disconnected', () => {
            this.connected = false;
            this.logger.warn('Socket Mode disconnected');
            this._startReconnectTimer();
        });

        client.on('error', (error) => {
            this.logger.error(`Socket Mode error: ${error.message}`);
        });

        client.on('close', (code, reason) => {
            this.connected = false;
            this.logger.warn(`Socket Mode closed: code=${code} reason=${reason || 'none'}`);
            this._startReconnectTimer();
        });
    }

    _startReconnectTimer() {
        if (this._reconnectTimer) return;
        this.logger.info(`Reconnect watchdog: will force restart in ${this._reconnectDelay / 1000}s if still disconnected`);
        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null;
            if (this.connected) return;
            this.logger.warn('Reconnect watchdog fired — forcing full restart of Bolt app');
            try {
                await this.app.stop();
                await this.app.start();
                this.connected = true;
                this.logger.info('Bolt app restarted successfully');
            } catch (err) {
                this.logger.error(`Bolt app restart failed: ${err.message}`);
            }
        }, this._reconnectDelay);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    _setupListeners() {
        this.app.event('app_mention', async ({ event, say }) => {
            try {
                await this._handleMention(event, say);
            } catch (err) {
                if (err.message && (err.message.includes('no active connection') || err.message.includes('client is not ready'))) {
                    this.logger.warn(`Mention handler failed (disconnected): ${err.message}`);
                } else {
                    throw err;
                }
            }
        });

        // Listen for all messages in monitored channels
        this.app.event('message', async ({ event }) => {
            try {
                await this._handleMonitoredMessage(event);
            } catch (err) {
                if (err.message && (err.message.includes('no active connection') || err.message.includes('client is not ready'))) {
                    this.logger.warn(`Message handler failed (disconnected): ${err.message}`);
                } else {
                    throw err;
                }
            }
        });
    }

    async _handleMonitoredMessage(event) {
        // Filter out message edits and subtypes (joins, topic changes, etc.)
        if (event.subtype) return;

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

        const result = await this.alertWorkflow.startAlertWorkflow({
            channelId,
            messageTs,
            text,
            incidentId,
            files: event.files
        });

        if (result.started) {
            this.logger.info(`Alert workflow started for ${messageTs}`);
        } else {
            this.logger.info(`Alert workflow skipped for ${messageTs}: ${result.reason}`);
        }
    }

    async _handleMention(event, say) {
        const userId = event.user;
        const channelId = event.channel;
        const threadTs = event.thread_ts || event.ts;
        const rawText = event.text || '';

        this.logger.info(`Mention received | user=${userId} channel=${channelId} thread=${threadTs} text="${rawText.substring(0, 100)}"`);

        if (!this._isOwner(userId)) {
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

        // Check if this is an alert workflow thread
        const alertThreadTs = event.thread_ts; // The root message ts of the thread
        if (alertThreadTs && this.alertWorkflow.isActive(alertThreadTs)) {
            if (text === '/exit') {
                await this.alertWorkflow.handleExit(alertThreadTs);
                await say({ text: 'Alert investigation session ended. :wave:', thread_ts: threadTs });
                return;
            }
            // Forward follow-up messages to the alert workflow
            const handled = await this.alertWorkflow.handleFollowUp(alertThreadTs, text);
            if (handled) {
                this.logger.info(`Follow-up forwarded to alert workflow: ${alertThreadTs}`);
                return;
            }
        }

        await this._processCommand(channelId, threadTs, text, say);
    }

    // ─── Command Processing ──────────────────────────────────────────

    async _processCommand(channelId, threadTs, command, say) {
        const sessionKey = `${channelId}-${threadTs}`;
        let session = this._getSession(sessionKey);
        let threadContext = null; // Will hold formatted thread messages to prepend

        try {
            if (session && this._isTmuxSessionAlive(session.sessionName)) {
                // Existing session — fetch only messages since last bot response
                this._touchSession(sessionKey);

                if (session.lastBotTs) {
                    const newMessages = await this._fetchThreadMessages(channelId, threadTs, session.lastBotTs);
                    if (newMessages.length > 0) {
                        threadContext = await this._formatThreadContext(newMessages);
                        this.logger.info(`Thread context (since ${session.lastBotTs}): ${newMessages.length} messages`);
                    }
                }
            } else if (session && !this._isTmuxSessionAlive(session.sessionName)) {
                // Session in DB but tmux died — recreate with full thread context
                this.logger.warn(`Tmux session ${session.sessionName} is dead, recreating...`);
                await say({ text: 'Previous Claude session ended. Starting a new one... :rocket:', thread_ts: threadTs });

                const created = await this._createTmuxSession(
                    session.sessionName,
                    session.repoPath,
                    this.config.claudeCommand || 'claude --dangerously-skip-permissions'
                );
                if (!created) {
                    await say({ text: 'Failed to create Claude session. Is tmux installed?', thread_ts: threadTs });
                    this._deleteSession(sessionKey);
                    return;
                }
                this._touchSession(sessionKey);

                // Fetch full thread context since session was recreated
                const allMessages = await this._fetchThreadMessages(channelId, threadTs);
                if (allMessages.length > 0) {
                    threadContext = await this._formatThreadContext(allMessages);
                    this.logger.info(`Full thread context (recreated session): ${allMessages.length} messages`);
                }
            } else {
                // Brand new conversation
                const sessionName = this._generateSessionName(channelId, threadTs);
                const claudeCmd = this.config.claudeCommand || 'claude --dangerously-skip-permissions';

                // Resolve repo path — check for project name patterns
                // Supported: "start claude from root" (uses SLACK_REPO_ROOT directly),
                //            "project XXX from root", "start claude from XXX project",
                //            "start claude from XXX", "start claude in XXX project", etc.
                let repoPath = this.config.repoPath || process.cwd();
                const rootMatch = command.match(/start\s+claude\s+(?:from|in)\s+root\s*$/i);
                const projectMatch = !rootMatch && (
                    command.match(
                        /(?:start\s+claude\s+(?:from|in)\s+)?project\s+(\S+)(?:\s+from\s+root)?/i
                    ) || command.match(
                        /start\s+claude\s+(?:from|in)\s+(\S+?)(?:\s+project)?\s*$/i
                    )
                );
                if (rootMatch) {
                    if (this.config.repoRoot) {
                        repoPath = this.config.repoRoot;
                        command = command.replace(/start\s+claude\s+(?:from|in)\s+root\s*$/i, '').trim();
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
                            .replace(/(?:start\s+claude\s+(?:from|in)\s+)?project\s+\S+(?:\s+from\s+root)?[,.]?\s*/i, '')
                            .replace(/start\s+claude\s+(?:from|in)\s+\S+?(?:\s+project)?\s*$/i, '')
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

                // If command was fully consumed by project pattern, default to "hi"
                if (!command) {
                    command = 'hi';
                }

                await say({ text: `Starting Claude session in \`${repoPath}\`... :rocket:`, thread_ts: threadTs });

                const created = await this._createTmuxSession(sessionName, repoPath, claudeCmd);
                if (!created) {
                    await say({ text: 'Failed to create Claude session. Is tmux installed?', thread_ts: threadTs });
                    return;
                }

                session = {
                    sessionName,
                    channelId,
                    threadTs,
                    repoPath,
                    createdAt: Date.now()
                };
                this._saveSession(session);

                // Fetch full thread context for brand new session
                const allMessages = await this._fetchThreadMessages(channelId, threadTs);
                if (allMessages.length > 0) {
                    threadContext = await this._formatThreadContext(allMessages);
                    this.logger.info(`Full thread context (new session): ${allMessages.length} messages`);
                }

                this.logger.info(`New session created: ${sessionName} for channel ${channelId}`);
            }

            // Handle /exit — clean up session
            if (command === '/exit') {
                await this._injectCommand(session.sessionName, command);
                this._deleteSession(sessionKey);
                const pollKey = session.sessionName;
                if (this.pollers.has(pollKey)) {
                    clearInterval(this.pollers.get(pollKey).interval);
                    this.pollers.delete(pollKey);
                }
                await say({ text: 'Claude session ended. :wave:', thread_ts: threadTs });
                return;
            }

            // Build the full command with thread context if available
            let fullCommand = command;
            if (threadContext) {
                fullCommand = `Here is the Slack thread discussion for context:\n\n---\n${threadContext}\n---\n\nMy request: ${command}`;
            }

            // Inject the command into the tmux session
            await this._injectCommand(session.sessionName, fullCommand);
            this.logger.info(`Command injected into ${session.sessionName}: ${fullCommand.substring(0, 120)}`);

            // Commands like /compact don't produce a standard response — just confirm
            if (command.startsWith('/')) {
                await say({ text: `Sent \`${command}\` to Claude session.`, thread_ts: threadTs });
                // Still poll for the eventual response
            }

            // Start polling for response (pass sessionKey for tracking last_bot_ts)
            this._pollForResponse(session, say, sessionKey);

        } catch (error) {
            this.logger.error('Error processing command:', error.message);
            await say({ text: `Error: ${error.message}`, thread_ts: threadTs });
        }
    }

    // ─── Tmux Management ─────────────────────────────────────────────

    _generateSessionName(channelId, threadTs) {
        const suffix = threadTs.replace('.', '').slice(-6);
        return `slack-${channelId.slice(-4)}-${suffix}`;
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
            this.logger.info(`Creating tmux session: ${cmd}`);

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

    async _injectCommand(sessionName, command) {
        return new Promise((resolve, reject) => {
            exec(`tmux send-keys -t ${sessionName} C-u`, (clearErr) => {
                if (clearErr) {
                    reject(new Error(`Failed to clear input: ${clearErr.message}`));
                    return;
                }

                setTimeout(() => {
                    const escaped = command.replace(/'/g, "'\"'\"'");
                    exec(`tmux send-keys -t ${sessionName} '${escaped}'`, (sendErr) => {
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

        if (this.pollers.has(pollKey)) {
            clearInterval(this.pollers.get(pollKey).interval);
        }

        let baselineOutput = this._captureOutput(sessionName);
        let lastOutput = baselineOutput;
        let stableCount = 0;
        let attempts = 0;
        let processing = false;
        const maxAttempts = 600; // 10 minutes per response cycle
        const stableThreshold = 3;

        const interval = setInterval(async () => {
            if (processing) return;

            // Stop if tmux session died
            if (!this._isTmuxSessionAlive(sessionName)) {
                clearInterval(interval);
                this.pollers.delete(pollKey);
                this.logger.info(`Poller stopped: tmux session ${sessionName} is dead`);
                return;
            }

            attempts++;

            if (attempts > maxAttempts) {
                clearInterval(interval);
                this.pollers.delete(pollKey);
                await say({ text: 'Claude session timed out (10 min). Send another message to continue.', thread_ts: threadTs });
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
                // in the 200-line tmux buffer would cause false positives
                const tailText = tailLines.join(' ');
                const isWorking =
                    tailText.includes('Clauding') ||
                    tailText.includes('Working') ||
                    tailText.includes('Processing') ||
                    tailText.includes('⏳') ||
                    tailText.includes('Thinking');

                if (attempts % 10 === 0) {
                    const lastFiveLines = lines.slice(-5).map(l => l.trim()).join(' | ');
                    this.logger.info(`Poll #${attempts} | stable=${stableCount} hasPrompt=${hasPrompt} isWorking=${isWorking} | last5: ${lastFiveLines}`);
                }

                if (hasPrompt && !isWorking) {
                    const response = this._extractResponse(baselineOutput, currentOutput);

                    if (response) {
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

            newLines = anchorEnd >= 0 ? currentLines.slice(anchorEnd) : [];
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
        const maxLen = 2990; // Slack section block text limit is 3000 chars, minus ``` wrapping
        const statsLine = stats
            ? `\n_${stats.model || ''} · Ctx: ${stats.context || '?'} · In: ${stats.tokensIn || '?'} Out: ${stats.tokensOut || '?'}_`
            : '';

        if (response.length <= maxLen) {
            const blocks = [
                { type: 'section', text: { type: 'mrkdwn', text: '```\n' + response + '\n```' } }
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
                    { type: 'section', text: { type: 'mrkdwn', text: '```\n' + chunks[i] + '\n```' } }
                ];
                // Add stats to the last chunk only
                if (i === chunks.length - 1 && statsLine) {
                    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine.trim() }] });
                }
                await say({ text: chunks[i], thread_ts: threadTs, blocks });
            }
        }
    }

    _isOwner(userId) {
        const ownerId = this.config.ownerUserId;
        if (!ownerId) return true; // No owner set = allow all (backwards compat)
        return userId === ownerId;
    }

    // ─── HTTP Server ─────────────────────────────────────────────────

    _setupHttpServer() {
        const httpApp = express();
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
                '/trigger-alert': {
                    post: {
                        summary: 'Manually trigger an alert investigation workflow',
                        requestBody: {
                            required: true,
                            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://wego.slack.com/archives/C07DEF456/p1709123456789012' } } } } }
                        },
                        responses: {
                            '200': { description: 'Investigation started', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, channelId: { type: 'string' }, messageTs: { type: 'string' } } } } } },
                            '400': { description: 'Missing/invalid URL or bad JSON' },
                            '405': { description: 'Wrong HTTP method' },
                            '409': { description: 'Workflow already active for this message' },
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
                    }
                }
            }
        };

        const swaggerUi = require('swagger-ui-express');
        httpApp.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

        httpApp.get('/', (req, res) => {
            const sessions = this._getAllSessions();
            const aliveSessions = sessions.filter(s => this._isTmuxSessionAlive(s.sessionName));
            res.json({
                status: this.connected ? 'ok' : 'degraded',
                service: 'claude-code-remote-slack',
                socketConnected: this.connected,
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

        // ─── Trigger Alert ─────────────────────────────────────
        httpApp.post('/trigger-alert', async (req, res) => {
            if (!this.app) {
                return res.status(503).json({ error: 'Slack app not initialized yet' });
            }

            const { url } = req.body || {};
            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid "url" field. Provide a Slack message permalink.' });
            }

            const parsed = AlertWorkflow.parseSlackUrl(url);
            if (!parsed) {
                return res.status(400).json({ error: 'Invalid Slack message URL format. Expected: https://<workspace>.slack.com/archives/<channel>/p<timestamp>' });
            }

            const { channelId, messageTs } = parsed;
            this.logger.info(`Trigger-alert received: channelId=${channelId} messageTs=${messageTs}`);

            // Check for duplicate
            if (this.alertWorkflow.isActive(messageTs)) {
                this.logger.info(`Trigger-alert blocked: workflow already active for messageTs=${messageTs}`);
                return res.status(409).json({ error: 'Workflow already active for this message', channelId, messageTs });
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

                const result = await this.alertWorkflow.startAlertWorkflow({
                    channelId,
                    messageTs,
                    text,
                    incidentId,
                    force: true,
                    files: message.files
                });

                if (result.started) {
                    this.logger.info(`Trigger-alert started workflow for messageTs=${messageTs}`);
                    res.json({ status: 'investigating', channelId, messageTs });
                } else {
                    this.logger.info(`Trigger-alert workflow not started: ${result.reason} for messageTs=${messageTs}`);
                    res.status(409).json({ status: result.reason, channelId, messageTs });
                }
            } catch (error) {
                this.logger.error(`Trigger alert error: ${error.message}`);
                res.status(500).json({ error: error.message });
            }
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

        this._httpApp = httpApp;
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

        // Reconcile DB sessions with live tmux sessions
        this._reconcileSessions();
        this.logger.info(`[startup] reconcileSessions: ${Date.now() - t0}ms`);

        const t1 = Date.now();
        await this.app.start();
        this.connected = true;
        this._setupConnectionMonitor();
        this.logger.info(`[startup] Slack Socket Mode connected: ${Date.now() - t1}ms`);

        // Resolve monitored channels and recover alert workflows
        const t2 = Date.now();
        await this.alertMonitor.resolveMonitorChannels();
        this.logger.info(`[startup] resolveMonitorChannels: ${Date.now() - t2}ms`);

        const t3 = Date.now();
        await this.alertWorkflow.recoverWorkflows();
        this.logger.info(`[startup] recoverWorkflows: ${Date.now() - t3}ms`);

        this.httpServer = this._httpApp.listen(this.httpPort, () => {
            this.logger.info(`[startup] HTTP API on port ${this.httpPort}`);
            this.logger.info(`[startup] total: ${Date.now() - t0}ms`);
        });
    }

    async stop() {
        this._clearReconnectTimer();

        if (this.httpServer) {
            this.httpServer.close();
        }

        for (const [key, poller] of this.pollers) {
            clearInterval(poller.interval);
        }
        this.pollers.clear();

        // NOTE: We do NOT kill tmux sessions on stop.
        // They persist so conversations can resume after restart.

        // Clean up alert workflow timers (but preserve tmux sessions for recovery)
        if (this.alertWorkflow) {
            for (const [, wf] of this.alertWorkflow.activeWorkflows) {
                if (wf.feedbackTimer) clearTimeout(wf.feedbackTimer);
            }
        }

        if (this.db) {
            this.db.close();
        }

        await this.app.stop();
        this.logger.info('Slack Socket Mode disconnected (tmux sessions preserved)');
    }
}

module.exports = SlackSocketHandler;
