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

- **`cli-hook-notify.js`** — Unified hook entry point. Called by Claude `Stop/SubagentStop` hooks and by Codex's `notify` hook. Looks up tmux session in SQLite DB to find the correct channel/thread. Sniffs `CLI_SOURCE` env (set in the tmux prelude) or payload shape to distinguish Claude vs Codex payloads.
- **`claude-hook-notify.js`** — One-line shim that requires `cli-hook-notify.js`. Kept so already-installed Claude hook commands on existing hosts keep working without re-running `npm run hooks:install`.
- **`claude-remote.js`** — Main CLI (`notify`, `test`, `status`, `config` commands)
- **`setup.js`** — Interactive setup wizard that generates `.env` and merges hooks into `~/.claude/settings.json` **and** `~/.codex/config.toml` (via the CLI adapters).
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

### CLI Adapters (`src/cli/`)

The bot can run tmux sessions with Claude Code or Codex CLI, chosen per feature. An adapter layer isolates the differences (launch command, alert-prompt syntax, working-state indicators, confirmation handling, hook-install path).

- `src/cli/index.js` — selector. `getCliAdapter(type)` returns an adapter by name (`'claude'`, `'codex'`, …), falling back to Claude on unknown names. `listAdapters()` / `adapterNames()` enumerate everything registered.
- `src/cli/claude-adapter.js` — Claude Code. Uses `SLACK_CLAUDE_COMMAND`. Installs `SessionStart`/`Stop`/`SubagentStop` hooks in `~/.claude/settings.json`. Watches for numbered-choice / "Do you want to proceed?" dialogs.
- `src/cli/codex-adapter.js` — Codex CLI. Uses `CODEX_COMMAND` (default `codex --dangerously-bypass-approvals-and-sandbox`). Installs a top-level `notify = ["node", "<repo>/cli-hook-notify.js", "completed"]` line in `~/.codex/config.toml`. Skips the Claude-specific confirmation watcher.

**Adding a new CLI** (e.g. Gemini): create `src/cli/gemini-adapter.js` exporting the same interface, register it in the `ADAPTERS` dict in `src/cli/index.js`. The hooks installer, @mention `start <cli> from project …` keyword detector, and config name validation all pick it up automatically — no other edits needed.

### Services (`src/services/`)

- **`daily-summary.js`** — Daily channel summary service. Fetches 24h of messages via personal Slack tokens (xoxc/xoxd), formats them, summarizes via Claude Agent SDK, and delivers via DM or channel post. Supports message splitting for long summaries.

### Relay System (`src/relay/`)

- **`tmux-injector.js`** — Injects commands into tmux sessions

### Data & State (`src/data/`)

All state is file-based:
- `slack-sessions.db` — SQLite DB mapping session keys to tmux sessions, channels, and threads. Alert sessions have `alert_message_ts` set for reaction management (👀 → ✅).

### Execution Flow (Regular)

1. Claude / Codex runs with hooks configured in `~/.claude/settings.json` (Claude) or `~/.codex/config.toml` (Codex — `notify` line)
2. On task completion, hooks call `cli-hook-notify.js completed|waiting`
3. Hook script detects which CLI sent the payload (via `CLI_SOURCE` env from the tmux prelude or payload shape) and looks up tmux session in SQLite -> posts to correct Slack channel/thread
4. User replies via Slack @mention
5. Socket Mode handler receives message -> creates/reuses tmux session (CLI recorded on the session row via `cli_type`) -> injects command
6. Poller reads tmux output using the session's adapter-specific working indicators -> posts response back to Slack thread
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

## Hooks (Critical for Slack Notifications)

The bot relies on CLI lifecycle hooks to know when a task finished:
- **Claude**: `Stop` / `SubagentStop` / `SessionStart` in `~/.claude/settings.json`
- **Codex**: top-level `notify = [...]` in `~/.codex/config.toml`

Both CLIs call the same entry point (`cli-hook-notify.js`), which routes to the right handler based on payload shape / `CLI_SOURCE` env.

**If a user reports the bot is not sending messages to Slack after the CLI completes a task**, the most likely cause is hooks not being installed. Debug with:
- `npm run hooks:status` — check both CLIs' hook state
- `cat ~/.claude/settings.json` / `cat ~/.codex/config.toml` — verify hook commands point to the correct absolute path of `cli-hook-notify.js`
- `node cli-hook-notify.js completed` — test the hook directly
- `npm run hooks:install` — re-install hooks for every registered CLI adapter

On a remote VPS, hooks must be installed for the user running the process (e.g. `root`). The hook path must match the actual project location on that machine.

## App Mode (`APP_MODE`)

Controls which features each instance handles. Allows running local + cloud instances on the same Slack app without duplicate responses.

- `local` — @mention chat in `SLACK_CHANNEL_ID` only. Ignores mentions in monitor channels. No alert/delay monitoring, no daily summary.
- `cloud` — Alert monitoring, delay monitoring, daily summary, and @mention chat in monitor channel threads only. Ignores mentions in non-monitor channels.
- `all` (default) — Everything enabled. Backward compatible.

The filtering happens in `_setupListeners()` in `src/channels/slack/socket.js`. Both instances connect via Socket Mode and receive all events, but each ignores events outside its responsibility.

## Multi-CLI Support

The bot runs Claude Code by default but can run Codex CLI (or any future adapter) **per feature**:

- `ALERT_CLI=claude|codex` — which CLI to launch for PagerDuty alert investigations (default `claude`)
- `DELAY_ALERT_CLI=claude|codex` — which CLI to launch for Airflow delay alert investigations (default `claude`)
- **Per-message override** in @mention chat: `start codex from project xxx`, `start claude from root`, `start codex`. The CLI keyword is stripped before the prompt is sent, and the chosen CLI is saved on the session row (`cli_type`) so follow-up messages in the same thread reuse it.
- **Daily summary** stays on `@anthropic-ai/claude-agent-sdk` — no tmux, no Codex variant.

Unknown CLI names fall back to Claude via `getCliAdapter`'s default, so a typo is safe. Skill names (`ALERT_SKILL`, `DELAY_ALERT_SKILL`) are shared across CLIs — the adapter only swaps the invocation syntax (`execute {skill} skill with argument …` vs `/{skill} …`).

## Configuration

Environment variables in `.env` (see `.env.example`):
- **Slack**: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_REPO_PATH`, `SLACK_REPO_ROOT`, `SLACK_CLAUDE_COMMAND`, `SLACK_WHITELIST`, `SLACK_HTTP_PORT`
- **App Mode**: `APP_MODE` (`local`, `cloud`, `all`)
- **CLI Selection**: `ALERT_CLI`, `DELAY_ALERT_CLI` (both default `claude`); optional `CODEX_COMMAND` overrides the default `codex --dangerously-bypass-approvals-and-sandbox`
- **Alert Monitoring**: `MONITOR_CHANNELS`, `ALERT_SKILL`, `PAGERDUTY_API_TOKEN`, `PAGERDUTY_FROM_EMAIL`
- **Daily Summary**: `DAILY_SUMMARY_CHANNELS`, `DAILY_SUMMARY_TIME`, `DAILY_SUMMARY_MODEL`, `SLACK_XOXC_TOKEN`, `SLACK_XOXD_TOKEN`
- **Session**: `SESSION_INACTIVITY_TIMEOUT_MS`, `POLLER_TIMEOUT_MS`
- **System**: `LOG_LEVEL`, `DAILY_RESTART_HOUR`

Config file hierarchy: `config/default.json` -> `config/user.json` -> env vars (deep merge with env overrides).

## Tech Stack

Node.js (>=14.0.0), `@slack/bolt` (Socket Mode + Web API), `better-sqlite3` (session persistence), `@anthropic-ai/claude-agent-sdk` (daily summaries), Express (HTTP health/API), Pino (logging), dotenv (config), `swagger-ui-express` (API docs). No TypeScript, no bundler, no test framework.
