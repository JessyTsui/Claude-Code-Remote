#!/usr/bin/env node

/**
 * Test Real Notification
 * Creates a notification with real tmux session name
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

async function testRealNotification() {
    console.log('🧪 Creating REAL notification with real tmux session...\n');
    
    // Configure Telegram channel
    const config = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    };
    
    const telegramChannel = new TelegramChannel(config);
    
    // Get real tmux session name from env
    const realSession = process.env.TMUX_SESSION || 'claude-real';
    
    // Create REAL notification
    const notification = {
        type: 'completed',
        title: 'Claude Task Completed',
        message: 'Real notification - Ready for command injection',
        project: 'claude-code-line',
        metadata: {
            userQuestion: 'Ready for real test',
            claudeResponse: 'Ready to receive new commands and inject into the real Claude session',
            tmuxSession: realSession
        }
    };
    
    try {
        console.log(`📱 Sending REAL notification for session: ${realSession}`);
        const result = await telegramChannel.send(notification);
        
        if (result) {
            console.log('✅ REAL notification sent successfully!');
            console.log(`🖥️ Commands will be injected into tmux session: ${realSession}`);
            console.log('\n📋 Now you can reply with:');
            console.log('   /cmd [NEW_TOKEN] <your command>');
            console.log('\n🎯 Example:');
            console.log('   /cmd [NEW_TOKEN] ls -la');
        } else {
            console.log('❌ Failed to send notification');
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

testRealNotification();