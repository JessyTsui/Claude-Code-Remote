/**
 * Alert Monitor
 * Watches configured Slack channels for PagerDuty alert messages
 * and triggers investigation workflows.
 */

const Logger = require('../../core/logger');

class AlertMonitor {
    constructor(app, config = {}) {
        this.app = app;
        this.config = config;
        this.logger = new Logger('AlertMonitor');

        // Map<channelName, channelId> resolved at startup
        this.monitoredChannels = new Map();
        // Reverse map for quick lookup
        this.monitoredChannelIds = new Set();
    }

    /**
     * Parse MONITOR_CHANNELS env var.
     * Format: comma-separated channel names, prefix with ! to exclude.
     * Returns { include: string[], exclude: string[] }
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
     * Resolve channel names → IDs.
     * Uses larger page size, excludes archived, and stops early once all found.
     */
    async resolveMonitorChannels() {
        const { include, exclude } = AlertMonitor.parseChannelList(this.config.monitorChannels);

        if (include.length === 0) {
            this.logger.info('No MONITOR_CHANNELS configured — alert monitoring disabled');
            return;
        }

        this.logger.info(`Resolving monitor channels: include=[${include.join(',')}] exclude=[${exclude.join(',')}]`);

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
                        this.logger.info(`Resolved channel: #${channel.name} → ${channel.id}`);
                    }
                }

                // Stop early if all channels found
                if (unresolved.size === 0) break;

                cursor = result.response_metadata?.next_cursor;
            } while (cursor);
        } catch (error) {
            this.logger.error(`Failed to resolve channels: ${error.message}`);
        }

        // Warn about unresolved channels
        for (const name of unresolved) {
            this.logger.warn(`Could not resolve channel: #${name}`);
        }

        this.logger.info(`Monitoring ${this.monitoredChannels.size} channel(s)`);
    }

    /**
     * Check if a channel ID is being monitored.
     */
    isMonitoredChannel(channelId) {
        return this.monitoredChannelIds.has(channelId);
    }

    /**
     * Detect if a Slack message is from PagerDuty.
     * Checks bot_profile name, username, and PD links in text/attachments.
     */
    isPagerDutyMessage(event) {
        // Check bot profile name
        if (event.bot_profile?.name?.toLowerCase().includes('pagerduty')) return true;

        // Check username
        if (event.username?.toLowerCase().includes('pagerduty')) return true;

        // Check text for PagerDuty links
        const text = event.text || '';
        if (text.includes('pagerduty.com')) return true;

        // Check attachments for PD links
        const attachments = event.attachments || [];
        for (const att of attachments) {
            const fallback = att.fallback || '';
            const attText = att.text || '';
            const title = att.title || '';
            const titleLink = att.title_link || '';
            if (fallback.includes('pagerduty.com') ||
                attText.includes('pagerduty.com') ||
                title.includes('pagerduty.com') ||
                titleLink.includes('pagerduty.com')) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if a PagerDuty message is a status notification (Acknowledged/Resolved)
     * that should be skipped.
     */
    isStatusNotification(event) {
        const text = (event.text || '').trim();
        if (text.startsWith('Acknowledged')) return true;
        if (text.startsWith('Resolved')) return true;
        return false;
    }

    /**
     * Extract PagerDuty incident ID from message text/attachments.
     */
    extractIncidentId(event) {
        const text = event.text || '';
        // Match PD incident URLs like https://xxx.pagerduty.com/incidents/PXXXXXX
        const urlMatch = text.match(/pagerduty\.com\/incidents\/([A-Z0-9]+)/i);
        if (urlMatch) return urlMatch[1];

        // Check attachments
        for (const att of (event.attachments || [])) {
            const link = att.title_link || att.fallback || att.text || '';
            const attMatch = link.match(/pagerduty\.com\/incidents\/([A-Z0-9]+)/i);
            if (attMatch) return attMatch[1];
        }

        return null;
    }
}

module.exports = AlertMonitor;
