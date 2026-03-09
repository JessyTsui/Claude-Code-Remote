# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Remote is a Node.js application that enables remote control of Claude Code sessions via Slack. Users receive notifications when Claude completes tasks or needs input, and can send commands back remotely through Slack mentions. All Claude sessions run in tmux. It also monitors Slack channels for PagerDuty alerts and automatically starts Claude investigation sessions.

For detailed architecture, class references, and data flow diagrams, see `docs/architecture.md`.

## Commands

```bash
# Install dependencies
npm install

# Interactive setup wizard (generates .env, configures Claude hooks)
npm run setup

# Start Slack Socket Mode bot
npm run slack
```

There is no test runner configured.

## Architecture

### Entry Points

- **`claude-hook-notify.js`** — Called by Claude Code hooks (Stop/SubagentStop) to post Slack notifications. Looks up tmux session in SQLite DB to find the correct channel/thread.
- **`claude-remote.js`** — Main CLI (`notify`, `test`, `status`, `config` commands)
- **`setup.js`** — Interactive setup wizard that generates `.env` and merges hooks into `~/.claude/settings.json`
- **`start-slack-socket.js`** — Slack Socket Mode launcher

### Core Modules (`src/core/`)

- **`config.js`** — Multi-level config: `config/default.json` → `config/user.json` → `.env` (deep merge, env vars override)
- **`notifier.js`** — Central orchestrator that sends Slack notifications
- **`logger.js`** — Structured logging with Pino

### Channel System (`src/channels/`)

Plugin architecture with a base class at `src/channels/base/channel.js`. Only Slack is active:
- `slack/slack.js` — Slack notification channel (uses `@slack/web-api`)
- `slack/socket.js` — Slack Socket Mode handler (manages Claude tmux sessions, relays responses, alert monitoring)
- `slack/alert-monitor.js` — Detects PagerDuty messages in monitored Slack channels

### Services (`src/services/`)

- **`daily-summary.js`** — Daily channel summary service. Fetches 24h of messages via personal Slack tokens (xoxc/xoxd), formats them, summarizes via Claude Agent SDK, and delivers via DM or channel post. Supports message splitting for long summaries.

### Relay System (`src/relay/`)

- **`tmux-injector.js`** — Injects commands into tmux sessions

### Data & State (`src/data/`)

All state is file-based:
- `slack-sessions.db` — SQLite DB mapping session keys to tmux sessions, channels, and threads. Alert sessions have `alert_message_ts` set for reaction management (👀 → ✅).

### Execution Flow (Regular)

1. Claude runs with hooks from `claude-hooks.json` configured in `~/.claude/settings.json`
2. On Stop/SubagentStop, hooks call `claude-hook-notify.js completed|waiting`
3. Hook script looks up tmux session in SQLite -> posts to correct Slack channel/thread
4. User replies via Slack @mention
5. Socket Mode handler receives message -> creates/reuses tmux session -> injects command
6. Poller reads tmux output -> posts response back to Slack thread
7. Cycle repeats

### Execution Flow (Alert — unified with regular)

1. PagerDuty posts alert to a monitored Slack channel
2. `AlertMonitor` detects PD message, extracts incident ID
3. Socket handler deduplicates, acknowledges PD, reacts with 👀
4. Builds prompt (using `ALERT_SKILL` + permalink) and calls `_processCommand()` — same as regular @mention
5. From here, identical to regular flow: tmux session, polling, output posting
6. On `/exit` or session cleanup, swaps 👀 → ✅ on the alert message

### Execution Flow (Daily Summary)

1. Scheduled via `setTimeout` at `DAILY_SUMMARY_TIME`, or triggered manually via `POST /daily-summary`
2. For each channel in `DAILY_SUMMARY_CHANNELS`: fetches 24h of messages using xoxc/xoxd tokens
3. Resolves user display names, formats timestamps to GMT+7, filters system messages
4. Passes formatted messages to Claude Agent SDK for summarization (single turn, no tools needed)
5. DMs combined summary to owner or posts to `SLACK_CHANNEL_ID`, splitting long messages into thread replies

## Configuration

Environment variables in `.env` (see `.env.example`):
- **Slack**: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_REPO_PATH`, `SLACK_REPO_ROOT`, `SLACK_CLAUDE_COMMAND`, `SLACK_WHITELIST`, `SLACK_HTTP_PORT`
- **Alert Monitoring**: `MONITOR_CHANNELS`, `ALERT_SKILL`, `PAGERDUTY_API_TOKEN`, `PAGERDUTY_FROM_EMAIL`
- **Daily Summary**: `DAILY_SUMMARY_CHANNELS`, `DAILY_SUMMARY_TIME`, `DAILY_SUMMARY_MODEL`, `SLACK_XOXC_TOKEN`, `SLACK_XOXD_TOKEN`
- **Session**: `SESSION_INACTIVITY_TIMEOUT_MS`
- **System**: `LOG_LEVEL`, `DAILY_RESTART_HOUR`

Config file hierarchy: `config/default.json` -> `config/user.json` -> env vars (deep merge with env overrides).

## Tech Stack

Node.js (>=14.0.0), `@slack/bolt` (Socket Mode + Web API), `better-sqlite3` (session persistence), `@anthropic-ai/claude-agent-sdk` (daily summaries), Express (HTTP health/API), Pino (logging), dotenv (config), `swagger-ui-express` (API docs). No TypeScript, no bundler, no test framework.
