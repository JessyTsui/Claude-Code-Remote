#!/usr/bin/env node

/**
 * Telegram Direct Chat - 直接對話模式
 * 用戶可以直接發送訊息與 Claude 對話，無需 token
 * 基於原分支的直接對話功能
 */

const TelegramBot = require('node-telegram-bot-api');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

class TelegramDirectChat {
    constructor() {
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        this.allowedChatId = process.env.TELEGRAM_CHAT_ID;
        this.tmuxSession = process.env.TMUX_SESSION || 'claude-real';
        
        if (!this.botToken || !this.allowedChatId) {
            console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
            process.exit(1);
        }
        
        // Initialize Telegram Bot with polling
        this.bot = new TelegramBot(this.botToken, { polling: true });
        this.setupEventHandlers();
        
        console.log('🤖 Telegram Direct Chat initialized');
        console.log('📱 Allowed Chat ID:', this.allowedChatId);
        console.log('🖥️ Tmux Session:', this.tmuxSession);
    }

    setupEventHandlers() {
        // Handle text messages
        this.bot.on('message', async (msg) => {
            try {
                await this.handleMessage(msg);
            } catch (error) {
                console.error('❌ Error handling message:', error.message);
                this.sendErrorMessage(msg.chat.id, '處理訊息時發生錯誤');
            }
        });

        // Handle polling errors
        this.bot.on('polling_error', (error) => {
            console.error('❌ Polling error:', error.message);
        });

        console.log('✅ Event handlers setup complete');
    }

    async handleMessage(msg) {
        const chatId = msg.chat.id.toString();
        const text = msg.text;

        // Check if message is from allowed user
        if (chatId !== this.allowedChatId) {
            console.log(`⚠️ Unauthorized access attempt from chat ID: ${chatId}`);
            await this.bot.sendMessage(chatId, '❌ 未授權的訪問');
            return;
        }

        // Skip if no text
        if (!text) {
            return;
        }

        console.log(`💬 Received message: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

        // Send confirmation
        await this.bot.sendMessage(chatId, `✅ 訊息已接收，正在處理...\n\n💭 您說：${text}`);

        // Inject message into Claude session
        await this.injectMessageToClaud(text);
    }

    async injectMessageToClaud(message) {
        try {
            // Escape special characters for tmux
            const escapedMessage = message.replace(/'/g, "'\"'\"'").replace(/\$/g, '\\$');
            
            // Check if tmux session exists
            if (!this.tmuxSessionExists()) {
                console.error(`❌ Tmux session '${this.tmuxSession}' not found`);
                await this.bot.sendMessage(this.allowedChatId, '❌ Claude 會話未找到，請確認 Claude 正在運行');
                return;
            }

            // Send message to Claude
            console.log(`📤 Injecting message into tmux session: ${this.tmuxSession}`);
            
            // Method 1: Direct tmux command injection
            execSync(`tmux send-keys -t ${this.tmuxSession} '${escapedMessage}' Enter`, {
                stdio: 'ignore'
            });

            console.log('✅ Message injected successfully');
            
            // Optional: Send confirmation to user
            await this.bot.sendMessage(this.allowedChatId, '🔄 訊息已發送給 Claude，正在等待回應...');

        } catch (error) {
            console.error('❌ Failed to inject message:', error.message);
            await this.bot.sendMessage(this.allowedChatId, `❌ 發送訊息失敗: ${error.message}`);
        }
    }

    tmuxSessionExists() {
        try {
            const sessions = execSync('tmux list-sessions -F "#{session_name}"', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim().split('\n');
            
            return sessions.includes(this.tmuxSession);
        } catch (error) {
            return false;
        }
    }

    async sendErrorMessage(chatId, message) {
        try {
            await this.bot.sendMessage(chatId, `❌ ${message}`);
        } catch (error) {
            console.error('❌ Failed to send error message:', error.message);
        }
    }

    async sendWelcomeMessage() {
        try {
            const welcomeMsg = `
🤖 **Claude 直接對話模式已啟動**

現在您可以直接發送訊息與 Claude 對話，無需使用命令格式！

💬 **使用方法：**
• 直接輸入您想說的話
• Claude 會自動回應
• 系統會自動發送回應通知

🔧 **系統狀態：**
• Tmux Session: ${this.tmuxSession}
• 會話狀態: ${this.tmuxSessionExists() ? '✅ 已連接' : '❌ 未連接'}

準備好開始對話了！
            `;

            await this.bot.sendMessage(this.allowedChatId, welcomeMsg, { parse_mode: 'Markdown' });
            console.log('📱 Welcome message sent');
        } catch (error) {
            console.error('❌ Failed to send welcome message:', error.message);
        }
    }

    getStatus() {
        return {
            botRunning: !!this.bot,
            allowedChatId: this.allowedChatId,
            tmuxSession: this.tmuxSession,
            sessionExists: this.tmuxSessionExists()
        };
    }

    stop() {
        if (this.bot) {
            this.bot.stopPolling();
            console.log('⏹️ Telegram Direct Chat stopped');
        }
    }
}

// Handle graceful shutdown
let directChat;

async function start() {
    directChat = new TelegramDirectChat();
    
    // Send welcome message
    await directChat.sendWelcomeMessage();
    
    console.log('🚀 Telegram Direct Chat started successfully');
    console.log('💬 Users can now send messages directly to Claude');
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    if (directChat) {
        directChat.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    if (directChat) {
        directChat.stop();
    }
    process.exit(0);
});

// Start the service
start().catch(error => {
    console.error('❌ Failed to start Telegram Direct Chat:', error.message);
    process.exit(1);
});