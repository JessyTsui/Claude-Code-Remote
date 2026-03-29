/**
 * Daily Summary Service
 *
 * Fetches last 24h of Slack channel messages using personal credentials (xoxc/xoxd),
 * then passes the formatted messages to Claude Agent SDK for summarization.
 * No API key needed — uses Claude Code auth via Agent SDK.
 */

const { query } = require('@anthropic-ai/claude-agent-sdk');
const axios = require('axios');
const Logger = require('../core/logger');

const logger = new Logger('DailySummary');

/**
 * Fetch channel messages from last 24h using personal Slack credentials.
 */
async function fetchChannelMessages(channelId, xoxcToken, xoxdToken) {
    // Yesterday midnight-to-midnight in GMT+7 (Bangkok)
    const GMT7_OFFSET_MS = 7 * 3600000;
    const now = new Date();
    const nowGmt7 = new Date(now.getTime() + GMT7_OFFSET_MS);
    const todayMidnightGmt7 = Date.UTC(nowGmt7.getUTCFullYear(), nowGmt7.getUTCMonth(), nowGmt7.getUTCDate());
    const yesterdayMidnightGmt7 = todayMidnightGmt7 - 86400000;
    // Convert GMT+7 boundaries back to UTC epoch seconds
    const oldest = Math.floor((yesterdayMidnightGmt7 - GMT7_OFFSET_MS) / 1000);
    const latest = Math.floor((todayMidnightGmt7 - GMT7_OFFSET_MS) / 1000);

    const messages = [];
    let cursor;
    const cookieHeader = `d=${xoxdToken}`;

    do {
        const params = {
            channel: channelId,
            oldest: String(oldest),
            latest: String(latest),
            limit: 200,
            inclusive: true,
        };
        if (cursor) params.cursor = cursor;

        const resp = await axios.get('https://slack.com/api/conversations.history', {
            headers: {
                'Authorization': `Bearer ${xoxcToken}`,
                'Cookie': cookieHeader,
            },
            params,
        });

        if (!resp.data.ok) {
            throw new Error(`Slack API error: ${resp.data.error}`);
        }

        messages.push(...(resp.data.messages || []));
        cursor = resp.data.response_metadata?.next_cursor;
    } while (cursor);

    return messages.reverse(); // oldest first
}

/**
 * Resolve Slack user IDs to display names.
 */
async function resolveUsers(messages, xoxcToken, xoxdToken) {
    const userIds = new Set();
    for (const msg of messages) {
        if (msg.user) userIds.add(msg.user);
    }

    const cookieHeader = `d=${xoxdToken}`;
    const cache = {};

    for (const uid of userIds) {
        try {
            const resp = await axios.get('https://slack.com/api/users.info', {
                headers: {
                    'Authorization': `Bearer ${xoxcToken}`,
                    'Cookie': cookieHeader,
                },
                params: { user: uid },
            });
            if (resp.data.ok) {
                const u = resp.data.user;
                cache[uid] = u.profile?.display_name || u.real_name || u.name || uid;
            } else {
                cache[uid] = uid;
            }
        } catch {
            cache[uid] = uid;
        }
    }

    return cache;
}

/**
 * Filter and format messages into readable text.
 */
function formatMessages(messages, userCache) {
    const SKIP_SUBTYPES = new Set([
        'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
        'channel_name', 'channel_archive', 'channel_unarchive',
        'bot_add', 'bot_remove', 'pinned_item', 'unpinned_item',
    ]);

    const lines = [];
    for (const msg of messages) {
        if (msg.subtype && msg.subtype !== 'file_share' && SKIP_SUBTYPES.has(msg.subtype)) {
            continue;
        }

        const ts = new Date(parseFloat(msg.ts) * 1000);
        // Convert to GMT+7 (Bangkok)
        const bangkokTime = new Date(ts.getTime() + 7 * 3600000);
        const hh = String(bangkokTime.getUTCHours()).padStart(2, '0');
        const mm = String(bangkokTime.getUTCMinutes()).padStart(2, '0');

        const username = userCache[msg.user] || msg.username || 'unknown';
        const text = (msg.text || '').replace(/<@(\w+)>/g, (_, uid) => `@${userCache[uid] || uid}`);

        let line = `[${hh}:${mm}] ${username}: ${text}`;

        if (msg.subtype === 'file_share' && msg.files?.length) {
            const fileNames = msg.files.map(f => f.name || f.title || 'file').join(', ');
            line += ` [shared: ${fileNames}]`;
        }

        lines.push(line);
    }

    return lines.join('\n');
}

/**
 * Summarize formatted messages using Claude Agent SDK.
 * Messages are pre-fetched and included in the prompt — no MCP tools needed.
 */
async function summarizeWithClaude(channelName, formattedMessages, model) {
    const dateStr = new Date().toISOString().split('T')[0];

    const prompt = `You are a daily summary assistant. Today is ${dateStr}.

Below are the messages from the Slack channel #${channelName} from yesterday (timestamps in GMT+7/Bangkok time):

---
${formattedMessages}
---

Create a concise, well-organized summary with these sections:

## Key Discussions
- *[HH:MM] Topic title* - description of what was discussed, who was involved, key points

## Action Items
- Person: task or next step mentioned

## Resources Shared
- *Description*: URL (context)

---
*Summary*: One-line overall summary of the day's activity.

Rules:
- Each discussion bullet MUST start with *[HH:MM]* timestamp from the messages (bold, GMT+7)
- Include actual usernames from the messages
- Include actual URLs shared (not shortened or modified)
- If the channel had no meaningful activity, note it briefly
- Write in plain text suitable for Slack (use *bold* and _italic_ for formatting)
- Do NOT use any tools. Just analyze the messages above and return the summary text directly.

At the very end, add this footer on its own line:
_Sent using @Claude - model ${model}_`;

    logger.info(`Summarizing #${channelName} with ${model}...`);
    let text = '';

    for await (const message of query({
        prompt,
        options: {
            model,
            permissionMode: 'bypassPermissions',
            maxTurns: 1,
        },
    })) {
        if (message.type === 'result') {
            if (message.result) {
                text = message.result;
            }
            const cost = message.total_cost_usd;
            logger.info(`#${channelName} done. Cost: $${cost?.toFixed(4) ?? 'unknown'}`);
        }
    }

    return text;
}

/**
 * Send a DM/message, splitting long messages into thread replies.
 */
function createSendDm(slackClient) {
    const MAX_LEN = 3900;

    return async function sendDm(target, text) {
        if (text.length <= MAX_LEN) {
            await slackClient.chat.postMessage({ channel: target, text });
            return;
        }

        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= MAX_LEN) {
                chunks.push(remaining);
                break;
            }

            let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN);
            if (splitAt < MAX_LEN * 0.5) {
                splitAt = remaining.lastIndexOf('\n', MAX_LEN);
            }
            if (splitAt < MAX_LEN * 0.3) {
                splitAt = MAX_LEN;
            }

            chunks.push(remaining.substring(0, splitAt));
            remaining = remaining.substring(splitAt).trimStart();
        }

        const mainMsg = await slackClient.chat.postMessage({ channel: target, text: chunks[0] });
        for (let i = 1; i < chunks.length; i++) {
            await slackClient.chat.postMessage({
                channel: target,
                text: chunks[i],
                thread_ts: mainMsg.ts,
            });
        }
    };
}

/**
 * Run daily summary for all configured channels.
 */
async function runDailySummary(options) {
    const { channels, ownerUserId, model = 'sonnet', xoxcToken, xoxdToken, slackClient, deliveryChannelId } = options;

    if (!channels || channels.length === 0) {
        logger.info('No channels configured, skipping');
        return;
    }

    if (!xoxcToken || !xoxdToken) {
        logger.error('SLACK_XOXC_TOKEN and SLACK_XOXD_TOKEN required for daily summary');
        return;
    }

    const target = deliveryChannelId || ownerUserId;
    if (!target) {
        logger.error('No delivery target: set SLACK_OWNER_USER_ID or SLACK_CHANNEL_ID');
        return;
    }

    logger.info(`Starting for ${channels.length} channel(s): ${channels.map(c => c.name).join(', ')}`);
    const sendDm = createSendDm(slackClient);

    for (const channel of channels) {
        try {
            logger.info(`Fetching #${channel.name} (${channel.id})...`);
            const messages = await fetchChannelMessages(channel.id, xoxcToken, xoxdToken);

            if (messages.length === 0) {
                logger.info(`#${channel.name}: no messages`);
                await sendDm(target, `*#${channel.name}*\n_No activity yesterday._`);
                continue;
            }

            logger.info(`#${channel.name}: ${messages.length} messages, resolving users...`);
            const userCache = await resolveUsers(messages, xoxcToken, xoxdToken);
            const formatted = formatMessages(messages, userCache);

            const summary = await summarizeWithClaude(channel.name, formatted, model);

            if (summary) {
                await sendDm(target, summary);
                logger.info(`Summary delivered for #${channel.name}`);
            } else {
                logger.warn(`No summary text produced for #${channel.name}`);
            }
        } catch (err) {
            logger.error(`Error summarizing #${channel.name}: ${err.message}`);
        }
    }

    logger.info('All channels processed');
}

/**
 * Parse DAILY_SUMMARY_CHANNELS env var.
 * Format: "name:ID,name:ID" e.g. "general:C012345,engineering:C067890"
 */
function parseChannelsConfig(configStr) {
    if (!configStr) return [];
    return configStr.split(',').map(entry => {
        const [name, id] = entry.trim().split(':');
        return { name: name.trim(), id: (id || '').trim() };
    }).filter(c => c.name && c.id);
}

module.exports = { runDailySummary, parseChannelsConfig };
