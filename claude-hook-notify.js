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

async function sendHookNotification() {
    try {
        console.log('🔔 Claude Hook: Sending Telegram notification...');
        
        // Get notification type from command line argument
        const notificationType = process.argv[2] || 'completed';
        
        // Configure Telegram channel
        const config = {
            botToken: process.env.TELEGRAM_BOT_TOKEN,
            chatId: process.env.TELEGRAM_CHAT_ID
        };
        
        if (!config.botToken || !config.chatId) {
            console.error('❌ Telegram configuration missing');
            process.exit(1);
        }
        
        const telegramChannel = new TelegramChannel(config);
        
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
        
        // Create notification
        const notification = {
            type: notificationType,
            title: `Claude ${notificationType === 'completed' ? 'Task Completed' : 'Waiting for Input'}`,
            message: `Claude has ${notificationType === 'completed' ? 'completed a task' : 'is waiting for input'}`,
            project: projectName,
            metadata: {
                userQuestion: 'Task completed via Claude Code',
                claudeResponse: `Claude has finished processing and is ready for the next command.`,
                tmuxSession: tmuxSession,
                workingDirectory: currentDir,
                timestamp: new Date().toISOString()
            }
        };
        
        console.log(`📱 Sending ${notificationType} notification for project: ${projectName}`);
        console.log(`🖥️ Tmux session: ${tmuxSession}`);
        
        const result = await telegramChannel.send(notification);
        
        if (result) {
            console.log('✅ Telegram notification sent successfully!');
            console.log('📋 You can now send new commands via Telegram');
        } else {
            console.log('❌ Failed to send Telegram notification');
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