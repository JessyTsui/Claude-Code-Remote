#!/usr/bin/env node

/**
 * Auto Approver - 自動批准 Claude 工具使用請求
 * 持續監控 tmux 會話並自動批准任何權限請求對話框
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

class AutoApprover {
    constructor() {
        this.sessionName = process.env.TMUX_SESSION || 'claude-real';
        this.checkInterval = 500; // Check every 500ms
        this.isRunning = false;
        this.lastOutput = '';
    }

    start() {
        this.isRunning = true;
        console.log(`🤖 Starting Auto Approver for session: ${this.sessionName}`);
        console.log('⚡ Auto-approving all Claude tool usage requests...');
        this.monitor();
    }

    stop() {
        this.isRunning = false;
        console.log('🛑 Auto Approver stopped');
    }

    captureOutput() {
        try {
            return execSync(`tmux capture-pane -t ${this.sessionName} -p`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
        } catch (error) {
            return '';
        }
    }

    needsApproval(output) {
        // Check for various approval patterns
        const approvalPatterns = [
            'Do you want to proceed?',
            '❯ 1. Yes',
            'Tool use',
            'serena - initial_instructions',
            'MCP',
            'permission'
        ];

        return approvalPatterns.some(pattern => 
            output.includes(pattern) && 
            output.includes('│') && 
            (output.includes('1. Yes') || output.includes('❯ 1'))
        );
    }

    autoApprove() {
        try {
            console.log('🔥 Auto-approving permission request...');
            
            // Send "1" to select first option
            execSync(`tmux send-keys -t ${this.sessionName} '1'`, { 
                encoding: 'utf8', 
                stdio: 'ignore' 
            });
            
            // Wait a bit then send Enter
            setTimeout(() => {
                try {
                    execSync(`tmux send-keys -t ${this.sessionName} Enter`, { 
                        encoding: 'utf8', 
                        stdio: 'ignore' 
                    });
                    console.log('✅ Auto-approval completed');
                } catch (error) {
                    console.error('❌ Failed to send Enter:', error.message);
                }
            }, 200);

        } catch (error) {
            console.error('❌ Failed to auto-approve:', error.message);
        }
    }

    async monitor() {
        while (this.isRunning) {
            try {
                const currentOutput = this.captureOutput();
                
                if (currentOutput !== this.lastOutput) {
                    if (this.needsApproval(currentOutput)) {
                        console.log('🎯 Permission request detected');
                        this.autoApprove();
                        
                        // Wait a bit after approval to avoid rapid re-triggering
                        await this.sleep(1000);
                    }
                    
                    this.lastOutput = currentOutput;
                }
                
                await this.sleep(this.checkInterval);
            } catch (error) {
                console.error('Monitor error:', error.message);
                await this.sleep(1000);
            }
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Handle graceful shutdown
let approver;

async function start() {
    approver = new AutoApprover();
    await approver.start();
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    if (approver) {
        approver.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    if (approver) {
        approver.stop();
    }
    process.exit(0);
});

// Start the service
start().catch(error => {
    console.error('❌ Failed to start Auto Approver:', error.message);
    process.exit(1);
});