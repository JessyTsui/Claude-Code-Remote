# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Remote is a multi-platform notification and command relay system that allows remote control of Claude Code sessions via LINE, Telegram, and email. The system enables bidirectional communication - receiving notifications when Claude completes tasks and sending new commands remotely.

## Requirements

### System Dependencies
- Node.js >= 14.0.0
- tmux (required for session management and command injection)
- Cross-platform support: macOS, Linux, Windows

### Environment Setup
```bash
# Copy environment template
cp .env.example .env

# Edit .env with your platform credentials:
# - TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for Telegram
# - LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN for LINE  
# - Email SMTP/IMAP settings for email notifications
# - ALLOWED_SENDERS for email whitelist
# - TMUX_SESSION for custom tmux session name (default: 'claude-real')
```

## Development Commands

### Testing and Development
```bash
# Note: No npm test command defined in package.json
# Test all notification channels
node claude-remote.js test

# Test specific automation features
node claude-remote.js test-claude    # Full Claude automation test
node claude-remote.js test-simple    # Simple automation test
node claude-remote.js test-paste     # Clipboard automation test

# Individual test files (run with node)
node test-telegram-notification.js  # Test Telegram notifications
node test-real-notification.js      # Test real notifications
node test-injection.js              # Test command injection
node test-hook.js                   # Test hook functionality
node test-direct.js                 # Test direct functionality
node test-full-flow.js              # Test complete workflow

# System diagnostics
node claude-remote.js diagnose
node claude-remote.js status
```

### Service Management
```bash
# Start all enabled platforms (recommended)
npm run webhooks
# or
node start-all-webhooks.js

# Start individual services
npm run telegram         # Telegram webhook
npm run line            # LINE webhook
npm run daemon:start    # Email daemon
npm run relay:pty       # PTY relay service

# Daemon management
npm run daemon:start
npm run daemon:stop
npm run daemon:status

# Smart monitoring for tmux sessions
node smart-monitor.js               # Intelligent monitoring with historical response detection
```

### Configuration
```bash
# Quick email setup wizard
node claude-remote.js setup-email

# Interactive configuration
node claude-remote.js config

# Edit configuration files directly
node claude-remote.js edit-config channels
node claude-remote.js edit-config user
```

## Architecture Overview

### Core Components

**Configuration System** (`src/core/config.js`)
- Hierarchical configuration management with user/default configs
- Channel-specific configuration handling
- Deep merge support for complex configuration objects

**Notification System** (`src/core/notifier.js`)
- Multi-channel notification dispatch
- Plugin-based channel architecture
- Support for metadata and session management

**Channel Architecture** (`src/channels/`)
- Base channel class (`base/channel.js`) for consistent interface
- Platform-specific implementations (telegram/, line/, email/, local/)
- Each channel supports both notifications and command relay

### Key Services

**Command Relay System** (`src/relay/`)
- `command-relay.js`: Email-based command processing
- `claude-command-bridge.js`: Command queue management
- `relay-pty.js`: PTY-based terminal injection
- `smart-injector.js`: Intelligent command injection into tmux sessions

**Automation Framework** (`src/automation/`)
- `claude-automation.js`: Claude Code-specific automation
- `clipboard-automation.js`: Cross-platform clipboard handling
- `simple-automation.js`: Basic automation primitives

**Session Management** (`src/data/sessions/`)
- UUID-based session tracking
- Token-based command authentication
- Automatic session expiration (24 hours)

### Multi-Platform Support

**Telegram Integration**
- Bot API with inline keyboard support
- Token-based command format: `/cmd TOKEN command`
- Group and private chat support
- Session management with clickable buttons

**LINE Integration**
- Webhook-based message handling
- Rich message formatting with templates
- User ID-based authentication
- Reply-based command processing

**Email Integration**
- IMAP/SMTP support for major providers
- Template-based message formatting
- Reply parsing for command extraction
- Threaded conversation support

## Important File Locations

### Configuration Files
- `config/channels.json` - Platform channel configurations
- `config/user.json` - User-specific settings
- `config/default.json` - Default configuration template
- `.env` - Environment variables for credentials

### Data Directories
- `src/data/sessions/` - Active session storage
- `src/data/processed-messages.json` - Message processing state
- `src/data/session-map.json` - Session mapping for replies
- `logs/` - Application logs

### Entry Points
- `claude-remote.js` - Main CLI interface
- `start-all-webhooks.js` - Multi-platform webhook starter
- `start-telegram-webhook.js` - Telegram-specific webhook
- `start-line-webhook.js` - LINE-specific webhook

## Development Patterns

### Adding New Channels
1. Extend `NotificationChannel` base class in `src/channels/base/channel.js`
2. Implement required methods: `_sendImpl()`, `supportsRelay()`, `validateConfig()`
3. Add channel configuration to default channel config
4. Register channel in notifier initialization

### Session Management
- Sessions use UUID v4 for unique identification
- Tokens are 8-character alphanumeric strings for user convenience
- All sessions auto-expire after 24 hours
- Session files stored as JSON in `src/data/sessions/`

### Command Processing Flow
1. **Command Reception**: User sends command via platform (email reply, Telegram `/cmd TOKEN command`, LINE reply)
2. **Webhook Processing**: Platform-specific webhook (`src/channels/*/webhook.js`) receives and validates command
3. **Token Validation**: Session token validated against `src/data/sessions/*.json` files
4. **Session Matching**: Token matched to active tmux session via session mapping
5. **Command Injection**: 
   - `smart-injector.js` intelligently injects command into tmux session
   - `relay-pty.js` handles PTY-based terminal injection
   - Commands sent using `tmux send-keys` to target session
6. **Response Monitoring**: System monitors tmux output for Claude completion
7. **Notification Dispatch**: Multi-channel notification sent via `notifier.js` when task completes

### Critical Data Flow Dependencies
- **Session Storage**: `src/data/sessions/` contains UUID-based session files
- **Message State**: `processed-messages.json` tracks processed commands to prevent duplicates
- **Session Mapping**: `session-map.json` maps tokens to active sessions for reply handling
- **tmux Integration**: All command injection relies on active tmux sessions with Claude Code running

### tmux Session Requirements
- Active tmux session with Claude Code running is **required** for command relay
- Default session name: `claude-real` (configurable via `TMUX_SESSION` env var)
- System uses `tmux capture-pane` for output monitoring
- Automatic session detection and attachment via `tmux-monitor.js`
- Session persistence allows commands to be injected even when not actively viewing the session

## Security Considerations

### Authentication
- Email: Sender whitelist in `ALLOWED_SENDERS` environment variable
- Telegram: Bot token and chat ID verification
- LINE: Channel secret and access token validation
- All platforms use session tokens for command verification

### Session Security
- Sessions automatically expire after 24 hours
- Tokens are single-use for command authentication
- Session files contain minimal sensitive information
- Commands are validated before execution

## Testing Strategy

The system includes comprehensive testing utilities:
- `test-claude` for full automation testing
- `test-simple` for basic functionality verification
- `test-paste` for clipboard automation testing
- Built-in channel testing via `claude-remote test`

## Common Development Tasks

### Adding New Automation Features
1. Create new automation class in `src/automation/`
2. Extend base automation patterns
3. Add platform-specific permission handling
4. Include comprehensive error handling and fallbacks

### Extending Message Templates
1. Update channel-specific message generation methods
2. Ensure consistent metadata handling across platforms
3. Test message formatting with various content lengths
4. Validate markdown/HTML formatting for each platform

### Configuration Management
- Use the hierarchical config system for all new settings
- Add validation methods for new configuration options
- Update configuration wizards and interactive setup tools
- Ensure backward compatibility with existing configurations

## Troubleshooting

### Common Issues
```bash
# Check if tmux session exists
tmux list-sessions | grep claude-real

# Verify webhook endpoints are accessible
curl -X POST http://localhost:3000/webhook/telegram  # Test Telegram webhook
curl -X POST http://localhost:3001/webhook/line      # Test LINE webhook

# Check session file permissions and structure
ls -la src/data/sessions/
cat src/data/sessions/[session-id].json

# Monitor tmux session output
tmux capture-pane -t claude-real -p

# Debug smart monitor
DEBUG=true node smart-monitor.js
```

### Architecture Dependencies
- **Critical**: tmux session must be running with Claude Code active
- **Platform Webhooks**: Each platform requires separate webhook endpoints
- **Session Persistence**: Session files in `src/data/sessions/` must be readable/writable
- **Token Mapping**: Session tokens expire after 24 hours and must be regenerated
- **Network Access**: Webhooks require accessible network endpoints for external platforms