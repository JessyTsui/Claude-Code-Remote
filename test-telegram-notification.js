#!/usr/bin/env node

/**
 * Test Telegram Notification
 * Simulates Claude sending a notification via Telegram
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

async function testNotification() {
    console.log('🧪 Testing Telegram notification...\n');
    
    // Configure Telegram channel
    const config = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    };
    
    const telegramChannel = new TelegramChannel(config);
    
    // Create test notification
    const notification = {
        type: 'completed',
        title: 'Claude Task Completed',
        message: 'Test notification from Claude Code Remote',
        project: 'claude-code-line',
        metadata: {
            userQuestion: 'Please help me look up this repository: https://github.com/JessyTsui/Claude-Code-Remote',
            claudeResponse: 'I have looked up this repository. This is a Claude Code Remote project that allows remote control of Claude Code via email.',
            tmuxSession: 'claude-test'
        }
    };
    
    try {
        console.log('📱 Sending test notification...');
        const result = await telegramChannel.send(notification);
        
        if (result) {
            console.log('✅ Test notification sent successfully!');
            console.log('📋 Now you can reply with a command in this format:');
            console.log('   /cmd TOKEN123 <your new command>');
            console.log('\n🎯 Example:');
            console.log('   /cmd [TOKEN_FROM_MESSAGE] Please analyze this project architecture');
        } else {
            console.log('❌ Failed to send test notification');
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

testNotification();