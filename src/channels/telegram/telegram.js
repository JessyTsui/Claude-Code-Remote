/**
 * Telegram Notification Channel
 * Sends notifications via Telegram Bot API with command support
 */

const NotificationChannel = require('../base/channel');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const TmuxMonitor = require('../../utils/tmux-monitor');
const { execSync } = require('child_process');

class TelegramChannel extends NotificationChannel {
    constructor(config = {}) {
        super('telegram', config);
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.tmuxMonitor = new TmuxMonitor();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username
        
        this._ensureDirectories();
        this._validateConfig();
    }

    _ensureDirectories() {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    _validateConfig() {
        if (!this.config.botToken) {
            this.logger.warn('Telegram Bot Token not found');
            return false;
        }
        if (!this.config.chatId && !this.config.groupId) {
            this.logger.warn('Telegram Chat ID or Group ID must be configured');
            return false;
        }
        return true;
    }

    /**
     * Generate network options for axios requests
     * @returns {Object} Network options object
     */
    _getNetworkOptions() {
        const options = {};
        if (this.config.forceIPv4) {
            options.family = 4;
        }
        return options;
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

    async _getBotUsername() {
        if (this.botUsername) {
            return this.botUsername;
        }

        try {
            const response = await axios.get(
                `${this.apiBaseUrl}/bot${this.config.botToken}/getMe`,
                this._getNetworkOptions()
            );
            
            if (response.data.ok && response.data.result.username) {
                this.botUsername = response.data.result.username;
                return this.botUsername;
            }
        } catch (error) {
            this.logger.error('Failed to get bot username:', error.message);
        }
        
        // Fallback to configured username or default
        return this.config.botUsername || 'claude_remote_bot';
    }

    async _sendImpl(notification) {
        if (!this._validateConfig()) {
            throw new Error('Telegram channel not properly configured');
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

        // Generate Telegram message
        const messageText = this._generateTelegramMessage(notification, sessionId, token);

        // Determine recipient (chat or group)
        const chatId = this.config.groupId || this.config.chatId;

        // Detect if Claude is asking for approval and choose appropriate buttons
        const claudeResponse = notification.metadata?.claudeResponse || '';
        const isApproval = this._detectApprovalRequest(claudeResponse);

        let buttons;
        if (isApproval) {
            buttons = this._generateApprovalButtons(token);
        } else {
            buttons = [
                [
                    { text: '📝 Personal Chat', callback_data: `personal:${token}` },
                    { text: '👥 Group Chat', callback_data: `group:${token}` }
                ]
            ];
        }

        // Split long messages
        const messageParts = this._splitMessage(messageText);

        try {
            // Send all parts; only the last part gets buttons
            for (let i = 0; i < messageParts.length; i++) {
                const isLastPart = i === messageParts.length - 1;
                const requestData = {
                    chat_id: chatId,
                    text: messageParts[i],
                    parse_mode: 'Markdown',
                    ...(isLastPart ? { reply_markup: { inline_keyboard: buttons } } : {})
                };

                try {
                    await axios.post(
                        `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                        requestData,
                        this._getNetworkOptions()
                    );
                } catch (markdownErr) {
                    // Markdown parse failed — retry as plain text
                    const fallbackData = { ...requestData };
                    delete fallbackData.parse_mode;
                    await axios.post(
                        `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                        fallbackData,
                        this._getNetworkOptions()
                    );
                }
            }

            this.logger.info(`Telegram message sent successfully, Session: ${sessionId}`);
            return true;
        } catch (error) {
            this.logger.error('Failed to send Telegram message:', error.response?.data || error.message);
            await this._removeSession(sessionId);
            return false;
        }
    }

    _generateTelegramMessage(notification, sessionId, token) {
        const type = notification.type;
        const emoji = type === 'completed' ? '✅' : '⏳';
        const status = type === 'completed' ? 'Completed' : 'Waiting for Input';

        let messageText = `${emoji} *Claude Task ${status}*\n`;
        messageText += `*Project:* ${this._escapeTelegramMarkdown(notification.project)}\n`;
        messageText += `*Session Token:* \`${token}\`\n\n`;

        if (notification.metadata) {
            if (notification.metadata.userQuestion) {
                const q = this._sanitizeTerminalOutput(notification.metadata.userQuestion);
                const escaped = this._escapeTelegramMarkdown(q.substring(0, 200));
                messageText += `📝 *Your Question:*\n${escaped}`;
                if (q.length > 200) messageText += '...';
                messageText += '\n\n';
            }

            if (notification.metadata.claudeResponse) {
                const r = this._sanitizeTerminalOutput(notification.metadata.claudeResponse);
                const escaped = this._escapeTelegramMarkdown(r.substring(0, 300));
                messageText += `🤖 *Claude Response:*\n${escaped}`;
                if (r.length > 300) messageText += '...';
                messageText += '\n\n';
            }
        }

        messageText += `💬 *To send a new command:*\n`;
        messageText += `Reply with: \`/cmd ${token} <your command>\`\n`;
        messageText += `Example: \`/cmd ${token} Please analyze this code\``;

        return messageText;
    }

    /**
     * Escape special characters for Telegram Markdown (v1)
     */
    _escapeTelegramMarkdown(text) {
        if (!text) return '';
        return text
            .replace(/_/g, '\\_')
            .replace(/\*/g, '\\*')
            .replace(/\[/g, '\\[')
            .replace(/]/g, '\\]')
            .replace(/`/g, '\\`');
    }

    /**
     * Strip ANSI escape codes and box-drawing characters from terminal output
     */
    _sanitizeTerminalOutput(text) {
        if (!text) return '';
        return text
            // Strip ANSI CSI sequences (including ? for cursor/mode codes)
            .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
            // Strip OSC sequences (BEL or ST terminated)
            .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, '')
            // Strip box-drawing characters
            .replace(/[╭╮╰╯│─┬┴┼├┤┌┐└┘]/g, '')
            .trim();
    }

    /**
     * Split long messages to stay under Telegram's 4096 char limit
     */
    _splitMessage(text, maxLen = 4000) {
        if (text.length <= maxLen) return [text];

        const parts = [];
        let remaining = text;
        let safety = 0;
        while (remaining.length > 0 && safety++ < 20) {
            if (remaining.length <= maxLen) {
                parts.push(remaining);
                break;
            }
            // Find a good split point (newline near the limit)
            let splitAt = remaining.lastIndexOf('\n', maxLen);
            if (splitAt < maxLen * 0.5) splitAt = maxLen;
            parts.push(remaining.substring(0, splitAt));
            remaining = remaining.substring(splitAt).trimStart();
        }

        // Add part labels if split into multiple
        if (parts.length > 1) {
            return parts.map((p, i) => `[${i + 1}/${parts.length}]\n${p}`);
        }
        return parts;
    }

    /**
     * Detect if Claude's response is asking for user approval/permission
     */
    _detectApprovalRequest(text) {
        if (!text) return false;
        const patterns = [
            /Do you want to\b/i,
            /\bShould I\b/i,
            /Would you like me to\b/i,
            /\bAllow this\b/i,
            /\bApprove this\b/i,
            /Do you approve\b/i,
            /\bMay I\b/i,
            /\bCan I proceed\b/i,
            /\bShall I\b/i,
            /\(y\/n\)/i,
            /\[Y\/n\]/i,
            /\[yes\/no\]/i,
            /Press Enter to confirm/i,
            /Do you want to proceed/i
        ];
        return patterns.some((p) => p.test(text));
    }

    /**
     * Generate inline keyboard buttons for approval actions
     */
    _generateApprovalButtons(token) {
        return [
            [
                { text: '✅ Yes', callback_data: `approve:${token}:yes` },
                { text: '❌ No', callback_data: `approve:${token}:no` }
            ]
        ];
    }

    async _createSession(sessionId, notification, token) {
        const session = {
            id: sessionId,
            token: token,
            type: 'telegram',
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

module.exports = TelegramChannel;
