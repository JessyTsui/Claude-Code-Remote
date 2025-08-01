# Claude Code Remote

Control [Claude Code](https://claude.ai/code) remotely via email. Start tasks locally, receive notifications when Claude completes them, and send new commands by simply replying to emails.

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

- **📧 Email Notifications**: Get notified when Claude completes tasks
- **🔄 Email Control**: Reply to emails to send new commands to Claude
- **📱 Remote Access**: Control Claude from anywhere with just email
- **🔒 Secure**: Whitelist-based sender verification
- **📋 Multi-line Support**: Send complex commands with formatting

## 🚀 Quick Start

### 1. Install

```bash
git clone https://github.com/JessyTsui/Claude-Code-Remote.git
cd Claude-Code-Remote
npm install
```

### 2. Configure Email

```bash
# Copy example config
cp .env.example .env

# Edit with your email credentials
nano .env
```

**Required settings:**
```env
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
IMAP_USER=your-email@gmail.com  
IMAP_PASS=your-app-password
EMAIL_TO=your-notification-email@gmail.com
ALLOWED_SENDERS=your-notification-email@gmail.com
SESSION_MAP_PATH=/your/path/to/Claude-Code-Remote/src/data/session-map.json
```

📌 **Gmail users**: Use [App Passwords](https://myaccount.google.com/security), not your regular password.

### 3. Configure Claude Code Hooks

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

> **Note**: Subagent notifications are disabled by default. To enable them, set `enableSubagentNotifications: true` in your config. See [Subagent Notifications Guide](./docs/SUBAGENT_NOTIFICATIONS.md) for details.

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

📖 **Detailed Email Reply Guide**: [English](./HOW_TO_USE_EMAIL_REPLY.md) | [中文](./HOW_TO_USE_EMAIL_REPLY_ZH.md)

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

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=JessyTsui/Claude-Code-Remote&type=Date)](https://star-history.com/#JessyTsui/Claude-Code-Remote&Date)

⭐ **Star this repo** if it helps you code more efficiently!

> 💡 **Tip**: Share your remote coding setup on Twitter and tag [@Jiaxi_Cui](https://x.com/Jiaxi_Cui) - we love seeing how developers use Claude Code Remote!