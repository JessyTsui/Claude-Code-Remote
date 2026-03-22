#!/usr/bin/env node

/**
 * Claude Hook Notification Script
 * Called by Claude Code hooks (Stop/SubagentStop) to post responses to Slack.
 *
 * Logic:
 *  1. Read stdin JSON from Claude Code (contains last_assistant_message, transcript_path)
 *  2. Use last_assistant_message directly (or parse transcript as fallback)
 *  3. Get current tmux session name → look up channel/thread in SQLite
 *  4. Post Claude's actual response to the correct Slack thread
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

/**
 * Read JSON from stdin (Claude Code passes hook data here).
 */
function readStdin() {
    return new Promise((resolve) => {
        let input = '';
        process.stdin.on('data', (chunk) => input += chunk);
        process.stdin.on('end', () => {
            try {
                resolve(input.trim() ? JSON.parse(input) : {});
            } catch {
                resolve({});
            }
        });
        // If stdin is already closed or not piped, resolve immediately
        if (process.stdin.isTTY) resolve({});
    });
}

/**
 * Fallback: Parse a Claude Code JSONL transcript and extract the last assistant text message.
 */
function extractFromTranscript(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    const lines = content.split('\n');

    // Iterate backwards to find the last assistant message with text content
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.type !== 'assistant' || !entry.message?.content) continue;

            let text = '';
            if (typeof entry.message.content === 'string') {
                text = entry.message.content;
            } else if (Array.isArray(entry.message.content)) {
                text = entry.message.content
                    .filter(item => item.type === 'text')
                    .map(item => item.text)
                    .join('\n');
            }

            // Filter out system-reminder tags
            text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
            text = text.replace(/\n{3,}/g, '\n\n').trim();

            if (text) return text;
        } catch {
            continue;
        }
    }

    return null;
}

/**
 * Parse transcript to extract cumulative session stats (model, tokens, cost, context %).
 */
function extractSessionStats(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    const lines = content.split('\n');
    let totalOutput = 0;
    let model = null;
    let lastInputTokens = 0;
    let lastCacheRead = 0;
    let lastCacheCreation = 0;

    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (entry.type !== 'assistant') continue;

            if (entry.message?.model) {
                model = entry.message.model;
            }

            const usage = entry.message?.usage;
            if (usage) {
                totalOutput += usage.output_tokens || 0;
                // Keep last turn's values — these reflect current context window state
                lastInputTokens = usage.input_tokens || 0;
                lastCacheRead = usage.cache_read_input_tokens || 0;
                lastCacheCreation = usage.cache_creation_input_tokens || 0;
            }
        } catch {
            continue;
        }
    }

    if (!lastInputTokens && !totalOutput) return null;

    // Format model name: "claude-opus-4-6-20250318" → "opus-4-6", keep it dynamic
    let modelShort = model || '';
    const modelMatch = modelShort.match(/claude-(\w+-[\d-]+)/);
    if (modelMatch) modelShort = modelMatch[1];

    // Context usage = last turn's input + cache_read + cache_creation (total tokens in context window)
    const contextTokens = lastInputTokens + lastCacheRead + lastCacheCreation;
    const contextLimit = (model || '').includes('opus') ? 1000000 : 200000;
    const contextPct = Math.min(100, Math.round((contextTokens / contextLimit) * 100));

    // Format token counts
    const fmtTokens = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

    return {
        model: modelShort,
        context: `${contextPct}%`,
        tokensIn: fmtTokens(lastInputTokens),
        tokensOut: fmtTokens(totalOutput),
    };
}

/**
 * Send a response to Slack, splitting into chunks if needed.
 * Appends session stats (model, context, tokens) to the last chunk.
 */
async function sendResponse(web, channelId, threadTs, response, stats, mentionUserId = null) {
    const maxLen = 2990; // Slack section block text limit
    const mention = mentionUserId ? `<@${mentionUserId}> ` : '';
    const prefix = `:black_circle_for_record: ${mention}`;
    const statsLine = stats
        ? `_${stats.model} · Ctx: ${stats.context} · In: ${stats.tokensIn} Out: ${stats.tokensOut}_`
        : '';

    if (response.length <= maxLen) {
        const blocks = [
            { type: 'section', text: { type: 'mrkdwn', text: prefix + response } }
        ];
        if (statsLine) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine }] });
        }
        await web.chat.postMessage({
            channel: channelId,
            text: response,
            blocks,
            thread_ts: threadTs
        });
    } else {
        const chunks = [];
        for (let i = 0; i < response.length; i += maxLen) {
            chunks.push(response.substring(i, i + maxLen));
        }
        for (let i = 0; i < chunks.length; i++) {
            const text = (i === 0 ? prefix : '') + chunks[i];
            const blocks = [
                { type: 'section', text: { type: 'mrkdwn', text } }
            ];
            // Stats on last chunk only
            if (i === chunks.length - 1 && statsLine) {
                blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine }] });
            }
            await web.chat.postMessage({
                channel: channelId,
                text: chunks[i],
                blocks,
                thread_ts: threadTs
            });
        }
    }
}

async function sendHookNotification() {
    const notificationType = process.argv[2] || 'completed';
    const currentDir = process.cwd();
    const projectName = path.basename(currentDir);

    // Read hook input from stdin (Claude Code passes last_assistant_message, transcript_path, etc.)
    const hookInput = await readStdin();

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

    // Only act on slack-* tmux sessions (remote sessions spawned by the Slack bot).
    // Skip local/dev sessions to avoid noisy notifications.
    if (!tmuxSession || !tmuxSession.startsWith('slack-')) {
        process.exit(0);
    }

    // Determine channel/thread from DB
    let channelId = process.env.SLACK_CHANNEL_ID;
    let threadTs = undefined;
    let isAlertSession = false;
    let alertMessageTs = null;
    let lastUserId = null;

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
                    isAlertSession = !!row.alert_message_ts;
                    alertMessageTs = row.alert_message_ts || null;
                    lastUserId = row.last_user_id || null;
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

    const { WebClient } = require('@slack/web-api');
    const web = new WebClient(process.env.SLACK_BOT_TOKEN);

    // Get Claude's response: prefer last_assistant_message, fallback to transcript parsing
    const assistantMessage = hookInput.last_assistant_message
        || extractFromTranscript(hookInput.transcript_path);

    // Extract session stats from transcript (model, tokens, context %)
    const stats = extractSessionStats(hookInput.transcript_path);

    if (assistantMessage && threadTs) {
        try {
            if (isAlertSession) {
                // Alert session: check if we already posted a response (avoid duplicates from multiple Stop events)
                let alreadyPosted = false;
                try {
                    const replies = await web.conversations.replies({
                        channel: channelId,
                        ts: threadTs,
                        limit: 50
                    });
                    alreadyPosted = (replies.messages || []).some(m =>
                        (m.bot_id || m.app_id) && m.text?.includes('Recommended Action:')
                    );
                } catch {
                    // If check fails, proceed with posting
                }

                if (alreadyPosted) {
                    console.log(`Alert response already posted to ${channelId} thread=${threadTs}, skipping`);
                    // Still swap reactions if not done yet
                    try {
                        const reactTs = alertMessageTs || threadTs;
                        await web.reactions.remove({ channel: channelId, timestamp: reactTs, name: 'eyes' }).catch(() => {});
                        await web.reactions.add({ channel: channelId, timestamp: reactTs, name: 'white_check_mark' }).catch(() => {});
                    } catch { /* ignore */ }
                    return;
                }

                // Post summary + upload full report
                const match = assistantMessage.match(/Recommended Action:\s*([\s\S]*?)(?:\n\s*---|\n\n##|\n\n\*\*|$)/i);
                const summary = match ? match[1].trim() : assistantMessage.substring(0, 500).trim();

                const alertBlocks = [
                    { type: 'section', text: { type: 'mrkdwn', text: `*Recommended Action:* ${summary}` } }
                ];
                if (stats) {
                    const statsLine = `_${stats.model} · Ctx: ${stats.context} · In: ${stats.tokensIn} Out: ${stats.tokensOut}_`;
                    alertBlocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statsLine }] });
                }

                await web.chat.postMessage({
                    channel: channelId,
                    text: `Recommended Action: ${summary}`,
                    thread_ts: threadTs,
                    blocks: alertBlocks
                });

                await web.filesUploadV2({
                    channel_id: channelId,
                    thread_ts: threadTs,
                    content: assistantMessage,
                    filename: `alert-investigation-${Date.now()}.txt`,
                    title: 'Full Investigation Report',
                    initial_comment: '_Full investigation details attached._',
                });

                // Swap reactions: 👀 → ✅
                try {
                    await web.reactions.remove({ channel: channelId, timestamp: threadTs, name: 'eyes' }).catch(() => {});
                    await web.reactions.add({ channel: channelId, timestamp: threadTs, name: 'white_check_mark' }).catch(() => {});
                } catch { /* ignore */ }

                console.log(`Alert response posted (${assistantMessage.length} chars) to ${channelId} thread=${threadTs}`);
            } else {
                // Regular session: post clean response with stats, mention last user
                await sendResponse(web, channelId, threadTs, assistantMessage, stats, lastUserId);
                console.log(`Response posted (${assistantMessage.length} chars) to ${channelId} thread=${threadTs}`);
            }
        } catch (error) {
            console.error('Failed to post response:', error.message);
        }
        return;
    }

    // Fallback: post status notification (no response available or no thread)
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
