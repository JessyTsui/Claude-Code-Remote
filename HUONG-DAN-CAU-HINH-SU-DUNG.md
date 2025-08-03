# 🚀 Hướng dẫn cấu hình và sử dụng Claude Code Remote

## 📋 Mục lục

1. [Giới thiệu](#giới-thiệu)
2. [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
3. [Cài đặt cơ bản](#cài-đặt-cơ-bản)
4. [Cấu hình Email](#cấu-hình-email)
5. [Cấu hình Telegram](#cấu-hình-telegram)
6. [Cấu hình Claude Code Hooks](#cấu-hình-claude-code-hooks)
7. [Khởi tạo và sử dụng](#khởi-tạo-và-sử-dụng)
8. [Troubleshooting](#troubleshooting)
9. [Scripts tiện ích](#scripts-tiện-ích)
10. [Best Practices](#best-practices)

---

## 🎯 Giới thiệu

**Claude Code Remote** là hệ thống cho phép điều khiển Claude Code từ xa thông qua nhiều nền tảng nhắn tin:

- **📧 Email**: Nhận thông báo và gửi commands qua email
- **📱 Telegram**: Bot tương tác với buttons và commands
- **💬 LINE**: Messaging với token-based commands  
- **🖥️ Desktop**: Sound alerts và system notifications

### ✨ Tính năng chính:

- **Two-way Control**: Nhận notifications và gửi commands
- **Multi-platform**: Hỗ trợ đồng thời nhiều kênh thông báo
- **Auto-approve**: Tự động approve tool permissions
- **Session Management**: Token-based security với timeout
- **Real-time Monitoring**: Terminal windows để theo dõi

---

## 💻 Yêu cầu hệ thống

### Phần mềm cần thiết:

- **Node.js** >= 14.0.0
- **tmux** (bắt buộc cho command injection)
- **Claude Code** (lệnh `claude`)
- **ngrok** (cho Telegram webhook)

### Kiểm tra yêu cầu:

```bash
# Kiểm tra Node.js
node --version

# Kiểm tra tmux
tmux -V

# Kiểm tra Claude Code
claude --help

# Kiểm tra ngrok (nếu dùng Telegram)
ngrok version
```

### Cài đặt thiếu:

```bash
# macOS với Homebrew
brew install tmux
brew install ngrok

# Ubuntu/Debian
sudo apt-get install tmux
```

---

## 🔧 Cài đặt cơ bản

### 1. Clone repository:

```bash
git clone https://github.com/JessyTsui/Claude-Code-Remote.git
cd Claude-Code-Remote
```

### 2. Cài đặt dependencies:

```bash
npm install
```

### 3. Tạo file cấu hình:

```bash
cp .env.example .env
```

### 4. Tạo thư mục data:

```bash
mkdir -p src/data
```

---

## 📧 Cấu hình Email

### 1. Cấu hình Gmail (Khuyến nghị)

#### Bước 1: Tạo App Password

1. Truy cập: https://myaccount.google.com/security
2. Bật **Two-Factor Authentication**
3. Tạo **App Password**: https://myaccount.google.com/apppasswords
4. Chọn "Mail" và tạo password 16 ký tự

#### Bước 2: Cấu hình .env

```env
# Bật email
EMAIL_ENABLED=true

# Gmail SMTP configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-16-digit-app-password

# Gmail IMAP configuration
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=your-email@gmail.com
IMAP_PASS=your-16-digit-app-password

# Email routing
EMAIL_TO=your-email@gmail.com
ALLOWED_SENDERS=your-email@gmail.com
```

### 2. Cấu hình providers khác

#### QQ Email:
```env
SMTP_HOST=smtp.qq.com
SMTP_PORT=587
IMAP_HOST=imap.qq.com
IMAP_PORT=993
```

#### 163 Email:
```env
SMTP_HOST=smtp.163.com
SMTP_PORT=587
IMAP_HOST=imap.163.com
IMAP_PORT=993
```

#### Outlook:
```env
SMTP_HOST=smtp.live.com
SMTP_PORT=587
IMAP_HOST=imap-mail.outlook.com
IMAP_PORT=993
```

### 3. Test email configuration:

```bash
node claude-remote.js test
```

---

## 📱 Cấu hình Telegram

### 1. Tạo Telegram Bot

#### Bước 1: Tạo bot với @BotFather

1. Mở Telegram, tìm `@BotFather`
2. Gửi `/newbot`
3. Đặt tên bot: `Claude Code Remote Bot`
4. Đặt username: `your_claude_remote_bot`
5. Lưu **Bot Token**

#### Bước 2: Lấy Chat ID

1. Start bot bằng cách gửi `/start`
2. Truy cập: `https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates`
3. Tìm `"chat":{"id": YOUR_CHAT_ID}`

### 2. Cấu hình ngrok

#### Cài đặt ngrok:
```bash
# macOS
brew install ngrok

# Đăng ký tài khoản miễn phí tại https://ngrok.com/
# Lấy authtoken từ dashboard
ngrok config add-authtoken YOUR_AUTHTOKEN
```

#### Start ngrok:
```bash
ngrok http 3001
```

Copy HTTPS URL (ví dụ: `https://abc123.ngrok.io`)

### 3. Cấu hình .env

```env
# Bật Telegram
TELEGRAM_ENABLED=true

# Bot configuration
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789

# Webhook configuration
TELEGRAM_WEBHOOK_URL=https://abc123.ngrok.io

# Network configuration (nếu cần)
TELEGRAM_FORCE_IPV4=false

# Whitelist (optional)
TELEGRAM_WHITELIST=123456789
```

### 4. Test Telegram:

```bash
node test-telegram-notification.js
```

---

## 🔗 Cấu hình Claude Code Hooks

### 1. Global Configuration (Khuyến nghị)

Tạo/chỉnh sửa `~/.claude/settings.json`:

```bash
mkdir -p ~/.claude
nano ~/.claude/settings.json
```

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node /full/path/to/Claude-Code-Remote/claude-hook-notify.js completed",
        "timeout": 5
      }]
    }],
    "SubagentStop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node /full/path/to/Claude-Code-Remote/claude-hook-notify.js waiting",
        "timeout": 5
      }]
    }]
  }
}
```

### 2. Project-Specific Configuration

```bash
export CLAUDE_HOOKS_CONFIG=/full/path/to/Claude-Code-Remote/claude-hooks.json

# Thêm vào ~/.zshrc để persistent
echo 'export CLAUDE_HOOKS_CONFIG=/full/path/to/Claude-Code-Remote/claude-hooks.json' >> ~/.zshrc
```

### 3. Cấu hình System

Cập nhật `.env`:

```env
# Session mapping path
SESSION_MAP_PATH=/full/path/to/Claude-Code-Remote/src/data/session-map.json

# Injection mode
INJECTION_MODE=tmux

# Tmux session name
TMUX_SESSION=claude-session

# Log level
LOG_LEVEL=info
```

---

## 🚀 Khởi tạo và sử dụng

### 1. Scripts có sẵn

#### Script cơ bản:
```bash
./create-new-session.sh
```
- Tự động tạo tmux session
- Start Claude với `--dangerously-skip-permissions`
- Tạo token mới
- Mở 2 terminal windows để monitor

#### Script nâng cao:
```bash
# Với bypass permissions (default)
./create-new-session-advanced.sh

# Normal mode (với permission prompts)
./create-new-session-advanced.sh --normal

# Custom session name
./create-new-session-advanced.sh --session my-claude

# Custom config file
./create-new-session-advanced.sh --config ~/.claude/custom.json

# Xem help
./create-new-session-advanced.sh --help
```

#### Script monitor:
```bash
# Chỉ mở terminals cho session hiện có
./open-monitoring-terminals.sh claude-session
```

### 2. Workflow sử dụng

#### Bước 1: Khởi tạo session
```bash
./create-new-session.sh
```

#### Bước 2: Start services
```bash
# Start tất cả services
npm run webhooks

# Hoặc start riêng lẻ
npm run telegram    # Telegram webhook
npm run daemon:start # Email daemon
```

#### Bước 3: Nhận token
- Kiểm tra Telegram/Email để nhận notification với token mới
- Token có dạng: `ABC12345` (8 ký tự)

#### Bước 4: Gửi commands

**Telegram:**
```
/cmd ABC12345 write text file with hello.txt
```

**Email:**
```
Reply email với: write text file with hello.txt
```

### 3. Terminal Windows

Khi chạy script, 2 terminal windows sẽ được mở:

#### 🤖 Claude Code Terminal:
- Attach trực tiếp vào tmux session
- Xem Claude Code đang chạy realtime
- **Ctrl+B, D** để detach (không tắt Claude)

#### 📊 Monitor Terminal:
- Hiển thị token hiện tại
- Commands để debug
- Realtime tmux output viewer
- **Enter** để refresh output

### 4. Completion Notifications

**Tính năng mới**: Commands từ Telegram sẽ tự động gửi notification khi hoàn thành.

**Cách hoạt động**:
1. Gửi command qua Telegram: `/cmd TOKEN your-command`
2. Nhận confirmation: "Command sent successfully"
3. Command được thực thi với enhanced format: `your-command; notification-trigger`
4. Nhận completion notification khi xong

**Enhanced Command Format**:
```bash
original-command; echo "✅ Command completed"; node compact-notification-trigger.js 'command-info'
```

**Compact Notification Format**:
```
🎉 Task Completed
📝 Your Question: write test file name ly.txt
🤖 Claude Response: ✅ Command completed successfully  
⏱️ Time: 3s
⚒️ Tokens: 75
🔑 Token: ABC12345
```

---

## 🔧 Troubleshooting

### 1. Vấn đề thường gặp

#### Claude Code không start:
```bash
# Kiểm tra Claude có cài đặt không
which claude

# Kiểm tra tmux session
tmux list-sessions

# Restart session
./create-new-session.sh
```

#### Telegram bot không phản hồi:
```bash
# Test bot connectivity
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": $TELEGRAM_CHAT_ID, \"text\": \"Test\"}"

# Kiểm tra webhook
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"

# Restart ngrok và webhook
ngrok http 3001  # Terminal 1
npm run telegram # Terminal 2
```

#### Commands không execute:
```bash
# Kiểm tra tmux session
tmux capture-pane -t claude-session -p

# Test injection trực tiếp
tmux send-keys -t claude-session 'echo "Test: $(date)"' Enter

# Test enhanced injection với notification
./test-completion-notification.sh

# Test compact notification format
./test-compact-notification.sh

# Kiểm tra Claude process
ps aux | grep claude
```

#### Không nhận completion notification:
```bash
# Restart webhook với enhanced features
./restart-webhook-with-notifications.sh

# Test manual notification trigger
node claude-hook-notify.js completed

# Kiểm tra webhook logs
# Xem terminal đang chạy npm run telegram
```

#### Email không hoạt động:
```bash
# Test email config
node claude-remote.js test

# Kiểm tra SMTP settings
# Đảm bảo sử dụng App Password cho Gmail
```

### 2. Debug Commands

```bash
# Kiểm tra system status
node claude-remote.js status

# Test notifications
node claude-hook-notify.js completed

# Diagnose issues
node claude-remote.js diagnose

# View logs
tail -f logs/claude-remote.log
```

### 3. Common Errors

#### "PTY session not found":
- Đảm bảo `INJECTION_MODE=tmux` trong .env
- Restart session với script mới

#### "Command execution failed":
- Kiểm tra token có hợp lệ không
- Đảm bảo Claude đang chạy trong tmux

#### "Webhook not responding":
- Restart ngrok
- Cập nhật TELEGRAM_WEBHOOK_URL
- Restart webhook server

---

## 🛠️ Scripts tiện ích

### 1. create-new-session.sh
```bash
#!/bin/bash
# Tạo session mới với bypass permissions
# Tự động mở 2 terminal windows
# Tạo token mới và gửi notifications
```

### 2. create-new-session-advanced.sh
```bash
#!/bin/bash
# Advanced options:
# --bypass-permissions (default)
# --normal
# --config FILE
# --session NAME
# --help
```

### 3. open-monitoring-terminals.sh
```bash
#!/bin/bash
# Mở terminals cho session hiện có
# Không tạo session mới
# Usage: ./open-monitoring-terminals.sh [session-name]
```

### 4. compact-notification-trigger.js
```bash
#!/usr/bin/env node
# Gửi compact notifications với format ngắn gọn
# Bao gồm: Question, Response, Time, Tokens
# Usage: node compact-notification-trigger.js [command-info]
```

### 5. Các lệnh hữu ích

```bash
# Tạo session nhanh
./create-new-session.sh

# Test compact notifications
./test-compact-notification.sh

# Restart webhook với compact format
./restart-webhook-with-notifications.sh

# Kiểm tra sessions
tmux list-sessions

# Attach vào session
tmux attach-session -t claude-session

# Kill session
tmux kill-session -t claude-session

# Xem output realtime
tmux capture-pane -t claude-session -p

# Test injection
tmux send-keys -t claude-session 'your-command' Enter

# Send compact notification manually
node compact-notification-trigger.js
```

---

## 🎯 Best Practices

### 1. Security

- **Sử dụng App Passwords** cho email, không dùng password chính
- **Whitelist Chat IDs** cho Telegram
- **Rotate tokens** định kỳ
- **Không share tokens** công khai

### 2. Operational

- **Luôn sử dụng tmux mode** (ổn định hơn PTY)
- **Monitor terminal windows** để debug
- **Backup configurations** quan trọng
- **Test sau mỗi thay đổi**

### 3. Development

- **Sử dụng bypass permissions** cho automation
- **Session timeout 24h** là hợp lý
- **Log level info** cho production
- **Debug level** chỉ khi troubleshoot

### 4. Team Usage

- **Shared Telegram groups** cho team notifications
- **Separate sessions** cho mỗi developer
- **Consistent naming** cho sessions
- **Document custom configs**

---

## 📞 Support

### Khi cần hỗ trợ:

1. **Kiểm tra logs**: `tail -f logs/claude-remote.log`
2. **Run diagnostics**: `node claude-remote.js diagnose`
3. **Test components**: `node claude-remote.js test`
4. **Check GitHub Issues**: https://github.com/JessyTsui/Claude-Code-Remote/issues

### Thông tin cần cung cấp:

- OS và version
- Node.js version
- Error messages
- Configuration files (ẩn sensitive data)
- Steps to reproduce

---

## 🎉 Kết luận

Claude Code Remote giúp bạn:

- **Điều khiển Claude Code từ xa** qua nhiều platforms
- **Tự động hóa workflow** với bypass permissions
- **Monitor realtime** qua terminal windows
- **Scale cho team** với shared notifications

**Happy coding with Claude Code Remote! 🚀**

---

*Tài liệu này được tạo dựa trên quá trình setup thực tế và troubleshooting. Cập nhật lần cuối: $(date)*