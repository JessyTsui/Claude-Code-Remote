#!/usr/bin/env node

/**
 * Auto Notification Daemon
 * Automatically monitors tmux output and sends Telegram/LINE notifications
 * Based on the original email automation but for real-time messaging platforms
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const TmuxMonitor = require('./src/utils/tmux-monitor');
const TelegramChannel = require('./src/channels/telegram/telegram');
const LineChannel = require('./src/channels/line/line');

class AutoNotificationDaemon {
    constructor() {
        this.tmuxSession = process.env.TMUX_SESSION || 'claude-real';
        this.monitor = new TmuxMonitor(this.tmuxSession);
        this.channels = [];
        this.isRunning = false;
        this.lastNotificationTime = 0;
        this.cooldownPeriod = 5000; // 5 seconds between notifications to avoid spam
        
        this._setupChannels();
        this._setupEventHandlers();
    }

    _setupChannels() {
        // Setup Telegram channel if configured
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            const telegramConfig = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID
            };
            this.channels.push({
                type: 'telegram',
                channel: new TelegramChannel(telegramConfig)
            });
            console.log('📱 Telegram channel configured');
        }

        // Setup LINE channel if configured
        if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID) {
            const lineConfig = {
                channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
                userId: process.env.LINE_USER_ID
            };
            this.channels.push({
                type: 'line',
                channel: new LineChannel(lineConfig)
            });
            console.log('📱 LINE channel configured');
        }

        if (this.channels.length === 0) {
            console.warn('⚠️ No notification channels configured');
            console.log('💡 Set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID or LINE_CHANNEL_ACCESS_TOKEN/LINE_USER_ID');
        }
    }

    _setupEventHandlers() {
        // Handle task completion events
        this.monitor.on('taskCompleted', (eventData) => {
            this._sendNotifications({
                type: 'completed',
                title: 'Claude Task Completed',
                message: 'Claude has completed the task and is ready for next command',
                project: 'claude-code-line',
                metadata: {
                    userQuestion: eventData.conversation.userQuestion,
                    claudeResponse: eventData.conversation.claudeResponse,
                    tmuxSession: eventData.sessionName,
                    workingDirectory: process.cwd(),
                    timestamp: eventData.timestamp,
                    triggerText: eventData.triggerText
                }
            });
        });

        // Handle waiting for input events
        this.monitor.on('waitingForInput', (eventData) => {
            this._sendNotifications({
                type: 'waiting',
                title: 'Claude Waiting for Input',
                message: 'Claude needs your guidance to continue',
                project: 'claude-code-line',
                metadata: {
                    userQuestion: eventData.conversation.userQuestion,
                    claudeResponse: eventData.conversation.claudeResponse,
                    tmuxSession: eventData.sessionName,
                    workingDirectory: process.cwd(),
                    timestamp: eventData.timestamp,
                    triggerText: eventData.triggerText
                }
            });
        });
    }

    async _sendNotifications(notification) {
        const now = Date.now();
        
        // Apply cooldown to prevent spam
        if (now - this.lastNotificationTime < this.cooldownPeriod) {
            console.log('⏰ Notification cooldown active, skipping...');
            return;
        }

        this.lastNotificationTime = now;

        console.log(`📨 Sending ${notification.type} notification via ${this.channels.length} channels`);

        const promises = this.channels.map(async ({ type, channel }) => {
            try {
                const result = await channel.send(notification);
                if (result) {
                    console.log(`✅ ${type} notification sent successfully`);
                    return { type, success: true };
                } else {
                    console.log(`❌ ${type} notification failed`);
                    return { type, success: false };
                }
            } catch (error) {
                console.error(`❌ ${type} notification error:`, error.message);
                return { type, success: false, error: error.message };
            }
        });

        const results = await Promise.all(promises);
        const successCount = results.filter(r => r.success).length;
        
        console.log(`📊 Notification results: ${successCount}/${results.length} successful`);
    }

    start() {
        if (this.isRunning) {
            console.log('⚠️ Daemon already running');
            return;
        }

        try {
            console.log(`🚀 Starting Auto Notification Daemon for tmux session: ${this.tmuxSession}`);
            console.log(`📋 Configured channels: ${this.channels.map(c => c.type).join(', ')}`);
            
            this.monitor.start();
            this.isRunning = true;
            
            console.log('✅ Auto Notification Daemon started successfully');
            console.log('🔍 Monitoring tmux session for Claude completion patterns...');
            console.log('💬 Notifications will be sent automatically when patterns are detected');
            
            // Keep the process alive
            this._keepAlive();
            
        } catch (error) {
            console.error('❌ Failed to start daemon:', error.message);
            process.exit(1);
        }
    }

    stop() {
        if (!this.isRunning) {
            return;
        }

        console.log('⏹️ Stopping Auto Notification Daemon...');
        
        this.monitor.stop();
        this.isRunning = false;
        
        console.log('✅ Daemon stopped');
    }

    _keepAlive() {
        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n🛑 Received SIGINT, shutting down gracefully...');
            this.stop();
            process.exit(0);
        });

        process.on('SIGTERM', () => {
            console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
            this.stop();
            process.exit(0);
        });

        // Monitor health and provide status updates every 60 seconds
        setInterval(() => {
            if (this.isRunning) {
                const status = this.monitor.getStatus();
                console.log('💓 Daemon health check:', {
                    monitoring: status.isMonitoring,
                    session: status.sessionName,
                    sessionExists: status.sessionExists,
                    bufferSize: status.bufferSize,
                    channels: this.channels.length
                });
            }
        }, 60000); // Every minute
    }

    // Manual test triggers
    async testCompletion() {
        console.log('🧪 Testing completion notification...');
        this.monitor.triggerCompletionTest();
    }

    async testWaiting() {
        console.log('🧪 Testing waiting notification...');
        this.monitor.triggerWaitingTest();
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            tmuxSession: this.tmuxSession,
            channels: this.channels.map(c => c.type),
            monitor: this.monitor.getStatus(),
            lastNotificationTime: new Date(this.lastNotificationTime).toISOString(),
            cooldownPeriod: this.cooldownPeriod
        };
    }
}

// CLI Interface
async function main() {
    const daemon = new AutoNotificationDaemon();
    
    const command = process.argv[2];
    
    switch (command) {
        case 'start':
            daemon.start();
            break;
            
        case 'test-completion':
            await daemon.testCompletion();
            setTimeout(() => process.exit(0), 2000);
            break;
            
        case 'test-waiting':
            await daemon.testWaiting();
            setTimeout(() => process.exit(0), 2000);
            break;
            
        case 'status':
            console.log('📊 Daemon Status:', JSON.stringify(daemon.getStatus(), null, 2));
            process.exit(0);
            break;
            
        case 'help':
        case '--help':
        case '-h':
            console.log(`
Auto Notification Daemon - Automatic Claude Code Notifications

Usage:
  node auto-notification-daemon.js <command>

Commands:
  start             Start the monitoring daemon
  test-completion   Send a test completion notification
  test-waiting      Send a test waiting notification  
  status            Show daemon status
  help              Show this help

Environment Variables:
  TMUX_SESSION              Tmux session to monitor (default: claude-real)
  TELEGRAM_BOT_TOKEN        Telegram bot token
  TELEGRAM_CHAT_ID          Telegram chat ID
  LINE_CHANNEL_ACCESS_TOKEN LINE channel access token
  LINE_USER_ID              LINE user ID

Examples:
  node auto-notification-daemon.js start
  node auto-notification-daemon.js test-completion
  node auto-notification-daemon.js status
            `);
            process.exit(0);
            break;
            
        default:
            console.log('❌ Unknown command. Use "help" for usage information.');
            process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Daemon error:', error.message);
        process.exit(1);
    });
}

module.exports = AutoNotificationDaemon;