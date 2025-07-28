#!/usr/bin/env node

/**
 * Manual Notification Trigger
 * Run this manually to send Telegram notification when Claude completes a task
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const TelegramChannel = require('./src/channels/telegram/telegram');

async function sendNotification() {
    try {
        console.log('📱 Sending manual Telegram notification...');
        
        const config = {
            botToken: process.env.TELEGRAM_BOT_TOKEN,
            chatId: process.env.TELEGRAM_CHAT_ID
        };
        
        const telegramChannel = new TelegramChannel(config);
        
        // Get current tmux session
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
            // Use default
        }
        
        const notification = {
            type: 'completed',
            title: 'Claude Task Completed',
            message: 'Claude has completed the task and is ready for next command',
            project: 'claude-code-line',
            metadata: {
                userQuestion: 'Manual notification triggered',
                claudeResponse: 'Ready for next command. You can now send instructions via Telegram.',
                tmuxSession: tmuxSession,
                workingDirectory: process.cwd(),
                timestamp: new Date().toISOString()
            }
        };
        
        console.log(`🖥️ Tmux session: ${tmuxSession}`);
        
        const result = await telegramChannel.send(notification);
        
        if (result) {
            console.log('✅ Telegram notification sent successfully!');
            console.log('💬 You can now send commands via Telegram');
        } else {
            console.log('❌ Failed to send notification');
        }
        
    } catch (error) {
        console.error('❌ Notification error:', error.message);
    }
}

sendNotification();