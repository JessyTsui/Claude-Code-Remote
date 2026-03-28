# Claude Code Remote

Control [Claude Code](https://claude.ai/code) remotely via Slack. Start tasks locally or from Slack, receive notifications when Claude completes them, and send new commands by replying in the thread. All sessions run in tmux.

## Features

- **Two-way Slack control** — @mention the bot with commands, get responses streamed back to the thread
- **Tmux session management** — Each Slack thread gets its own tmux session with Claude running
- **Hook-based notifications** — Claude Code Stop/SubagentStop hooks post to the correct Slack thread automatically
- **PagerDuty alert monitoring** — Watch Slack channels for PD alerts, auto-start Claude investigation sessions
- **Daily channel summaries** — AI-powered daily digests of Slack channel activity, delivered via DM or channel
- **Session persistence** — SQLite-backed sessions survive bot restarts; dead sessions auto-reconcile on startup
- **HTTP API** — Health check, Swagger docs, and management endpoints at `localhost:9999`
- **Image support** — Attach images to Slack messages and they're passed to Claude
- **User whitelist** — Restrict who can interact with the bot

## Quick Start

### Prerequisites

- Node.js >= 14.0.0
- tmux installed
- A Slack app with Socket Mode enabled (bot token + app-level token)

### Install

```bash
git clone https://github.com/JessyTsui/Claude-Code-Remote.git
cd Claude-Code-Remote
npm install
```

### Setup

```bash
npm run setup
```

The interactive wizard will:
1. Prompt for Slack tokens, channel ID, repo path, etc.
2. Generate `.env`
3. Merge Claude hooks into `~/.claude/settings.json`

You can re-run it anytime to update settings.

### Manual Configuration (optional)

```bash
cp .env.example .env
nano .env
```

Required settings:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_CHANNEL_ID=C0123456789
```

Optional settings:

```env
# Working directory for Claude sessions
SLACK_REPO_PATH=/Users/you/your-project

# Root for project discovery ("start claude in project X from root")
SLACK_REPO_ROOT=/Users/you/projects

# Custom Claude launch command
SLACK_CLAUDE_COMMAND=claude --dangerously-skip-permissions

# Authorized Slack user IDs (comma-separated, empty = all users)
SLACK_WHITELIST=U0123456789,U9876543210

# HTTP API port (default: 9999)
SLACK_HTTP_PORT=9999

# Daily Socket Mode restart hour (0-23, helps maintain clean connection)
DAILY_RESTART_HOUR=23
```

#### Configure Claude Code Hooks (only needed if you skipped `npm run setup`)

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/Claude-Code-Remote/claude-hook-notify.js completed", "timeout": 5 }] }],
    "SubagentStop": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/Claude-Code-Remote/claude-hook-notify.js waiting", "timeout": 5 }] }]
  }
}
```

### Start

```bash
npm run slack
```

Or use the service wrapper:

```bash
./enzo.sh start    # Start in background
./enzo.sh stop     # Graceful shutdown
./enzo.sh restart  # Restart
./enzo.sh status   # Show status + recent logs
./enzo.sh logs     # Tail logs
```

### Test

```bash
# Test hook notification (sends to Slack)
node claude-hook-notify.js completed
```

## How It Works

1. **@mention the bot** in any Slack channel with a command
2. Bot creates a tmux session with Claude running in your configured repo
3. Command is injected into the tmux session
4. Bot polls tmux output and streams new lines back to the Slack thread
5. When Claude finishes, hooks fire and post a notification to the thread
6. **Reply in the thread** to continue the conversation

### Alert Monitoring (optional)

Configure PagerDuty alert monitoring to auto-investigate incidents:

```env
MONITOR_CHANNELS=payments-alerts,incidents
ALERT_SKILL=one:pay-ops-production
PAGERDUTY_API_TOKEN=your-token
PAGERDUTY_FROM_EMAIL=your-email@company.com
SESSION_INACTIVITY_TIMEOUT_MS=300000
# POLLER_TIMEOUT_MS=1800000
```

When a PagerDuty alert appears in a monitored channel:
1. Bot reacts with eyes emoji and auto-acknowledges the PD incident
2. Starts a Claude session with the configured alert skill
3. Posts investigation results back to the alert thread
4. On `/exit` or cleanup, swaps eyes to checkmark

### Daily Channel Summaries (optional)

Generate AI-powered daily summaries of Slack channel activity:

```env
# Channels to summarize (format: name:ID,name:ID)
DAILY_SUMMARY_CHANNELS=general:C012345,engineering:C067890

# Time to run (HH:MM format, local time, default: 07:00)
DAILY_SUMMARY_TIME=07:00

# Claude model (sonnet, opus, haiku — default: sonnet)
DAILY_SUMMARY_MODEL=sonnet

# Required: personal Slack tokens for reading channel history
SLACK_XOXC_TOKEN=xoxc-...
SLACK_XOXD_TOKEN=xoxd-...
```

At the scheduled time (or via `POST /daily-summary`):
1. Fetches last 24h of messages using personal Slack credentials
2. Resolves usernames and formats timestamps (GMT+7)
3. Summarizes via Claude Agent SDK — key discussions, decisions, action items, shared links
4. DMs the summary to the owner (or posts to `SLACK_CHANNEL_ID`)

## App Mode

`APP_MODE` controls which features each instance handles, allowing local and cloud instances to run simultaneously on the same Slack app without duplicate responses.

| Mode | @Mention (main channel) | @Mention (monitor threads) | Alert monitoring | Delay monitoring | Daily summary |
|------|------------------------|---------------------------|-----------------|-----------------|---------------|
| `local` | Yes | No | No | No | No |
| `cloud` | No | Yes | Yes | Yes | Yes |
| `all` (default) | Yes | Yes | Yes | Yes | Yes |

**Typical split setup:**
- **Cloud/VPS:** `APP_MODE=cloud` — handles PagerDuty alerts, delay alerts, daily summaries, and chat within monitor threads
- **Local machine:** `APP_MODE=local` — handles direct @mention chat in `SLACK_CHANNEL_ID`

Both connect via Slack Socket Mode. Each instance ignores events it's not responsible for.

## Architecture

See [`docs/architecture.md`](./docs/architecture.md) for detailed data flow diagrams, class references, and the full file map.

### Key Files

| File | Purpose |
|------|---------|
| `start-slack-socket.js` | Server launcher (Socket Mode) |
| `claude-hook-notify.js` | Hook entry point (Stop/SubagentStop -> Slack) |
| `claude-remote.js` | CLI: `notify`, `test`, `status`, `config` |
| `setup.js` | Interactive setup wizard |
| `src/channels/slack/socket.js` | Main runtime — manages sessions, polling, alerts |
| `src/channels/slack/alert-monitor.js` | PagerDuty detection in monitored channels |
| `src/services/daily-summary.js` | Daily channel summary generation |
| `src/relay/tmux-injector.js` | tmux command injection |
| `src/data/slack-sessions.db` | SQLite session persistence |

## Troubleshooting

**Bot not responding to @mentions?**
- Verify `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set correctly
- Ensure the Slack app has Socket Mode enabled
- Check the bot is invited to the channel
- If using whitelist, verify your Slack user ID is included

**Hook notifications not appearing?**
```bash
# Test the hook directly
node claude-hook-notify.js completed

# Check hooks are installed
npm run hooks:status

# Check Claude is running in a tmux session that the hook can find
tmux list-sessions
```

**Commands not executing?**
```bash
# Verify tmux is available
which tmux

# Check for active sessions
tmux list-sessions
```

**Debug mode:**
```bash
LOG_LEVEL=debug npm run slack
```

## Commands

```bash
npm run setup   # Interactive setup wizard
npm run slack   # Start Slack Socket Mode bot
```

**CLI:**
```bash
node claude-remote.js notify --type completed   # Send notification
node claude-remote.js test                      # Test notification channels
node claude-remote.js status                    # Show config and status
node claude-remote.js config                    # Interactive config manager
```

## Security

- **Slack auth** — Bot token + app token required for Socket Mode
- **User whitelist** — `SLACK_WHITELIST` restricts who can send commands
- **Session isolation** — Each thread gets its own tmux session
- **Auto-cleanup** — Sessions older than 7 days are automatically removed

## License

MIT License

---

Follow [@Jiaxi_Cui](https://x.com/Jiaxi_Cui) for updates.
