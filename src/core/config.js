/**
 * Claude-Code-Remote Configuration Manager
 * Handles loading, merging, and saving configurations — Slack only
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

class ConfigManager {
    constructor(configDir = null) {
        this.logger = new Logger('Config');
        this.configDir = configDir || path.join(__dirname, '../../config');
        this.userConfigPath = path.join(this.configDir, 'user.json');
        this.defaultConfigPath = path.join(this.configDir, 'default.json');
        this.channelsConfigPath = path.join(this.configDir, 'channels.json');

        this._config = null;
        this._channels = null;
    }

    getDefaultConfig() {
        return {
            language: 'en',
            enabled: true,
            timeout: 5,
            customMessages: {
                completed: null,
                waiting: null
            },
            channels: {
                slack: {
                    enabled: true,
                    priority: 1
                }
            }
        };
    }

    getDefaultChannelsConfig() {
        return {
            slack: {
                type: 'chat',
                enabled: process.env.SLACK_ENABLED === 'true',
                config: {
                    botToken: process.env.SLACK_BOT_TOKEN || '',
                    appToken: process.env.SLACK_APP_TOKEN || '',
                    channelId: process.env.SLACK_CHANNEL_ID || '',
                    repoPath: process.env.SLACK_REPO_PATH || '',
                    claudeCommand: process.env.SLACK_CLAUDE_COMMAND || 'claude --dangerously-skip-permissions'
                }
            }
        };
    }

    load() {
        this.logger.debug('Loading configuration...');

        let defaultConfig = this.getDefaultConfig();
        try {
            if (fs.existsSync(this.defaultConfigPath)) {
                const fileConfig = JSON.parse(fs.readFileSync(this.defaultConfigPath, 'utf8'));
                defaultConfig = { ...defaultConfig, ...fileConfig };
            }
        } catch (error) {
            this.logger.warn('Failed to load default config:', error.message);
        }

        let userConfig = {};
        try {
            if (fs.existsSync(this.userConfigPath)) {
                userConfig = JSON.parse(fs.readFileSync(this.userConfigPath, 'utf8'));
            }
        } catch (error) {
            this.logger.warn('Failed to load user config:', error.message);
        }

        this._config = this._deepMerge(defaultConfig, userConfig);

        this._channels = this.getDefaultChannelsConfig();
        try {
            if (fs.existsSync(this.channelsConfigPath)) {
                const fileChannels = JSON.parse(fs.readFileSync(this.channelsConfigPath, 'utf8'));
                this._channels = this._deepMerge(this._channels, fileChannels);
            }
        } catch (error) {
            this.logger.warn('Failed to load channels config:', error.message);
        }

        this.logger.info('Configuration loaded successfully');
        return this._config;
    }

    save() {
        this.logger.debug('Saving user configuration...');

        try {
            if (!fs.existsSync(this.configDir)) {
                fs.mkdirSync(this.configDir, { recursive: true });
            }

            fs.writeFileSync(this.userConfigPath, JSON.stringify(this._config, null, 2));
            fs.writeFileSync(this.channelsConfigPath, JSON.stringify(this._channels, null, 2));

            this.logger.info('Configuration saved successfully');
            return true;
        } catch (error) {
            this.logger.error('Failed to save configuration:', error.message);
            return false;
        }
    }

    get(key, defaultValue = undefined) {
        if (!this._config) {
            this.load();
        }

        const keys = key.split('.');
        let value = this._config;

        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k];
            } else {
                return defaultValue;
            }
        }

        return value;
    }

    set(key, value) {
        if (!this._config) {
            this.load();
        }

        const keys = key.split('.');
        let target = this._config;

        for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (!(k in target) || typeof target[k] !== 'object') {
                target[k] = {};
            }
            target = target[k];
        }

        target[keys[keys.length - 1]] = value;
        return this;
    }

    getChannel(channelName) {
        if (!this._channels) {
            this.load();
        }
        return this._channels[channelName];
    }

    setChannel(channelName, config) {
        if (!this._channels) {
            this.load();
        }
        this._channels[channelName] = config;
        return this;
    }

    getProjectName() {
        try {
            const { execSync } = require('child_process');
            const gitName = execSync('git rev-parse --show-toplevel 2>/dev/null', { encoding: 'utf8' }).trim();
            if (gitName) {
                return path.basename(gitName);
            }
        } catch (e) {
            // Not a git repository
        }

        return path.basename(process.cwd());
    }

    _deepMerge(target, source) {
        const result = { ...target };

        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                result[key] = this._deepMerge(result[key] || {}, source[key]);
            } else {
                result[key] = source[key];
            }
        }

        return result;
    }
}

module.exports = ConfigManager;
