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
    repoRoot: process.env.SLACK_REPO_ROOT || '',
    claudeCommand: process.env.SLACK_CLAUDE_COMMAND || 'claude --dangerously-skip-permissions',
    ownerUserId: process.env.SLACK_OWNER_USER_ID || '',
    whitelist: process.env.SLACK_WHITELIST ? process.env.SLACK_WHITELIST.split(',').map(id => id.trim()) : [],
    httpPort: parseInt(process.env.SLACK_HTTP_PORT) || 9999,
    // Alert monitoring
    monitorChannels: process.env.MONITOR_CHANNELS || '',
    alertSkill: process.env.ALERT_SKILL || '',
    sessionInactivityTimeoutMs: parseInt(process.env.SESSION_INACTIVITY_TIMEOUT_MS) || 300000,
    pagerdutyApiToken: process.env.PAGERDUTY_API_TOKEN || '',
    pagerdutyFromEmail: process.env.PAGERDUTY_FROM_EMAIL || ''
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

function scheduleDailyRestart(hour) {
    function msUntilNextOccurrence() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(hour, 0, 0, 0);
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }
        return target - now;
    }

    function scheduleNext() {
        const ms = msUntilNextOccurrence();
        const hours = (ms / 3600000).toFixed(1);
        logger.info(`Daily restart scheduled at ${hour}:00 (in ${hours}h)`);
        setTimeout(async () => {
            logger.info('Daily restart triggered — restarting Bolt app...');
            try {
                await handler.stop();
                await handler.start();
                logger.info('Daily restart completed successfully');
            } catch (err) {
                logger.error(`Daily restart failed: ${err.message} — exiting process`);
                process.exit(1);
            }
            scheduleNext();
        }, ms);
    }

    scheduleNext();
}

async function start() {
    logger.info('Starting Slack Socket Mode server...');
    logger.info('Configuration:');
    logger.info(`- Repo Path: ${config.repoPath}`);
    logger.info(`- Repo Root: ${config.repoRoot || 'Not set'}`);
    logger.info(`- Claude Command: ${config.claudeCommand}`);
    logger.info(`- Channel ID: ${config.channelId || 'Any'}`);
    logger.info(`- Whitelist: ${config.whitelist.length > 0 ? config.whitelist.join(', ') : 'None (all authorized)'}`);
    logger.info(`- HTTP Port: ${config.httpPort}`);
    logger.info(`- Monitor Channels: ${config.monitorChannels || 'None'}`);
    logger.info(`- Alert Skill: ${config.alertSkill || 'None'}`);
    logger.info(`- PagerDuty: ${config.pagerdutyApiToken ? 'Configured' : 'Not configured'}`);
    logger.info(`- Session Inactivity Timeout: ${config.sessionInactivityTimeoutMs}ms`);

    await handler.start();
    logger.info('Slack Socket Mode is running. Listening for messages...');

    // Schedule daily restart if configured
    const restartHour = parseInt(process.env.DAILY_RESTART_HOUR);
    if (!isNaN(restartHour) && restartHour >= 0 && restartHour <= 23) {
        scheduleDailyRestart(restartHour);
    }
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

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
});
