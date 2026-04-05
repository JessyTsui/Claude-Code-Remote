/**
 * Delay Alert Monitor
 * Watches configured Slack channels for Airflow task delay alerts.
 * When alerts for a specific DAG exceed the threshold within the time window,
 * triggers an investigation workflow.
 */

const Logger = require('../../core/logger');

class DelayAlertMonitor {
    constructor(app, db, config = {}) {
        this.app = app;
        this.db = db;
        this.config = config;
        this.logger = new Logger('DelayAlertMonitor');

        // Map<channelName, channelId> resolved at startup
        this.monitoredChannels = new Map();
        this.monitoredChannelIds = new Set();

        // Config
        this.threshold = parseInt(config.delayAlertThreshold) || 3;
        this.windowMs = parseInt(config.delayAlertWindowMs) || 3600000; // 1hr
        this.taskPatterns = this._parsePatterns(config.delayAlertTaskPatterns);
        this.skill = config.delayAlertSkill || 'one:pay-ops-tax-production';

        this._initCountersTable();
    }

    /**
     * Parse DELAY_ALERT_TASK_PATTERNS into lowercase substrings for matching.
     */
    _parsePatterns(envValue) {
        if (!envValue || !envValue.trim()) return [];
        return envValue.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
    }

    /**
     * Create the alert_counters table if it doesn't exist.
     */
    _initCountersTable() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS alert_counters (
                dag_name       TEXT PRIMARY KEY,
                count          INTEGER NOT NULL DEFAULT 0,
                first_seen_at  INTEGER NOT NULL,
                last_message_ts TEXT,
                channel_id     TEXT
            )
        `);

        this._counterStmts = {
            get: this.db.prepare('SELECT * FROM alert_counters WHERE dag_name = ?'),
            upsert: this.db.prepare(`
                INSERT INTO alert_counters (dag_name, count, first_seen_at, last_message_ts, channel_id)
                VALUES (@dag_name, @count, @first_seen_at, @last_message_ts, @channel_id)
                ON CONFLICT(dag_name) DO UPDATE SET
                    count = @count,
                    first_seen_at = @first_seen_at,
                    last_message_ts = @last_message_ts,
                    channel_id = @channel_id
            `),
            delete: this.db.prepare('DELETE FROM alert_counters WHERE dag_name = ?'),
            all: this.db.prepare('SELECT * FROM alert_counters'),
        };
    }

    /**
     * Parse MONITOR_DELAY_CHANNELS env var.
     * Same format as MONITOR_CHANNELS: comma-separated names, ! prefix to exclude.
     */
    static parseChannelList(envValue) {
        if (!envValue || !envValue.trim()) return { include: [], exclude: [] };

        const include = [];
        const exclude = [];

        for (const raw of envValue.split(',')) {
            const name = raw.trim();
            if (!name) continue;
            if (name.startsWith('!')) {
                exclude.push(name.slice(1));
            } else {
                include.push(name);
            }
        }

        return { include, exclude };
    }

    /**
     * Resolve channel names → IDs via Slack API.
     */
    async resolveMonitorChannels() {
        const { include, exclude } = DelayAlertMonitor.parseChannelList(this.config.monitorDelayChannels);

        if (include.length === 0) {
            this.logger.info('No MONITOR_DELAY_CHANNELS configured — delay alert monitoring disabled');
            return;
        }

        this.logger.info(`Resolving delay monitor channels: include=[${include.join(',')}] exclude=[${exclude.join(',')}]`);
        this.logger.info(`Config: threshold=${this.threshold}, window=${this.windowMs}ms, patterns=[${this.taskPatterns.join(',')}], skill=${this.skill}`);

        const unresolved = new Set(include.filter(n => !exclude.includes(n)));
        let cursor;

        try {
            do {
                const result = await this.app.client.conversations.list({
                    types: 'public_channel,private_channel',
                    limit: 1000,
                    exclude_archived: true,
                    cursor
                });

                for (const channel of (result.channels || [])) {
                    if (unresolved.has(channel.name)) {
                        this.monitoredChannels.set(channel.name, channel.id);
                        this.monitoredChannelIds.add(channel.id);
                        unresolved.delete(channel.name);
                        this.logger.info(`Resolved delay channel: #${channel.name} → ${channel.id}`);

                        // Auto-join so the bot receives message events
                        if (!channel.is_member) {
                            try {
                                await this.app.client.conversations.join({ channel: channel.id });
                                this.logger.info(`Joined delay channel: #${channel.name}`);
                            } catch (joinErr) {
                                this.logger.warn(`Failed to join #${channel.name}: ${joinErr.message}`);
                            }
                        }
                    }
                }

                if (unresolved.size === 0) break;
                cursor = result.response_metadata?.next_cursor;
            } while (cursor);
        } catch (error) {
            this.logger.error(`Failed to resolve delay channels: ${error.message}`);
        }

        for (const name of unresolved) {
            this.logger.warn(`Could not resolve delay channel: #${name}`);
        }

        this.logger.info(`Delay monitoring ${this.monitoredChannels.size} channel(s)`);
    }

    /**
     * Check if a channel ID is being monitored for delay alerts.
     */
    isMonitoredChannel(channelId) {
        return this.monitoredChannelIds.has(channelId);
    }

    /**
     * Detect if a Slack message is an Airflow delay alert.
     * Matches messages containing *Task*:, *Dag*:, *Execution Time*: patterns.
     */
    isAirflowDelayAlert(event) {
        const text = event.text || '';
        // Check for Airflow delay alert patterns (with or without bold markdown)
        const hasTask = /\*?Task\*?\s*:/i.test(text);
        const hasDag = /\*?Dag\*?\s*:/i.test(text);
        const hasExecTime = /\*?Execution Time\*?\s*:/i.test(text);

        // Must have at least Task and Dag to be considered an Airflow alert
        return hasTask && hasDag && hasExecTime;
    }

    /**
     * Extract Task and Dag names from an Airflow delay alert message.
     * Returns { task, dag } or null if not parseable.
     */
    extractAlertInfo(event) {
        const text = event.text || '';

        const taskMatch = text.match(/\*?Task\*?\s*:\s*(.+?)(?:\n|$)/i);
        const dagMatch = text.match(/\*?Dag\*?\s*:\s*(.+?)(?:\n|$)/i);

        if (!taskMatch || !dagMatch) return null;

        return {
            task: taskMatch[1].trim(),
            dag: dagMatch[1].trim(),
        };
    }

    /**
     * Check if the task name matches any configured patterns.
     * If no patterns configured, all tasks match.
     */
    matchesTaskPattern(taskName) {
        if (this.taskPatterns.length === 0) return true;
        const lower = taskName.toLowerCase();
        return this.taskPatterns.some(pattern => lower.includes(pattern));
    }

    /**
     * Increment counter for a DAG and return the new count.
     * Resets counter if the time window has expired.
     * Returns { count, triggered } where triggered=true if threshold just reached.
     */
    incrementCounter(dagName, channelId, messageTs) {
        const now = Date.now();
        const existing = this._counterStmts.get.get(dagName);

        if (existing) {
            const elapsed = now - existing.first_seen_at;

            if (elapsed > this.windowMs) {
                // Window expired — reset counter
                this.logger.info(`Counter for ${dagName} expired (${Math.round(elapsed / 1000)}s > ${Math.round(this.windowMs / 1000)}s) — resetting`);
                this._counterStmts.upsert.run({
                    dag_name: dagName,
                    count: 1,
                    first_seen_at: now,
                    last_message_ts: messageTs,
                    channel_id: channelId,
                });
                return { count: 1, triggered: false };
            }

            // Within window — increment
            const newCount = existing.count + 1;
            this._counterStmts.upsert.run({
                dag_name: dagName,
                count: newCount,
                first_seen_at: existing.first_seen_at,
                last_message_ts: messageTs,
                channel_id: channelId,
            });

            const triggered = newCount === this.threshold;
            this.logger.info(`Counter for ${dagName}: ${newCount}/${this.threshold}${triggered ? ' — THRESHOLD REACHED' : ` — ${this.threshold - newCount} more to trigger`}`);
            return { count: newCount, triggered };
        }

        // First occurrence
        this._counterStmts.upsert.run({
            dag_name: dagName,
            count: 1,
            first_seen_at: now,
            last_message_ts: messageTs,
            channel_id: channelId,
        });
        this.logger.info(`Counter for ${dagName}: 1/${this.threshold} — ${this.threshold - 1} more to trigger (new)`);
        return { count: 1, triggered: this.threshold === 1 };
    }

    /**
     * Reset counter for a DAG (after investigation triggered).
     */
    resetCounter(dagName) {
        this._counterStmts.delete.run(dagName);
        this.logger.info(`Counter reset for ${dagName}`);
    }

    /**
     * Get all active counters (for debugging/status).
     */
    getAllCounters() {
        return this._counterStmts.all.all();
    }
}

module.exports = DelayAlertMonitor;
