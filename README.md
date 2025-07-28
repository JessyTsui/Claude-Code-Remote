# Claude Code Remote

Control [Claude Code](https://claude.ai/code) remotely via multiple messaging platforms. Start tasks locally, receive notifications when Claude completes them, and send new commands by simply replying to messages.

**Supported Platforms:**
- 📱 **Telegram** - Interactive bot with buttons and slash commands
- 💬 **LINE** - Rich messaging with token-based commands  
- 📧 **Email** - Traditional SMTP/IMAP integration
- 🖥️ **Local** - Desktop notifications

<div align="center">
  
  ### 🎥 Watch Demo Video
  
  <a href="https://youtu.be/_yrNlDYOJhw">
    <img src="./CCRemote_demo.png" alt="Claude Code Remote Demo" width="100%">
    <br>
    <img src="https://img.shields.io/badge/▶-Watch%20on%20YouTube-red?style=for-the-badge&logo=youtube" alt="Watch on YouTube">
  </a>
  
</div>

> 🐦 Follow [@Jiaxi_Cui](https://x.com/Jiaxi_Cui) for updates and AI development insights

## ✨ Features

- **📱 Multiple Messaging Platforms**: 
  - LINE messages with token-based commands
  - Telegram Bot with interactive buttons and slash commands
  - Traditional email notifications
- **🔄 Two-way Control**: Reply to messages or emails to send new commands
- **📱 Remote Access**: Control Claude from anywhere
- **🔒 Secure**: ID-based whitelist verification for all platforms
- **👥 Group Support**: Use in LINE groups or Telegram groups for team collaboration
- **🤖 Smart Commands**: Intuitive command formats for each platform
- **📋 Multi-line Support**: Send complex commands with formatting
- **⚡ Smart Monitoring**: Intelligent detection of Claude responses with historical tracking
- **🔄 tmux Integration**: Seamless command injection into active tmux sessions

## 🚀 Quick Start

### 1. Prerequisites

**System Requirements:**
- Node.js >= 14.0.0
- **tmux** (required for command injection)
- Active tmux session with Claude Code running

### 2. Install

```bash
git clone https://github.com/JessyTsui/Claude-Code-Remote.git
cd Claude-Code-Remote
npm install
```

### 3. Choose Your Platform

#### Option A: Configure Telegram (Recommended)
See [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md) for detailed Telegram setup instructions.

Quick setup:
```bash
# Copy example config
cp .env.example .env

# Edit with your Telegram credentials
nano .env
```

**Required Telegram settings:**
```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

#### Option B: Configure LINE
See [LINE_SETUP.md](LINE_SETUP.md) for detailed LINE setup instructions.

**Required LINE settings:**
```env
LINE_ENABLED=true
LINE_CHANNEL_ACCESS_TOKEN=your-token
LINE_CHANNEL_SECRET=your-secret
LINE_USER_ID=your-user-id
```

#### Option C: Configure Email
```bash
# Copy example config
cp .env.example .env

# Edit with your email credentials
nano .env
```

**Required email settings:**
```env
EMAIL_ENABLED=true
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
IMAP_USER=your-email@gmail.com  
IMAP_PASS=your-app-password
EMAIL_TO=your-notification-email@gmail.com
ALLOWED_SENDERS=your-notification-email@gmail.com
SESSION_MAP_PATH=/your/path/to/Claude-Code-Remote/src/data/session-map.json
```

📌 **Gmail users**: Use [App Passwords](https://myaccount.google.com/security), not your regular password.

### 4. Start Platform Service

#### Option A: Start All Enabled Platforms (Recommended)
```bash
# Automatically starts all enabled platforms
npm run webhooks
# or
node start-all-webhooks.js
```

#### Option B: Start Individual Platforms

**For Telegram:**
```bash
npm run telegram
# or
node start-telegram-webhook.js
```

**For LINE:**
```bash
npm run line
# or
node start-line-webhook.js
```

**For Email:**
```bash
npm run daemon:start
# or
node claude-remote.js daemon start
```

### 5. Configure Claude Code Hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node /your/path/to/Claude-Code-Remote/claude-remote.js notify --type completed",
        "timeout": 5
      }]
    }],
    "SubagentStop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node /your/path/to/Claude-Code-Remote/claude-remote.js notify --type waiting",
        "timeout": 5
      }]
    }]
  }
}
```

### 6. Start tmux Session & Monitoring

```bash
# Create tmux session with Claude Code (required)
tmux new-session -d -s claude-real
tmux attach -t claude-real
claude

# In another terminal, start smart monitoring
node smart-monitor.js

# Or start PTY relay for command injection
npm run relay:pty
```

**Important**: The tmux session name must match your `TMUX_SESSION` environment variable (default: `claude-real`).

## 🎮 How It Works

1. **Use Claude normally** in tmux session
2. **Get email notifications** when Claude completes tasks
3. **Reply to emails** with new commands
4. **Commands execute automatically** in Claude

### Example Email Flow

**📩 Notification received:**
```
Subject: Claude Code Remote Task Complete [#ABC123]

Claude completed: "Analyze the code structure"
[Claude's full response...]

Reply to send new commands.
```

**📨 Your reply:**
```
Please optimize the performance and fix any bugs you find.
```

**⚡ Result:** Your command automatically executes in Claude!

### Platform Command Formats

**Telegram:**
```
/cmd ABC123 Analyze the code structure and suggest improvements
```

**LINE:**
```
Reply to notification with: Your command here
(Token automatically extracted from conversation context)
```

**Email:**
```
Simply reply to notification email with your command
(No special formatting required)
```

## 💡 Use Cases

- **Remote Code Reviews**: Start reviews at office, continue from home via email
- **Long-running Tasks**: Monitor progress and guide next steps remotely
- **Multi-location Development**: Control Claude from anywhere without VPN

## 🔧 Commands

### Testing & Diagnostics
```bash
# Test all notification channels
node claude-remote.js test

# Test specific automation features
node claude-remote.js test-claude    # Full Claude automation test
node claude-remote.js test-simple    # Simple automation test
node claude-remote.js test-paste     # Clipboard automation test

# Individual test files
node test-telegram-notification.js
node test-real-notification.js
node test-injection.js

# System diagnostics
node claude-remote.js diagnose
node claude-remote.js status
```

### Service Management
```bash
# Start all enabled platforms
npm run webhooks

# Start individual services
npm run telegram         # Telegram webhook
npm run line            # LINE webhook
npm run daemon:start    # Email daemon
npm run relay:pty       # PTY relay service

# Smart monitoring
node smart-monitor.js   # Intelligent tmux session monitoring
```

### Session Management
```bash
# List tmux sessions
tmux list-sessions

# Attach to Claude session
tmux attach -t claude-real

# Monitor session output
tmux capture-pane -t claude-real -p
```

## 🔍 Troubleshooting

### Common Issues

**tmux session not found?**
```bash
# Check if tmux session exists
tmux list-sessions | grep claude-real

# Create session if missing
tmux new-session -d -s claude-real
```

**Commands not injecting?**
```bash
# Verify session exists and is active
tmux capture-pane -t claude-real -p

# Check session file permissions
ls -la src/data/sessions/

# Test command injection directly
node test-injection.js
```

**Webhooks not responding?**
```bash
# Test webhook endpoints
curl -X POST http://localhost:3000/webhook/telegram
curl -X POST http://localhost:3001/webhook/line

# Check webhook logs
DEBUG=true npm run telegram
```

**Notifications not working?**
```bash
# Test all notification channels
node claude-remote.js test

# Test specific platforms
node test-telegram-notification.js
node test-real-notification.js

# Manual notification test
node claude-remote.js notify --type completed
```

**Session tokens expired?**
```bash
# Check session data structure
cat src/data/sessions/[session-id].json

# Sessions auto-expire after 24 hours - create new session
```

### Debug Mode
```bash
# Enable debug logging
DEBUG=true node smart-monitor.js
DEBUG=true npm run webhooks
```

## 🛡️ Security

### Multi-Platform Authentication
- ✅ **Email**: Sender whitelist via `ALLOWED_SENDERS` environment variable
- ✅ **Telegram**: Bot token and chat ID verification  
- ✅ **LINE**: Channel secret and access token validation
- ✅ **Session Tokens**: 8-character alphanumeric tokens for command verification

### Session Security
- ✅ **Session Isolation**: Each token controls only its specific tmux session
- ✅ **Auto Expiration**: Sessions timeout automatically after 24 hours
- ✅ **Token-based Commands**: All platforms require valid session tokens
- ✅ **Minimal Data Storage**: Session files contain only necessary information

## 🤝 Contributing

Found a bug or have a feature request? 

- 🐛 **Issues**: [GitHub Issues](https://github.com/JessyTsui/Claude-Code-Remote/issues)
- 🐦 **Updates**: Follow [@Jiaxi_Cui](https://x.com/Jiaxi_Cui) on Twitter
- 💬 **Discussions**: Share your use cases and improvements

## 📄 License

MIT License - Feel free to use and modify!

---

**🚀 Make Claude Code truly remote and accessible from anywhere!**

⭐ **Star this repo** if it helps you code more efficiently!

> 💡 **Tip**: Share your remote coding setup on Twitter and tag [@Jiaxi_Cui](https://x.com/Jiaxi_Cui) - we love seeing how developers use Claude Code Remote!