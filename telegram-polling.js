#!/usr/bin/env node

/**
 * Telegram Polling Handler
 * Alternative to webhook for local testing
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

class TelegramPolling {
    constructor() {
        this.logger = new Logger('TelegramPolling');
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.sessionsDir = path.join(__dirname, 'src/data/sessions');
        this.injector = new ControllerInjector();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.lastUpdateId = 0;
        this.running = false;
        
        this._ensureDirectories();
    }
    
    _ensureDirectories() {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }
    
    async start() {
        this.logger.info('🤖 Starting Telegram polling...');
        this.logger.info(`📱 Bot Token: ${this.botToken ? 'Configured' : 'Missing'}`);
        this.logger.info(`👤 Chat ID: ${this.chatId}`);
        
        if (!this.botToken) {
            this.logger.error('TELEGRAM_BOT_TOKEN not configured');
            return;
        }
        
        this.running = true;
        await this._poll();
    }
    
    stop() {
        this.logger.info('⏹️ Stopping Telegram polling...');
        this.running = false;
    }
    
    async _poll() {
        while (this.running) {
            try {
                const response = await axios.get(`${this.apiBaseUrl}/bot${this.botToken}/getUpdates`, {
                    params: {
                        offset: this.lastUpdateId + 1,
                        timeout: 30
                    }
                });
                
                const updates = response.data.result;
                
                for (const update of updates) {
                    this.lastUpdateId = update.update_id;
                    
                    if (update.message) {
                        await this._handleMessage(update.message);
                    }
                }
                
            } catch (error) {
                this.logger.error('Polling error:', error.message);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
    
    async _handleMessage(message) {
        const chatId = message.chat.id;
        const userId = message.from.id;
        const messageText = message.text?.trim();
        
        if (!messageText) return;
        
        this.logger.info(`📨 Received message from ${userId}: ${messageText}`);
        
        // Check authorization
        if (this.chatId && String(chatId) !== String(this.chatId)) {
            this.logger.warn(`❌ Unauthorized chat: ${chatId}`);
            await this._sendMessage(chatId, '⚠️ You are not authorized to use this bot.');
            return;
        }
        
        // Handle commands
        if (messageText === '/start') {
            await this._sendWelcomeMessage(chatId);
            return;
        }
        
        if (messageText === '/help') {
            await this._sendHelpMessage(chatId);
            return;
        }
        
        // Parse command
        const commandMatch = messageText.match(/^\/cmd\s+([A-Z0-9]{8})\s+(.+)$/i);
        if (commandMatch) {
            const token = commandMatch[1].toUpperCase();
            const command = commandMatch[2];
            await this._processCommand(chatId, token, command);
            return;
        }
        
        // Direct token command
        const directMatch = messageText.match(/^([A-Z0-9]{8})\s+(.+)$/);
        if (directMatch) {
            const token = directMatch[1].toUpperCase();
            const command = directMatch[2];
            await this._processCommand(chatId, token, command);
            return;
        }
        
        // Invalid format
        await this._sendMessage(chatId, 
            '❌ Invalid format. Use:\n`/cmd <TOKEN> <command>`\n\nExample:\n`/cmd ABC12345 analyze this code`',
            { parse_mode: 'Markdown' });
    }
    
    async _processCommand(chatId, token, command) {
        this.logger.info(`🔧 Processing command - Token: ${token}, Command: ${command}`);
        
        // Find session by token
        const session = await this._findSessionByToken(token);
        if (!session) {
            await this._sendMessage(chatId, 
                '❌ Invalid or expired token. Please wait for a new task notification.');
            return;
        }
        
        // Check if session is expired
        if (session.expiresAt < Math.floor(Date.now() / 1000)) {
            await this._sendMessage(chatId, 
                '❌ Token has expired. Please wait for a new task notification.');
            await this._removeSession(session.id);
            return;
        }
        
        try {
            // Inject command into tmux session
            const tmuxSession = session.tmuxSession || 'claude-test';
            this.logger.info(`💉 Injecting command into tmux session: ${tmuxSession}`);
            
            // For testing, we'll simulate command injection
            if (tmuxSession === 'claude-test') {
                this.logger.info(`📋 Simulated command injection: ${command}`);
                await this._sendMessage(chatId, 
                    `✅ *Command sent successfully (TEST MODE)*\n\n📝 *Command:* ${command}\n🖥️ *Session:* ${tmuxSession}\n\n⚠️ *Note:* This is test mode. In real usage, the command would be injected into Claude.`,
                    { parse_mode: 'Markdown' });
            } else {
                await this.injector.injectCommand(command, tmuxSession);
                await this._sendMessage(chatId, 
                    `✅ *Command sent successfully*\n\n📝 *Command:* ${command}\n🖥️ *Session:* ${tmuxSession}\n\nClaude is now processing your request...`,
                    { parse_mode: 'Markdown' });
            }
            
            this.logger.info(`✅ Command processed successfully`);
            
        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._sendMessage(chatId, 
                `❌ *Command execution failed:* ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }
    
    async _findSessionByToken(token) {
        try {
            const files = fs.readdirSync(this.sessionsDir);
            
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                
                const sessionPath = path.join(this.sessionsDir, file);
                const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                if (session.token === token) {
                    return session;
                }
            }
        } catch (error) {
            this.logger.error('Error finding session:', error.message);
        }
        
        return null;
    }
    
    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }
    
    async _sendWelcomeMessage(chatId) {
        const message = `🤖 *Welcome to Claude Code Remote Bot!*\n\n` +
            `I'll notify you when Claude completes tasks or needs input.\n\n` +
            `When you receive a notification with a token, you can send commands back using:\n` +
            `\`/cmd <TOKEN> <your command>\`\n\n` +
            `Type /help for more information.`;
        
        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
    
    async _sendHelpMessage(chatId) {
        const message = `📚 *Claude Code Remote Bot Help*\n\n` +
            `*Commands:*\n` +
            `• \`/start\` - Welcome message\n` +
            `• \`/help\` - Show this help\n` +
            `• \`/cmd <TOKEN> <command>\` - Send command to Claude\n\n` +
            `*Example:*\n` +
            `\`/cmd ABC12345 analyze the performance of this function\`\n\n` +
            `*Tips:*\n` +
            `• Tokens are case-insensitive\n` +
            `• Tokens expire after 24 hours\n` +
            `• You can also just type \`TOKEN command\` without /cmd`;
        
        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
    
    async _sendMessage(chatId, text, options = {}) {
        try {
            await axios.post(`${this.apiBaseUrl}/bot${this.botToken}/sendMessage`, {
                chat_id: chatId,
                text: text,
                ...options
            });
        } catch (error) {
            this.logger.error('Failed to send message:', error.response?.data || error.message);
        }
    }
}

// Start polling
const polling = new TelegramPolling();

async function start() {
    await polling.start();
}

start();

// Handle graceful shutdown
process.on('SIGINT', () => {
    polling.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    polling.stop();
    process.exit(0);
});