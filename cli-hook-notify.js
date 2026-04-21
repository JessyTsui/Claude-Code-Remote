#!/usr/bin/env node

/**
 * CLI Hook Notification Script
 * Called by Claude Code's Stop/SubagentStop hooks AND Codex's notify hook.
 *
 * Logic:
 *  1. Read stdin JSON (Claude) or argv (Codex) — shape sniffed at top
 *  2. Normalize to { last_assistant_message, session_id, transcript_path } shape
 *  3. Get SLACK_SESSION_KEY from env → look up channel/thread in SQLite
 *  4. Post response to the correct Slack thread
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { execSync } = require('child_process');

// Load environment variables from the project directory
const projectDir = path.dirname(__filename);
const envPath = path.join(projectDir, '.env');

if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true, quiet: true });
} else {
    console.error('.env file not found at:', envPath);
    process.exit(1);
}

/**
 * Read JSON from stdin (Claude/Codex both deliver payloads this way, with different shapes).
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
        if (process.stdin.isTTY) resolve({});
    });
}

/**
 * Detect which CLI emitted this hook payload.
 *
 * Priority:
 *  1. CLI_SOURCE env var (set by tmux-helper when we launched the session)
 *  2. Shape sniffing — Codex uses hyphenated keys (last-assistant-message, turn-id),
 *     Claude uses underscored keys (last_assistant_message, session_id).
 *  3. Default to 'claude' for backward compat.
 */
function detectCliSource(hookInput) {
    const envSource = (process.env.CLI_SOURCE || '').toLowerCase();
    if (envSource === 'codex' || envSource === 'claude') return envSource;
    if (hookInput && typeof hookInput === 'object') {
        if ('last-assistant-message' in hookInput || 'turn-id' in hookInput) return 'codex';
        if ('last_assistant_message' in hookInput || 'session_id' in hookInput) return 'claude';
    }
    return 'claude';
}

/**
 * Normalize Codex Stop-hook payload to Claude-shaped input so the rest of the
 * script is CLI-agnostic. Codex emits underscored keys per the docs
 * (https://developers.openai.com/codex/hooks): session_id, turn_id,
 * last_assistant_message, transcript_path. Hyphenated fallbacks are kept for
 * any version that emits them.
 */
function normalizeCodexInput(raw) {
    if (!raw || typeof raw !== 'object') return {};
    return {
        last_assistant_message: raw.last_assistant_message || raw['last-assistant-message'] || raw.message || '',
        session_id: raw.session_id || raw['session-id'] || raw.turn_id || raw['turn-id'] || null,
        transcript_path: raw.transcript_path || raw['transcript-path'] || null,
        _codex_raw: raw,
    };
}

/**
 * For alert sessions (Claude only): scan transcript for the assistant message containing
 * the investigation report. Returns the longest message with "Recommended Action:" marker.
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
 * Fallback (Claude-only transcript format): extract the last assistant text message.
 */
function extractFromTranscript(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    const lines = content.split('\n');

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
 * Parse Claude transcript for session stats. Returns null for non-Claude transcripts —
 * Codex stats would need its own extractor once we know the payload shape (see plan §2).
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
                lastInputTokens = usage.input_tokens || 0;
                lastCacheRead = usage.cache_read_input_tokens || 0;
                lastCacheCreation = usage.cache_creation_input_tokens || 0;
            }
        } catch {
            continue;
        }
    }

    if (!lastInputTokens && !totalOutput) return null;

    let modelShort = model || '';
    const modelMatch = modelShort.match(/claude-(\w+-[\d-]+)/);
    if (modelMatch) modelShort = modelMatch[1];

    const contextTokens = lastInputTokens + lastCacheRead + lastCacheCreation;
    const contextLimit = (model || '').includes('opus') ? 1000000 : 200000;
    const contextPct = Math.min(100, Math.round((contextTokens / contextLimit) * 100));

    const fmtTokens = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

    return {
        model: modelShort,
        context: `${contextPct}%`,
        tokensIn: fmtTokens(lastInputTokens),
        tokensOut: fmtTokens(totalOutput),
    };
}

/**
 * Codex transcript stats. The rollout JSONL carries:
 *  - `turn_context` payload → `model`, `effort`
 *  - `event_msg` payload `type=token_count` → `info.last_token_usage`,
 *    `info.total_token_usage`, `info.model_context_window`
 * We take the LAST token_count event (matches what Codex shows in its footer).
 */
function extractCodexSessionStats(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    let model = null;
    let effort = null;
    let lastTokenInfo = null;

    for (const line of content.split('\n')) {
        try {
            const entry = JSON.parse(line);
            const p = entry.payload;
            if (entry.type === 'turn_context' && p) {
                if (p.model) model = p.model;
                if (p.effort) effort = p.effort;
            } else if (entry.type === 'event_msg' && p && p.type === 'token_count' && p.info) {
                lastTokenInfo = p.info;
            }
        } catch {
            continue;
        }
    }

    if (!lastTokenInfo) return null;

    const last = lastTokenInfo.last_token_usage || {};
    const total = lastTokenInfo.total_token_usage || {};
    const windowSize = lastTokenInfo.model_context_window || 0;
    const lastTotal = last.total_tokens || 0;
    const contextPct = windowSize > 0
        ? Math.min(100, Math.round((lastTotal / windowSize) * 100))
        : 0;

    const fmtTokens = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0);

    return {
        model: effort ? `${model} ${effort}` : (model || ''),
        context: `${contextPct}%`,
        tokensIn: fmtTokens(last.input_tokens || 0),
        tokensOut: fmtTokens(total.output_tokens || 0),
    };
}

/**
 * Send a response to Slack, splitting into chunks if needed.
 * Appends session stats (model, context, tokens) to the last chunk when available.
 */
async function sendResponse(web, channelId, threadTs, response, stats, mentionUserId = null) {
    const maxLen = 2990;
    const mention = mentionUserId ? `<@${mentionUserId}> ` : '';
    const prefix = `:black_circle_for_record: ${mention}`;
    const statsLine = stats
        ? `_${stats.model} · Ctx: ${stats.context} · In: ${stats.tokensIn} Out: ${stats.tokensOut}_`
        : '';

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
        chunks.push(response.substring(0, firstChunkMax));
        for (let i = firstChunkMax; i < response.length; i += maxLen) {
            chunks.push(response.substring(i, i + maxLen));
        }
        for (let i = 0; i < chunks.length; i++) {
            const text = (i === 0 ? prefix : '') + chunks[i];
            const blocks = [
                { type: 'section', text: { type: 'mrkdwn', text } }
            ];
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
            console.error(`Alert queue: freed slot for channel=${channelId} ts=${alertMessageTs}`);
            kickQueue();
        }
    } catch (err) {
        console.error(`Failed to free alert queue slot: ${err.message}`);
    }
}

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

    const rawInput = await readStdin();
    const cliSource = detectCliSource(rawInput);
    const hookInput = cliSource === 'codex' ? normalizeCodexInput(rawInput) : rawInput;

    const slackSessionKey = process.env.SLACK_SESSION_KEY;
    if (!slackSessionKey) {
        process.exit(0);
    }

    // ─── SessionStart: register session_id in DB ─────────────────────
    // (Claude-only — Codex's notify hook doesn't have a session_start equivalent.)
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
                const result = db.prepare(
                    'UPDATE sessions SET claude_session_id = COALESCE(claude_session_id, ?), updated_at = ? WHERE session_key = ?'
                ).run(sessionId, Date.now(), slackSessionKey);
                db.close();
                console.error(`SessionStart: mapped session_id=${sessionId} to key=${slackSessionKey} (rows=${result.changes})`);
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

            if (slackSessionKey) {
                row = db.prepare(
                    'SELECT * FROM sessions WHERE session_key = ?'
                ).get(slackSessionKey);
                if (row) {
                    console.error(`Resolved via SLACK_SESSION_KEY=${slackSessionKey}`);
                }
            }

            if (!row && hookInput.session_id) {
                row = db.prepare(
                    'SELECT * FROM sessions WHERE claude_session_id = ? LIMIT 1'
                ).get(hookInput.session_id);
                if (row) {
                    console.error(`Resolved via session_id=${hookInput.session_id}`);
                }
            }

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

    let assistantMessage = hookInput.last_assistant_message
        || (cliSource === 'claude' ? extractFromTranscript(hookInput.transcript_path) : null);

    const stats = cliSource === 'codex'
        ? extractCodexSessionStats(hookInput.transcript_path)
        : extractSessionStats(hookInput.transcript_path);

    if (assistantMessage && threadTs) {
        try {
            if (isAlertSession) {
                if (notificationType !== 'completed') {
                    console.error(`Alert session: skipping ${notificationType} (only post on completed)`);
                    return;
                }

                if (rootSessionId && hookInput.session_id && hookInput.session_id !== rootSessionId) {
                    console.error(`Alert session: skipping Stop from subagent (hook=${hookInput.session_id}, root=${rootSessionId})`);
                    return;
                }

                // Stash file pattern used to recover state across hook invocations
                // (each Stop hook spawns a fresh node process, so /tmp is our memory):
                //   hook-primary-<key>  JSON { ts, fileId } — the canonical alert post
                //   hook-warning-<key>  ts of an "AI agent unresponsive" warning, if any
                //   hook-retry-<key>    nudge retry counter
                const primaryFile = `/tmp/hook-primary-${slackSessionKey}`;
                const warningFile = `/tmp/hook-warning-${slackSessionKey}`;
                const retryFile = `/tmp/hook-retry-${slackSessionKey}`;

                let primary = null;
                try { primary = JSON.parse(fs.readFileSync(primaryFile, 'utf-8')); } catch { /* no prior primary */ }

                // Cold-start recovery: if the stash is empty (service restart, /tmp
                // cleanup), scan the thread for our earlier primary post so we still
                // dedupe instead of posting a second alert block.
                if (!primary) {
                    try {
                        const replies = await web.conversations.replies({
                            channel: channelId, ts: threadTs, limit: 50,
                        });
                        const existing = (replies.messages || []).find(m =>
                            m.ts !== threadTs && typeof m.text === 'string' && m.text.startsWith('Recommended Action:')
                        );
                        if (existing) {
                            primary = { ts: existing.ts, fileId: null };
                            console.error(`Recovered primary from Slack thread: ts=${existing.ts}`);
                        }
                    } catch { /* proceed without recovery */ }
                }

                let hasValidReport = false;
                if (cliSource === 'claude' && hookInput.transcript_path) {
                    const report = extractAlertReport(hookInput.transcript_path);
                    if (report) {
                        console.error(`Alert report found in transcript (${report.length} chars), overriding last_assistant_message (${(assistantMessage || '').length} chars)`);
                        assistantMessage = report;
                        hasValidReport = true;
                    }
                }

                if (!hasValidReport && assistantMessage && assistantMessage.length >= 500
                    && /(?:^|\n)(?:#{1,3}\s+)?(?:\*\*)?Recommended Action(?:\*\*)?:/im.test(assistantMessage)) {
                    hasValidReport = true;
                }

                if (hasValidReport) {
                    try { fs.unlinkSync(retryFile); } catch { /* ignore */ }
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

                    // Attachment is the "attachment zone" — everything after the first
                    // `---` separator (skill's two-zone format). Summary is already in
                    // the inline post above; including it again duplicates the heading.
                    const sepMatch = assistantMessage.match(/\n\s*---\s*\n/);
                    const attachmentZone = sepMatch
                        ? assistantMessage.slice(sepMatch.index + sepMatch[0].length).trim()
                        : assistantMessage;

                    let postedTs = null;
                    const isUpdate = !!(primary && primary.ts);

                    if (isUpdate) {
                        // Claude refined its answer on a later turn. Overwrite the
                        // existing post in-place so the thread shows one clean message
                        // instead of competing reports.
                        try {
                            await web.chat.update({
                                channel: channelId,
                                ts: primary.ts,
                                text: `Recommended Action: ${summary}`,
                                blocks: alertBlocks,
                            });
                            postedTs = primary.ts;
                            console.error(`Updated primary alert post ts=${primary.ts} with refined report`);
                        } catch (err) {
                            console.error(`chat.update failed (ts=${primary.ts}): ${err.message} — leaving primary as-is`);
                        }

                        if (postedTs && primary.fileId) {
                            try { await web.files.delete({ file: primary.fileId }); } catch (err) {
                                console.error(`files.delete failed (${primary.fileId}): ${err.message}`);
                            }
                        }
                    }

                    if (!postedTs) {
                        const postResult = await web.chat.postMessage({
                            channel: channelId,
                            text: `Recommended Action: ${summary}`,
                            thread_ts: threadTs,
                            blocks: alertBlocks,
                        });
                        postedTs = postResult?.ts || null;
                    }

                    let uploadedFileId = null;
                    try {
                        const uploadResult = await web.filesUploadV2({
                            channel_id: channelId,
                            thread_ts: threadTs,
                            content: attachmentZone,
                            filename: `alert-investigation-${Date.now()}.md`,
                            title: 'Full Investigation Report',
                            initial_comment: isUpdate ? '_Updated investigation attached._' : '_Full investigation details attached._',
                        });
                        uploadedFileId = uploadResult?.files?.[0]?.id
                            || uploadResult?.files?.[0]?.files?.[0]?.id
                            || uploadResult?.file?.id
                            || null;
                    } catch (err) {
                        console.error(`filesUploadV2 failed: ${err.message}`);
                    }

                    if (postedTs) {
                        try {
                            fs.writeFileSync(primaryFile, JSON.stringify({ ts: postedTs, fileId: uploadedFileId }));
                        } catch (err) {
                            console.error(`Failed to persist primary stash: ${err.message}`);
                        }
                    }

                    // Clean up any stale "AI agent unresponsive" warning posted earlier
                    // — once we have a real report, the human-check prompt is obsolete.
                    try {
                        const warningTs = fs.readFileSync(warningFile, 'utf-8').trim();
                        if (warningTs) {
                            try { await web.chat.delete({ channel: channelId, ts: warningTs }); } catch (err) {
                                console.error(`chat.delete (warning ts=${warningTs}) failed: ${err.message}`);
                            }
                        }
                        fs.unlinkSync(warningFile);
                    } catch { /* no warning posted */ }

                    markAlertQueueComplete(channelId, alertMessageTs);
                } else {
                    // No valid report on this Stop.
                    // If we already have a primary posted, the user has a clean answer —
                    // stop nudging, stop warning. Subsequent short turns are usually just
                    // the agent narrating between async tool callbacks.
                    if (primary && primary.ts) {
                        console.error(`No valid report in this turn, primary already posted (ts=${primary.ts}) — silent exit`);
                        return;
                    }

                    const HOOK_MAX_RETRIES = parseInt(process.env.HOOK_MAX_RETRIES, 10) || 3;
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
                        console.error(`Alert incomplete (attempt ${retryCount}/${HOOK_MAX_RETRIES}) — nudging CLI in tmux ${sessionName}`);
                        const nudge = 'Please continue the investigation. Output your final report with a "## Recommended Action" section summarizing what happened and what to do.';
                        try {
                            const nudgeTmp = `/tmp/hook-nudge-${Date.now()}.txt`;
                            fs.writeFileSync(nudgeTmp, nudge);
                            execSync(`tmux load-buffer ${nudgeTmp} && tmux paste-buffer -t ${sessionName}`);
                            execSync(`sleep 0.3 && tmux send-keys -t ${sessionName} Enter`);
                            fs.unlinkSync(nudgeTmp);
                        } catch (err) {
                            console.error(`Failed to nudge CLI in tmux: ${err.message}`);
                        }
                        process.exit(0);
                    }

                    if (tmuxAlive) {
                        // Retries exhausted but the session is still alive. The AI agent
                        // may be waiting on async tool callbacks (Monitor, background
                        // Bash) and could still produce a report. Post a single
                        // human-check warning, then silently exit on subsequent Stops —
                        // don't reset the counter and don't keep nudging.
                        let alreadyWarned = false;
                        try { fs.accessSync(warningFile); alreadyWarned = true; } catch { /* first warn */ }
                        if (alreadyWarned) {
                            console.error(`Retries exhausted, tmux alive, warning already posted — silent exit`);
                            return;
                        }

                        try {
                            const warnResult = await web.chat.postMessage({
                                channel: channelId,
                                text: ':warning: Session is still alive but no report was received from the AI agent ' +
                                      `after ${HOOK_MAX_RETRIES} attempts. Please check the tmux session manually.`,
                                thread_ts: threadTs,
                            });
                            if (warnResult?.ts) {
                                fs.writeFileSync(warningFile, warnResult.ts);
                            }
                            console.error(`Posted AI-agent-unresponsive warning after ${retryCount} retries (tmux alive)`);
                        } catch (err) {
                            console.error(`Failed to post warning: ${err.message}`);
                        }

                        if (assistantMessage) {
                            try {
                                await web.filesUploadV2({
                                    channel_id: channelId,
                                    thread_ts: threadTs,
                                    content: assistantMessage,
                                    filename: `alert-raw-output-${Date.now()}.txt`,
                                    title: 'Raw CLI Output (debug)',
                                    initial_comment: '_Raw output attached for debugging._',
                                });
                            } catch (err) {
                                console.error(`Failed to upload raw debug output: ${err.message}`);
                            }
                        }

                        // Do NOT mark the queue complete — the session is still alive.
                        return;
                    }

                    // tmux is genuinely gone → definitive incomplete notice.
                    try { fs.unlinkSync(retryFile); } catch { /* ignore */ }
                    try { fs.unlinkSync(warningFile); } catch { /* ignore */ }
                    console.error(`tmux session dead, no valid report (assistantMessage: ${(assistantMessage || '').length} chars) — posting final incomplete notice`);
                    await web.chat.postMessage({
                        channel: channelId,
                        text: ':warning: Investigation incomplete — tmux session ended before a report was produced.',
                        thread_ts: threadTs,
                    });

                    if (assistantMessage) {
                        try {
                            await web.filesUploadV2({
                                channel_id: channelId,
                                thread_ts: threadTs,
                                content: assistantMessage,
                                filename: `alert-raw-output-${Date.now()}.txt`,
                                title: 'Raw CLI Output (debug)',
                                initial_comment: '_Raw output attached for debugging._',
                            });
                        } catch (err) {
                            console.error(`Failed to upload raw debug output: ${err.message}`);
                        }
                    }

                    markAlertQueueComplete(channelId, alertMessageTs);
                }
            } else {
                await sendResponse(web, channelId, threadTs, assistantMessage, stats, lastUserId);
                console.error(`Response posted (${assistantMessage.length} chars) to ${channelId} thread=${threadTs}`);
            }
        } catch (error) {
            console.error('Failed to post response:', error.message);
        }
        return;
    }

    const emoji = notificationType === 'completed' ? ':white_check_mark:' : ':hourglass_flowing_sand:';
    const status = notificationType === 'completed' ? 'Completed' : 'Waiting for Input';
    const fallbackText = `${emoji} Task ${status} - ${projectName}`;

    const blocks = [
        {
            type: 'header',
            text: { type: 'plain_text', text: `${emoji} Task ${status}` }
        },
        {
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Project:*\n${projectName}` },
                { type: 'mrkdwn', text: `*Time:*\n${new Date().toLocaleTimeString()}` }
            ]
        }
    ];

    try {
        await web.chat.postMessage({
            channel: channelId,
            text: fallbackText,
            blocks,
            thread_ts: threadTs
        });
        console.error(`Slack notification sent (${notificationType}) to ${channelId}${threadTs ? ' thread=' + threadTs : ''}`);
    } catch (error) {
        console.error('Failed to send Slack notification:', error.message);
        process.exit(1);
    }
}

sendHookNotification();
