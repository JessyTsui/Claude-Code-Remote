# Claude Code Remote - LINE Edition

Control [Claude Code](https://claude.ai/code) remotely via LINE messages or email. Start tasks locally, receive notifications when Claude completes them, and send new commands by simply replying to LINE messages or emails.

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

## 🚀 Quick Start

### 1. Install

```bash
git clone https://github.com/JessyTsui/Claude-Code-Remote.git
cd Claude-Code-Remote
npm install
```

### 2. Choose Your Platform

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

### 3. Start Platform Service

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

### 4. Configure Claude Code Hooks

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

### 4. Start

```bash
# Start email monitoring
npm run relay:pty

# In another terminal, start Claude Code
tmux new-session -d -s my-project
tmux attach -t my-project
claude
```

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

## 💡 Use Cases

- **Remote Code Reviews**: Start reviews at office, continue from home via email
- **Long-running Tasks**: Monitor progress and guide next steps remotely
- **Multi-location Development**: Control Claude from anywhere without VPN

## 🔧 Commands

```bash
# Test functionality
node claude-remote.js test

# Check status
node claude-remote.js status

# View pending commands
node claude-remote.js commands list

# Manage sessions
tmux list-sessions
tmux attach -t session-name
```

## 🔍 Troubleshooting

**Email not working?**
```bash
node claude-remote.js test  # Test email setup
```

**Commands not injecting?**
```bash
tmux list-sessions  # Check if session exists
grep ALLOWED_SENDERS .env  # Verify sender whitelist
```

**Hooks not triggering?**
```bash
node claude-remote.js notify --type completed  # Test manually
```

## 🛡️ Security

- ✅ **Sender Whitelist**: Only authorized emails can send commands
- ✅ **Session Isolation**: Each token controls only its specific session
- ✅ **Auto Expiration**: Sessions timeout automatically

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