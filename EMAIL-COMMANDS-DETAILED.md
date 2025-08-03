# 📧 Claude Code Remote - Email Commands Chi Tiết

## 🏷️ Email Subject Lines

### Notification Emails (từ Claude)
```
[Claude-Code-Remote #TOKEN] Claude Code Task Completed - ProjectName
[Claude-Code-Remote #TOKEN] Claude Code Waiting for Input - ProjectName
```
- **TOKEN**: 8 ký tự (ví dụ: ABC12345)
- **ProjectName**: Tên thư mục hiện tại

### System Response Emails
```
[Claude-Code-Remote] System Response
[Claude-Code-Remote] Session Status  
[Claude-Code-Remote] Help Information
```

## 🎛️ System Commands (bắt đầu với !)

### 1. Start New Session
**Command:**
```
!start-session [session-name]
```

**Examples:**
```
!start-session
!start-session my-project
!start-session web-scraper-v2
```

**Response Email:**
```
Subject: [Claude-Code-Remote] Session Created: my-project

✅ New Claude session 'my-project' started successfully!

🎯 Session Details:
- Name: my-project
- Status: Active
- Created: 2025-08-03 17:00:00

💡 You can now send commands to this session by replying to emails.

📋 Available system commands:
- !list-sessions - List all active sessions
- !status - Get system status
- !help - Show all commands

🚀 Try sending a command like: "create a hello world file"
```

### 2. List Sessions
**Command:**
```
!list-sessions
```

**Response Email:**
```
Subject: [Claude-Code-Remote] System Response

📋 Active tmux sessions:

1. claude-session: 1 windows (created Sun Aug  3 15:22:43 2025)
2. my-project: 1 windows (created Sun Aug  3 17:00:15 2025)
3. web-scraper: 1 windows (created Sun Aug  3 16:45:30 2025)

💡 Use !restart-session <name> to restart a session.
```

### 3. Restart Session
**Command:**
```
!restart-session <session-name>
```

**Examples:**
```
!restart-session claude-session
!restart-session my-project
```

**Response Email:**
```
Subject: [Claude-Code-Remote] Session Restarted: my-project

✅ Session 'my-project' restarted successfully!

🔄 Actions performed:
- Killed existing session
- Created new session
- Started Claude with bypass permissions

🚀 Session is ready for commands.
```

### 4. Kill Session
**Command:**
```
!kill-session <session-name>
```

**Examples:**
```
!kill-session old-project
!kill-session claude-session
```

**Response Email:**
```
Subject: [Claude-Code-Remote] Session Killed: old-project

✅ Session 'old-project' killed successfully.

💀 Session has been terminated and removed from active sessions list.
```

### 5. System Status
**Command:**
```
!status
```

**Response Email:**
```
Subject: [Claude-Code-Remote] System Status Report

📊 System Status Report

🖥️ System: darwin
⏰ Time: 2025-08-03 17:05:30
📋 Active Sessions: 3
🔧 Email Relay: Running

⏱️ Uptime: 17:05  up 2 days,  8:45, 2 users, load averages: 1.23 0.98 0.87
💾 Disk: 45G used of 250G

💡 Use !help to see all available commands.
```

### 6. Help Command
**Command:**
```
!help
```

**Response Email:**
```
Subject: [Claude-Code-Remote] Help Information

📚 Claude Code Remote - Email Commands Help

🎛️ System Commands:
- !start-session [name] - Create new Claude session
- !list-sessions - List all active sessions  
- !restart-session <name> - Restart a session
- !kill-session <name> - Kill a session
- !status - Get system status
- !help - Show this help message

💬 Regular Commands:
Just reply with any command for Claude:
- "create a Python script"
- "write a README file"
- "explain this code"

🔧 Examples:
- !start-session my-project
- !restart-session claude-session
- create a web scraper in Python

📧 How it works:
1. Reply to any Claude Code Remote email
2. Use ! prefix for system commands
3. Regular text goes to Claude directly

💡 Tips:
- Sessions auto-start Claude with bypass permissions
- Each session is isolated
- Commands are executed in tmux sessions
- You can manage multiple projects simultaneously

🚀 Happy coding remotely!
```

## 💬 Regular Commands (cho Claude)

### Format
```
[Bất kỳ text nào không bắt đầu với !]
```

### Examples
```
create a Python web scraper for news articles
```

```
write a README file for my project with installation instructions
```

```
explain how async/await works in JavaScript with examples
```

```
create a simple REST API using Flask with the following endpoints:
- GET /users - list all users
- POST /users - create new user
- GET /users/<id> - get user by id
```

### Response
- Commands được inject vào tmux session
- Claude xử lý và tạo code/files
- Bạn nhận notification email khi hoàn thành
- Reply email đó để tiếp tục conversation

## 📨 Email Threading & Replies

### Cách Reply
1. **Reply trực tiếp** email notification từ Claude
2. **Giữ nguyên subject line** (quan trọng!)
3. **Viết command** trong email body
4. **Gửi email**

### Email Body Format
```
[Command của bạn ở đây]

-- 
[Email signature sẽ được tự động loại bỏ]
```

### Multi-line Commands
```
create a Python class with the following methods:
- __init__(self, name, age)
- get_info(self) - returns formatted string
- update_age(self, new_age) - updates age
- is_adult(self) - returns True if age >= 18

Add proper docstrings and type hints.
```

## 🔍 Email Detection Logic

### Emails được xử lý khi:
1. **Subject contains**: `[Claude-Code-Remote`
2. **Subject contains**: `Claude Code`
3. **Body contains**: `Claude-Code-Remote`
4. **Is reply to**: Previous notification email

### Emails bị bỏ qua khi:
- Không match detection criteria
- Từ sender không trong whitelist
- Đã được xử lý trước đó
- Không có command content

## 🚨 Error Handling

### Invalid Commands
**Email:**
```
!invalid-command
```

**Response:**
```
Subject: [Claude-Code-Remote] Error: Invalid Command

❌ Unknown system command: !invalid-command

📚 Available commands:
- !start-session [name]
- !list-sessions
- !restart-session <name>
- !kill-session <name>
- !status
- !help

💡 Use !help for detailed information.
```

### Session Not Found
**Email:**
```
!restart-session non-existent
```

**Response:**
```
Subject: [Claude-Code-Remote] Error: Session Not Found

❌ Session 'non-existent' not found.

📋 Active sessions:
- claude-session
- my-project

💡 Use !list-sessions to see all active sessions.
```

### System Errors
**Response:**
```
Subject: [Claude-Code-Remote] System Error

❌ System error occurred: [Error details]

🔧 Troubleshooting:
1. Check system status with !status
2. Try restarting session with !restart-session
3. Contact administrator if problem persists

💡 Use !help for available commands.
```

## 📋 Complete Workflow Examples

### Example 1: New Project Setup
```
Email 1: !start-session web-scraper
Response: ✅ Session created successfully

Email 2: create a Python web scraper for BBC news
Response: [Claude notification] Task completed

Email 3: add error handling and logging
Response: [Claude notification] Task completed

Email 4: create unit tests for the scraper
Response: [Claude notification] Task completed
```

### Example 2: Multiple Projects
```
Email 1: !start-session project-a
Response: ✅ Session project-a created

Email 2: !start-session project-b  
Response: ✅ Session project-b created

Email 3: !list-sessions
Response: 📋 Active sessions: project-a, project-b, claude-session

Email 4: create a React component (goes to default session)
Email 5: Switch to project-a context and work there
```

### Example 3: Troubleshooting
```
Email 1: create a complex algorithm
Response: [No response - session might be stuck]

Email 2: !status
Response: 📊 System running, 2 active sessions

Email 3: !restart-session claude-session
Response: ✅ Session restarted

Email 4: create a complex algorithm
Response: [Claude notification] Task completed
```

## 🎯 Best Practices

### Subject Lines
- **Không thay đổi** subject khi reply
- **Giữ nguyên** `[Claude-Code-Remote #TOKEN]` format
- **Email client** tự động handle threading

### Command Writing
- **Rõ ràng và cụ thể**: "create a Python web scraper" thay vì "make scraper"
- **Include context**: "add error handling to the web scraper we just created"
- **Multi-step instructions**: Chia nhỏ tasks phức tạp

### Session Management
- **Descriptive names**: `web-scraper-v2` thay vì `session1`
- **Project-based**: Một session cho mỗi project
- **Clean up**: Kill sessions không dùng với `!kill-session`

### Email Organization
- **Folders**: Tạo folder riêng cho Claude Code Remote emails
- **Filters**: Auto-sort emails theo subject line
- **Archive**: Archive old conversations nhưng giữ recent ones

---

## 🎊 Ready to Use!

**Bây giờ bạn đã biết tất cả về email commands!**

1. **Start service**: `./start-email-remote.sh`
2. **Send first email**: Reply với `!help`
3. **Create session**: `!start-session my-project`
4. **Start coding**: Send any command to Claude
5. **Manage sessions**: Use system commands as needed

**Happy remote coding via email! 📧🚀**