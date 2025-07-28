#!/usr/bin/env node

/**
 * Smart Monitor - 智能監控器，能檢測歷史回應和新回應
 * 解決監控器錯過已完成回應的問題
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { execSync } = require('child_process');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const TelegramChannel = require('./src/channels/telegram/telegram');

class SmartMonitor {
    constructor() {
        this.sessionName = process.env.TMUX_SESSION || 'claude-real';
        this.lastOutput = '';
        this.processedResponses = new Set(); // 記錄已處理的回應
        this.checkInterval = 1000; // Check every 1 second
        this.isRunning = false;
        this.startupTime = Date.now();
        
        // Setup Telegram
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            const telegramConfig = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID
            };
            this.telegram = new TelegramChannel(telegramConfig);
            console.log('📱 Smart Monitor configured successfully');
        } else {
            console.log('❌ Telegram not configured');
            process.exit(1);
        }
    }

    start() {
        this.isRunning = true;
        console.log(`🧠 Starting smart monitor for session: ${this.sessionName}`);
        
        // Check for any unprocessed responses on startup
        this.checkForUnprocessedResponses();
        
        // Initial capture
        this.lastOutput = this.captureOutput();
        
        // Start monitoring
        this.monitor();
    }

    async checkForUnprocessedResponses() {
        console.log('🔍 Checking for unprocessed responses...');
        
        const currentOutput = this.captureOutput();
        const responses = this.extractAllResponses(currentOutput);
        
        // Check if there are recent responses (within 5 minutes) that might be unprocessed
        const recentResponses = responses.filter(response => {
            const responseAge = Date.now() - this.startupTime;
            return responseAge < 5 * 60 * 1000; // 5 minutes
        });
        
        if (recentResponses.length > 0) {
            console.log(`🎯 Found ${recentResponses.length} potentially unprocessed responses`);
            
            // Send notification for the most recent response
            const latestResponse = recentResponses[recentResponses.length - 1];
            await this.sendNotificationForResponse(latestResponse);
        } else {
            console.log('✅ No unprocessed responses found');
        }
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

    extractAllResponses(content) {
        const lines = content.split('\n');
        const responses = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Look for Claude responses
            if (line.startsWith('⏺ ') && line.length > 2) {
                const responseText = line.substring(2).trim();
                
                // Find the corresponding user question
                let userQuestion = 'Recent command';
                for (let j = i - 1; j >= 0; j--) {
                    const prevLine = lines[j].trim();
                    if (prevLine.startsWith('> ') && prevLine.length > 2) {
                        userQuestion = prevLine.substring(2).trim();
                        break;
                    }
                }
                
                responses.push({
                    userQuestion,
                    claudeResponse: responseText,
                    lineIndex: i,
                    responseId: `${userQuestion}-${responseText}`.substring(0, 50)
                });
            }
        }
        
        return responses;
    }

    async monitor() {
        while (this.isRunning) {
            await this.sleep(this.checkInterval);
            
            const currentOutput = this.captureOutput();
            
            if (currentOutput !== this.lastOutput) {
                console.log('📝 Output changed, checking for new responses...');
                
                const oldResponses = this.extractAllResponses(this.lastOutput);
                const newResponses = this.extractAllResponses(currentOutput);
                
                // Find truly new responses
                const newResponseIds = new Set(newResponses.map(r => r.responseId));
                const oldResponseIds = new Set(oldResponses.map(r => r.responseId));
                
                const actuallyNewResponses = newResponses.filter(response => 
                    !oldResponseIds.has(response.responseId) && 
                    !this.processedResponses.has(response.responseId)
                );
                
                if (actuallyNewResponses.length > 0) {
                    console.log(`🎯 Found ${actuallyNewResponses.length} new responses`);
                    
                    for (const response of actuallyNewResponses) {
                        await this.sendNotificationForResponse(response);
                        this.processedResponses.add(response.responseId);
                    }
                } else {
                    console.log('ℹ️ No new responses detected');
                }
                
                this.lastOutput = currentOutput;
            }
        }
    }

    async sendNotificationForResponse(response) {
        try {
            console.log('📤 Sending notification for response:', response.claudeResponse.substring(0, 50) + '...');
            
            const notification = {
                type: 'completed',
                title: 'Claude Response Ready',
                message: 'Claude has responded to your command',
                project: 'claude-code-line',
                metadata: {
                    userQuestion: response.userQuestion,
                    claudeResponse: response.claudeResponse,
                    tmuxSession: this.sessionName,
                    workingDirectory: process.cwd(),
                    timestamp: new Date().toISOString(),
                    autoDetected: true
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

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stop() {
        this.isRunning = false;
        console.log('⏹️ Smart Monitor stopped');
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            sessionName: this.sessionName,
            processedCount: this.processedResponses.size,
            uptime: Math.floor((Date.now() - this.startupTime) / 1000) + 's'
        };
    }
}

// Handle graceful shutdown
const monitor = new SmartMonitor();

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