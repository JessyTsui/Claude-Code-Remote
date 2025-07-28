#!/usr/bin/env node

/**
 * Telegram Direct Mode - 直接對話模式
 * 基於現有的 telegram-polling.js，支援直接與 Claude 對話
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const axios = require('axios');
const Logger = require('./src/core/logger');
const ControllerInjector = require('./src/utils/controller-injector');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

class TelegramDirectMode {
    constructor() {
        this.logger = new Logger('TelegramDirectMode');
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.tmuxSession = process.env.TMUX_SESSION || 'claude-real';
        this.injector = new ControllerInjector();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.lastUpdateId = 0;
        this.running = false;
        this.pollInterval = 1000; // 1 second polling
    }
    
    async start() {
        this.logger.info('🤖 Starting Telegram Direct Mode...');
        this.logger.info(`📱 Bot Token: ${this.botToken ? 'Configured' : 'Missing'}`);
        this.logger.info(`👤 Chat ID: ${this.chatId}`);
        this.logger.info(`🖥️ Tmux Session: ${this.tmuxSession}`);
        
        if (!this.botToken) {
            this.logger.error('TELEGRAM_BOT_TOKEN not configured');
            return;
        }
        
        // Send welcome message
        await this.sendWelcomeMessage();
        
        this.running = true;
        this.startPolling();
    }
    
    async sendWelcomeMessage() {
        const message = `🤖 **Claude 直接對話模式已啟動**

現在您可以直接發送訊息與 Claude 對話！

💬 **使用方法：**
• 直接輸入您想說的話
• Claude 會自動回應
• 系統會自動發送回應通知

🎯 **範例：**
• "你好，Claude"
• "幫我分析這段代碼"
• "今天天氣如何？"

準備好開始對話了！`;

        await this.sendMessage(message);
    }
    
    startPolling() {
        this.logger.info('🔄 Starting polling for messages...');
        
        const poll = async () => {
            if (!this.running) return;
            
            try {
                await this.getUpdates();
            } catch (error) {
                this.logger.error('Polling error:', error.message);
            }
            
            setTimeout(poll, this.pollInterval);
        };
        
        poll();
    }
    
    async getUpdates() {
        try {
            const url = `${this.apiBaseUrl}/bot${this.botToken}/getUpdates`;
            const params = {
                offset: this.lastUpdateId + 1,
                limit: 100,
                timeout: 0
            };
            
            const response = await axios.get(url, { params });
            
            if (response.data.ok && response.data.result.length > 0) {
                for (const update of response.data.result) {
                    await this.handleUpdate(update);
                    this.lastUpdateId = update.update_id;
                }
            }
        } catch (error) {
            this.logger.error('Failed to get updates:', error.message);
        }
    }
    
    async handleUpdate(update) {
        if (!update.message || !update.message.text) {
            return;
        }
        
        const message = update.message;
        const chatId = message.chat.id.toString();
        const text = message.text.trim();
        
        // Check if message is from allowed user
        if (chatId !== this.chatId) {
            this.logger.warn(`Unauthorized access from chat ID: ${chatId}`);
            await this.sendMessageToChat(chatId, '❌ 未授權的訪問');
            return;
        }
        
        this.logger.info(`💬 Received message: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
        
        // Send confirmation
        await this.sendMessage(`✅ 收到您的訊息，正在發送給 Claude...\n\n💭 **您說：** ${text}`);
        
        // Process the message
        await this.handleDirectMessage(text);
    }
    
    async handleDirectMessage(text) {
        try {
            // Inject message directly into Claude session
            const success = await this.injector.injectCommand(text, this.tmuxSession);
            
            if (success) {
                this.logger.info('✅ Message injected into Claude session');
                await this.sendMessage('🔄 訊息已發送給 Claude，請等待回應...');
            } else {
                this.logger.error('❌ Failed to inject message');
                await this.sendMessage('❌ 發送訊息失敗，請檢查 Claude 會話狀態');
            }
            
        } catch (error) {
            this.logger.error('Error handling direct message:', error.message);
            await this.sendMessage(`❌ 處理訊息時發生錯誤: ${error.message}`);
        }
    }
    
    async sendMessage(text) {
        return this.sendMessageToChat(this.chatId, text);
    }
    
    async sendMessageToChat(chatId, text) {
        try {
            const url = `${this.apiBaseUrl}/bot${this.botToken}/sendMessage`;
            const data = {
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown'
            };
            
            const response = await axios.post(url, data);
            
            if (response.data.ok) {
                this.logger.debug('✅ Message sent successfully');
                return true;
            } else {
                this.logger.error('Failed to send message:', response.data);
                return false;
            }
        } catch (error) {
            this.logger.error('Error sending message:', error.message);
            return false;
        }
    }
    
    stop() {
        this.logger.info('⏹️ Stopping Telegram Direct Mode...');
        this.running = false;
    }
    
    getStatus() {
        return {
            running: this.running,
            botToken: !!this.botToken,
            chatId: this.chatId,
            tmuxSession: this.tmuxSession,
            lastUpdateId: this.lastUpdateId
        };
    }
}

// Handle graceful shutdown
let directMode;

async function start() {
    directMode = new TelegramDirectMode();
    await directMode.start();
    
    console.log('🚀 Telegram Direct Mode started successfully');
    console.log('💬 Users can now send messages directly to Claude');
    console.log('📱 Send any message to start chatting!');
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    if (directMode) {
        directMode.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    if (directMode) {
        directMode.stop();
    }
    process.exit(0);
});

// Start the service
start().catch(error => {
    console.error('❌ Failed to start Telegram Direct Mode:', error.message);
    process.exit(1);
});