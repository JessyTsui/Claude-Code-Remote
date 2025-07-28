#!/usr/bin/env node

/**
 * Direct Test - 直接測試命令執行和通知
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { execSync } = require('child_process');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const TelegramChannel = require('./src/channels/telegram/telegram');

async function testDirectNotification() {
    console.log('🧪 Testing direct notification system...');
    
    // Check environment
    console.log('Bot Token exists:', !!process.env.TELEGRAM_BOT_TOKEN);
    console.log('Chat ID exists:', !!process.env.TELEGRAM_CHAT_ID);
    console.log('Tmux Session:', process.env.TMUX_SESSION || 'claude-real');
    
    // Setup Telegram
    const telegramConfig = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    };
    
    const telegram = new TelegramChannel(telegramConfig);
    
    // Get current tmux content
    const sessionName = process.env.TMUX_SESSION || 'claude-real';
    let tmuxContent = '';
    
    try {
        tmuxContent = execSync(`tmux capture-pane -t ${sessionName} -p`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        console.log('📺 Tmux content captured, length:', tmuxContent.length);
    } catch (error) {
        console.error('❌ Failed to capture tmux:', error.message);
        return;
    }
    
    // Extract conversation
    const lines = tmuxContent.split('\n');
    let userQuestion = '';
    let claudeResponse = '';
    
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        
        if (line.startsWith('⏺ ') && !claudeResponse) {
            claudeResponse = line.substring(2).trim();
        }
        
        if (line.startsWith('> ') && !userQuestion) {
            userQuestion = line.substring(2).trim();
            if (claudeResponse) break;
        }
    }
    
    console.log('👤 User Question:', userQuestion || 'Not found');
    console.log('🤖 Claude Response:', claudeResponse || 'Not found');
    
    // Create notification
    const notification = {
        type: 'completed',
        title: 'Direct Test Notification',
        message: 'Testing direct notification delivery',
        project: 'claude-code-line-test',
        metadata: {
            userQuestion: userQuestion || 'Test command execution',
            claudeResponse: claudeResponse || 'Command executed successfully',
            tmuxSession: sessionName,
            workingDirectory: process.cwd(),
            timestamp: new Date().toISOString(),
            testMode: true
        }
    };
    
    // Send notification
    console.log('📤 Sending notification...');
    
    try {
        const result = await telegram.send(notification);
        
        if (result) {
            console.log('✅ Direct notification sent successfully!');
            console.log('📱 Check your Telegram for the test notification');
        } else {
            console.log('❌ Failed to send notification');
        }
    } catch (error) {
        console.error('❌ Notification error:', error.message);
    }
}

testDirectNotification();