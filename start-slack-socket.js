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
const { runDailySummary, parseChannelsConfig } = require('./src/services/daily-summary');

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
    pollerTimeoutMs: parseInt(process.env.POLLER_TIMEOUT_MS) || 1800000, // 30 min
    pagerdutyApiToken: process.env.PAGERDUTY_API_TOKEN || '',
    pagerdutyFromEmail: process.env.PAGERDUTY_FROM_EMAIL || '',
    // Delay alert monitoring
    monitorDelayChannels: process.env.MONITOR_DELAY_CHANNELS || '',
    delayAlertThreshold: process.env.DELAY_ALERT_THRESHOLD || '3',
    delayAlertWindowMs: process.env.DELAY_ALERT_WINDOW_MS || '3600000',
    delayAlertTaskPatterns: process.env.DELAY_ALERT_TASK_PATTERNS || '',
    delayAlertSkill: process.env.DELAY_ALERT_SKILL || 'one:pay-ops-tax-production',
    // Daily summary
    dailySummaryChannels: process.env.DAILY_SUMMARY_CHANNELS || '',
    dailySummaryTime: process.env.DAILY_SUMMARY_TIME || '07:00',
    dailySummaryModel: process.env.DAILY_SUMMARY_MODEL || 'sonnet',
    xoxcToken: process.env.SLACK_XOXC_TOKEN || '',
    xoxdToken: process.env.SLACK_XOXD_TOKEN || '',
    // App mode: 'local' (mentions only), 'cloud' (monitors + summary only), 'all' (everything)
    appMode: (process.env.APP_MODE || 'all').toLowerCase(),
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
            const MAX_RETRIES = 3;
            const RETRY_DELAY_MS = 5000;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    await handler.stop();
                    await handler.start();
                    logger.info('Daily restart completed successfully');
                    break;
                } catch (err) {
                    logger.error(`Daily restart attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
                    if (attempt === MAX_RETRIES) {
                        logger.error('All restart attempts failed — exiting process');
                        process.exit(1);
                    }
                    logger.info(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                }
            }
            scheduleNext();
        }, ms);
    }

    scheduleNext();
}

function scheduleDailySummary(time) {
    const channels = parseChannelsConfig(config.dailySummaryChannels);
    if (channels.length === 0) return;

    const [hh, mm] = time.split(':').map(Number);

    function msUntilNextOccurrence() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(hh, mm, 0, 0);
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }
        return target - now;
    }

    function scheduleNext() {
        const ms = msUntilNextOccurrence();
        const hours = (ms / 3600000).toFixed(1);
        logger.info(`Daily summary scheduled at ${time} (in ${hours}h) for: ${channels.map(c => c.name).join(', ')}`);
        setTimeout(async () => {
            logger.info('Daily summary triggered');
            try {
                await runDailySummary({
                    channels,
                    ownerUserId: config.ownerUserId,
                    model: config.dailySummaryModel,
                    xoxcToken: config.xoxcToken,
                    xoxdToken: config.xoxdToken,
                    slackClient: handler.app.client,
                    deliveryChannelId: config.channelId,
                });
            } catch (err) {
                logger.error(`Daily summary failed: ${err.message}`);
            }
            scheduleNext();
        }, ms).unref();
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
    logger.info(`- Poller Timeout: ${config.pollerTimeoutMs}ms`);
    logger.info(`- Delay Monitor Channels: ${config.monitorDelayChannels || 'None'}`);
    logger.info(`- Delay Alert Skill: ${config.delayAlertSkill}`);
    logger.info(`- Delay Alert Threshold: ${config.delayAlertThreshold} alerts in ${config.delayAlertWindowMs}ms`);
    logger.info(`- Daily Summary: ${config.dailySummaryChannels ? `${config.dailySummaryTime} → ${config.dailySummaryChannels}` : 'Not configured'}`);
    logger.info(`- App Mode: ${config.appMode}`);

    await handler.start();
    logger.info('Slack Socket Mode is running. Listening for messages...');

    // Schedule daily restart if configured
    const restartHour = parseInt(process.env.DAILY_RESTART_HOUR);
    if (!isNaN(restartHour) && restartHour >= 0 && restartHour <= 23) {
        scheduleDailyRestart(restartHour);
    }

    // Schedule daily summary if configured (skip in local mode)
    if (config.dailySummaryChannels && config.appMode !== 'local') {
        scheduleDailySummary(config.dailySummaryTime);
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

// Track last log time per rejection reason to avoid log spam
const _rejectionLogTimes = new Map();
const REJECTION_LOG_INTERVAL = 60000; // 1 min

// WebSocket-specific error patterns to feed into the resilience tracker
const WS_ERROR_PATTERNS = [
    'WebSocket was closed before the connection was established',
    'no active connection',
    'client is not ready',
    'Failed to send a WebSocket message',
    'Failed to send a message as the client',
];

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const now = Date.now();
    const lastLogged = _rejectionLogTimes.get(msg) || 0;
    if (now - lastLogged >= REJECTION_LOG_INTERVAL) {
        _rejectionLogTimes.set(msg, now);
        logger.error(`Unhandled rejection: ${msg}`);
    }

    // Feed WebSocket-specific rejections into the handler's error tracker
    if (WS_ERROR_PATTERNS.some(pattern => msg.includes(pattern))) {
        if (handler && handler._recordWsError) {
            handler._recordWsError('unhandled_rejection', msg);
        }
    }
});
