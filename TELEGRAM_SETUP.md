# Claude Code Telegram 設置指南

這是 Claude Code Remote 的 Telegram 版本，使用 Telegram Bot 來接收通知和發送指令。

## 功能特點

- 🤖 **Telegram Bot 通知**：當 Claude 完成任務或需要輸入時，立即收到 Telegram 訊息
- 🔄 **指令控制**：透過 `/cmd` 指令發送新指令給 Claude
- 🔒 **安全性**：基於 Chat ID 的白名單驗證
- 👥 **群組支援**：可以在 Telegram 群組中使用
- 📱 **按鈕互動**：訊息包含互動按鈕，方便操作

## 快速開始

### 1. 創建 Telegram Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 發送 `/newbot` 創建新 Bot
3. 為您的 Bot 選擇名稱和用戶名
4. 記下 Bot Token（格式：`123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`）

### 2. 取得 Chat ID

#### 方法 1：使用 Bot 獲取
1. 將您的 Bot 加入個人聊天或群組
2. 發送任意訊息給 Bot
3. 訪問：`https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. 在返回的 JSON 中找到 `chat.id`

#### 方法 2：使用 @userinfobot
1. 前往 [@userinfobot](https://t.me/userinfobot)
2. 發送 `/start` 獲取您的 Chat ID

### 3. 設定 Webhook

您需要一個公開的 HTTPS URL 來接收 Telegram 訊息。

#### 選項 A：使用 ngrok（本地測試）
```bash
# 安裝 ngrok
brew install ngrok  # macOS
# 或從 https://ngrok.com 下載

# 啟動 ngrok
ngrok http 3001
```

#### 選項 B：部署到伺服器
確保您有一個支援 HTTPS 的公開域名。

### 4. 配置環境變數

複製 `.env.example` 為 `.env` 並設定：

```bash
# 啟用 Telegram
TELEGRAM_ENABLED=true
EMAIL_ENABLED=false
LINE_ENABLED=false

# Telegram Bot 設定
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11

# 設定接收者（擇一或兩者都設）
TELEGRAM_CHAT_ID=123456789
# TELEGRAM_GROUP_ID=-1001234567890

# 可選：白名單（允許多個使用者/群組）
# TELEGRAM_WHITELIST=123456789,-1001234567890

# Webhook 設定
TELEGRAM_WEBHOOK_PORT=3001
TELEGRAM_WEBHOOK_URL=https://your-domain.com
```

### 5. 安裝依賴

```bash
npm install
```

### 6. 啟動服務

#### 方法 A：自動設定 Webhook
```bash
# 設定了 TELEGRAM_WEBHOOK_URL 後，啟動時會自動設定 webhook
node start-telegram-webhook.js
```

#### 方法 B：手動設定 Webhook
```bash
# 先啟動伺服器
node start-telegram-webhook.js

# 在另一個終端手動設定 webhook
curl -X POST https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook \
  -d "url=https://your-domain.com/webhook/telegram"
```

#### 啟動 Claude Code
```bash
# 使用 tmux（推薦）
tmux new-session -s claude-code
claude --hooks-config=./claude-hooks.json
```

## 使用方式

### 接收通知

當 Claude 完成任務或需要輸入時，您會收到 Telegram 訊息：

```
✅ Claude Task Completed
Project: my-project
Session Token: ABC12345

📝 Your Question:
Please analyze this code...

🤖 Claude Response:
I've completed the code analysis...

💬 To send a new command:
Reply with: /cmd ABC12345 <your command>
Example: /cmd ABC12345 Please analyze this code
```

### 發送指令

使用以下任一格式發送指令：

#### 方法 1：使用 /cmd 指令
```
/cmd ABC12345 Please continue optimizing the code
```

#### 方法 2：直接使用 Token
```
ABC12345 Please continue optimizing the code
```

### Bot 指令

- `/start` - 顯示歡迎訊息
- `/help` - 顯示說明
- `/cmd <TOKEN> <command>` - 發送指令給 Claude

## 進階設定

### 使用群組

1. 將 Bot 加入 Telegram 群組
2. 將 Bot 設為群組管理員（可選，但建議）
3. 使用群組 ID 替代個人聊天 ID：
   ```bash
   TELEGRAM_GROUP_ID=-1001234567890
   ```

### 白名單設定

限制可以使用 Bot 的使用者或群組：

```bash
# 允許多個 Chat ID
TELEGRAM_WHITELIST=123456789,987654321,-1001234567890
```

### 使用 PM2 管理服務

```bash
# 安裝 PM2
npm install -g pm2

# 啟動服務
pm2 start start-telegram-webhook.js --name telegram-webhook

# 設定開機自啟
pm2 save
pm2 startup
```

### 使用 Docker

創建 `Dockerfile`：

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["node", "start-telegram-webhook.js"]
```

建置並執行：

```bash
docker build -t claude-telegram-bot .
docker run -d --env-file .env -p 3001:3001 claude-telegram-bot
```

## 故障排除

### Webhook 設定問題

檢查 webhook 狀態：
```bash
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
```

刪除 webhook：
```bash
curl -X POST https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook
```

### 常見錯誤

1. **Bot Token 無效**
   - 確認從 @BotFather 複製的 Token 正確
   - 檢查 Token 格式：`數字:字母數字-符號`

2. **收不到訊息**
   - 確認 webhook URL 可從外部訪問
   - 檢查 HTTPS 憑證是否有效
   - 確認防火牆設定

3. **Chat ID 錯誤**
   - 個人聊天 ID 通常是正數
   - 群組 ID 通常是負數（以 -100 開頭）
   - 超級群組 ID 格式：`-1001234567890`

4. **權限問題**
   - 確認 Bot 已加入群組
   - 檢查白名單設定
   - 群組中可能需要將 Bot 設為管理員

### 測試指令

測試 Bot 是否正常工作：

```bash
# 發送測試訊息
curl -X POST https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage \
  -d "chat_id=<YOUR_CHAT_ID>" \
  -d "text=Test message"

# 獲取 Bot 資訊
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getMe
```

## 安全建議

1. **保護 Bot Token**：不要在公開程式碼中暴露 Token
2. **使用 HTTPS**：Telegram 要求 webhook 使用 HTTPS
3. **設定白名單**：限制可以使用 Bot 的使用者
4. **定期輪換 Token**：定期更新 Bot Token
5. **監控使用情況**：追蹤 Bot 的使用狀況和錯誤

## 限制

- Token 有效期：24 小時
- Telegram API 限制：每秒最多 30 條訊息
- 訊息長度限制：最多 4096 字元
- Webhook timeout：Telegram 要求在 20 秒內回應

## 支援

如有問題，請提交 Issue 到 GitHub repository 或查看 [Telegram Bot API 文件](https://core.telegram.org/bots/api)。