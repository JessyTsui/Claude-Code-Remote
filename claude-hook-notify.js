#!/usr/bin/env node

/**
 * Claude Hook Notification Script
 * Called by Claude Code hooks to send Slack notifications.
 *
 * Logic:
 *  1. Get current tmux session name
 *  2. Look up session in SQLite DB
 *  3. If found -> post to that channel/thread
 *  4. If not found -> post top-level message to SLACK_CHANNEL_ID
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { execSync } = require('child_process');

// Load environment variables from the project directory
const projectDir = path.dirname(__filename);
const envPath = path.join(projectDir, '.env');

if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    console.error('.env file not found at:', envPath);
    process.exit(1);
}

async function sendHookNotification() {
    const notificationType = process.argv[2] || 'completed';
    const currentDir = process.cwd();
    const projectName = path.basename(currentDir);

    // Get current tmux session name
    let tmuxSession = null;
    try {
        tmuxSession = execSync('tmux display-message -p "#S"', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch {
        // Not in tmux
    }

    // Determine channel/thread from DB
    let channelId = process.env.SLACK_CHANNEL_ID;
    let threadTs = undefined;

    if (tmuxSession) {
        try {
            const Database = require('better-sqlite3');
            const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');

            if (fs.existsSync(dbPath)) {
                const db = new Database(dbPath, { readonly: true });
                const row = db.prepare('SELECT * FROM sessions WHERE session_name = ?').get(tmuxSession);
                db.close();

                if (row) {
                    channelId = row.channel_id;
                    threadTs = row.thread_ts;
                }
            }
        } catch (error) {
            console.error('DB lookup failed:', error.message);
        }
    }

    if (!channelId) {
        console.error('No SLACK_CHANNEL_ID configured and no session found');
        process.exit(1);
    }

    if (!process.env.SLACK_BOT_TOKEN) {
        console.error('SLACK_BOT_TOKEN not configured');
        process.exit(1);
    }

    // Post to Slack
    const { WebClient } = require('@slack/web-api');
    const web = new WebClient(process.env.SLACK_BOT_TOKEN);

    const emoji = notificationType === 'completed' ? ':white_check_mark:' : ':hourglass_flowing_sand:';
    const status = notificationType === 'completed' ? 'Completed' : 'Waiting for Input';
    const fallbackText = `${emoji} Claude Task ${status} - ${projectName}`;

    const blocks = [
        {
            type: 'header',
            text: { type: 'plain_text', text: `${emoji} Claude Task ${status}` }
        },
        {
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Project:*\n${projectName}` },
                { type: 'mrkdwn', text: `*Time:*\n${new Date().toLocaleTimeString()}` }
            ]
        }
    ];

    if (tmuxSession) {
        blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `tmux session: \`${tmuxSession}\`` }]
        });
    }

    try {
        await web.chat.postMessage({
            channel: channelId,
            text: fallbackText,
            blocks,
            thread_ts: threadTs
        });
        console.log(`Slack notification sent (${notificationType}) to ${channelId}${threadTs ? ' thread=' + threadTs : ''}`);
    } catch (error) {
        console.error('Failed to send Slack notification:', error.message);
        process.exit(1);
    }
}

sendHookNotification();
