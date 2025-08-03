#!/usr/bin/env node

/**
 * Advanced Email Relay Service
 * Supports session management commands via email
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Import the original email listener
const EmailListener = require('./src/relay/email-listener');

class AdvancedEmailRelay extends EventEmitter {
    constructor() {
        super();
        this.isRunning = false;
        this.activeSessions = new Map();
        
        // Email configuration
        this.emailConfig = {
            smtp: {
                host: process.env.SMTP_HOST,
                port: parseInt(process.env.SMTP_PORT),
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS
                }
            },
            imap: {
                host: process.env.IMAP_HOST,
                port: parseInt(process.env.IMAP_PORT),
                secure: process.env.IMAP_SECURE === 'true',
                auth: {
                    user: process.env.IMAP_USER,
                    pass: process.env.IMAP_PASS
                }
            },
            from: process.env.EMAIL_FROM,
            to: process.env.EMAIL_TO
        };
    }

    async executeSystemCommand(command) {
        return new Promise((resolve) => {
            console.log(`🔧 Executing system command: ${command}`);
            
            const process = spawn('bash', ['-c', command], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            let output = '';
            let error = '';
            
            process.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            process.stderr.on('data', (data) => {
                error += data.toString();
            });
            
            process.on('close', (code) => {
                resolve({
                    success: code === 0,
                    output: output.trim(),
                    error: error.trim(),
                    code: code
                });
            });
        });
    }

    async injectToTmux(command, sessionName = 'claude-session') {
        return new Promise((resolve) => {
            console.log(`🔧 Injecting to tmux session '${sessionName}': ${command.substring(0, 50)}...`);
            
            // Step 1: Clear input field with Ctrl+U
            const clearProcess = spawn('tmux', ['send-keys', '-t', sessionName, 'C-u']);
            
            clearProcess.on('close', (clearCode) => {
                if (clearCode !== 0) {
                    console.log('❌ Failed to clear input');
                    resolve(false);
                    return;
                }
                
                // Step 2: Send the command
                setTimeout(() => {
                    const sendProcess = spawn('tmux', ['send-keys', '-t', sessionName, command]);
                    
                    sendProcess.on('close', (sendCode) => {
                        if (sendCode !== 0) {
                            console.log('❌ Failed to send command');
                            resolve(false);
                            return;
                        }
                        
                        // Step 3: Send Enter key (C-m)
                        setTimeout(() => {
                            const enterProcess = spawn('tmux', ['send-keys', '-t', sessionName, 'C-m']);
                            
                            enterProcess.on('close', (enterCode) => {
                                if (enterCode === 0) {
                                    console.log('✅ Command injected successfully');
                                    resolve(true);
                                } else {
                                    console.log('❌ Failed to send Enter');
                                    resolve(false);
                                }
                            });
                            
                            enterProcess.on('error', (error) => {
                                console.log('❌ Enter error:', error.message);
                                resolve(false);
                            });
                        }, 200);
                    });
                    
                    sendProcess.on('error', (error) => {
                        console.log('❌ Send error:', error.message);
                        resolve(false);
                    });
                }, 200);
            });
            
            clearProcess.on('error', (error) => {
                console.log('❌ Clear error:', error.message);
                resolve(false);
            });
        });
    }

    async handleSystemCommand(command, from) {
        console.log(`🎛️ Processing system command: ${command}`);
        
        // Parse system commands
        if (command.startsWith('!start-session')) {
            return await this.startNewSession(command, from);
        } else if (command.startsWith('!list-sessions')) {
            return await this.listSessions(from);
        } else if (command.startsWith('!restart-session')) {
            return await this.restartSession(command, from);
        } else if (command.startsWith('!kill-session')) {
            return await this.killSession(command, from);
        } else if (command.startsWith('!status')) {
            return await this.getSystemStatus(from);
        } else if (command.startsWith('!help')) {
            return await this.sendHelpMessage(from);
        }
        
        return false;
    }

    async startNewSession(command, from) {
        console.log('🚀 Starting new Claude session...');
        
        // Parse session name from command
        const parts = command.split(' ');
        const sessionName = parts[1] || `claude-${Date.now()}`;
        
        try {
            // Check if session already exists
            const checkResult = await this.executeSystemCommand(`tmux has-session -t ${sessionName} 2>/dev/null`);
            
            if (checkResult.success) {
                console.log(`⚠️ Session ${sessionName} already exists`);
                await this.sendEmailResponse(from, `Session '${sessionName}' already exists. Use !restart-session ${sessionName} to restart it.`);
                return true;
            }
            
            // Create new tmux session
            const createResult = await this.executeSystemCommand(`tmux new-session -d -s ${sessionName}`);
            
            if (!createResult.success) {
                console.log('❌ Failed to create tmux session:', createResult.error);
                await this.sendEmailResponse(from, `Failed to create session: ${createResult.error}`);
                return true;
            }
            
            // Wait a moment for session to initialize
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Start Claude in the session
            const claudeResult = await this.executeSystemCommand(`tmux send-keys -t ${sessionName} 'claude --dangerously-skip-permissions' Enter`);
            
            if (!claudeResult.success) {
                console.log('❌ Failed to start Claude:', claudeResult.error);
                await this.sendEmailResponse(from, `Failed to start Claude in session: ${claudeResult.error}`);
                return true;
            }
            
            // Wait for Claude to start
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Track the session
            this.activeSessions.set(sessionName, {
                name: sessionName,
                created: new Date(),
                status: 'active'
            });
            
            console.log(`✅ Session ${sessionName} created successfully`);
            
            // Send success notification
            await this.sendEmailResponse(from, `✅ New Claude session '${sessionName}' started successfully!
            
🎯 Session Details:
- Name: ${sessionName}
- Status: Active
- Created: ${new Date().toLocaleString()}

💡 You can now send commands to this session by replying to emails.

📋 Available system commands:
- !list-sessions - List all active sessions
- !status - Get system status
- !help - Show all commands

🚀 Try sending a command like: "create a hello world file"`);
            
            return true;
            
        } catch (error) {
            console.error('❌ Error starting session:', error.message);
            await this.sendEmailResponse(from, `Error starting session: ${error.message}`);
            return true;
        }
    }

    async listSessions(from) {
        console.log('📋 Listing tmux sessions...');
        
        try {
            const result = await this.executeSystemCommand('tmux list-sessions 2>/dev/null || echo "No sessions found"');
            
            let response = `📋 Active tmux sessions:\n\n`;
            
            if (result.output.includes('No sessions found')) {
                response += '❌ No active sessions found.\n\n';
                response += '💡 Use !start-session [name] to create a new session.';
            } else {
                const sessions = result.output.split('\n');
                sessions.forEach((session, index) => {
                    if (session.trim()) {
                        response += `${index + 1}. ${session}\n`;
                    }
                });
                
                response += '\n💡 Use !restart-session <name> to restart a session.';
            }
            
            await this.sendEmailResponse(from, response);
            return true;
            
        } catch (error) {
            console.error('❌ Error listing sessions:', error.message);
            await this.sendEmailResponse(from, `Error listing sessions: ${error.message}`);
            return true;
        }
    }

    async restartSession(command, from) {
        const parts = command.split(' ');
        const sessionName = parts[1] || 'claude-session';
        
        console.log(`🔄 Restarting session: ${sessionName}`);
        
        try {
            // Kill existing session if it exists
            await this.executeSystemCommand(`tmux kill-session -t ${sessionName} 2>/dev/null || true`);
            
            // Wait a moment
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Start new session
            return await this.startNewSession(`!start-session ${sessionName}`, from);
            
        } catch (error) {
            console.error('❌ Error restarting session:', error.message);
            await this.sendEmailResponse(from, `Error restarting session: ${error.message}`);
            return true;
        }
    }

    async killSession(command, from) {
        const parts = command.split(' ');
        const sessionName = parts[1];
        
        if (!sessionName) {
            await this.sendEmailResponse(from, 'Usage: !kill-session <session-name>');
            return true;
        }
        
        console.log(`💀 Killing session: ${sessionName}`);
        
        try {
            const result = await this.executeSystemCommand(`tmux kill-session -t ${sessionName}`);
            
            if (result.success) {
                this.activeSessions.delete(sessionName);
                await this.sendEmailResponse(from, `✅ Session '${sessionName}' killed successfully.`);
            } else {
                await this.sendEmailResponse(from, `❌ Failed to kill session '${sessionName}': ${result.error}`);
            }
            
            return true;
            
        } catch (error) {
            console.error('❌ Error killing session:', error.message);
            await this.sendEmailResponse(from, `Error killing session: ${error.message}`);
            return true;
        }
    }

    async getSystemStatus(from) {
        console.log('📊 Getting system status...');
        
        try {
            const sessionsResult = await this.executeSystemCommand('tmux list-sessions 2>/dev/null | wc -l');
            const sessionCount = parseInt(sessionsResult.output) || 0;
            
            const uptimeResult = await this.executeSystemCommand('uptime');
            const diskResult = await this.executeSystemCommand('df -h / | tail -1');
            const memResult = await this.executeSystemCommand('free -h | grep Mem || vm_stat | head -5');
            
            let response = `📊 System Status Report\n\n`;
            response += `🖥️ System: ${process.platform}\n`;
            response += `⏰ Time: ${new Date().toLocaleString()}\n`;
            response += `📋 Active Sessions: ${sessionCount}\n`;
            response += `🔧 Email Relay: Running\n\n`;
            
            if (uptimeResult.success) {
                response += `⏱️ Uptime: ${uptimeResult.output}\n`;
            }
            
            if (diskResult.success) {
                response += `💾 Disk: ${diskResult.output.split(/\s+/).slice(3, 5).join(' used of ')}\n`;
            }
            
            response += `\n💡 Use !help to see all available commands.`;
            
            await this.sendEmailResponse(from, response);
            return true;
            
        } catch (error) {
            console.error('❌ Error getting status:', error.message);
            await this.sendEmailResponse(from, `Error getting status: ${error.message}`);
            return true;
        }
    }

    async sendHelpMessage(from) {
        const helpMessage = `📚 Claude Code Remote - Email Commands Help

🎛️ System Commands:
- !start-session [name] - Create new Claude session
- !list-sessions - List all active sessions  
- !restart-session <name> - Restart a session
- !kill-session <name> - Kill a session
- !status - Get system status
- !help - Show this help message

💬 Regular Commands:
Just reply with any command for Claude:
- "create a Python script"
- "write a README file"
- "explain this code"

🔧 Examples:
- !start-session my-project
- !restart-session claude-session
- create a web scraper in Python

📧 How it works:
1. Reply to any Claude Code Remote email
2. Use ! prefix for system commands
3. Regular text goes to Claude directly

💡 Tips:
- Sessions auto-start Claude with bypass permissions
- Each session is isolated
- Commands are executed in tmux sessions
- You can manage multiple projects simultaneously

🚀 Happy coding remotely!`;

        await this.sendEmailResponse(from, helpMessage);
        return true;
    }

    async sendEmailResponse(to, message) {
        try {
            const nodemailer = require('nodemailer');
            
            // Use configured email as fallback if no sender provided
            const recipient = to || this.emailConfig.to;
            
            if (!recipient) {
                console.error('❌ No recipient email address available');
                return;
            }
            
            const transporter = nodemailer.createTransport({
                host: this.emailConfig.smtp.host,
                port: this.emailConfig.smtp.port,
                secure: this.emailConfig.smtp.secure,
                auth: this.emailConfig.smtp.auth
            });
            
            const mailOptions = {
                from: this.emailConfig.from,
                to: recipient,
                subject: '[Claude-Code-Remote] System Response',
                text: message,
                html: `<pre style="font-family: monospace; white-space: pre-wrap;">${message}</pre>`
            };
            
            await transporter.sendMail(mailOptions);
            console.log(`📧 Response sent to ${recipient}`);
            
        } catch (error) {
            console.error('❌ Failed to send email response:', error.message);
        }
    }

    async start() {
        if (this.isRunning) {
            console.log('⚠️  Service already running');
            return;
        }

        this.isRunning = true;
        console.log('🚀 Advanced Email Relay Service started');
        console.log('📧 Email config:', {
            smtp: `${this.emailConfig.smtp.host}:${this.emailConfig.smtp.port}`,
            imap: `${this.emailConfig.imap.host}:${this.emailConfig.imap.port}`,
            user: this.emailConfig.smtp.auth.user,
            to: this.emailConfig.to
        });

        try {
            // Create email listener
            this.emailListener = new EmailListener(this.emailConfig);
            
            // Handle commands
            this.emailListener.on('command', async (commandData) => {
                console.log('📨 EMAIL COMMAND RECEIVED!');
                const fromEmail = commandData.email?.from || commandData.from;
                console.log('📧 From:', fromEmail);
                console.log('📝 Command:', commandData.command);
                
                // Check if it's a system command
                if (commandData.command.startsWith('!')) {
                    console.log('🎛️ System command detected');
                    await this.handleSystemCommand(commandData.command, fromEmail);
                } else {
                    console.log('💬 Regular Claude command');
                    // Inject to default session or create one if needed
                    const success = await this.injectToTmux(commandData.command);
                    
                    if (!success) {
                        // Try to start default session if injection failed
                        console.log('🔄 Injection failed, trying to start default session...');
                        await this.startNewSession('!start-session claude-session', fromEmail);
                        
                        // Retry injection
                        setTimeout(() => {
                            this.injectToTmux(commandData.command);
                        }, 3000);
                    }
                }
            });

            // Start email listening
            await this.emailListener.start();
            
            console.log('✅ Advanced Email Relay started successfully');
            console.log('🎛️ System commands: !start-session, !list-sessions, !status, !help');
            console.log('💬 Regular commands: Just reply with text for Claude');
            
        } catch (error) {
            console.error('❌ Failed to start email listener:', error.message);
            this.isRunning = false;
        }
    }

    stop() {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;
        
        if (this.emailListener) {
            this.emailListener.stop();
        }
        
        console.log('🛑 Advanced Email Relay Service stopped');
    }
}

// Create and start service
const relay = new AdvancedEmailRelay();

// Start service
relay.start().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    relay.stop();
    process.exit(0);
});

console.log('\n💡 Press Ctrl+C to stop the service');
console.log('📧 Advanced Email Relay with session management ready!');
console.log('\n🎛️ Email Commands:');
console.log('  !start-session [name] - Create new session');
console.log('  !list-sessions - List active sessions');
console.log('  !status - System status');
console.log('  !help - Show help');
console.log('\n💬 Regular commands go directly to Claude');

module.exports = AdvancedEmailRelay;