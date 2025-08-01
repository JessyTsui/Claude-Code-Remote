/**
 * LINE Notification Channel
 * Sends notifications via LINE Messaging API with command support
 */

const NotificationChannel = require('../base/channel');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const TmuxMonitor = require('../../utils/tmux-monitor');
const { execSync } = require('child_process');

class LINEChannel extends NotificationChannel {
    constructor(config = {}) {
        super('line', config);
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.tmuxMonitor = new TmuxMonitor();
        this.lineApiUrl = 'https://api.line.me/v2/bot/message';
        
        this._ensureDirectories();
        this._validateConfig();
    }

    _ensureDirectories() {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    _validateConfig() {
        if (!this.config.channelAccessToken) {
            this.logger.warn('LINE Channel Access Token not found');
            return false;
        }
        if (!this.config.userId && !this.config.groupId) {
            this.logger.warn('LINE User ID or Group ID must be configured');
            return false;
        }
        return true;
    }

    _generateToken() {
        // Generate short Token (uppercase letters + numbers, 8 digits)
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let token = '';
        for (let i = 0; i < 8; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return token;
    }

    _getCurrentTmuxSession() {
        try {
            // Try to get current tmux session
            const tmuxSession = execSync('tmux display-message -p "#S"', { 
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            
            return tmuxSession || null;
        } catch (error) {
            // Not in a tmux session or tmux not available
            return null;
        }
    }

    async _sendImpl(notification) {
        if (!this._validateConfig()) {
            throw new Error('LINE channel not properly configured');
        }

        // Generate session ID and Token
        const sessionId = uuidv4();
        const token = this._generateToken();
        
        // Get current tmux session and conversation content
        const tmuxSession = this._getCurrentTmuxSession();
        if (tmuxSession && !notification.metadata) {
            const conversation = this.tmuxMonitor.getRecentConversation(tmuxSession);
            notification.metadata = {
                userQuestion: conversation.userQuestion || notification.message,
                claudeResponse: conversation.claudeResponse || notification.message,
                tmuxSession: tmuxSession
            };
        }
        
        // Create session record
        await this._createSession(sessionId, notification, token);

        // Generate LINE message
        const messages = this._generateLINEMessage(notification, sessionId, token);
        
        // Determine recipient (user or group)
        const to = this.config.groupId || this.config.userId;
        
        const requestData = {
            to: to,
            messages: messages
        };

        try {
            const response = await axios.post(
                `${this.lineApiUrl}/push`,
                requestData,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.config.channelAccessToken}`
                    }
                }
            );

            this.logger.info(`LINE message sent successfully, Session: ${sessionId}`);
            return true;
        } catch (error) {
            this.logger.error('Failed to send LINE message:', error.response?.data || error.message);
            // Clean up failed session
            await this._removeSession(sessionId);
            return false;
        }
    }

    _generateLINEMessage(notification, sessionId, token) {
        const type = notification.type;
        const emoji = type === 'completed' ? '✅' : '⏳';
        const status = type === 'completed' ? '已完成' : '等待輸入';
        
        let messageText = `${emoji} Claude 任務 ${status}\n`;
        messageText += `專案: ${notification.project}\n`;
        messageText += `會話 Token: ${token}\n\n`;
        
        if (notification.metadata) {
            if (notification.metadata.userQuestion) {
                messageText += `📝 您的問題:\n${notification.metadata.userQuestion.substring(0, 200)}`;
                if (notification.metadata.userQuestion.length > 200) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }
            
            if (notification.metadata.claudeResponse) {
                messageText += `🤖 Claude 回應:\n${notification.metadata.claudeResponse.substring(0, 300)}`;
                if (notification.metadata.claudeResponse.length > 300) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }
        }
        
        messageText += `💬 回覆此訊息並輸入:\n`;
        messageText += `Token ${token} <您的指令>\n`;
        messageText += `來發送新指令給 Claude`;

        return [{
            type: 'text',
            text: messageText
        }];
    }

    async _createSession(sessionId, notification, token) {
        const session = {
            id: sessionId,
            token: token,
            type: 'line',
            created: new Date().toISOString(),
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Expires after 24 hours
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
            tmuxSession: notification.metadata?.tmuxSession || 'default',
            project: notification.project,
            notification: notification
        };

        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
        
        this.logger.debug(`Session created: ${sessionId}`);
    }

    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    supportsRelay() {
        return true;
    }

    validateConfig() {
        return this._validateConfig();
    }
}

module.exports = LINEChannel;