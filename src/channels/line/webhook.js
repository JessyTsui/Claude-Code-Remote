/**
 * LINE Webhook Handler
 * Handles incoming LINE messages and commands
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const Logger = require('../../core/logger');
const ControllerInjector = require('../../utils/controller-injector');

class LINEWebhookHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('LINEWebhook');
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.injector = new ControllerInjector();
        this.app = express();
        
        this._setupMiddleware();
        this._setupRoutes();
    }

    _setupMiddleware() {
        // Parse raw body for signature verification
        this.app.use('/webhook', express.raw({ type: 'application/json' }));
        
        // Parse JSON for other routes
        this.app.use(express.json());
    }

    _setupRoutes() {
        // LINE webhook endpoint
        this.app.post('/webhook', this._handleWebhook.bind(this));
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', service: 'line-webhook' });
        });
    }

    _validateSignature(body, signature) {
        if (!this.config.channelSecret) {
            this.logger.error('Channel Secret not configured');
            return false;
        }

        const hash = crypto
            .createHmac('SHA256', this.config.channelSecret)
            .update(body)
            .digest('base64');

        return hash === signature;
    }

    async _handleWebhook(req, res) {
        const signature = req.headers['x-line-signature'];
        
        // Validate signature
        if (!this._validateSignature(req.body, signature)) {
            this.logger.warn('Invalid signature');
            return res.status(401).send('Unauthorized');
        }

        try {
            const events = JSON.parse(req.body.toString()).events;
            
            for (const event of events) {
                if (event.type === 'message' && event.message.type === 'text') {
                    await this._handleTextMessage(event);
                }
            }
            
            res.status(200).send('OK');
        } catch (error) {
            this.logger.error('Webhook handling error:', error.message);
            res.status(500).send('Internal Server Error');
        }
    }

    async _handleTextMessage(event) {
        const userId = event.source.userId;
        const groupId = event.source.groupId;
        const messageText = event.message.text.trim();
        const replyToken = event.replyToken;
        
        // Check if user is authorized
        if (!this._isAuthorized(userId, groupId)) {
            this.logger.warn(`Unauthorized user/group: ${userId || groupId}`);
            await this._replyMessage(replyToken, '⚠️ 您沒有權限使用此功能');
            return;
        }

        // Parse command
        const commandMatch = messageText.match(/^Token\s+([A-Z0-9]{8})\s+(.+)$/i);
        if (!commandMatch) {
            await this._replyMessage(replyToken, 
                '❌ 格式錯誤。請使用:\nToken <8位Token> <您的指令>\n\n例如:\nToken ABC12345 請幫我分析這段程式碼');
            return;
        }

        const token = commandMatch[1].toUpperCase();
        const command = commandMatch[2];

        // Find session by token
        const session = await this._findSessionByToken(token);
        if (!session) {
            await this._replyMessage(replyToken, 
                '❌ Token 無效或已過期。請等待新的任務通知。');
            return;
        }

        // Check if session is expired
        if (session.expiresAt < Math.floor(Date.now() / 1000)) {
            await this._replyMessage(replyToken, 
                '❌ Token 已過期。請等待新的任務通知。');
            await this._removeSession(session.id);
            return;
        }

        try {
            // Inject command into tmux session
            const tmuxSession = session.tmuxSession || 'default';
            await this.injector.injectCommand(command, tmuxSession);
            
            // Send confirmation
            await this._replyMessage(replyToken, 
                `✅ 指令已發送\n\n📝 指令: ${command}\n🖥️ 會話: ${tmuxSession}\n\n請稍候，Claude 正在處理您的請求...`);
            
            // Log command execution
            this.logger.info(`Command injected - User: ${userId}, Token: ${token}, Command: ${command}`);
            
        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._replyMessage(replyToken, 
                `❌ 指令執行失敗: ${error.message}`);
        }
    }

    _isAuthorized(userId, groupId) {
        // Check whitelist
        const whitelist = this.config.whitelist || [];
        
        if (groupId && whitelist.includes(groupId)) {
            return true;
        }
        
        if (userId && whitelist.includes(userId)) {
            return true;
        }
        
        // If no whitelist configured, allow configured user/group
        if (whitelist.length === 0) {
            if (groupId && groupId === this.config.groupId) {
                return true;
            }
            if (userId && userId === this.config.userId) {
                return true;
            }
        }
        
        return false;
    }

    async _findSessionByToken(token) {
        const files = fs.readdirSync(this.sessionsDir);
        
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            
            const sessionPath = path.join(this.sessionsDir, file);
            try {
                const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                if (session.token === token) {
                    return session;
                }
            } catch (error) {
                this.logger.error(`Failed to read session file ${file}:`, error.message);
            }
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

    async _replyMessage(replyToken, text) {
        try {
            await axios.post(
                'https://api.line.me/v2/bot/message/reply',
                {
                    replyToken: replyToken,
                    messages: [{
                        type: 'text',
                        text: text
                    }]
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.config.channelAccessToken}`
                    }
                }
            );
        } catch (error) {
            this.logger.error('Failed to reply message:', error.response?.data || error.message);
        }
    }

    start(port = 3000) {
        this.app.listen(port, () => {
            this.logger.info(`LINE webhook server started on port ${port}`);
        });
    }
}

module.exports = LINEWebhookHandler;