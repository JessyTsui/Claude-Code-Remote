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

        // Telegram limits: 4096 chars per message, leave room for formatting
        this.MAX_MESSAGE_LENGTH = 3800;
        this.MAX_QUESTION_LENGTH = 500;
        this.MAX_RESPONSE_LENGTH = 2500;

        // Characters to strip from terminal output (box drawing, lines, etc.)
        this.terminalJunkPattern = /[─━┄┅┈┉╌╍═╭╮╯╰│┃┆┇┊┋╎╏║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓⏺■□▪▫●○◆◇◈★☆✓✔✕✖✗✘⚠️➜➤►▶▷◀◁←→↑↓↔↕⬆⬇⬅➡↩↪⤴⤵🔑📁📝🤖💬⏳✅❌⏭️🚫⚠️_]+/g;

        // Patterns that indicate an approval/permission request
        this.approvalPatterns = [
            /\b(do you want|would you like|shall I|should I|can I|may I)\b.*\?/i,
            /\b(proceed|continue|confirm|approve|allow|permit|accept)\b.*\?/i,
            /\b(yes|no|y\/n)\b.*\?/i,
            /\b(permission|approval|authorization)\b/i,
            /\b(run|execute|delete|remove|modify|change|update|create|write)\b.*\?/i,
            /\ballow.*tool\b/i,
            /\baccept.*edit\b/i,
        ];

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

    /**
     * Sanitize terminal output by removing box-drawing chars and cleaning up
     */
    _sanitizeTerminalOutput(text) {
        if (!text) return '';
        return text
            // Remove box-drawing and line characters
            .replace(/[─━┄┅┈┉╌╍═╭╮╯╰│┃┆┇┊┋╎╏║]+/g, '')
            // Remove lines of underscores or dashes
            .replace(/^[_\-─━=]{3,}$/gm, '')
            // Remove ANSI escape codes
            .replace(/\x1b\[[0-9;]*m/g, '')
            // Collapse multiple blank lines into one
            .replace(/\n{3,}/g, '\n\n')
            // Collapse multiple spaces
            .replace(/  +/g, ' ')
            // Trim each line
            .split('\n').map(l => l.trim()).filter(l => l).join('\n')
            .trim();
    }

    /**
     * Detect if the response contains an approval/permission request
     * @param {string} text - The text to analyze
     * @returns {Object|null} - Approval info with extracted question, or null
     */
    _detectApprovalRequest(text) {
        if (!text) return null;

        for (const pattern of this.approvalPatterns) {
            const match = text.match(pattern);
            if (match) {
                // Extract the sentence containing the approval request
                const sentences = text.split(/(?<=[.!?])\s+/);
                const approvalSentence = sentences.find(s => pattern.test(s)) || match[0];

                return {
                    detected: true,
                    question: approvalSentence.trim(),
                    fullMatch: match[0]
                };
            }
        }
        return null;
    }

    /**
     * Generate inline keyboard buttons for approval requests
     * @param {string} token - Session token
     * @returns {Array} - Inline keyboard button rows
     */
    _generateApprovalButtons(token) {
        return [
            [
                { text: '✅ Yes', callback_data: `approve:${token}:yes` },
                { text: '❌ No', callback_data: `approve:${token}:no` }
            ],
            [
                { text: '⏭️ Skip', callback_data: `approve:${token}:skip` },
                { text: '🚫 Always Deny', callback_data: `approve:${token}:always_deny` }
            ],
            [
                { text: '✅ Yes, don\'t ask again', callback_data: `approve:${token}:always_allow` }
            ]
        ];
    }

    /**
     * Split a long message into multiple parts
     * @param {string} text - Text to split
     * @param {number} maxLength - Maximum length per part
     * @returns {Array<string>} - Array of message parts
     */
    _splitMessage(text, maxLength = this.MAX_MESSAGE_LENGTH) {
        if (text.length <= maxLength) {
            return [text];
        }

        const parts = [];
        let remaining = text;
        let partNum = 1;

        while (remaining.length > 0) {
            let chunk;
            if (remaining.length <= maxLength) {
                chunk = remaining;
                remaining = '';
            } else {
                // Find a good break point (paragraph, sentence, or word boundary)
                let breakPoint = remaining.lastIndexOf('\n\n', maxLength);
                if (breakPoint < maxLength * 0.5) {
                    breakPoint = remaining.lastIndexOf('\n', maxLength);
                }
                if (breakPoint < maxLength * 0.5) {
                    breakPoint = remaining.lastIndexOf('. ', maxLength);
                }
                if (breakPoint < maxLength * 0.5) {
                    breakPoint = remaining.lastIndexOf(' ', maxLength);
                }
                if (breakPoint < maxLength * 0.3) {
                    breakPoint = maxLength;
                }

                chunk = remaining.substring(0, breakPoint + 1).trim();
                remaining = remaining.substring(breakPoint + 1).trim();
            }

            if (chunk) {
                parts.push(chunk);
                partNum++;
            }
        }

        // Add part indicators if multiple parts
        if (parts.length > 1) {
            return parts.map((part, i) =>
                `📄 *[${i + 1}/${parts.length}]*\n\n${part}`
            );
        }

        return parts;
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

        // Generate Telegram message with approval detection
        const messageResult = this._generateTelegramMessage(notification, sessionId, token);

        // Determine recipient (chat or group)
        const chatId = this.config.groupId || this.config.chatId;

        // Choose buttons based on whether there's an approval request
        let buttons;
        if (messageResult.hasApproval && messageResult.approvalButtons) {
            // Use approval buttons when permission is needed
            buttons = messageResult.approvalButtons;
        } else {
            // Default help buttons
            buttons = [
                [
                    { text: '📝 Personal Chat', callback_data: `personal:${token}` },
                    { text: '👥 Group Chat', callback_data: `group:${token}` }
                ]
            ];
        }

        try {
            // Split message if too long
            const messageParts = this._splitMessage(messageResult.text);

            for (let i = 0; i < messageParts.length; i++) {
                const isLastPart = i === messageParts.length - 1;
                const requestData = {
                    chat_id: chatId,
                    text: messageParts[i],
                    parse_mode: 'Markdown',
                    // Only add buttons to the last message
                    ...(isLastPart && { reply_markup: { inline_keyboard: buttons } })
                };

                await axios.post(
                    `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                    requestData,
                    this._getNetworkOptions()
                );

                // Small delay between messages to maintain order
                if (!isLastPart) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }

            this.logger.info(`Telegram message sent successfully, Session: ${sessionId}, Parts: ${messageParts.length}`);
            return true;
        } catch (error) {
            this.logger.error('Failed to send Telegram message:', error.response?.data || error.message);
            // Clean up failed session
            await this._removeSession(sessionId);
            return false;
        }
    }

    /**
     * Generate Telegram message with approval detection and improved formatting
     * @param {Object} notification - Notification object
     * @param {string} sessionId - Session UUID
     * @param {string} token - Session token
     * @returns {Object} - { text, hasApproval, approvalButtons }
     */
    _generateTelegramMessage(notification, sessionId, token) {
        const type = notification.type;
        const emoji = type === 'completed' ? '✅' : '⏳';
        const status = type === 'completed' ? 'Completed' : 'Waiting for Input';

        const claudeResponse = notification.metadata?.claudeResponse || '';
        const approvalInfo = this._detectApprovalRequest(claudeResponse);

        // Sanitize the response to remove terminal UI artifacts
        const cleanResponse = this._sanitizeTerminalOutput(claudeResponse);
        const cleanApproval = approvalInfo ? this._sanitizeTerminalOutput(approvalInfo.question) : null;

        // Ultra-compact format
        let messageText = `${emoji} \`${token}\` ${notification.project}`;

        if (cleanApproval) {
            messageText += `\n⚠️ ${cleanApproval}`;
        } else if (cleanResponse) {
            const maxLen = this.MAX_RESPONSE_LENGTH;
            const truncated = cleanResponse.length > maxLen;
            messageText += `\n${cleanResponse.substring(0, maxLen)}${truncated ? '...' : ''}`;
        }

        if (!approvalInfo) {
            messageText += `\n\n/cmd ${token} ...`;
        }

        return {
            text: messageText,
            hasApproval: !!approvalInfo,
            approvalButtons: approvalInfo ? this._generateApprovalButtons(token) : null
        };
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
