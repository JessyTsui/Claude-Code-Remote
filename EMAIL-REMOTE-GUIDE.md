# 📧 Claude Code Remote - Email Control Guide

## 🚀 Quick Start

### 1. One-time Setup (trên máy tính)
```bash
# Start email relay service
./start-email-remote.sh
```

### 2. Remote Control (qua email)
Reply to any Claude Code Remote email with commands:

## 🎛️ System Commands (bắt đầu với !)

### Start New Session
```
!start-session my-project
```
- Tạo tmux session mới với tên `my-project`
- Tự động start Claude với bypass permissions
- Sẵn sàng nhận commands

### List Active Sessions
```
!list-sessions
```
- Hiển thị tất cả tmux sessions đang chạy
- Xem status của từng session

### Restart Session
```
!restart-session claude-session
```
- Kill session cũ và tạo mới
- Hữu ích khi session bị lỗi

### System Status
```
!status
```
- Xem system info, uptime, memory
- Số lượng sessions đang chạy

### Help
```
!help
```
- Hiển thị tất cả commands có sẵn

## 💬 Regular Commands (gửi trực tiếp cho Claude)

```
create a Python web scraper
```

```
write a README file for my project
```

```
explain how async/await works in JavaScript
```

## 📋 Workflow Examples

### Scenario 1: Start Project mới
1. **Email**: `!start-session web-scraper`
2. **Response**: Session created successfully
3. **Email**: `create a Python web scraper for news articles`
4. **Claude**: Tạo code và gửi notification
5. **Email**: `add error handling to the scraper`
6. **Continue...**

### Scenario 2: Multiple Projects
1. **Email**: `!start-session project-a`
2. **Email**: `!start-session project-b`
3. **Email**: `!list-sessions` → See both sessions
4. Switch between projects by using different sessions

### Scenario 3: Troubleshooting
1. **Email**: `!status` → Check system
2. **Email**: `!list-sessions` → See active sessions
3. **Email**: `!restart-session claude-session` → Fix issues

## 🔧 Advanced Usage

### Session Management
- **Multiple sessions**: Mỗi project một session riêng
- **Auto-start**: Sessions tự động start Claude
- **Isolation**: Commands chỉ affect session hiện tại

### Email Threading
- **Reply chains**: Mỗi email reply tạo thread riêng
- **Context**: Claude nhớ context trong session
- **History**: Full conversation history trong tmux

### Error Recovery
- **Auto-restart**: Nếu injection fail, tự động tạo session mới
- **Fallback**: System commands luôn hoạt động
- **Monitoring**: Real-time status qua email

## 🚨 Troubleshooting

### Email không phản hồi
1. Check email relay service đang chạy
2. Verify email configuration trong .env
3. Check spam folder

### Commands không execute
1. `!status` để check system
2. `!list-sessions` để xem sessions
3. `!restart-session <name>` để restart

### Session bị stuck
1. `!kill-session <name>`
2. `!start-session <name>`
3. Gửi command mới

## 💡 Tips & Best Practices

### Email Commands
- **System commands**: Luôn bắt đầu với `!`
- **Regular commands**: Gửi trực tiếp cho Claude
- **Multi-line**: Có thể gửi commands dài

### Session Naming
- **Descriptive names**: `web-scraper`, `data-analysis`
- **Project-based**: Một session per project
- **Easy to remember**: Tránh tên phức tạp

### Workflow
- **Start session** trước khi làm việc
- **Check status** định kỳ
- **Clean up** sessions không dùng

## 🎯 Use Cases

### Remote Development
- Làm việc từ xa hoàn toàn
- Không cần VPN hay SSH
- Chỉ cần email

### Mobile Coding
- Gửi commands từ điện thoại
- Nhận results qua email
- Code anywhere, anytime

### Team Collaboration
- Share email notifications
- Multiple developers, multiple sessions
- Centralized development server

### Long-running Tasks
- Start task và đi làm việc khác
- Nhận notification khi xong
- Continue từ bất kỳ đâu

## 🔒 Security

### Email Security
- **Whitelist**: Chỉ emails được phép mới hoạt động
- **Authentication**: SMTP/IMAP với App Passwords
- **Encryption**: TLS/SSL cho email connections

### Session Security
- **Isolation**: Mỗi session độc lập
- **Timeout**: Sessions tự động expire
- **Access Control**: Chỉ owner có thể control

### System Security
- **Limited Commands**: Chỉ tmux và Claude commands
- **No Shell Access**: Không thể execute arbitrary system commands
- **Sandboxed**: Claude chạy trong controlled environment

---

## 🎊 Ready to Code Remotely!

1. **Start**: `./start-email-remote.sh`
2. **Create**: `!start-session my-project`
3. **Code**: Send commands via email
4. **Enjoy**: Remote development freedom!

**Happy remote coding! 🚀📧**