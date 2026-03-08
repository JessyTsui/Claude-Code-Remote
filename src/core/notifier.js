/**
 * Claude-Code-Remote Core Notifier
 * Central notification orchestrator — Slack only
 */

const Logger = require('./logger');
const ConfigManager = require('./config');

class Notifier {
    constructor(configManager = null) {
        this.logger = new Logger('Notifier');
        this.config = configManager || new ConfigManager();
        this.channels = new Map();
        this.i18n = null;

        this._loadI18n();
    }

    registerChannel(name, channel) {
        this.logger.debug(`Registering channel: ${name}`);
        this.channels.set(name, channel);
    }

    async initializeChannels() {
        this.logger.debug('Initializing channels...');

        const SlackChannel = require('../channels/slack/slack');
        const slackConfig = this.config.getChannel('slack');
        if (slackConfig && slackConfig.enabled) {
            const slack = new SlackChannel(slackConfig.config || {});
            this.registerChannel('slack', slack);
        }

        this.logger.info(`Initialized ${this.channels.size} channels`);
    }

    async notify(type, metadata = {}) {
        if (!this.config.get('enabled', true)) {
            this.logger.debug('Notifications disabled');
            return { success: false, reason: 'disabled' };
        }

        const notification = this._buildNotification(type, metadata);
        this.logger.info(`Sending ${type} notification for project: ${notification.project}`);

        const results = {};
        const promises = [];

        for (const [name, channel] of this.channels) {
            if (channel.enabled) {
                promises.push(
                    channel.send(notification)
                        .then(success => ({ name, success }))
                        .catch(error => ({ name, success: false, error: error.message }))
                );
            } else {
                results[name] = { success: false, reason: 'disabled' };
            }
        }

        const channelResults = await Promise.all(promises);
        channelResults.forEach(result => {
            results[result.name] = result;
        });

        const successCount = Object.values(results).filter(r => r.success).length;
        this.logger.info(`Notification sent to ${successCount}/${this.channels.size} channels`);

        return {
            success: successCount > 0,
            results,
            notification
        };
    }

    _buildNotification(type, metadata = {}) {
        const project = metadata.project || this.config.getProjectName();
        const lang = this.config.get('language', 'en');
        const content = this._getNotificationContent(type, lang);

        const message = content.message.replace('{project}', project);
        const customMessage = this.config.get(`customMessages.${type}`);
        const finalMessage = customMessage ? customMessage.replace('{project}', project) : message;

        return {
            type,
            title: content.title,
            message: finalMessage,
            project,
            metadata: {
                timestamp: new Date().toISOString(),
                language: lang,
                ...metadata
            }
        };
    }

    _getNotificationContent(type, lang) {
        if (!this.i18n) {
            this._loadI18n();
        }

        const langData = this.i18n[lang] || this.i18n['en'];
        return langData[type] || langData.completed;
    }

    _loadI18n() {
        this.i18n = {
            'en': {
                completed: {
                    title: 'Claude Code - Task Completed',
                    message: '[{project}] Task completed, Claude is waiting for next instruction'
                },
                waiting: {
                    title: 'Claude Code - Waiting for Input',
                    message: '[{project}] Claude needs your further guidance'
                }
            }
        };
    }

    async test() {
        this.logger.info('Testing all channels...');

        const results = {};
        for (const [name, channel] of this.channels) {
            try {
                const success = await channel.test();
                results[name] = { success };
                this.logger.info(`Channel ${name}: ${success ? 'PASS' : 'FAIL'}`);
            } catch (error) {
                results[name] = { success: false, error: error.message };
                this.logger.error(`Channel ${name}: ERROR - ${error.message}`);
            }
        }

        return results;
    }

    getStatus() {
        const channels = {};
        for (const [name, channel] of this.channels) {
            channels[name] = channel.getStatus();
        }

        return {
            enabled: this.config.get('enabled', true),
            channels,
            config: {
                language: this.config.get('language'),
                customMessages: this.config.get('customMessages')
            }
        };
    }
}

module.exports = Notifier;
