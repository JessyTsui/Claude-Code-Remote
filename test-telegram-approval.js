#!/usr/bin/env node

/**
 * Test Telegram Approval Detection and Message Formatting
 * Tests the new approval detection, message splitting, and button generation features
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

// Test cases for approval detection
const approvalTestCases = [
    {
        name: 'Permission question with "Do you want"',
        text: 'I found some files. Do you want me to delete them?',
        shouldDetect: true
    },
    {
        name: 'Permission question with "Should I"',
        text: 'The tests are failing. Should I fix them automatically?',
        shouldDetect: true
    },
    {
        name: 'Permission question with "Can I"',
        text: 'Can I run npm install to add the dependencies?',
        shouldDetect: true
    },
    {
        name: 'Permission with "proceed"',
        text: 'This will modify 15 files. Proceed with the changes?',
        shouldDetect: true
    },
    {
        name: 'Tool permission',
        text: 'Claude wants to use the Bash tool. Allow tool usage?',
        shouldDetect: true
    },
    {
        name: 'Edit acceptance',
        text: 'I want to make the following changes. Accept this edit?',
        shouldDetect: true
    },
    {
        name: 'Yes/No question',
        text: 'Continue with this approach? (y/n)',
        shouldDetect: true
    },
    {
        name: 'Regular statement (no approval)',
        text: 'I have completed the analysis of your codebase.',
        shouldDetect: false
    },
    {
        name: 'Question without approval keywords',
        text: 'What framework are you using for this project?',
        shouldDetect: false
    },
    {
        name: 'Statement with question mark',
        text: 'You mentioned you want to refactor the code?',
        shouldDetect: false
    }
];

// Test cases for message splitting
const splitTestCases = [
    {
        name: 'Short message (no split)',
        length: 500,
        expectedParts: 1
    },
    {
        name: 'Medium message (no split)',
        length: 3000,
        expectedParts: 1
    },
    {
        name: 'Long message (needs split)',
        length: 5000,
        expectedParts: 2
    },
    {
        name: 'Very long message (multiple splits)',
        length: 10000,
        expectedParts: 3
    }
];

function generateTestText(length) {
    const words = ['Lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit'];
    let text = '';
    while (text.length < length) {
        text += words[Math.floor(Math.random() * words.length)] + ' ';
        if (text.length % 100 < 10) text += '\n'; // Add some newlines
    }
    return text.substring(0, length);
}

async function runTests() {
    console.log('🧪 Testing Telegram Approval Detection and Message Formatting\n');
    console.log('=' .repeat(60) + '\n');

    const config = {
        botToken: process.env.TELEGRAM_BOT_TOKEN || 'test-token',
        chatId: process.env.TELEGRAM_CHAT_ID || '12345'
    };

    const telegramChannel = new TelegramChannel(config);

    let passed = 0;
    let failed = 0;

    // Test 1: Approval Detection
    console.log('📋 Test 1: Approval Detection\n');

    for (const testCase of approvalTestCases) {
        const result = telegramChannel._detectApprovalRequest(testCase.text);
        const detected = result !== null;
        const success = detected === testCase.shouldDetect;

        if (success) {
            console.log(`  ✅ ${testCase.name}`);
            passed++;
        } else {
            console.log(`  ❌ ${testCase.name}`);
            console.log(`     Expected: ${testCase.shouldDetect ? 'approval detected' : 'no approval'}`);
            console.log(`     Got: ${detected ? 'approval detected' : 'no approval'}`);
            if (result) {
                console.log(`     Matched: "${result.question}"`);
            }
            failed++;
        }
    }

    console.log('\n' + '-'.repeat(60) + '\n');

    // Test 2: Message Splitting
    console.log('📋 Test 2: Message Splitting\n');

    for (const testCase of splitTestCases) {
        const text = generateTestText(testCase.length);
        const parts = telegramChannel._splitMessage(text);
        const success = parts.length === testCase.expectedParts;

        if (success) {
            console.log(`  ✅ ${testCase.name} (${testCase.length} chars → ${parts.length} parts)`);
            passed++;
        } else {
            console.log(`  ❌ ${testCase.name}`);
            console.log(`     Expected: ${testCase.expectedParts} parts`);
            console.log(`     Got: ${parts.length} parts`);
            failed++;
        }
    }

    console.log('\n' + '-'.repeat(60) + '\n');

    // Test 3: Approval Buttons Generation
    console.log('📋 Test 3: Approval Buttons Generation\n');

    const buttons = telegramChannel._generateApprovalButtons('TEST1234');

    // Check button structure
    const hasYesNo = buttons[0]?.length === 2 &&
                     buttons[0][0].text.includes('Yes') &&
                     buttons[0][1].text.includes('No');
    const hasSkipDeny = buttons[1]?.length === 2 &&
                        buttons[1][0].text.includes('Skip') &&
                        buttons[1][1].text.includes('Deny');
    const hasAlwaysAllow = buttons[2]?.length === 1 &&
                           buttons[2][0].text.includes('don\'t ask again');

    if (hasYesNo) {
        console.log('  ✅ Yes/No buttons present');
        passed++;
    } else {
        console.log('  ❌ Yes/No buttons missing or malformed');
        failed++;
    }

    if (hasSkipDeny) {
        console.log('  ✅ Skip/Always Deny buttons present');
        passed++;
    } else {
        console.log('  ❌ Skip/Always Deny buttons missing or malformed');
        failed++;
    }

    if (hasAlwaysAllow) {
        console.log('  ✅ Always Allow button present');
        passed++;
    } else {
        console.log('  ❌ Always Allow button missing or malformed');
        failed++;
    }

    // Check callback data format
    const callbackValid = buttons[0][0].callback_data === 'approve:TEST1234:yes' &&
                          buttons[0][1].callback_data === 'approve:TEST1234:no';
    if (callbackValid) {
        console.log('  ✅ Callback data format correct');
        passed++;
    } else {
        console.log('  ❌ Callback data format incorrect');
        console.log(`     Got: ${buttons[0][0].callback_data}`);
        failed++;
    }

    console.log('\n' + '-'.repeat(60) + '\n');

    // Test 4: Message Generation with Approval
    console.log('📋 Test 4: Message Generation with Approval Request\n');

    const approvalNotification = {
        type: 'waiting',
        project: 'test-project',
        metadata: {
            userQuestion: 'Please refactor this code',
            claudeResponse: 'I found some issues. Do you want me to fix them automatically? This will modify several files.',
            tmuxSession: 'test-session'
        }
    };

    const messageResult = telegramChannel._generateTelegramMessage(approvalNotification, 'uuid-123', 'TEST1234');

    if (messageResult.hasApproval) {
        console.log('  ✅ Approval detected in notification');
        passed++;
    } else {
        console.log('  ❌ Approval not detected in notification');
        failed++;
    }

    if (messageResult.approvalButtons && messageResult.approvalButtons.length > 0) {
        console.log('  ✅ Approval buttons generated');
        passed++;
    } else {
        console.log('  ❌ Approval buttons not generated');
        failed++;
    }

    if (messageResult.text.includes('⚠️')) {
        console.log('  ✅ Warning indicator present');
        passed++;
    } else {
        console.log('  ❌ Warning indicator missing');
        failed++;
    }

    console.log('\n' + '-'.repeat(60) + '\n');

    // Test 5: Message Generation without Approval
    console.log('📋 Test 5: Message Generation without Approval Request\n');

    const regularNotification = {
        type: 'completed',
        project: 'test-project',
        metadata: {
            userQuestion: 'What is this codebase about?',
            claudeResponse: 'This is a notification system for Claude Code.',
            tmuxSession: 'test-session'
        }
    };

    const regularResult = telegramChannel._generateTelegramMessage(regularNotification, 'uuid-456', 'TEST5678');

    if (!regularResult.hasApproval) {
        console.log('  ✅ No approval detected (correct)');
        passed++;
    } else {
        console.log('  ❌ Approval incorrectly detected');
        failed++;
    }

    if (regularResult.approvalButtons === null) {
        console.log('  ✅ No approval buttons (correct)');
        passed++;
    } else {
        console.log('  ❌ Approval buttons incorrectly generated');
        failed++;
    }

    if (regularResult.text.includes('/cmd TEST5678')) {
        console.log('  ✅ Command help included');
        passed++;
    } else {
        console.log('  ❌ Command help missing');
        failed++;
    }

    console.log('\n' + '='.repeat(60) + '\n');

    // Summary
    const total = passed + failed;
    console.log(`📊 Results: ${passed}/${total} tests passed\n`);

    if (failed === 0) {
        console.log('✅ All tests passed!\n');
    } else {
        console.log(`❌ ${failed} test(s) failed\n`);
        process.exit(1);
    }
}

// Run tests
runTests().catch(console.error);
