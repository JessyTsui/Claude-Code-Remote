#!/usr/bin/env node

/**
 * Live Test: Telegram Approval Notification
 * Sends an actual notification with approval buttons to Telegram
 *
 * Usage: node test-telegram-approval-live.js [scenario]
 *
 * Scenarios:
 *   approval  - Send notification with approval request (default)
 *   long      - Send a very long notification that gets split
 *   regular   - Send a regular notification without approval
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const TelegramChannel = require('./src/channels/telegram/telegram');

const scenarios = {
    approval: {
        type: 'waiting',
        title: 'Claude needs your approval',
        message: 'Claude is waiting for permission',
        project: 'test-approval',
        metadata: {
            userQuestion: 'Please refactor the authentication module to use JWT tokens instead of sessions.',
            claudeResponse: `I've analyzed the authentication module and found the following:

1. Current implementation uses express-session
2. 15 files need to be modified
3. Tests will need updating

**Do you want me to proceed with these changes?**

This will:
- Replace session middleware with JWT verification
- Update all auth-related routes
- Modify the user model

The changes are significant but reversible.`,
            tmuxSession: 'test-session'
        }
    },

    long: {
        type: 'completed',
        title: 'Analysis Complete',
        message: 'Claude completed the analysis',
        project: 'test-long-message',
        metadata: {
            userQuestion: 'Analyze the entire codebase and provide a comprehensive report.',
            claudeResponse: `# Codebase Analysis Report

## Overview
This is a comprehensive analysis of the Claude-Code-Remote project.

## Architecture
The project follows a modular architecture with the following components:

### Core Components
1. **Notification System** - Handles sending notifications via multiple channels
2. **Webhook Handlers** - Processes incoming messages from Telegram/LINE
3. **Session Management** - Tracks active sessions with tokens
4. **Command Injection** - Injects commands into tmux sessions

### Channel Implementations
- **Telegram** - Full-featured with inline buttons
- **LINE** - Basic messaging support
- **Email** - SMTP-based notifications

## File Structure
\`\`\`
src/
├── channels/
│   ├── telegram/
│   ├── line/
│   └── email/
├── core/
│   ├── notifier.js
│   └── logger.js
├── utils/
│   ├── tmux-monitor.js
│   └── controller-injector.js
└── data/
    └── sessions/
\`\`\`

## Dependencies
- express: Web framework for webhooks
- axios: HTTP client for API calls
- node-pty: Terminal emulation
- pino: High-performance logging

## Recommendations
1. Add rate limiting to webhook endpoints
2. Implement session cleanup cron job
3. Add health check endpoints
4. Consider adding Redis for session storage

## Security Considerations
- Tokens expire after 24 hours
- Whitelist-based authorization
- No sensitive data in logs

## Performance
- Average response time: <100ms
- Memory usage: ~50MB
- Supports concurrent sessions

This analysis covers the main aspects of the codebase. Let me know if you need more details on any specific component.`,
            tmuxSession: 'test-session'
        }
    },

    regular: {
        type: 'completed',
        title: 'Task Completed',
        message: 'Claude has finished the task',
        project: 'test-regular',
        metadata: {
            userQuestion: 'What time is it?',
            claudeResponse: 'Based on the system clock, the current time is 3:45 PM. Is there anything else you would like to know?',
            tmuxSession: 'test-session'
        }
    }
};

async function runLiveTest(scenarioName = 'approval') {
    console.log('🧪 Live Test: Telegram Notification\n');

    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        console.error('❌ Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env');
        process.exit(1);
    }

    const scenario = scenarios[scenarioName];
    if (!scenario) {
        console.error(`❌ Unknown scenario: ${scenarioName}`);
        console.error(`   Available: ${Object.keys(scenarios).join(', ')}`);
        process.exit(1);
    }

    console.log(`📋 Scenario: ${scenarioName}\n`);

    const config = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    };

    const telegramChannel = new TelegramChannel(config);

    try {
        console.log('📱 Sending notification...\n');
        const result = await telegramChannel.send(scenario);

        if (result) {
            console.log('✅ Notification sent successfully!\n');

            if (scenarioName === 'approval') {
                console.log('🎯 Expected behavior:');
                console.log('   - Message shows "ACTION REQUIRED" banner at top');
                console.log('   - Approval question is highlighted');
                console.log('   - Buttons appear: Yes, No, Skip, Always Deny, Yes don\'t ask again');
                console.log('   - Clicking a button sends the response to Claude\n');
            } else if (scenarioName === 'long') {
                console.log('🎯 Expected behavior:');
                console.log('   - Message is split into multiple parts');
                console.log('   - Each part is labeled [1/N], [2/N], etc.');
                console.log('   - Help buttons appear on the last message only\n');
            } else {
                console.log('🎯 Expected behavior:');
                console.log('   - Standard notification format');
                console.log('   - Personal/Group chat help buttons');
                console.log('   - No approval section\n');
            }
        } else {
            console.log('❌ Failed to send notification');
            process.exit(1);
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

// Get scenario from command line
const scenario = process.argv[2] || 'approval';
runLiveTest(scenario);
