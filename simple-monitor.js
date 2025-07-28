#!/usr/bin/env node

/**
 * Simple Monitor - Immediate detection for Claude responses
 * Uses a different approach to catch Claude responses quickly
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log('📝 Loaded .env file');
} else {
    console.log('❌ .env file not found at:', envPath);
}

const TelegramChannel = require('./src/channels/telegram/telegram');

class SimpleMonitor {
    constructor() {
        this.sessionName = process.env.TMUX_SESSION || 'claude-real';
        this.lastOutput = '';
        this.checkInterval = 500; // Check every 0.5 seconds
        this.isRunning = false;
        
        // Setup Telegram
        console.log('🔧 Bot Token exists:', !!process.env.TELEGRAM_BOT_TOKEN);
        console.log('🔧 Chat ID exists:', !!process.env.TELEGRAM_CHAT_ID);
        
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            const telegramConfig = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID
            };
            this.telegram = new TelegramChannel(telegramConfig);
            console.log('📱 Telegram configured successfully');
        } else {
            console.log('❌ Telegram not configured - missing environment variables');
            console.log('Bot token length:', process.env.TELEGRAM_BOT_TOKEN?.length || 0);
            console.log('Chat ID:', process.env.TELEGRAM_CHAT_ID || 'undefined');
            process.exit(1);
        }
    }

    start() {
        this.isRunning = true;
        console.log(`🔍 Starting simple monitor for session: ${this.sessionName}`);
        
        // Initial capture
        this.lastOutput = this.captureOutput();
        
        // Start monitoring
        this.monitor();
    }

    captureOutput() {
        try {
            return execSync(`tmux capture-pane -t ${this.sessionName} -p`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
        } catch (error) {
            console.error('Error capturing tmux:', error.message);
            return '';
        }
    }

    async monitor() {
        while (this.isRunning) {
            await this.sleep(this.checkInterval);
            
            const currentOutput = this.captureOutput();
            
            if (currentOutput !== this.lastOutput) {
                console.log('📝 Output changed, checking for Claude response...');
                
                // Get the new content
                const newContent = this.getNewContent(this.lastOutput, currentOutput);
                
                if (this.hasClaudeResponse(newContent)) {
                    console.log('🎯 Claude response detected!');
                    await this.sendNotification(newContent);
                }
                
                this.lastOutput = currentOutput;
            }
        }
    }

    getNewContent(oldOutput, newOutput) {
        const oldLines = oldOutput.split('\n');
        const newLines = newOutput.split('\n');
        
        // Simple approach: if content is different, check the recent lines
        if (oldOutput === newOutput) {
            return ''; // No change
        }
        
        // Get the last 10 lines for analysis (more reliable than diff)
        const recentLines = newLines.slice(-10);
        return recentLines.join('\n');
    }

    hasClaudeResponse(content) {
        // Look for Claude response indicators
        const patterns = [
            /⏺.*[a-zA-Z]/,  // Claude response with actual content
            /Bash\(.*\)/,   // Command execution
            /✅/,           // Success indicator
            /completed/i,   // Completion word
            /successfully/i // Success word
        ];
        
        console.log('Checking content:', content.substring(0, 200));
        console.log('Has ⏺ symbol:', content.includes('⏺'));
        
        const hasResponse = patterns.some(pattern => pattern.test(content));
        console.log('Pattern match result:', hasResponse);
        
        return hasResponse;
    }

    async sendNotification(newContent) {
        try {
            const conversation = this.extractConversation();
            
            const notification = {
                type: 'completed',
                title: 'Claude Response Ready',
                message: 'Claude has responded to your command',
                project: 'claude-code-line',
                metadata: {
                    userQuestion: conversation.userQuestion,
                    claudeResponse: conversation.claudeResponse,
                    tmuxSession: this.sessionName,
                    workingDirectory: process.cwd(),
                    timestamp: new Date().toISOString(),
                    newContent: newContent
                }
            };
            
            const result = await this.telegram.send(notification);
            
            if (result) {
                console.log('✅ Notification sent successfully');
            } else {
                console.log('❌ Failed to send notification');
            }
            
        } catch (error) {
            console.error('❌ Notification error:', error.message);
        }
    }

    extractConversation() {
        const fullOutput = this.lastOutput;
        const lines = fullOutput.split('\n');
        
        let userQuestion = '';
        let claudeResponse = '';
        
        // Find the most recent user input and Claude response
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            
            // Look for Claude response (⏺ prefix)
            if (line.startsWith('⏺ ') && !claudeResponse) {
                claudeResponse = line.substring(2).trim();
                continue;
            }
            
            // Look for user input (> prefix)
            if (line.startsWith('> ') && !userQuestion) {
                userQuestion = line.substring(2).trim();
                if (claudeResponse) break; // We have both
            }
        }
        
        return {
            userQuestion: userQuestion || 'Recent command',
            claudeResponse: claudeResponse || 'Command executed'
        };
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stop() {
        this.isRunning = false;
        console.log('⏹️ Monitor stopped');
    }
}

// Handle graceful shutdown
const monitor = new SimpleMonitor();

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    monitor.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    monitor.stop();
    process.exit(0);
});

// Start monitoring
monitor.start();