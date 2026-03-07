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
const Logger = require('../../core/logger');

class SlackSocketHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('SlackSocket');

        // Polling state per session (in-memory only, rebuilt on start)
        this.pollers = new Map();

        this.app = new App({
            token: config.botToken,
            appToken: config.appToken,
            socketMode: true
        });

        this.httpPort = config.httpPort || 9999;
        this.httpServer = null;

        this._initDb();
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
                updated_at    INTEGER NOT NULL
            )
        `);

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
            touch: this.db.prepare('UPDATE sessions SET updated_at = ? WHERE session_key = ?')
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
            createdAt: row.created_at
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

    // ─── Slack Event Listeners ───────────────────────────────────────

    _setupListeners() {
        this.app.event('app_mention', async ({ event, say }) => {
            await this._handleMention(event, say);
        });
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

        const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();
        if (!text) {
            await say({ text: 'Please provide a message after mentioning me.', thread_ts: threadTs });
            return;
        }

        await this._processCommand(channelId, threadTs, text, say);
    }

    // ─── Command Processing ──────────────────────────────────────────

    async _processCommand(channelId, threadTs, command, say) {
        const sessionKey = `${channelId}-${threadTs}`;
        let session = this._getSession(sessionKey);

        try {
            if (session && this._isTmuxSessionAlive(session.sessionName)) {
                // Existing session — update timestamp
                this._touchSession(sessionKey);
            } else if (session && !this._isTmuxSessionAlive(session.sessionName)) {
                // Session in DB but tmux died — recreate
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
            } else {
                // Brand new conversation
                await say({ text: 'Starting Claude session... :rocket:', thread_ts: threadTs });

                const sessionName = this._generateSessionName(channelId, threadTs);
                const repoPath = this.config.repoPath || process.cwd();
                const claudeCmd = this.config.claudeCommand || 'claude --dangerously-skip-permissions';

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

            // Inject the command into the tmux session
            await this._injectCommand(session.sessionName, command);
            this.logger.info(`Command injected into ${session.sessionName}: ${command.substring(0, 80)}`);

            // Commands like /compact don't produce a standard response — just confirm
            if (command.startsWith('/')) {
                await say({ text: `Sent \`${command}\` to Claude session.`, thread_ts: threadTs });
                // Still poll for the eventual response
            }

            // Start polling for response
            this._pollForResponse(session, say);

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
            const cmd = `tmux new-session -d -s ${sessionName} -c "${repoPath}" "${claudeCmd}"`;
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

    _pollForResponse(session, say) {
        const { sessionName, threadTs } = session;
        const pollKey = sessionName;

        if (this.pollers.has(pollKey)) {
            clearInterval(this.pollers.get(pollKey).interval);
        }

        const baselineOutput = this._captureOutput(sessionName);
        let lastOutput = baselineOutput;
        let stableCount = 0;
        let attempts = 0;
        const maxAttempts = 600; // 10 minutes
        const stableThreshold = 3;

        const interval = setInterval(async () => {
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

                const isWorking =
                    currentOutput.includes('Clauding') ||
                    currentOutput.includes('Working') ||
                    currentOutput.includes('Processing') ||
                    currentOutput.includes('⏳') ||
                    currentOutput.includes('Thinking');

                if (attempts % 10 === 0) {
                    const lastFiveLines = lines.slice(-5).map(l => l.trim()).join(' | ');
                    this.logger.info(`Poll #${attempts} | stable=${stableCount} hasPrompt=${hasPrompt} isWorking=${isWorking} | last5: ${lastFiveLines}`);
                }

                if (hasPrompt && !isWorking) {
                    clearInterval(interval);
                    this.pollers.delete(pollKey);

                    const response = this._extractResponse(baselineOutput, currentOutput);
                    const sessionStats = this._extractSessionStats(currentOutput);
                    this.logger.info(`Response extracted (${response ? response.length : 0} chars): "${(response || '').substring(0, 200)}"`);
                    if (response) {
                        await this._sendResponse(say, threadTs, response, sessionStats);
                        this.logger.info(`Response sent to Slack thread ${threadTs}`);
                    } else {
                        this.logger.warn(`No response extracted. Baseline lines: ${baselineOutput.split('\n').length}, Current lines: ${currentOutput.split('\n').length}`);
                    }
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

        let diffStart = 0;
        for (let i = 0; i < Math.min(baseLines.length, currentLines.length); i++) {
            if (baseLines[i] !== currentLines[i]) {
                diffStart = i;
                break;
            }
            diffStart = i + 1;
        }

        const newLines = currentLines.slice(diffStart);
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
            // Match: Model: Opus 4.6⎇ mainCtx(u): 12.2% | In: 6Out: 26 | Cost: $0.24
            const modelMatch = line.match(/Model:\s*(.+?)(?:⎇|$)/);
            if (modelMatch) stats.model = modelMatch[1].trim();

            const ctxMatch = line.match(/Ctx\(u\):\s*([\d.]+%)/);
            if (ctxMatch) stats.context = ctxMatch[1];

            const inMatch = line.match(/In:\s*([\d,]+)/);
            if (inMatch) stats.tokensIn = inMatch[1];

            const outMatch = line.match(/Out:\s*([\d,]+)/);
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
        const maxLen = 3900;
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
                '/health': {
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

        httpApp.get('/health', (req, res) => {
            const sessions = this._getAllSessions();
            const aliveSessions = sessions.filter(s => this._isTmuxSessionAlive(s.sessionName));
            res.json({
                status: 'ok',
                service: 'claude-code-remote-slack',
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
        // Reconcile DB sessions with live tmux sessions
        this._reconcileSessions();

        await this.app.start();
        this.logger.info('Slack Socket Mode connected');

        this.httpServer = this._httpApp.listen(this.httpPort, () => {
            this.logger.info(`HTTP API server started on port ${this.httpPort}`);
            this.logger.info(`Swagger docs: http://localhost:${this.httpPort}/docs`);
        });
    }

    async stop() {
        if (this.httpServer) {
            this.httpServer.close();
        }

        for (const [key, poller] of this.pollers) {
            clearInterval(poller.interval);
        }
        this.pollers.clear();

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
