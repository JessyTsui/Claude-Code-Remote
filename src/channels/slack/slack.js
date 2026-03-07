/**
 * Slack Notification Channel
 * Sends notifications via Slack Bot using @slack/bolt
 */

const NotificationChannel = require('../base/channel');

class SlackChannel extends NotificationChannel {
    constructor(config = {}) {
        super('slack', config);
        this._validateConfig();
    }

    _validateConfig() {
        if (!this.config.botToken) {
            this.logger.warn('SLACK_BOT_TOKEN not found');
            return false;
        }
        if (!this.config.channelId) {
            this.logger.warn('SLACK_CHANNEL_ID not found');
            return false;
        }
        return true;
    }

    async _sendImpl(notification) {
        if (!this._validateConfig()) {
            throw new Error('Slack channel not properly configured');
        }

        // Lazy-load to avoid startup cost when channel is disabled
        const { WebClient } = require('@slack/web-api');
        const web = new WebClient(this.config.botToken);

        const emoji = notification.type === 'completed' ? ':white_check_mark:' : ':hourglass_flowing_sand:';
        const status = notification.type === 'completed' ? 'Completed' : 'Waiting for Input';

        const blocks = [
            {
                type: 'header',
                text: { type: 'plain_text', text: `${emoji} Claude Task ${status}` }
            },
            {
                type: 'section',
                fields: [
                    { type: 'mrkdwn', text: `*Project:*\n${notification.project}` },
                    { type: 'mrkdwn', text: `*Time:*\n${new Date().toLocaleTimeString()}` }
                ]
            }
        ];

        if (notification.metadata?.claudeResponse) {
            const response = notification.metadata.claudeResponse.substring(0, 2900);
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: `*Claude Response:*\n${response}` }
            });
        }

        try {
            await web.chat.postMessage({
                channel: this.config.channelId,
                text: `${emoji} Claude Task ${status} - ${notification.project}`,
                blocks,
                thread_ts: this.config.threadTs || undefined
            });

            this.logger.info('Slack message sent successfully');
            return true;
        } catch (error) {
            this.logger.error('Failed to send Slack message:', error.message);
            return false;
        }
    }

    supportsRelay() {
        return true;
    }

    validateConfig() {
        return this._validateConfig();
    }
}

module.exports = SlackChannel;
