/**
 * Email Listener
 * Monitors IMAP inbox for replies and extracts commands
 */

const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const EventEmitter = require('events');
const Logger = require('../core/logger');
const fs = require('fs');
const path = require('path');

class EmailListener extends EventEmitter {
    constructor(config) {
        super();
        this.logger = new Logger('EmailListener');
        this.config = config;
        this.imap = null;
        this.isConnected = false;
        this.isListening = false;
        this.sessionsDir = path.join(__dirname, '../data/sessions');
        this.sentMessagesPath = config.sentMessagesPath || path.join(__dirname, '../data/sent-messages.json');
        this.checkInterval = (config.template?.checkInterval || 30) * 1000; // Convert to milliseconds
        this.lastCheckTime = new Date();
        
        this._ensureDirectories();
    }

    _ensureDirectories() {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    async start() {
        if (this.isListening) {
            this.logger.warn('Email listener already running');
            return;
        }

        try {
            await this._connect();
            this._startListening();
            this.isListening = true;
            this.logger.info('Email listener started successfully');
        } catch (error) {
            this.logger.error('Failed to start email listener:', error.message);
            throw error;
        }
    }

    async stop() {
        if (!this.isListening) {
            return;
        }

        this.isListening = false;
        
        if (this.imap) {
            this.imap.end();
            this.imap = null;
        }
        
        this.isConnected = false;
        this.logger.info('Email listener stopped');
    }

    async _connect() {
        return new Promise((resolve, reject) => {
            this.imap = new Imap({
                user: this.config.imap.auth.user,
                password: this.config.imap.auth.pass,
                host: this.config.imap.host,
                port: this.config.imap.port,
                tls: this.config.imap.secure,
                connTimeout: 10000,
                authTimeout: 5000,
                keepalive: true
            });

            this.imap.once('ready', () => {
                this.isConnected = true;
                this.logger.debug('IMAP connection established');
                resolve();
            });

            this.imap.once('error', (error) => {
                this.logger.error('IMAP connection error:', error.message);
                reject(error);
            });

            this.imap.once('end', () => {
                this.isConnected = false;
                this.logger.debug('IMAP connection ended');
            });

            this.imap.connect();
        });
    }

    _startListening() {
        // Periodically check for new emails
        this._checkNewMails();
        setInterval(() => {
            if (this.isListening && this.isConnected) {
                this._checkNewMails();
            }
        }, this.checkInterval);
    }

    async _checkNewMails() {
        try {
            await this._openInbox();
            await this._searchAndProcessMails();
        } catch (error) {
            this.logger.error('Error checking emails:', error.message);
            
            // If connection is lost, try to reconnect
            if (!this.isConnected) {
                this.logger.info('Attempting to reconnect...');
                try {
                    await this._connect();
                } catch (reconnectError) {
                    this.logger.error('Reconnection failed:', reconnectError.message);
                }
            }
        }
    }

    async _openInbox() {
        return new Promise((resolve, reject) => {
            this.imap.openBox('INBOX', false, (error, box) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(box);
                }
            });
        });
    }

    async _searchAndProcessMails() {
        return new Promise((resolve, reject) => {
            // Search for recent unread emails
            const searchCriteria = [
                'UNSEEN',
                ['SINCE', this.lastCheckTime]
            ];

            this.imap.search(searchCriteria, (searchError, results) => {
                if (searchError) {
                    reject(searchError);
                    return;
                }

                if (results.length === 0) {
                    resolve();
                    return;
                }

                this.logger.debug(`Found ${results.length} new emails`);

                const fetch = this.imap.fetch(results, { 
                    bodies: '',
                    markSeen: true 
                });

                fetch.on('message', (msg, seqno) => {
                    this._processMessage(msg, seqno);
                });

                fetch.once('error', (fetchError) => {
                    this.logger.error('Fetch error:', fetchError.message);
                    reject(fetchError);
                });

                fetch.once('end', () => {
                    this.lastCheckTime = new Date();
                    resolve();
                });
            });
        });
    }

    _processMessage(msg, seqno) {
        let buffer = '';

        msg.on('body', (stream, info) => {
            stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
            });

            stream.once('end', async () => {
                try {
                    const parsed = await simpleParser(buffer);
                    await this._handleParsedEmail(parsed, seqno);
                } catch (parseError) {
                    this.logger.error('Email parsing error:', parseError.message);
                }
            });
        });

        msg.once('attributes', (attrs) => {
            this.logger.debug(`Processing email ${seqno}:`, {
                date: attrs.date,
                flags: attrs.flags
            });
        });

        msg.once('end', () => {
            this.logger.debug(`Finished processing email ${seqno}`);
        });
    }

    async _handleParsedEmail(email, seqno) {
        try {
            // First check if this is a system-sent email
            const messageId = email.headers.get('message-id');
            if (await this._isSystemSentEmail(messageId)) {
                this.logger.debug(`Skipping system-sent email: ${messageId}`);
                await this._removeFromSentMessages(messageId);
                return;
            }
            
            // Check if it's a reply email
            if (!this._isReplyEmail(email)) {
                this.logger.debug(`Email ${seqno} is not a TaskPing reply`);
                return;
            }

            // Extract session ID
            const sessionId = this._extractSessionId(email);
            if (!sessionId) {
                this.logger.warn(`No session ID found in email ${seqno}`);
                return;
            }

            // Validate session
            const session = await this._validateSession(sessionId);
            if (!session) {
                this.logger.warn(`Invalid session ID in email ${seqno}: ${sessionId}`);
                return;
            }

            // Extract command
            const command = this._extractCommand(email);
            if (!command) {
                this.logger.warn(`No command found in email ${seqno}`);
                return;
            }

            // Security check
            if (!this._isCommandSafe(command)) {
                this.logger.warn(`Unsafe command in email ${seqno}: ${command}`);
                return;
            }

            // Emit command event
            this.emit('command', {
                sessionId,
                command: command.trim(),
                email: {
                    from: email.from?.text,
                    subject: email.subject,
                    date: email.date
                },
                session
            });

            this.logger.info(`Command extracted from email ${seqno}:`, {
                sessionId,
                command: command.substring(0, 100) + (command.length > 100 ? '...' : ''),
                from: email.from?.text
            });

        } catch (error) {
            this.logger.error(`Error handling email ${seqno}:`, error.message);
        }
    }

    _isReplyEmail(email) {
        // Check if subject contains Claude-Code-Remote identifier
        const subject = email.subject || '';
        if (!subject.includes('[Claude-Code-Remote')) {
            return false;
        }

        // Check if it's a reply (Re: or RE:)
        const isReply = /^(Re:|RE:|Reply:)/i.test(subject);
        if (isReply) {
            return true;
        }

        // Check if session ID exists in email headers
        const sessionId = this._extractSessionId(email);
        return !!sessionId;
    }

    _extractSessionId(email) {
        // Extract from email headers
        const headers = email.headers;
        if (headers && headers.get('x-claude-code-remote-session-id')) {
            return headers.get('x-claude-code-remote-session-id');
        }

        // Extract token from subject line
        const subject = email.subject || '';
        const tokenMatch = subject.match(/\[Claude-Code-Remote #([A-Z0-9]{6,8})\]/);
        if (tokenMatch) {
            const token = tokenMatch[1];
            // Look up session by token
            return this._getSessionIdByToken(token);
        }

        // Extract from email body (as backup method)
        const text = email.text || '';
        const sessionMatch = text.match(/Session ID:\s*([a-f0-9-]{36})/i);
        if (sessionMatch) {
            return sessionMatch[1];
        }

        // Extract from quoted email
        const html = email.html || '';
        const htmlSessionMatch = html.match(/Session ID:\s*<code>([a-f0-9-]{36})<\/code>/i);
        if (htmlSessionMatch) {
            return htmlSessionMatch[1];
        }

        return null;
    }

    _getSessionIdByToken(token) {
        // Check session files for matching token
        try {
            const sessionFiles = fs.readdirSync(this.sessionsDir);
            for (const file of sessionFiles) {
                if (file.endsWith('.json')) {
                    const sessionPath = path.join(this.sessionsDir, file);
                    const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                    if (sessionData.token === token) {
                        return sessionData.id;
                    }
                }
            }
        } catch (error) {
            this.logger.error('Error looking up session by token:', error.message);
        }
        return null;
    }

    async _validateSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        
        if (!fs.existsSync(sessionFile)) {
            return null;
        }

        try {
            const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            
            // Check if session has expired
            const now = new Date();
            const expires = new Date(sessionData.expires);
            
            if (now > expires) {
                this.logger.debug(`Session ${sessionId} has expired`);
                // Delete expired session
                fs.unlinkSync(sessionFile);
                return null;
            }

            // Check command count limit
            if (sessionData.commandCount >= sessionData.maxCommands) {
                this.logger.debug(`Session ${sessionId} has reached command limit`);
                return null;
            }

            return sessionData;
        } catch (error) {
            this.logger.error(`Error reading session ${sessionId}:`, error.message);
            return null;
        }
    }

    _extractCommand(email) {
        let text = email.text || '';
        
        // Remove email signature and quoted content
        text = this._cleanEmailContent(text);
        
        // Remove empty lines and excess whitespace
        text = text.replace(/\n\s*\n/g, '\n').trim();
        
        return text;
    }

    _cleanEmailContent(text) {
        // Remove common email quote markers
        const lines = text.split('\n');
        const cleanLines = [];
        let foundOriginalMessage = false;
        
        for (const line of lines) {
            // Check if reached original email start
            if (line.includes('-----Original Message-----') ||
                line.includes('--- Original Message ---') ||
                line.includes('at') && line.includes('wrote:') ||
                line.includes('On') && line.includes('wrote:') ||
                line.match(/^>\s*/) ||  // Quote marker
                line.includes('Session ID:')) {
                foundOriginalMessage = true;
                break;
            }
            
            // Skip common email signatures
            if (line.includes('--') || 
                line.includes('Sent from') ||
                line.includes('Sent from my')) {
                break;
            }
            
            cleanLines.push(line);
        }
        
        return cleanLines.join('\n').trim();
    }

    _isCommandSafe(command) {
        // Basic security check
        if (command.length > 1000) {
            return false;
        }

        // Dangerous command blacklist
        const dangerousPatterns = [
            /rm\s+-rf/i,
            /sudo\s+/i,
            /chmod\s+777/i,
            />\s*\/dev\/null/i,
            /curl.*\|\s*sh/i,
            /wget.*\|\s*sh/i,
            /eval\s*\(/i,
            /exec\s*\(/i
        ];

        for (const pattern of dangerousPatterns) {
            if (pattern.test(command)) {
                return false;
            }
        }

        return true;
    }

    async updateSessionCommandCount(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        
        if (fs.existsSync(sessionFile)) {
            try {
                const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
                sessionData.commandCount = (sessionData.commandCount || 0) + 1;
                sessionData.lastCommand = new Date().toISOString();
                
                fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
                this.logger.debug(`Updated command count for session ${sessionId}: ${sessionData.commandCount}`);
            } catch (error) {
                this.logger.error(`Error updating session ${sessionId}:`, error.message);
            }
        }
    }

    async _isSystemSentEmail(messageId) {
        if (!messageId || !fs.existsSync(this.sentMessagesPath)) {
            return false;
        }
        
        try {
            const sentMessages = JSON.parse(fs.readFileSync(this.sentMessagesPath, 'utf8'));
            return sentMessages.messages.some(msg => msg.messageId === messageId);
        } catch (error) {
            this.logger.error('Error reading sent messages:', error.message);
            return false;
        }
    }

    async _removeFromSentMessages(messageId) {
        if (!fs.existsSync(this.sentMessagesPath)) {
            return;
        }
        
        try {
            const sentMessages = JSON.parse(fs.readFileSync(this.sentMessagesPath, 'utf8'));
            sentMessages.messages = sentMessages.messages.filter(msg => msg.messageId !== messageId);
            
            // Also clean up old messages (older than 24 hours)
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            sentMessages.messages = sentMessages.messages.filter(msg => {
                return new Date(msg.sentAt) > oneDayAgo;
            });
            
            fs.writeFileSync(this.sentMessagesPath, JSON.stringify(sentMessages, null, 2));
            this.logger.debug(`Removed message ${messageId} from sent tracking`);
        } catch (error) {
            this.logger.error('Error removing from sent messages:', error.message);
        }
    }
}

module.exports = EmailListener;