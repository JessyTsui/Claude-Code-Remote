# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Remote is a Node.js application that enables remote notification and command control of Claude Code sessions via multiple messaging platforms (Email, Telegram, LINE, Desktop). Users receive notifications when Claude completes tasks or needs input, and can send commands back remotely.

## Commands

```bash
# Install dependencies
npm install

# Interactive setup wizard (generates .env, configures Claude hooks)
npm run setup

# Start webhook servers
npm run telegram          # Telegram webhook only
npm run line              # LINE webhook only
npm run webhooks          # All enabled webhooks

# PTY-based command relay
npm run relay:pty

# Email listener daemon
npm run daemon:start
npm run daemon:stop
npm run daemon:status

# Validate JSON configs (used in CI)
find . -name "*.json" -not -path "./node_modules/*" -not -path "./.git/*" -exec python3 -m json.tool {} \;
```

There is no test runner configured. Manual test scripts exist: `test-telegram-notification.js`, `test-complete-flow.sh`, `test-injection.js`, `test-long-email.js`.

## Architecture

### Entry Points

- **`claude-hook-notify.js`** — Called by Claude Code hooks (Stop/SubagentStop) to dispatch notifications to enabled channels
- **`claude-remote.js`** — Main CLI (`notify`, `test`, `status`, `config`, `relay`, `daemon` commands)
- **`setup.js`** — Interactive setup wizard that generates `.env` and merges hooks into `~/.claude/settings.json`
- **`start-telegram-webhook.js`** / **`start-line-webhook.js`** / **`start-all-webhooks.js`** — Webhook server launchers

### Core Modules (`src/core/`)

- **`config.js`** — Multi-level config: `config/default.json` → `config/user.json` → `.env` (deep merge, env vars override)
- **`notifier.js`** — Central orchestrator that instantiates enabled channels and sends notifications in parallel via `Promise.all()`
- **`logger.js`** — Structured logging with Pino

### Channel System (`src/channels/`)

Plugin architecture with a base class at `src/channels/base/channel.js`. Each channel implements:
- `send(notification)` — Send a notification
- `test()` — Test channel configuration
- `handleCommand(command, context)` — Handle incoming commands (relay-capable channels)
- `supportsRelay()` — Whether the channel supports command relay

Channel implementations:
- `local/desktop.js` — Platform-specific (macOS osascript, Linux notify-send, Windows PowerShell)
- `email/smtp.js` — SMTP via Nodemailer + IMAP reply listening
- `telegram/telegram.js` + `telegram/webhook.js` — Telegram Bot API with Express webhook server
- `line/line.js` + `line/webhook.js` — LINE Messaging API with Express webhook server (HMAC-SHA256 signature verification)

To add a new channel: create a class extending `NotificationChannel`, implement the interface, and register it in the `Notifier`.

### Command Relay System (`src/relay/`)

Receives commands from remote channels and injects them into active Claude sessions:
- **`relay-pty.js`** — PTY-based command relay (default, no tmux needed)
- **`tmux-injector.js`** — Tmux session injection
- **`smart-injector.js`** — Auto-selects best injection method
- **`command-relay.js`** — Email relay orchestrator (extends EventEmitter)
- **`email-listener.js`** — IMAP polling for email commands

### Data & State (`src/data/`)

All state is file-based JSON:
- `session-map.json` — Maps 8-char session tokens to execution contexts (24h auto-expiry)
- `processed-messages.json` — Email deduplication (7-day rotation)
- `sessions/` — Per-session PTY/execution context

### Execution Flow

1. Claude runs with hooks from `claude-hooks.json` configured in `~/.claude/settings.json`
2. On Stop/SubagentStop, hooks call `claude-hook-notify.js completed|waiting`
3. Notifications sent to all enabled channels in parallel
4. User replies via channel (email, Telegram command, LINE message)
5. Webhook/IMAP listener receives command → relay injects into Claude session
6. Cycle repeats

## Configuration

Environment variables in `.env` (see `.env.example`):
- **Email**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `IMAP_*`, `EMAIL_*`, `ALLOWED_SENDERS`
- **Telegram**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_GROUP_ID`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_FORCE_IPV4`
- **LINE**: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_USER_ID`, `LINE_GROUP_ID`
- **System**: `INJECTION_MODE` (pty|tmux), `SESSION_MAP_PATH`, `LOG_LEVEL`

Config file hierarchy: `config/default.json` → `config/user.json` → env vars (deep merge with env overrides).

## Tech Stack

Node.js (>=14.0.0), Express (webhooks), Axios (HTTP), Nodemailer (SMTP), node-imap/imapflow (IMAP), node-pty (PTY relay), Pino (logging), dotenv (config). No TypeScript, no bundler, no test framework.

## CI

GitHub Actions runs on Node 18.x and 20.x: `npm ci`, `npm audit`, JSON config validation. No automated test suite — only manual test scripts.
