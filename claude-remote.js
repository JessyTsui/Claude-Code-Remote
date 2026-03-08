#!/usr/bin/env node

/**
 * Claude-Code-Remote - Slack + Tmux CLI
 */

const path = require('path');
const envPath = path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

const Logger = require('./src/core/logger');
const Notifier = require('./src/core/notifier');
const ConfigManager = require('./src/core/config');

class ClaudeCodeRemoteCLI {
    constructor() {
        this.logger = new Logger('CLI');
        this.config = new ConfigManager();
        this.notifier = new Notifier(this.config);
    }

    async init() {
        this.config.load();
        await this.notifier.initializeChannels();
    }

    async run() {
        const args = process.argv.slice(2);
        const command = args[0];

        try {
            await this.init();

            switch (command) {
                case 'notify':
                    await this.handleNotify(args.slice(1));
                    break;
                case 'test':
                    await this.handleTest(args.slice(1));
                    break;
                case 'status':
                    await this.handleStatus(args.slice(1));
                    break;
                case 'config':
                    await this.handleConfig(args.slice(1));
                    break;
                case '--help':
                case '-h':
                case undefined:
                    this.showHelp();
                    break;
                default:
                    console.error(`Unknown command: ${command}`);
                    this.showHelp();
                    process.exit(1);
            }
        } catch (error) {
            this.logger.error('CLI error:', error.message);
            process.exit(1);
        }
    }

    async handleNotify(args) {
        const typeIndex = args.findIndex(arg => arg === '--type');

        if (typeIndex === -1 || typeIndex + 1 >= args.length) {
            console.error('Usage: claude-remote notify --type <completed|waiting>');
            process.exit(1);
        }

        const type = args[typeIndex + 1];

        if (!['completed', 'waiting'].includes(type)) {
            console.error('Invalid type. Use: completed or waiting');
            process.exit(1);
        }

        const metadata = await this.captureCurrentConversation();

        const result = await this.notifier.notify(type, metadata);

        if (result.success) {
            this.logger.info(`${type} notification sent successfully`);
            process.exit(0);
        } else {
            this.logger.error(`Failed to send ${type} notification`);
            process.exit(1);
        }
    }

    async captureCurrentConversation() {
        try {
            const { execSync } = require('child_process');
            const TmuxMonitor = require('./src/utils/tmux-monitor');

            let currentSession = null;
            try {
                currentSession = execSync('tmux display-message -p "#S"', {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                }).trim();
            } catch (e) {
                return {};
            }

            if (!currentSession) {
                return {};
            }

            const tmuxMonitor = new TmuxMonitor();
            const conversation = tmuxMonitor.getRecentConversation(currentSession);
            const fullTrace = tmuxMonitor.getFullExecutionTrace(currentSession);

            return {
                userQuestion: conversation.userQuestion,
                claudeResponse: conversation.claudeResponse,
                tmuxSession: currentSession,
                fullExecutionTrace: fullTrace
            };
        } catch (error) {
            this.logger.debug('Failed to capture conversation:', error.message);
            return {};
        }
    }

    async handleTest(args) {
        console.log('Testing notification channels...\n');

        const results = await this.notifier.test();

        for (const [channel, result] of Object.entries(results)) {
            const status = result.success ? 'PASS' : 'FAIL';
            console.log(`${channel}: ${status}`);
            if (result.error) {
                console.log(`   Error: ${result.error}`);
            }
        }

        const passCount = Object.values(results).filter(r => r.success).length;
        const totalCount = Object.keys(results).length;

        console.log(`\nTest completed: ${passCount}/${totalCount} channels passed`);

        if (passCount === 0) {
            process.exit(1);
        }
    }

    async handleStatus(args) {
        const status = this.notifier.getStatus();

        console.log('Claude-Code-Remote Status\n');
        console.log('Configuration:');
        console.log(`  Enabled: ${status.enabled ? 'Yes' : 'No'}`);
        console.log(`  Language: ${status.config.language}`);

        console.log('\nChannels:');

        const allChannels = this.config._channels || {};
        const activeChannels = status.channels || {};

        const channelNames = new Set([
            ...Object.keys(allChannels),
            ...Object.keys(activeChannels)
        ]);

        for (const name of channelNames) {
            const channelStatus = activeChannels[name];

            let enabled, configured, relay;

            if (channelStatus) {
                enabled = channelStatus.enabled ? 'Yes' : 'No';
                configured = channelStatus.configured ? 'Yes' : 'No';
                relay = channelStatus.supportsRelay ? 'Yes' : 'No';
            } else {
                const channelConfig = allChannels[name] || {};
                enabled = channelConfig.enabled ? 'Yes' : 'No';
                configured = 'Unknown';
                relay = name === 'slack' ? 'Yes' : 'No';
            }

            console.log(`  ${name}:`);
            console.log(`    Enabled: ${enabled}`);
            console.log(`    Configured: ${configured}`);
            console.log(`    Supports Relay: ${relay}`);
        }
    }

    async handleConfig(args) {
        const ConfigTool = require('./src/tools/config-manager');
        const configTool = new ConfigTool(this.config);
        await configTool.run(args);
    }

    showHelp() {
        console.log(`
Claude-Code-Remote - Slack + Tmux Notification System

Usage: claude-remote <command> [options]

Commands:
  notify --type <type>    Send a notification (completed|waiting)
  test                    Test Slack notification channel
  status                  Show system status
  config                  Launch configuration manager

Options:
  -h, --help             Show this help message

Examples:
  claude-remote notify --type completed
  claude-remote test
  claude-remote status

For more information, visit: https://github.com/Claude-Code-Remote/Claude-Code-Remote
        `);
    }
}

if (require.main === module) {
    const cli = new ClaudeCodeRemoteCLI();
    cli.run().catch(error => {
        console.error('Fatal error:', error.message);
        process.exit(1);
    });
}

module.exports = ClaudeCodeRemoteCLI;
