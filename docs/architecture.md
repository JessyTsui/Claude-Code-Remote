# Architecture Reference

## System Overview

Claude Code Remote is a Slack-based remote control system for Claude Code sessions running in tmux.
When Claude completes a task or needs input, a hook fires a Slack notification. Users reply via
Slack @mentions, and the bot injects commands into tmux sessions. It also includes an alert
monitoring system that watches Slack channels for PagerDuty alerts and automatically starts
Claude investigation sessions with configurable skills.

```
User (Slack)                       Server                          Terminal
    |                                |                                |
    |  @bot "fix the bug"           |                                |
    |------------------------------->|                                |
    |                                |  tmux send-keys "fix the bug" |
    |                                |------------------------------->|
    |                                |                                | Claude runs...
    |                                |  poll tmux capture-pane        |
    |                                |<-------------------------------|
    |  "Done. Here's the diff..."   |                                |
    |<-------------------------------|                                |
    |                                |                                |
    |                                |  [hook fires on Stop]          |
    |                                |  claude-hook-notify.js         |
    |  "Task Completed" notification |  -> Slack Web API              |
    |<-------------------------------|                                |
```

---

## File Map

### Active Files (in use by Slack + Tmux flow)

```
.
|-- claude-hook-notify.js          # Hook entry point (Stop/SubagentStop -> Slack)
|-- claude-remote.js               # CLI: notify, test, status, config
|-- setup.js                       # Interactive .env + hooks setup wizard
|-- start-slack-socket.js          # Slack Socket Mode server launcher
|-- enzo.sh                       # Shell wrapper: start/stop/restart/status/logs
|-- claude-hooks.json              # Hook template for ~/.claude/settings.json
|-- package.json                   # Dependencies & scripts
|-- .env.example                   # Environment variable template
|-- CLAUDE.md                      # AI assistant guidance
|-- README.md                      # Project readme
|-- LICENSE                        # MIT license
|
|-- config/
|   |-- default.json               # Default settings (merged first)
|   |-- user.json                  # User overrides (merged second)
|   |-- channels.json              # Channel definitions (Slack only)
|   `-- defaults/
|       |-- claude-hooks.json      # Hook template (legacy, uses {TASKPING_ROOT} placeholder)
|       |-- config.json            # Default config template
|       `-- i18n.json              # Notification text translations
|
|-- src/
|   |-- core/
|   |   |-- config.js              # ConfigManager: load/merge/save configs
|   |   |-- notifier.js            # Notifier: channel orchestrator
|   |   `-- logger.js              # Logger: timestamped console output
|   |
|   |-- channels/
|   |   |-- base/
|   |   |   `-- channel.js         # NotificationChannel: abstract base class
|   |   `-- slack/
|   |       |-- slack.js           # SlackChannel: send notifications via Web API
|   |       |-- socket.js          # SlackSocketHandler: Socket Mode bot (main runtime)
|   |       `-- alert-monitor.js   # AlertMonitor: detect PagerDuty alerts in monitored channels
|   |
|   |-- relay/
|   |   `-- tmux-injector.js       # TmuxInjector: inject commands + auto-confirm
|   |
|   |-- utils/
|   |   |-- tmux-helper.js         # buildTmuxCommand(): create tmux new-session cmd
|   |   |-- tmux-monitor.js        # TmuxMonitor: capture/parse tmux pane output
|   |   |-- trace-capture.js       # TraceCapture: track user input timestamps
|   |   |-- conversation-tracker.js # ConversationTracker: file-based Q&A history
|   |   |-- subagent-tracker.js    # SubagentTracker: track subagent activities
|   |
|   |-- services/
|   |   `-- daily-summary.js       # DailySummary: fetch channel msgs + Claude Agent SDK summarization
|   |
|   `-- data/
|       `-- slack-sessions.db      # SQLite: sessions table (with alert_message_ts for alert sessions)
```

---

## Class & Module Reference

### Core Layer

#### `Logger` (`src/core/logger.js`)

Minimal structured logger with namespace and level filtering.

| Method                                | Description                                  |
|---------------------------------------|----------------------------------------------|
| `constructor(namespace)`              | Create logger with prefix                    |
| `debug/info/warn/error(msg, ...args)` | Log at level                                 |
| `child(namespace)`                    | Create sub-logger                            |
| `_shouldLog(level)`                   | Check against `CLAUDE_CODE_REMOTE_LOG_LEVEL` |

#### `ConfigManager` (`src/core/config.js`)

Multi-level configuration: `default.json` -> `user.json` -> env vars.

| Method                       | Description                                        |
|------------------------------|----------------------------------------------------|
| `getDefaultConfig()`         | Hardcoded defaults (Slack channel, relay settings) |
| `getDefaultChannelsConfig()` | Channel definitions from env vars                  |
| `load()`                     | Load + merge all config sources                    |
| `save()`                     | Write user.json + channels.json                    |
| `get(key, default)`          | Dot-notation config access                         |
| `set(key, value)`            | Dot-notation config setter                         |
| `getChannel(name)`           | Get channel config by name                         |
| `setChannel(name, config)`   | Set channel config                                 |
| `getProjectName()`           | Git root basename or cwd basename                  |
| `_deepMerge(target, source)` | Recursive object merge                             |

#### `Notifier` (`src/core/notifier.js`)

Channel orchestrator. Registers channels and sends notifications in parallel.

| Method                               | Description                               |
|--------------------------------------|-------------------------------------------|
| `registerChannel(name, channel)`     | Add channel to map                        |
| `initializeChannels()`               | Auto-register Slack channel from config   |
| `notify(type, metadata)`             | Build notification + send to all channels |
| `test()`                             | Test all registered channels              |
| `getStatus()`                        | Return channel status summary             |
| `_buildNotification(type, metadata)` | Create notification object with i18n      |
| `_loadI18n()`                        | Load hardcoded English notification text  |

---

### Channel Layer

#### `NotificationChannel` (`src/channels/base/channel.js`)

Abstract base class. All channels extend this.

| Method                            | Description                                         |
|-----------------------------------|-----------------------------------------------------|
| `send(notification)`              | Send with enabled check + error handling            |
| `test()`                          | Send test notification                              |
| `supportsRelay()`                 | Default: `false`                                    |
| `handleCommand(command, context)` | Default: no-op                                      |
| `_sendImpl(notification)`         | **Abstract** - must be overridden                   |
| `validateConfig()`                | Default: `true`                                     |
| `getStatus()`                     | Return `{name, enabled, configured, supportsRelay}` |

#### `SlackChannel` (`src/channels/slack/slack.js`)

Extends `NotificationChannel`. Posts Block Kit messages via `@slack/web-api`.

| Method                    | Description                       |
|---------------------------|-----------------------------------|
| `_validateConfig()`       | Check `botToken` and `channelId`  |
| `_sendImpl(notification)` | Build blocks + `chat.postMessage` |
| `supportsRelay()`         | Returns `true`                    |

#### `SlackSocketHandler` (`src/channels/slack/socket.js`)

**The main runtime class.** Slack Socket Mode bot that manages Claude tmux sessions.

```
SlackSocketHandler
  |-- Slack App (Bolt)           # Socket Mode connection
  |-- SQLite DB                  # Session persistence (sessions table with alert_message_ts)
  |-- Pollers Map                # Per-session output polling
  |-- AlertMonitor               # PagerDuty message detection
  |-- Express HTTP server        # Health check, Swagger, API
```

| Method                                                  | Description                                                                                                                                 |
|---------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| **Lifecycle**                                           |                                                                                                                                             |
| `constructor(config)`                                   | Init Bolt app, SQLite, AlertMonitor, HTTP server, listeners                                                                                 |
| `start()`                                               | Connect Socket Mode, reconcile sessions (swap alert reactions for dead ones), resolve monitor channels, start HTTP                           |
| `stop()`                                                | Stop pollers, close DB, disconnect (tmux sessions preserved)                                                                                |
| **SQLite**                                              |                                                                                                                                             |
| `_initDb()`                                             | Create sessions table, prepare statements, clean old                                                                                        |
| `_getSession(key)`                                      | Get session by composite key                                                                                                                |
| `_upsertSession(...)`                                   | Insert or update session row                                                                                                                |
| `_deleteSession(key)`                                   | Remove session row                                                                                                                          |
| `_getAllSessions()`                                     | List all sessions                                                                                                                           |
| `_reconcileSessions()`                                  | Remove DB entries for dead tmux sessions                                                                                                    |
| **Message handling**                                    |                                                                                                                                             |
| `_setupListeners()`                                     | Register `app_mention` + `message` event handlers                                                                                           |
| `_handleMention(event, say)`                            | Auth check -> parse text -> download images -> `_processCommand`                                                                            |
| `_handleMonitoredMessage(event)`                        | Filter monitored channels -> detect PagerDuty -> dedup -> PD ack -> react 👀 -> build prompt -> `_processCommand`                           |
| `_processCommand(channel, thread, cmd, say, msgTs, alertMsgTs)` | Route command: start/resume/exit session, inject command. Alert sessions tracked via `alertMessageTs`                                  |
| **Session management**                                  |                                                                                                                                             |
| `_startNewSession(channel, thread, repoPath, cmd, say)` | Create tmux session, start polling                                                                                                          |
| `_isTmuxSessionAlive(name)`                             | Check via `tmux has-session`                                                                                                                |
| `_killSession(key)`                                     | Kill tmux + remove from DB + stop poller                                                                                                    |
| **Polling**                                             |                                                                                                                                             |
| `_startPolling(key, channel, thread, sessionName)`      | Start interval: capture pane -> diff -> post new lines                                                                                      |
| `_stopPolling(key)`                                     | Clear interval                                                                                                                              |
| `_captureTmuxOutput(sessionName)`                       | `tmux capture-pane -p -S -500`                                                                                                              |
| **HTTP server**                                         |                                                                                                                                             |
| `_setupHttpServer()`                                    | Routes: `/` health, `/docs` swagger, `/send-command`, `/exit-session`, `/remove-reaction`, `/trigger-alert`, `/sessions`, `/delete-message`, `/daily-summary` |
| **Connection monitoring**                               |                                                                                                                                             |
| `_setupConnectionMonitor()`                             | Watchdog: detect disconnect, auto-reconnect                                                                                                 |
| **Utilities**                                           |                                                                                                                                             |
| `_isOwner(userId)`                                      | Check whitelist                                                                                                                             |
| `_downloadSlackImages(files, prefix)`                   | Download attached images to temp dir                                                                                                        |
| `_parseSlackUrl(url)`                                   | Extract channel + ts from Slack permalink                                                                                                   |

#### `AlertMonitor` (`src/channels/slack/alert-monitor.js`)

Watches configured Slack channels for PagerDuty alert messages. Resolves channel names to IDs at startup.

| Method                              | Description                                                                   |
|-------------------------------------|-------------------------------------------------------------------------------|
| `constructor(app, config)`          | Init with Bolt app and config                                                 |
| `static parseChannelList(envValue)` | Parse `MONITOR_CHANNELS` (comma-separated, `!` prefix to exclude)             |
| `resolveMonitorChannels()`          | Resolve channel names → IDs via `conversations.list` (paginated, stops early) |
| `isMonitoredChannel(channelId)`     | Check if channel ID is being monitored                                        |
| `isPagerDutyMessage(event)`         | Detect PD messages via bot_profile, username, or `pagerduty.com` links        |
| `isStatusNotification(event)`       | Skip "Acknowledged" / "Resolved" status updates                               |
| `extractIncidentId(event)`          | Extract PD incident ID from text/attachment URLs                              |

Alert investigations use the same session flow as regular conversations. The only difference
is the trigger source (PagerDuty vs user @mention). Alert sessions are tracked via the
`alert_message_ts` column in the sessions table, which enables reaction management (👀 → ✅).

Additional methods on `SlackSocketHandler` for alert support:

| Method                                       | Description                                                      |
|----------------------------------------------|------------------------------------------------------------------|
| `_addReaction(channelId, messageTs, name)`   | Add emoji reaction (handles `already_reacted`)                   |
| `_removeReaction(channelId, messageTs, name)` | Remove emoji reaction (handles `no_reaction`)                   |
| `_acknowledgePagerDuty(incidentId)`          | Check PD incident status + auto-acknowledge via REST API         |
| `_getPermalink(channelId, messageTs)`        | Get Slack message permalink for building alert prompts           |

---

### Services Layer

#### `DailySummary` (`src/services/daily-summary.js`)

Generates AI-powered daily summaries of Slack channel activity. Fetches messages via personal Slack tokens, formats them, and uses Claude Agent SDK for summarization.

| Function                                            | Description                                                              |
|-----------------------------------------------------|--------------------------------------------------------------------------|
| `runDailySummary(options)`                          | Main entry: iterate channels, fetch, format, summarize, deliver          |
| `fetchChannelMessages(channelId, xoxcToken, xoxdToken)` | Fetch 24h of messages via Slack `conversations.history` (xoxc/xoxd) |
| `resolveUsers(messages, xoxcToken, xoxdToken)`      | Resolve user IDs to display names via `users.info`                       |
| `formatMessages(messages, userCache)`               | Filter system subtypes, format as `[HH:MM] user: text` (GMT+7)          |
| `summarizeWithClaude(channelName, formattedMessages, model)` | Single-turn Claude Agent SDK call with pre-fetched messages     |
| `createSendDm(slackClient)`                         | Returns DM sender that splits long messages into thread replies          |
| `parseChannelsConfig(configStr)`                    | Parse `name:ID,name:ID` format from env var                             |

---

### Relay Layer

#### `TmuxInjector` (`src/relay/tmux-injector.js`)

Full tmux command injection with auto-confirmation handling.

| Method                              | Description                                                           |
|-------------------------------------|-----------------------------------------------------------------------|
| `checkTmuxAvailable()`              | `which tmux`                                                          |
| `checkClaudeSession()`              | `tmux has-session -t <name>`                                          |
| `createClaudeSession()`             | Create detached tmux session running Claude                           |
| `injectCommand(command)`            | 3-step: clear (C-u) -> send-keys -> enter (C-m)                       |
| `handleConfirmations()`             | Poll screen for Y/N, option select, Enter prompts (up to 8 attempts)  |
| `getCaptureOutput()`                | `tmux capture-pane`                                                   |
| `restartClaudeSession()`            | Kill + recreate                                                       |
| `injectCommandFull(token, command)` | Full workflow: check tmux -> check/create session -> inject -> notify |
| `sendSuccessNotification(command)`  | macOS `osascript` notification                                        |
| `logInjection(command)`             | Append to JSON log file                                               |
| `getSessionInfo()`                  | `tmux list-sessions`                                                  |

---

### Utility Layer

#### `buildTmuxCommand()` (`src/utils/tmux-helper.js`)

Single function. Builds `tmux new-session -d -s <name> -c <path> "<shell> -l -c '<cmd>'"`.
Ensures full user environment (PATH, profiles) via login shell.

#### `TmuxMonitor` (`src/utils/tmux-monitor.js`)

Extends `EventEmitter`. Monitors tmux pane for Claude completion/waiting patterns.

| Method                                    | Description                                      |
|-------------------------------------------|--------------------------------------------------|
| **Real-time monitoring**                  |                                                  |
| `start()`                                 | Begin periodic capture + analysis                |
| `stop()`                                  | Stop monitoring                                  |
| `_checkForChanges()`                      | Diff pane content, detect new lines              |
| `_analyzeNewContent(lines)`               | Match against completion/waiting patterns        |
| `_detectResponseCompletion(text, buffer)` | Look for success indicators                      |
| `_extractRecentConversation()`            | Parse buffer for user question + Claude response |
| **Capture methods**                       |                                                  |
| `startCapture(session)`                   | Start `tmux pipe-pane` to file                   |
| `stopCapture(session)`                    | Stop pipe-pane                                   |
| `getRecentConversation(session, lines)`   | Get Q&A from capture file or buffer              |
| `getFullExecutionTrace(session, lines)`   | Get cleaned trace from last user input           |
| `extractConversation(text)`               | Parse `> ` (user) and `⏺ ` (Claude) patterns     |
| `_filterByTimestamp(content)`             | Filter to content after last `> ` line           |
| `_cleanExecutionTrace(trace)`             | Remove prompt boxes, user input, final response  |
| **Events emitted**                        |                                                  |
| `taskCompleted`                           | When completion pattern detected                 |
| `waitingForInput`                         | When waiting pattern detected                    |

#### `TraceCapture` (`src/utils/trace-capture.js`)

Tracks when users send input to tmux sessions (timestamps per session).

| Method                                | Description                    |
|---------------------------------------|--------------------------------|
| `recordUserInput(session, timestamp)` | Store timestamp (keep last 10) |
| `getLastUserInputTime(session)`       | Get most recent input time     |
| `cleanup()`                           | Remove data older than 7 days  |

#### `ConversationTracker` (`src/utils/conversation-tracker.js`)

File-based JSON store for user/Claude message history per session.

| Method                                      | Description                       |
|---------------------------------------------|-----------------------------------|
| `recordUserMessage(sessionId, message)`     | Append user message               |
| `recordClaudeResponse(sessionId, response)` | Append Claude response            |
| `getRecentConversation(sessionId, limit)`   | Get latest Q&A pair               |
| `cleanupOldConversations()`                 | Remove sessions older than 7 days |

#### `SubagentTracker` (`src/utils/subagent-tracker.js`)

Tracks subagent activities per session for inclusion in notifications.

| Method                                | Description                            |
|---------------------------------------|----------------------------------------|
| `addActivity(sessionId, activity)`    | Append activity                        |
| `getActivities(sessionId)`            | Get all activities for session         |
| `clearActivities(sessionId)`          | Clear session activities               |
| `cleanupOldActivities()`              | Remove data older than 24h             |
| `formatActivitiesForEmail(sessionId)` | Format as HTML (legacy, email-focused) |

---

### Entry Points

#### `claude-hook-notify.js`

Called by Claude Code hooks. Minimal, fast script:
1. Load `.env`
2. Get tmux session name via `tmux display-message`
3. Query SQLite for channel/thread mapping
4. Post to Slack via `WebClient.chat.postMessage`

#### `start-slack-socket.js`

Server launcher:
1. Load `.env` and build config object
2. Validate `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
3. Create `SlackSocketHandler` and call `start()`
4. Schedule daily restart if `DAILY_RESTART_HOUR` set
5. Schedule daily summary if `DAILY_SUMMARY_CHANNELS` set
6. Handle SIGINT/SIGTERM for graceful shutdown

#### `claude-remote.js` (CLI)

| Command                              | Description                                         |
|--------------------------------------|-----------------------------------------------------|
| `notify --type <completed\|waiting>` | Capture tmux conversation + send Slack notification |
| `test`                               | Test all registered channels                        |
| `status`                             | Show config + channel status                        |
| `config`                             | Launch interactive config manager                   |

#### `setup.js`

Interactive wizard: prompts for Slack tokens, channel ID, repo path, etc.
Writes `.env` and upserts hooks into `~/.claude/settings.json`.

#### `enzo.sh`

Shell service manager. Runs `start-slack-socket.js` via `nohup` with PID tracking.

---

## Data Flow Diagrams

### 1. Hook Notification Flow

```
Claude Code (running in tmux)
    |
    | [Stop hook fires]
    v
claude-hook-notify.js
    |
    |-- tmux display-message -p "#S"  -->  session_name
    |
    |-- SQLite: SELECT * FROM sessions
    |   WHERE session_name = ?
    |
    |-- [found]  --> channel_id + thread_ts from DB
    |-- [not found] --> SLACK_CHANNEL_ID from .env
    |
    v
Slack Web API: chat.postMessage
    |
    v
User sees notification in Slack thread
```

### 2. Command Relay Flow

```
User sends @bot message in Slack
    |
    v
SlackSocketHandler._handleMention()
    |
    |-- Auth check (_isOwner)
    |-- Strip @mention, parse text
    |-- Download any attached images
    |
    v
_processCommand(channelId, threadTs, command)
    |
    |-- [new thread] --> _startNewSession()
    |   |-- buildTmuxCommand() + exec
    |   |-- Upsert to SQLite
    |   |-- _startPolling()
    |   `-- tmux send-keys (initial command)
    |
    |-- [existing session alive] --> tmux send-keys (command)
    |
    |-- [session dead] --> restart session
    |
    v
Poller (_startPolling)
    |-- Every 500ms: tmux capture-pane
    |-- Diff against last capture
    |-- New lines --> chat.postMessage to thread
    `-- Claude done --> user sees response
```

### 3. Alert Investigation Flow (unified with regular sessions)

```
PagerDuty posts alert to monitored Slack channel
    |
    v
SlackSocketHandler._handleMonitoredMessage()
    |-- AlertMonitor.isMonitoredChannel() → yes
    |-- AlertMonitor.isPagerDutyMessage() → yes
    |-- AlertMonitor.isStatusNotification() → skip if Ack/Resolved
    |-- Dedup by incident ID + session key
    |-- PD API: acknowledge incident (if token configured)
    |-- React with 👀 on alert message
    |-- Build prompt: /<alertSkill> <permalink> [images]
    |
    v
_processCommand(channelId, messageTs, prompt, null, messageTs, alertMessageTs)
    |
    |-- [same flow as regular @mention from here]
    |-- Create tmux session + save to DB (with alert_message_ts)
    |-- Inject prompt via tmux send-keys
    |-- Start polling
    |
    v
Regular polling + response posting
    |-- Owner can @bot follow-up → inject into tmux, re-poll
    |-- Owner can @bot /exit → swap 👀→✅, kill session
    |-- On restart, if tmux dead → reconcile swaps 👀→✅
```

### 4. Daily Summary Flow

```
Scheduled timer fires (DAILY_SUMMARY_TIME) or POST /daily-summary
    |
    v
runDailySummary()
    |-- For each channel in DAILY_SUMMARY_CHANNELS:
    |   |
    |   |-- fetchChannelMessages(channelId, xoxcToken, xoxdToken)
    |   |   `-- Slack API: conversations.history (last 24h, paginated)
    |   |
    |   |-- resolveUsers() → display name cache
    |   |-- formatMessages() → "[HH:MM] user: text" (GMT+7, filtered)
    |   |
    |   |-- summarizeWithClaude(channelName, formattedMessages, model)
    |   |   `-- Claude Agent SDK: query() with maxTurns=1
    |   |
    |   `-- sendDm(target, summaryText)
    |       |-- If <= 3900 chars: single message
    |       `-- If > 3900 chars: split at paragraph boundaries, thread replies
    |
    v
Summary delivered to SLACK_OWNER_USER_ID or SLACK_CHANNEL_ID
```

### 5. Configuration Merge Order

```
Hardcoded defaults (getDefaultConfig)
    |
    v
config/default.json  (file overrides)
    |
    v
config/user.json     (user overrides)
    |
    v
.env                 (env var overrides via getDefaultChannelsConfig)
    |
    v
Final runtime config
```

---

## Dependency Graph (Active Code)

```
start-slack-socket.js
  |-- SlackSocketHandler (socket.js)
  |     |-- @slack/bolt (App)
  |     |-- better-sqlite3 (Database)
  |     |-- express (HTTP API)
  |     |-- swagger-ui-express
  |     |-- axios (image download)
  |     |-- Logger
  |     |-- tmux-helper.js (buildTmuxCommand)
  |     |-- DailySummary (daily-summary.js)
  |     `-- AlertMonitor (alert-monitor.js)
  |         `-- Logger
  `-- DailySummary (daily-summary.js)
        |-- @anthropic-ai/claude-agent-sdk (query)
        |-- axios (Slack API calls)
        `-- Logger

claude-hook-notify.js
  |-- @slack/web-api (WebClient)
  |-- better-sqlite3 (readonly)
  `-- dotenv

claude-remote.js
  |-- Notifier
  |   `-- SlackChannel (slack.js)
  |       `-- @slack/web-api (WebClient)
  |-- ConfigManager (config.js)
  |-- Logger
  `-- TmuxMonitor (for captureCurrentConversation)
      `-- TraceCapture

setup.js
  `-- dotenv (parse existing .env)
```

---

## SQLite Schema

**Database:** `src/data/slack-sessions.db`

```sql
CREATE TABLE sessions (
    session_key   TEXT PRIMARY KEY,   -- "{channelId}-{threadTs}"
    session_name  TEXT NOT NULL,      -- tmux session name (e.g. "slack-C0AJ3-1709123")
    channel_id    TEXT NOT NULL,      -- Slack channel ID
    thread_ts     TEXT NOT NULL,      -- Slack thread timestamp
    repo_path     TEXT NOT NULL,      -- Working directory for Claude
    created_at    INTEGER NOT NULL,   -- Unix ms
    updated_at    INTEGER NOT NULL,   -- Unix ms
    last_bot_ts       TEXT                -- Last bot message ts (for edit-in-place)
    alert_message_ts  TEXT                -- If set, this is an alert session (PD alert msg ts)
);
```

Sessions are auto-cleaned after 7 days. On startup, DB is reconciled against
live tmux sessions (dead entries removed, alert reactions swapped for dead alert sessions).

---

## Environment Variables

| Variable                    | Required | Description                                                                         |
|-----------------------------|----------|-------------------------------------------------------------------------------------|
| `SLACK_BOT_TOKEN`           | Yes      | Bot token (xoxb-...)                                                                |
| `SLACK_APP_TOKEN`           | Yes      | App-level token (xapp-...)                                                          |
| `SLACK_CHANNEL_ID`          | Yes      | Default notification channel                                                        |
| `SLACK_REPO_PATH`           | No       | Default working directory for Claude                                                |
| `SLACK_REPO_ROOT`           | No       | Root for "start claude in project X" discovery                                      |
| `SLACK_CLAUDE_COMMAND`      | No       | Claude launch command (default: `claude --dangerously-skip-permissions`)            |
| `SLACK_WHITELIST`           | No       | Comma-separated authorized Slack user IDs                                           |
| `SLACK_HTTP_PORT`           | No       | HTTP API port (default: 9999)                                                       |
| **Alert Monitoring**        |          |                                                                                     |
| `MONITOR_CHANNELS`          | No       | Comma-separated channel names to watch for PagerDuty alerts (`!` prefix to exclude) |
| `ALERT_SKILL`               | No       | Claude skill/prompt for alert investigation (e.g. `one:pay-ops-production`)         |
| `PAGERDUTY_API_TOKEN`       | No       | PagerDuty API token for auto-acknowledge                                            |
| `PAGERDUTY_FROM_EMAIL`      | No       | PagerDuty "From" email for API calls                                                |
| `SESSION_INACTIVITY_TIMEOUT_MS` | No   | Inactivity timeout for all sessions (default: 300000 = 5 min)                       |
| `POLLER_TIMEOUT_MS`             | No   | Max time poller waits for Claude response (default: 1800000 = 30 min)               |
| **Daily Summary**           |          |                                                                                     |
| `DAILY_SUMMARY_CHANNELS`   | No       | Channels to summarize (format: `name:ID,name:ID`)                                   |
| `DAILY_SUMMARY_TIME`       | No       | Time to run (HH:MM, local time, default: `07:00`)                                   |
| `DAILY_SUMMARY_MODEL`      | No       | Claude model for summarization (`sonnet`/`opus`/`haiku`, default: `sonnet`)          |
| `SLACK_XOXC_TOKEN`         | No       | Personal Slack token (xoxc-...) for reading channel history                          |
| `SLACK_XOXD_TOKEN`         | No       | Personal Slack cookie token (xoxd-...) for reading channel history                   |
| **System**                  |          |                                                                                     |
| `LOG_LEVEL`                 | No       | `debug`/`info`/`warn`/`error`                                                       |
| `DAILY_RESTART_HOUR`        | No       | Hour (0-23) for daily Socket Mode restart                                           |
