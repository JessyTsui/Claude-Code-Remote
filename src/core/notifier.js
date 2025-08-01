/**
 * Claude-Code-Remote Core Notifier
 * Central notification orchestrator that manages multiple channels
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

    /**
     * Register a notification channel
     * @param {string} name - Channel name
     * @param {NotificationChannel} channel - Channel instance
     */
    registerChannel(name, channel) {
        this.logger.debug(`Registering channel: ${name}`);
        this.channels.set(name, channel);
    }

    /**
     * Initialize default channels
     */
    async initializeChannels() {
        this.logger.debug('Initializing channels...');
        
        // Load desktop channel
        const DesktopChannel = require('../channels/local/desktop');
        const desktopConfig = this.config.getChannel('desktop');
        if (desktopConfig && desktopConfig.enabled) {
            const desktop = new DesktopChannel(desktopConfig.config || {});
            desktop.config.completedSound = this.config.get('sound.completed');
            desktop.config.waitingSound = this.config.get('sound.waiting');
            this.registerChannel('desktop', desktop);
        }

        // Load email channel
        const EmailChannel = require('../channels/email/smtp');
        const emailConfig = this.config.getChannel('email');
        if (emailConfig && emailConfig.enabled) {
            const email = new EmailChannel(emailConfig.config || {});
            this.registerChannel('email', email);
        }

        // Load LINE channel
        const LINEChannel = require('../channels/line/line');
        const lineConfig = this.config.getChannel('line');
        if (lineConfig && lineConfig.enabled) {
            const line = new LINEChannel(lineConfig.config || {});
            this.registerChannel('line', line);
        }

        // Load Telegram channel
        const TelegramChannel = require('../channels/telegram/telegram');
        const telegramConfig = this.config.getChannel('telegram');
        if (telegramConfig && telegramConfig.enabled) {
            const telegram = new TelegramChannel(telegramConfig.config || {});
            this.registerChannel('telegram', telegram);
        }

        // ✅ Telegram integration completed
        // TODO: Future channels - Discord, Slack, Teams, etc.

        this.logger.info(`Initialized ${this.channels.size} channels`);
    }

    /**
     * Send notification to all enabled channels
     * @param {string} type - Notification type: 'completed' | 'waiting'
     * @param {Object} metadata - Additional metadata
     * @returns {Promise<Object>} Results from all channels
     */
    async notify(type, metadata = {}) {
        if (!this.config.get('enabled', true)) {
            this.logger.debug('Notifications disabled');
            return { success: false, reason: 'disabled' };
        }

        const notification = this._buildNotification(type, metadata);
        this.logger.info(`Sending ${type} notification for project: ${notification.project}`);

        const results = {};
        const promises = [];

        // Send to all channels in parallel
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

        // Wait for all channels to complete
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

    /**
     * Build notification object from type and metadata
     * @param {string} type - Notification type
     * @param {Object} metadata - Additional metadata
     * @returns {Object} Notification object
     */
    _buildNotification(type, metadata = {}) {
        const project = metadata.project || this.config.getProjectName();
        const lang = this.config.get('language', 'zh-CN');
        const content = this._getNotificationContent(type, lang);

        // Replace project placeholder
        const message = content.message.replace('{project}', project);

        // Use custom message if configured
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

    /**
     * Get notification content for type and language
     * @param {string} type - Notification type
     * @param {string} lang - Language code
     * @returns {Object} Content object with title and message
     */
    _getNotificationContent(type, lang) {
        if (!this.i18n) {
            this._loadI18n();
        }

        const langData = this.i18n[lang] || this.i18n['en'];
        return langData[type] || langData.completed;
    }

    /**
     * Load internationalization data
     */
    _loadI18n() {
        this.i18n = {
            'zh-CN': {
                completed: {
                    title: 'Claude Code - Task Completed',
                    message: '[{project}] Task completed, Claude is waiting for next instruction'
                },
                waiting: {
                    title: 'Claude Code - Waiting for Input',
                    message: '[{project}] Claude needs your further guidance'
                }
            },
            'en': {
                completed: {
                    title: 'Claude Code - Task Completed',
                    message: '[{project}] Task completed, Claude is waiting for next instruction'
                },
                waiting: {
                    title: 'Claude Code - Waiting for Input',
                    message: '[{project}] Claude needs your further guidance'
                }
            },
            'ja': {
                completed: {
                    title: 'Claude Code - タスク完了',
                    message: '[{project}] タスクが完了しました。Claudeが次の指示を待っています'
                },
                waiting: {
                    title: 'Claude Code - 入力待ち',
                    message: '[{project}] Claudeにはあなたのさらなるガイダンスが必要です'
                }
            }
        };
    }

    /**
     * Test all channels
     * @returns {Promise<Object>} Test results
     */
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

    /**
     * Get status of all channels
     * @returns {Object} Status information
     */
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
                sound: this.config.get('sound'),
                customMessages: this.config.get('customMessages')
            }
        };
    }
}

module.exports = Notifier;