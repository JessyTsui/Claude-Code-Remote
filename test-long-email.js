#!/usr/bin/env node

/**
 * Test script for long email content
 * Tests the new terminal-style email template with long Claude responses
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const EmailChannel = require('./src/channels/email/smtp');
const ConfigManager = require('./src/core/config');

async function testLongEmail() {
    console.log('Testing long email content...\n');
    
    // Load config
    const configManager = new ConfigManager();
    configManager.load();
    const emailConfig = configManager.getChannel('email');
    
    if (!emailConfig || !emailConfig.enabled) {
        console.error('❌ Email channel not configured or disabled');
        console.log('Please configure email in config/channels.json first');
        process.exit(1);
    }
    
    // Create email channel
    const email = new EmailChannel(emailConfig.config);
    
    // Create a test notification with very long content
    const longCodeExample = `
function processData(inputArray) {
    // This is a sample function with detailed implementation
    const results = [];
    
    for (let i = 0; i < inputArray.length; i++) {
        const item = inputArray[i];
        
        // Validate input
        if (!item || typeof item !== 'object') {
            console.warn(\`Invalid item at index \${i}\`);
            continue;
        }
        
        // Process each item
        const processed = {
            id: item.id || generateId(),
            name: item.name?.trim() || 'Unknown',
            timestamp: new Date().toISOString(),
            data: {
                original: item,
                processed: true,
                metadata: {
                    source: 'test-system',
                    version: '1.0.0',
                    processingTime: Date.now()
                }
            }
        };
        
        // Apply transformations
        if (item.transform) {
            processed.data.transformed = applyTransform(item.transform, item);
        }
        
        results.push(processed);
    }
    
    return results;
}

// Helper functions
function generateId() {
    return 'id_' + Math.random().toString(36).substr(2, 9);
}

function applyTransform(transformType, data) {
    switch (transformType) {
        case 'uppercase':
            return JSON.stringify(data).toUpperCase();
        case 'reverse':
            return JSON.stringify(data).split('').reverse().join('');
        default:
            return data;
    }
}
`;
    
    const testNotification = {
        type: 'completed',
        title: 'Test Long Content',
        message: 'Testing terminal-style email with long Claude response',
        project: 'Claude-Code-Remote-Test',
        metadata: {
            userQuestion: 'Please help me implement a data processing function with error handling, validation, and transformation features',
            claudeResponse: `I'll help you implement a comprehensive data processing function. Here's a complete implementation with all the features you requested:

${longCodeExample}

This implementation includes:

1. **Input Validation**: The function checks each item to ensure it's a valid object before processing.

2. **Error Handling**: Uses try-catch blocks and console warnings for invalid items.

3. **Data Transformation**: Supports different transformation types through the \`applyTransform\` function.

4. **Metadata Tracking**: Each processed item includes metadata about when and how it was processed.

5. **ID Generation**: Automatically generates unique IDs for items that don't have one.

Additional features you might want to consider:

- **Async Processing**: For handling large datasets or async transformations
- **Batch Processing**: Process items in chunks to avoid memory issues
- **Progress Tracking**: Add callbacks or events to track processing progress
- **Custom Validators**: Allow custom validation functions to be passed in
- **Error Recovery**: Implement retry logic for failed items

The function is designed to be extensible and maintainable. You can easily add new transformation types or modify the processing logic as needed.`,
            tmuxSession: 'test-session'
        }
    };
    
    try {
        console.log('Sending test email with long content...');
        const result = await email._sendImpl(testNotification);
        
        if (result) {
            console.log('✅ Email sent successfully!');
            console.log('Check your inbox for the terminal-style email');
        } else {
            console.log('❌ Failed to send email');
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

// Run test
testLongEmail();