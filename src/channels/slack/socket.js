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
        this._reconnectTimer = null;
        this._reconnectDelay = 30000; // 30s watchdog

        this._initDb();

        // Alert monitoring
        this.alertMonitor = new AlertMonitor(this.app, config);
        this.trackedIncidents = new Set();

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

        this._stmts = {
            upsert: this.db.prepare(`
                INSERT INTO sessions (session_key, session_name, channel_id, thread_ts, repo_path, created_at, updated_at, alert_message_ts)
                VALUES (@session_key, @session_name, @channel_id, @thread_ts, @repo_path, @created_at, @updated_at, @alert_message_ts)
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
            alertMessageTs: row.alert_message_ts || null
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
            alertMessageTs: row.alert_message_ts || null
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
            this.logger.debug('Socket Mode connected');
            this._clearReconnectTimer();
        });

        client.on('disconnected', () => {
            this.connected = false;
            this.logger.debug('Socket Mode disconnected');
            this._startReconnectTimer();
        });

        client.on('error', (error) => {
            this.logger.debug(`Socket Mode error: ${error.message}`);
        });

        client.on('close', (code, reason) => {
            this.connected = false;
            this.logger.debug(`Socket Mode closed: code=${code} reason=${reason || 'none'}`);
            this._startReconnectTimer();
        });
    }

    _startReconnectTimer() {
        if (this._reconnectTimer) return;
        this.logger.debug(`Reconnect watchdog: will force restart in ${this._reconnectDelay / 1000}s if still disconnected`);
        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null;
            if (this.connected) return;
            this.logger.debug('Reconnect watchdog fired — forcing full restart of Bolt app');
            try {
                await this.app.stop();
                await this.app.start();
                this.connected = true;
                this.logger.debug('Bolt app restarted successfully');
            } catch (err) {
                this.logger.debug(`Bolt app restart failed: ${err.message}`);
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
                await this._handleDelayAlertMessage(event);
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

        if (incidentId) this.trackedIncidents.add(incidentId);

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
        // Filter out message edits and subtypes
        if (event.subtype) return;

        const channelId = event.channel;
        if (!this.delayAlertMonitor.isMonitoredChannel(channelId)) return;

        // Detect Airflow delay alerts
        if (!this.delayAlertMonitor.isAirflowDelayAlert(event)) return;

        const alertInfo = this.delayAlertMonitor.extractAlertInfo(event);
        if (!alertInfo) return;

        // Check task pattern match
        if (!this.delayAlertMonitor.matchesTaskPattern(alertInfo.task)) {
            this.logger.info(`Delay alert skipped (pattern mismatch): task=${alertInfo.task} dag=${alertInfo.dag}`);
            return;
        }

        const messageTs = event.ts;
        this.logger.info(`Delay alert detected: dag=${alertInfo.dag} task=${alertInfo.task} ts=${messageTs}`);

        // Increment counter (persisted to SQLite)
        const { count, triggered } = this.delayAlertMonitor.incrementCounter(alertInfo.dag, channelId, messageTs);

        if (!triggered) return;

        // Threshold reached — trigger investigation
        this.logger.info(`Delay alert threshold reached for ${alertInfo.dag} (${count} alerts) — triggering investigation`);

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

        await this._processCommand(channelId, threadTs, text, say, event.ts);
    }

    // ─── Command Processing ──────────────────────────────────────────

    async _processCommand(channelId, threadTs, command, say, messageTs, alertMessageTs = null) {
        // Create a say function if one wasn't provided (e.g. alert triggers)
        if (!say) {
            say = async (msg) => {
                await this.app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, ...msg });
            };
        }
        const sessionKey = `${channelId}-${threadTs}`;
        let session = this._getSession(sessionKey);
        let threadContext = null; // Will hold formatted thread messages to prepend

        try {
            if (session && this._isTmuxSessionAlive(session.sessionName)) {
                // Existing session — fetch only messages since last bot response
                this._touchSession(sessionKey);
                this._startSessionTimeout(sessionKey);

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

                if (!alertMessageTs) {
                    await say({ text: `Starting Claude session in \`${repoPath}\`... :rocket:`, thread_ts: threadTs });
                }

                const created = await this._createTmuxSession(sessionName, repoPath, claudeCmd);
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

                // Fetch full thread context for brand new session
                const allMessages = await this._fetchThreadMessages(channelId, threadTs);
                if (allMessages.length > 0) {
                    threadContext = await this._formatThreadContext(allMessages);
                    this.logger.info(`Full thread context (new session): ${allMessages.length} messages`);
                }

                this.logger.info(`New session created: ${sessionName} for channel ${channelId}`);
                this._startSessionTimeout(sessionKey);
            }

            // Handle /exit — clean up session
            if (command === '/exit') {
                await this._injectCommand(session.sessionName, command);
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
            await this._injectCommand(session.sessionName, fullCommand);
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
        const isAlertSession = !!session.alertMessageTs;
        let isFirstResponse = isAlertSession; // only true for the very first response of an alert

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
                this.logger.info(`Poller stopped: tmux session ${sessionName} is dead`);
                return;
            }

            attempts++;

            if (attempts > maxAttempts) {
                clearInterval(interval);
                this.pollers.delete(pollKey);
                this.logger.warn(`Poller timeout after ${maxAttempts}s for ${sessionName} (alert=${isAlertSession})`);
                try {
                    await say({ text: 'Claude session timed out. Send another message to continue.', thread_ts: threadTs });
                } catch (err) {
                    this.logger.error(`Failed to send timeout message: ${err.message}`);
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

                            if (isFirstResponse) {
                                // Alert first response: post summary + upload full report as file
                                await this._sendAlertSummary(say, threadTs, response, sessionStats);
                                isFirstResponse = false;
                            } else {
                                await this._sendResponse(say, threadTs, response, sessionStats);
                            }
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

        const timeoutMs = this.config.sessionInactivityTimeoutMs || 300000;
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

            // Alert sessions only: swap 👀 → ✅
            if (session.alertMessageTs) {
                await this._removeReaction(session.channelId, session.alertMessageTs, 'eyes');
                await this._addReaction(session.channelId, session.alertMessageTs, 'white_check_mark');
            }

            this._deleteSession(sessionKey);
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

    /**
     * Extract the Recommended Action section from an alert investigation response.
     * Looks for text between "Recommended Action:" and the next "---" or section boundary.
     */
    _extractRecommendedAction(response) {
        // Match "Recommended Action:" followed by content, up to next "---" or end
        const match = response.match(/Recommended Action:\s*([\s\S]*?)(?:\n\s*---|\n\n##|\n\n\*\*|$)/i);
        if (match) {
            return match[1].trim();
        }
        // Fallback: return first 500 chars
        return response.substring(0, 500).trim();
    }

    /**
     * Send alert summary: Recommended Action as Slack message + full report as file upload.
     */
    async _sendAlertSummary(say, threadTs, response, stats) {
        const summary = this._extractRecommendedAction(response);
        const statsLine = stats
            ? `\n_${stats.model || ''} · Ctx: ${stats.context || '?'} · In: ${stats.tokensIn || '?'} Out: ${stats.tokensOut || '?'}_`
            : '';

        // Post the summary (Recommended Action only)
        const blocks = [
            { type: 'section', text: { type: 'mrkdwn', text: `*Recommended Action:* ${summary}` } }
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

        httpApp.get('/sessions', (req, res) => {
            const sessions = this._getAllSessions().map(s => ({
                ...s,
                tmuxAlive: this._isTmuxSessionAlive(s.sessionName),
                createdAt: new Date(s.createdAt).toISOString(),
                updatedAt: new Date(s.updatedAt).toISOString()
            }));
            res.json({ sessions });
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

        // Re-initialize DB if it was closed (e.g. after stop() during daily restart)
        if (!this.db || !this.db.open) {
            this._initDb();
            // Re-init delay alert monitor's DB reference and counters table
            this.delayAlertMonitor.db = this.db;
            this.delayAlertMonitor._initCountersTable();
        }

        // Reconcile DB sessions with live tmux sessions
        await this._reconcileSessions();
        this.logger.info(`[startup] reconcileSessions: ${Date.now() - t0}ms`);

        const t1 = Date.now();
        await this.app.start();
        this.connected = true;
        this._setupConnectionMonitor();
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
    }

    async stop() {
        this._clearReconnectTimer();

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
