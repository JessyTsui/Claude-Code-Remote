# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Claude Code Remote is a notification system that sends desktop notifications when Claude completes tasks or needs input. It supports multiple messaging platforms (Email, Telegram, LINE) and enables two-way control where you can reply to messages to send new commands.

## Common Development Commands

### Start Services
```bash
# Start all enabled platforms
npm run webhooks

# Individual platforms
npm run telegram       # Start Telegram webhook server
npm run line          # Start LINE webhook server
npm run daemon:start  # Start email daemon

# Configuration tool
npm run config        # Interactive configuration
```

### Testing
```bash
# Test notification system
node claude-hook-notify.js completed
node claude-hook-notify.js waiting

# Test specific platforms
node test-telegram-notification.js
node test-injection.js
node test-real-notification.js

# System diagnostics
node claude-remote.js diagnose
node claude-remote.js status
```

## High-Level Architecture

### Core Components

1. **Notification System (`src/core/`)**
   - `notifier.js` - Central orchestrator managing multiple notification channels
   - `config.js` - Configuration manager handling environment variables and config files
   - `logger.js` - Logging infrastructure

2. **Channel Architecture (`src/channels/`)**
   - Base channel interface in `base/channel.js`
   - Platform-specific implementations:
     - `local/desktop.js` - Desktop notifications with sound alerts
     - `email/smtp.js` - Email notifications via SMTP/IMAP
     - `telegram/telegram.js` - Telegram bot integration
     - `line/line.js` - LINE messaging integration

3. **Command Relay System (`src/relay/`)**
   - `tmux-injector.js` - Injects commands into active tmux sessions
   - `email-listener.js` - Monitors IMAP for email replies
   - `command-relay.js` - Routes commands from different channels

4. **Session Management (`src/utils/`)**
   - `conversation-tracker.js` - Tracks active Claude sessions
   - `trace-capture.js` - Captures terminal output for email notifications
   - Session tokens stored in `src/data/session-map.json`

### Hook Integration

The system integrates with Claude Code through hooks configured in:
- Global: `~/.claude/settings.json`
- Project: via `CLAUDE_HOOKS_CONFIG` environment variable

Hooks trigger on:
- `Stop` - When Claude completes a task
- `SubagentStop` - When a subagent completes (optional)

### Multi-Platform Flow

1. Claude Code triggers hook → `claude-hook-notify.js`
2. Notification sent to all enabled channels simultaneously
3. User receives notification with session token
4. User replies with command + token
5. Platform-specific webhook/daemon receives message
6. Command injected into Claude's tmux session

### Environment Configuration

Key environment variables:
- `SESSION_MAP_PATH` - Path to session tracking file
- `INJECTION_MODE` - 'tmux' (required for command injection)
- Platform-specific: `TELEGRAM_BOT_TOKEN`, `LINE_CHANNEL_ACCESS_TOKEN`, etc.

### Security Model

- Email: Sender whitelist via `ALLOWED_SENDERS`
- Telegram/LINE: User/group ID whitelisting
- Session tokens: 8-character alphanumeric, 24-hour expiry
- Each token controls only its specific tmux session