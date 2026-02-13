#!/usr/bin/env node

/**
 * Claude Hook Notification Script
 * Called by Claude Code hooks to send Telegram notifications
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables from the project directory
const projectDir = path.dirname(__filename);
const envPath = path.join(projectDir, '.env');

console.log('🔍 Hook script started from:', process.cwd());
console.log('📁 Script location:', __filename);
console.log('🔧 Looking for .env at:', envPath);

if (fs.existsSync(envPath)) {
    console.log('✅ .env file found, loading...');
    dotenv.config({ path: envPath });
} else {
    console.error('❌ .env file not found at:', envPath);
    console.log('📂 Available files in script directory:');
    try {
        const files = fs.readdirSync(projectDir);
        console.log(files.join(', '));
    } catch (error) {
        console.error('Cannot read directory:', error.message);
    }
    process.exit(1);
}

const TelegramChannel = require('./src/channels/telegram/telegram');
const DesktopChannel = require('./src/channels/local/desktop');
const EmailChannel = require('./src/channels/email/smtp');

/**
 * Read hook data from stdin (Claude Code passes JSON via stdin to hooks)
 */
function readStdin() {
    return new Promise((resolve) => {
        if (process.stdin.isTTY) {
            resolve(null);
            return;
        }

        let data = '';
        let resolved = false;

        const done = (value) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            process.stdin.removeListener('data', onData);
            process.stdin.removeListener('end', onEnd);
            resolve(value);
        };

        const onData = (chunk) => { data += chunk; };
        const onEnd = () => {
            if (!data.trim()) { done(null); return; }
            try {
                done(JSON.parse(data));
            } catch (e) {
                done(null);
            }
        };

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onData);
        process.stdin.on('end', onEnd);

        const timer = setTimeout(() => done(null), 1000);
    });
}

async function sendHookNotification() {
    try {
        console.log('🔔 Claude Hook: Sending notifications...');
        
        // Get notification type from command line argument
        const notificationType = process.argv[2] || 'completed';
        
        const channels = [];
        const results = [];
        
        // Configure Desktop channel (always enabled for sound)
        const desktopChannel = new DesktopChannel({
            completedSound: 'Glass',
            waitingSound: 'Tink'
        });
        channels.push({ name: 'Desktop', channel: desktopChannel });
        
        // Configure Telegram channel if enabled
        if (process.env.TELEGRAM_ENABLED === 'true' && process.env.TELEGRAM_BOT_TOKEN) {
            const telegramConfig = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID,
                groupId: process.env.TELEGRAM_GROUP_ID
            };
            
            if (telegramConfig.botToken && (telegramConfig.chatId || telegramConfig.groupId)) {
                const telegramChannel = new TelegramChannel(telegramConfig);
                channels.push({ name: 'Telegram', channel: telegramChannel });
            }
        }
        
        // Configure Email channel if enabled
        if (process.env.EMAIL_ENABLED === 'true' && process.env.SMTP_USER) {
            const emailConfig = {
                smtp: {
                    host: process.env.SMTP_HOST,
                    port: parseInt(process.env.SMTP_PORT),
                    secure: process.env.SMTP_SECURE === 'true',
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS
                    }
                },
                from: process.env.EMAIL_FROM,
                fromName: process.env.EMAIL_FROM_NAME,
                to: process.env.EMAIL_TO
            };
            
            if (emailConfig.smtp.host && emailConfig.smtp.auth.user && emailConfig.to) {
                const emailChannel = new EmailChannel(emailConfig);
                channels.push({ name: 'Email', channel: emailChannel });
            }
        }
        
        // Get current working directory and tmux session
        const currentDir = process.cwd();
        const projectName = path.basename(currentDir);

        // Try to get current tmux session
        let tmuxSession = process.env.TMUX_SESSION || 'claude-real';
        try {
            const { execSync } = require('child_process');
            const sessionOutput = execSync('tmux display-message -p "#S"', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (sessionOutput) {
                tmuxSession = sessionOutput;
            }
        } catch (error) {
            // Not in tmux or tmux not available, use default
        }

        // Read hook data from stdin — Claude Code hooks pass JSON with result/transcript
        const hookData = await readStdin();

        let userQuestion = '';
        let claudeResponse = '';

        if (hookData) {
            // Extract from hook result or transcript_summary
            if (hookData.result) {
                claudeResponse = typeof hookData.result === 'string'
                    ? hookData.result
                    : JSON.stringify(hookData.result);
            }
            if (hookData.transcript_summary) {
                claudeResponse = claudeResponse || hookData.transcript_summary;
            }
            if (hookData.input) {
                userQuestion = typeof hookData.input === 'string'
                    ? hookData.input
                    : JSON.stringify(hookData.input);
            }
            if (hookData.session_id) {
                tmuxSession = hookData.session_id;
            }
        }

        // Create notification
        const notification = {
            type: notificationType,
            title: `Claude ${notificationType === 'completed' ? 'Task Completed' : 'Waiting for Input'}`,
            message: notificationType === 'completed'
                ? 'Claude has completed a task'
                : 'Claude is waiting for input',
            project: projectName
        };

        // Set metadata from stdin data if available; otherwise let TelegramChannel try tmux capture
        if (userQuestion || claudeResponse) {
            notification.metadata = {
                userQuestion: userQuestion || 'Recent command',
                claudeResponse: claudeResponse || 'Task completed',
                tmuxSession: tmuxSession
            };
        }

        console.log(`📱 Sending ${notificationType} notification for project: ${projectName}`);
        console.log(`🖥️ Tmux session: ${tmuxSession}`);
        
        // Send notifications to all configured channels
        for (const { name, channel } of channels) {
            try {
                console.log(`📤 Sending to ${name}...`);
                const result = await channel.send(notification);
                results.push({ name, success: result });
                
                if (result) {
                    console.log(`✅ ${name} notification sent successfully!`);
                } else {
                    console.log(`❌ Failed to send ${name} notification`);
                }
            } catch (error) {
                console.error(`❌ ${name} notification error:`, error.message);
                results.push({ name, success: false, error: error.message });
            }
        }
        
        // Report overall results
        const successful = results.filter(r => r.success).length;
        const total = results.length;
        
        if (successful > 0) {
            console.log(`\n✅ Successfully sent notifications via ${successful}/${total} channels`);
            if (results.some(r => r.name === 'Telegram' && r.success)) {
                console.log('📋 You can now send new commands via Telegram');
            }
        } else {
            console.log('\n❌ All notification channels failed');
            process.exit(1);
        }
        
    } catch (error) {
        console.error('❌ Hook notification error:', error.message);
        process.exit(1);
    }
}

// Show usage if no arguments
if (process.argv.length < 2) {
    console.log('Usage: node claude-hook-notify.js [completed|waiting]');
    process.exit(1);
}

sendHookNotification();