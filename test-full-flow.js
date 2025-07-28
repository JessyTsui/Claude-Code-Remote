#!/usr/bin/env node

/**
 * Full Flow Test - 測試完整的自動化流程
 * 1. 發送通知 -> 2. 模擬命令注入 -> 3. 檢測回應 -> 4. 發送結果通知
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
const ControllerInjector = require('./src/utils/controller-injector');

async function testFullFlow() {
    console.log('🔄 Testing full automation flow...');
    
    // Setup
    const telegramConfig = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    };
    const telegram = new TelegramChannel(telegramConfig);
    const sessionName = process.env.TMUX_SESSION || 'claude-real';
    
    console.log('📡 Step 1: Sending initial notification with new token...');
    
    // Step 1: Send notification with token
    const notification1 = {
        type: 'completed',
        title: 'Test Flow - Ready for Command',
        message: 'Send a test command using the token below',
        project: 'claude-code-line-test',
        metadata: {
            userQuestion: 'Full flow test initiated',
            claudeResponse: 'Ready to receive test command via Telegram',
            tmuxSession: sessionName,
            timestamp: new Date().toISOString(),
            testFlow: true
        }
    };
    
    await telegram.send(notification1);
    console.log('✅ Step 1 complete: Notification sent');
    
    // Wait a bit
    await sleep(2000);
    
    console.log('⚡ Step 2: Simulating command injection...');
    
    // Step 2: Simulate command injection (as if received from Telegram)
    const testCommand = 'echo "Full flow test - ' + new Date().toISOString() + '"';
    
    try {
        // Inject command directly into tmux session
        execSync(`tmux send-keys -t ${sessionName} '${testCommand}' Enter`, {
            stdio: 'ignore'
        });
        console.log('✅ Step 2 complete: Command injected');
    } catch (error) {
        console.error('❌ Step 2 failed:', error.message);
        return;
    }
    
    // Wait for command execution
    await sleep(3000);
    
    console.log('🔍 Step 3: Checking for Claude response...');
    
    // Step 3: Check for response
    let tmuxContent = '';
    try {
        tmuxContent = execSync(`tmux capture-pane -t ${sessionName} -p`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
    } catch (error) {
        console.error('❌ Step 3 failed:', error.message);
        return;
    }
    
    // Look for our test command in the output
    const hasTestOutput = tmuxContent.includes('Full flow test -');
    const hasClaudeResponse = /⏺.*/.test(tmuxContent);
    
    console.log('🔍 Command output found:', hasTestOutput);
    console.log('🔍 Claude response found:', hasClaudeResponse);
    
    if (hasTestOutput || hasClaudeResponse) {
        console.log('✅ Step 3 complete: Response detected');
        
        console.log('📤 Step 4: Sending result notification...');
        
        // Step 4: Send result notification
        const conversation = extractConversation(tmuxContent);
        
        const notification2 = {
            type: 'completed',
            title: 'Test Flow - Command Executed',
            message: 'Full flow test completed successfully',
            project: 'claude-code-line-test',
            metadata: {
                userQuestion: conversation.userQuestion,
                claudeResponse: conversation.claudeResponse,
                tmuxSession: sessionName,
                timestamp: new Date().toISOString(),
                testCommand: testCommand,
                autoDetected: true
            }
        };
        
        const result = await telegram.send(notification2);
        
        if (result) {
            console.log('✅ Step 4 complete: Result notification sent');
            console.log('🎉 FULL FLOW TEST SUCCESSFUL!');
            console.log('📱 Check your Telegram for both notifications');
        } else {
            console.log('❌ Step 4 failed: Could not send result notification');
        }
    } else {
        console.log('❌ Step 3 failed: No response detected');
        console.log('Last 10 lines of tmux output:');
        console.log(tmuxContent.split('\n').slice(-10).join('\n'));
    }
}

function extractConversation(tmuxContent) {
    const lines = tmuxContent.split('\n');
    
    let userQuestion = '';
    let claudeResponse = '';
    
    // Find the most recent interaction
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        
        if (line.startsWith('⏺ ') && !claudeResponse) {
            claudeResponse = line.substring(2).trim();
        }
        
        if (line.startsWith('> ') && !userQuestion) {
            userQuestion = line.substring(2).trim();
            if (claudeResponse) break;
        }
    }
    
    return {
        userQuestion: userQuestion || 'Test command executed',
        claudeResponse: claudeResponse || 'Command completed successfully'
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

testFullFlow().catch(error => {
    console.error('❌ Full flow test failed:', error.message);
    process.exit(1);
});