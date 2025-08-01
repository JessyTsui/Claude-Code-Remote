#!/usr/bin/env node

/**
 * LINE Webhook Server
 * Starts the LINE webhook server for receiving messages
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Logger = require('./src/core/logger');
const LINEWebhookHandler = require('./src/channels/line/webhook');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const logger = new Logger('LINE-Webhook-Server');

// Load configuration
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    userId: process.env.LINE_USER_ID,
    groupId: process.env.LINE_GROUP_ID,
    whitelist: process.env.LINE_WHITELIST ? process.env.LINE_WHITELIST.split(',').map(id => id.trim()) : [],
    port: process.env.LINE_WEBHOOK_PORT || 3000
};

// Validate configuration
if (!config.channelAccessToken || !config.channelSecret) {
    logger.error('LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET must be set in .env file');
    process.exit(1);
}

if (!config.userId && !config.groupId) {
    logger.error('Either LINE_USER_ID or LINE_GROUP_ID must be set in .env file');
    process.exit(1);
}

// Create and start webhook handler
const webhookHandler = new LINEWebhookHandler(config);

logger.info('Starting LINE webhook server...');
logger.info(`Configuration:`);
logger.info(`- Port: ${config.port}`);
logger.info(`- User ID: ${config.userId || 'Not set'}`);
logger.info(`- Group ID: ${config.groupId || 'Not set'}`);
logger.info(`- Whitelist: ${config.whitelist.length > 0 ? config.whitelist.join(', ') : 'None (using configured IDs)'}`);

webhookHandler.start(config.port);

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down LINE webhook server...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Shutting down LINE webhook server...');
    process.exit(0);
});