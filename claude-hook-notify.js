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
    dotenv.config({ path: envPath, override: true });
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
 * For alert sessions: scan transcript for the assistant message containing the investigation report.
 * Returns the longest message with "Recommended Action:" marker, or null if not found.
 */
function extractAlertReport(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    let bestReport = null;

    for (const line of content.split('\n')) {
        try {
            const entry = JSON.parse(line);
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

            text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
            text = text.replace(/\n{3,}/g, '\n\n').trim();

            // Use stricter matching to avoid intermediate narration
            // (e.g. "Recommended Action: All agent definitions loaded...").
            // Real reports use markdown headings or bold and are 500+ chars.
            const MIN_REPORT_LEN = 500;
            if (text && text.length >= MIN_REPORT_LEN
                && /(?:^|\n)(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:/im.test(text)) {
                if (!bestReport || text.length > bestReport.length) {
                    bestReport = text;
                }
            }
        } catch {
            continue;
        }
    }

    return bestReport;
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

    // First chunk must leave room for the prefix
    const firstChunkMax = maxLen - prefix.length;

    if (response.length <= firstChunkMax) {
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
        // First chunk is smaller to accommodate prefix
        chunks.push(response.substring(0, firstChunkMax));
        for (let i = firstChunkMax; i < response.length; i += maxLen) {
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

/**
 * Free the alert_queue slot once the investigation report has been posted.
 * The tmux session stays alive so the user can ask follow-ups in-thread, but
 * the queue slot is released so the next pending alert can start.
 */
function markAlertQueueComplete(channelId, alertMessageTs) {
    if (!channelId || !alertMessageTs) return;
    try {
        const Database = require('better-sqlite3');
        const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');
        if (!fs.existsSync(dbPath)) return;
        const db = new Database(dbPath);
        const result = db.prepare(
            "UPDATE alert_queue SET status = 'completed', updated_at = ? " +
            "WHERE channel_id = ? AND message_ts = ? AND status = 'processing'"
        ).run(Date.now(), channelId, alertMessageTs);
        db.close();
        if (result.changes > 0) {
            console.log(`Alert queue: freed slot for channel=${channelId} ts=${alertMessageTs}`);
            kickQueue();
        }
    } catch (err) {
        console.error(`Failed to free alert queue slot: ${err.message}`);
    }
}

/**
 * Nudge the main Socket process to dequeue the next pending alert immediately.
 * Fire-and-forget — we don't care if the HTTP server isn't reachable.
 */
function kickQueue() {
    try {
        const port = process.env.SLACK_HTTP_PORT || 9999;
        const http = require('http');
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/queue/kick',
            method: 'POST',
            timeout: 2000,
        });
        req.on('error', () => {});
        req.end();
    } catch {}
}

async function sendHookNotification() {
    const notificationType = process.argv[2] || 'completed';
    const currentDir = process.cwd();
    const projectName = path.basename(currentDir);

    // Read hook input from stdin (Claude Code passes last_assistant_message, transcript_path, etc.)
    const hookInput = await readStdin();

    // Skip non-remote sessions: only proceed if SLACK_SESSION_KEY is set (bot sets this
    // in tmux env when creating sessions). No fallback — wrong thread is worse than silence.
    const slackSessionKey = process.env.SLACK_SESSION_KEY;
    if (!slackSessionKey) {
        process.exit(0);
    }

    // ─── SessionStart: register claude session_id in DB ──────────────
    if (notificationType === 'session_start') {
        const sessionId = hookInput.session_id;
        if (!sessionId || !slackSessionKey) {
            process.exit(0);
        }

        try {
            const Database = require('better-sqlite3');
            const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');

            if (fs.existsSync(dbPath)) {
                const db = new Database(dbPath);
                db.pragma('journal_mode = WAL');
                // Only set claude_session_id if not already set (preserve root/parent session).
                // Subagents (Agent tool) inherit SLACK_SESSION_KEY and fire their own SessionStart,
                // but we only want the root session's Stop hook to post alert responses.
                const result = db.prepare(
                    'UPDATE sessions SET claude_session_id = COALESCE(claude_session_id, ?), updated_at = ? WHERE session_key = ?'
                ).run(sessionId, Date.now(), slackSessionKey);
                db.close();
                console.log(`SessionStart: mapped session_id=${sessionId} to key=${slackSessionKey} (rows=${result.changes})`);
            }
        } catch (error) {
            console.error('SessionStart DB update failed:', error.message);
        }

        process.exit(0);
    }

    // ─── Stop/SubagentStop: resolve session from DB ──────────────────
    let channelId = process.env.SLACK_CHANNEL_ID;
    let threadTs = undefined;
    let isAlertSession = false;
    let alertMessageTs = null;
    let lastUserId = null;
    let rootSessionId = null;
    let sessionName = null;

    try {
        const Database = require('better-sqlite3');
        const dbPath = path.join(projectDir, 'src/data/slack-sessions.db');

        if (fs.existsSync(dbPath)) {
            const db = new Database(dbPath, { readonly: true });
            let row = null;

            // Strategy 1: lookup by SLACK_SESSION_KEY env var (direct primary-key match, always correct)
            if (slackSessionKey) {
                row = db.prepare(
                    'SELECT * FROM sessions WHERE session_key = ?'
                ).get(slackSessionKey);
                if (row) {
                    console.log(`Resolved via SLACK_SESSION_KEY=${slackSessionKey}`);
                }
            }

            // Strategy 2: lookup by claude session_id (works for Stop, may fail for SubagentStop)
            if (!row && hookInput.session_id) {
                row = db.prepare(
                    'SELECT * FROM sessions WHERE claude_session_id = ? LIMIT 1'
                ).get(hookInput.session_id);
                if (row) {
                    console.log(`Resolved via session_id=${hookInput.session_id}`);
                }
            }

            // No fallback — sending to the wrong thread is worse than no notification.
            // SLACK_SESSION_KEY and claude_session_id are the only reliable lookups.

            db.close();

            if (row) {
                channelId = row.channel_id;
                threadTs = row.thread_ts;
                isAlertSession = !!row.alert_message_ts;
                alertMessageTs = row.alert_message_ts || null;
                lastUserId = row.last_user_id || null;
                rootSessionId = row.claude_session_id || null;
                sessionName = row.session_name || null;
            }
        }
    } catch (error) {
        console.error('DB lookup failed:', error.message);
    }

    if (!channelId || !threadTs) {
        console.error('No session found — cannot post to Slack');
        process.exit(0);
    }

    if (!process.env.SLACK_BOT_TOKEN) {
        console.error('SLACK_BOT_TOKEN not configured');
        process.exit(1);
    }

    const { WebClient } = require('@slack/web-api');
    const web = new WebClient(process.env.SLACK_BOT_TOKEN);

    // Get Claude's response: prefer last_assistant_message, fallback to transcript parsing
    let assistantMessage = hookInput.last_assistant_message
        || extractFromTranscript(hookInput.transcript_path);

    // Extract session stats from transcript (model, tokens, context %)
    const stats = extractSessionStats(hookInput.transcript_path);

    if (assistantMessage && threadTs) {
        try {
            if (isAlertSession) {
                // Alert sessions: only post on final Stop (completed), not SubagentStop (waiting).
                // SubagentStop fires for every subagent during investigation and would post
                // intermediate garbage (skill file contents, etc.) as "Recommended Action".
                if (notificationType !== 'completed') {
                    console.log(`Alert session: skipping ${notificationType} (only post on completed)`);
                    return;
                }

                // Only allow the root/parent session to post. Subagents (Agent tool) inherit
                // SLACK_SESSION_KEY and fire their own Stop hooks — their last_assistant_message
                // is often skill file contents or intermediate output, not the investigation report.
                // SessionStart uses COALESCE to preserve the root session_id.
                if (rootSessionId && hookInput.session_id && hookInput.session_id !== rootSessionId) {
                    console.log(`Alert session: skipping Stop from subagent (hook=${hookInput.session_id}, root=${rootSessionId})`);
                    return;
                }

                // Check if alert summary was already posted (by poller or earlier hook)
                let alreadyPosted = false;
                try {
                    const replies = await web.conversations.replies({
                        channel: channelId,
                        ts: threadTs,
                        limit: 50
                    });
                    alreadyPosted = (replies.messages || []).some(m =>
                        m.ts !== threadTs && m.text?.includes('Recommended Action:')
                    );
                } catch {
                    // If check fails, proceed with posting
                }

                if (alreadyPosted) {
                    // Alert summary already posted. This is a follow-up @mention response —
                    // post as regular response (no "Recommended Action:" format, no file upload).
                    // Use the original last_assistant_message, NOT extractAlertReport().
                    console.log(`Alert summary already posted — posting follow-up as regular response`);
                    await sendResponse(web, channelId, threadTs, assistantMessage, stats, lastUserId);
                    console.log(`Follow-up response posted (${assistantMessage.length} chars) to ${channelId} thread=${threadTs}`);
                } else {
                    // First alert response: override assistantMessage with the full investigation
                    // report from transcript (last_assistant_message is often a cleanup message).
                    let hasValidReport = false;
                    if (hookInput.transcript_path) {
                        const report = extractAlertReport(hookInput.transcript_path);
                        if (report) {
                            console.log(`Alert report found in transcript (${report.length} chars), overriding last_assistant_message (${(assistantMessage || '').length} chars)`);
                            assistantMessage = report;
                            hasValidReport = true;
                        }
                    }

                    // Fallback: check if assistantMessage itself qualifies as a real report
                    if (!hasValidReport && assistantMessage && assistantMessage.length >= 500
                        && /(?:^|\n)(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:/im.test(assistantMessage)) {
                        hasValidReport = true;
                    }

                    if (hasValidReport) {
                        // Clean up retry file on success
                        try { fs.unlinkSync(`/tmp/hook-retry-${slackSessionKey}`); } catch { /* ignore */ }
                        // Post summary + upload full report
                        const match = assistantMessage.match(/Recommended Action:\s*([\s\S]*?)(?:\n\s*---|\n\n##|\n\n\*\*)/i);
                        const summary = match ? match[1].trim() : (
                            assistantMessage.match(/Recommended Action:\s*(.+(?:\n(?!\n).+)*)/i)?.[1]?.trim()
                            || assistantMessage.substring(0, 500).trim()
                        );

                        const maxSummaryLen = 2970;
                        const trimmedSummary = summary.length > maxSummaryLen
                            ? summary.substring(0, maxSummaryLen) + '…' : summary;
                        const alertBlocks = [
                            { type: 'section', text: { type: 'mrkdwn', text: `*Recommended Action:* ${trimmedSummary}` } }
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

                        // Investigation done — free queue slot so next pending alert can start.
                        // tmux session stays alive for follow-up @mentions in this thread.
                        markAlertQueueComplete(channelId, alertMessageTs);
                    } else {
                        // No valid report — Claude likely stalled mid-investigation.
                        // If tmux is alive, nudge Claude to continue (up to MAX_HOOK_RETRIES).
                        const HOOK_MAX_RETRIES = parseInt(process.env.HOOK_MAX_RETRIES, 10) || 3;
                        const retryFile = `/tmp/hook-retry-${slackSessionKey}`;
                        let retryCount = 0;
                        try { retryCount = parseInt(fs.readFileSync(retryFile, 'utf-8').trim(), 10) || 0; } catch { /* first attempt */ }

                        let tmuxAlive = false;
                        if (sessionName) {
                            try {
                                execSync(`tmux has-session -t ${sessionName} 2>/dev/null`);
                                tmuxAlive = true;
                            } catch { /* session dead */ }
                        }

                        if (tmuxAlive && retryCount < HOOK_MAX_RETRIES) {
                            retryCount++;
                            fs.writeFileSync(retryFile, String(retryCount));
                            console.log(`Alert incomplete (attempt ${retryCount}/${HOOK_MAX_RETRIES}) — nudging Claude in tmux ${sessionName}`);
                            const nudge = 'Please continue the investigation. Output your final report with a "## Recommended Action" section summarizing what happened and what to do.';
                            try {
                                // Write nudge to temp file and paste into tmux (avoids shell escaping issues)
                                const nudgeTmp = `/tmp/hook-nudge-${Date.now()}.txt`;
                                fs.writeFileSync(nudgeTmp, nudge);
                                execSync(`tmux load-buffer ${nudgeTmp} && tmux paste-buffer -t ${sessionName}`);
                                // Small delay then send Enter to submit
                                execSync(`sleep 0.3 && tmux send-keys -t ${sessionName} Enter`);
                                fs.unlinkSync(nudgeTmp);
                            } catch (err) {
                                console.error(`Failed to nudge Claude in tmux: ${err.message}`);
                            }
                            // Don't post "incomplete" — wait for next Stop hook
                            process.exit(0);
                        }

                        // Retries exhausted or tmux dead — post incomplete notice
                        try { fs.unlinkSync(retryFile); } catch { /* ignore */ }
                        console.log(`No valid alert report found after ${retryCount} retries (assistantMessage: ${(assistantMessage || '').length} chars) — posting incomplete notice`);
                        await web.chat.postMessage({
                            channel: channelId,
                            text: ':warning: Investigation incomplete — Claude exited before producing a report.',
                            thread_ts: threadTs,
                        });

                        // Upload raw Claude output so owner can debug what happened
                        if (assistantMessage) {
                            try {
                                await web.filesUploadV2({
                                    channel_id: channelId,
                                    thread_ts: threadTs,
                                    content: assistantMessage,
                                    filename: `alert-raw-output-${Date.now()}.txt`,
                                    title: 'Raw Claude Output (debug)',
                                    initial_comment: '_Raw Claude output attached for debugging._',
                                });
                            } catch (err) {
                                console.error(`Failed to upload raw debug output: ${err.message}`);
                            }
                        }

                        // Retries exhausted — free queue slot so next pending alert isn't blocked
                        markAlertQueueComplete(channelId, alertMessageTs);
                    }

                    console.log(`Alert response posted (${assistantMessage.length} chars) to ${channelId} thread=${threadTs}`);
                }

                // Reaction swap (👀→✅) is handled by socket handler on session cleanup (timeout, /exit, or reconciliation)
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
