#!/usr/bin/env node

/**
 * Slack Socket Mode Server
 * Starts the Slack Socket Mode connection for receiving messages
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Logger = require('./src/core/logger');
const SlackSocketHandler = require('./src/channels/slack/socket');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const logger = new Logger('Slack-Socket-Server');

// Load configuration
const config = {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    channelId: process.env.SLACK_CHANNEL_ID,
    repoPath: process.env.SLACK_REPO_PATH || process.cwd(),
    claudeCommand: process.env.SLACK_CLAUDE_COMMAND || 'claude --dangerously-skip-permissions',
    ownerUserId: process.env.SLACK_OWNER_USER_ID || '',
    whitelist: process.env.SLACK_WHITELIST ? process.env.SLACK_WHITELIST.split(',').map(id => id.trim()) : [],
    httpPort: parseInt(process.env.SLACK_HTTP_PORT) || 9999
};

// Validate configuration
if (!config.botToken) {
    logger.error('SLACK_BOT_TOKEN must be set in .env file');
    process.exit(1);
}

if (!config.appToken) {
    logger.error('SLACK_APP_TOKEN must be set in .env file (starts with xapp-)');
    process.exit(1);
}

const handler = new SlackSocketHandler(config);

async function start() {
    logger.info('Starting Slack Socket Mode server...');
    logger.info('Configuration:');
    logger.info(`- Repo Path: ${config.repoPath}`);
    logger.info(`- Claude Command: ${config.claudeCommand}`);
    logger.info(`- Channel ID: ${config.channelId || 'Any'}`);
    logger.info(`- Whitelist: ${config.whitelist.length > 0 ? config.whitelist.join(', ') : 'None (all authorized)'}`);
    logger.info(`- HTTP Port: ${config.httpPort}`);

    await handler.start();
    logger.info('Slack Socket Mode is running. Listening for messages...');
}

start().catch((error) => {
    logger.error('Failed to start Slack Socket Mode:', error.message);
    process.exit(1);
});

// Handle graceful shutdown
function shutdown() {
    logger.info('Shutting down Slack Socket Mode server...');
    handler.stop().then(() => {
        process.exit(0);
    }).catch(() => {
        process.exit(1);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
