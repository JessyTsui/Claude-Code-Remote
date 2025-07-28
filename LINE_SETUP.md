# Claude Code LINE 設置指南

這是 Claude Code Remote 的 LINE 版本，使用 LINE 訊息來接收通知和發送指令，取代原本的 Email 功能。

## 功能特點

- 📱 **LINE 通知**：當 Claude 完成任務或需要輸入時，立即收到 LINE 訊息
- 🔄 **LINE 指令控制**：透過回覆 LINE 訊息來發送新指令給 Claude
- 🔒 **安全性**：基於 LINE User ID / Group ID 的白名單驗證
- 📋 **支援群組**：可以在 LINE 群組中使用

## 快速開始

### 1. 創建 LINE Bot

1. 前往 [LINE Developers Console](https://developers.line.biz/)
2. 登入您的 LINE 帳號
3. 創建新的 Provider（如果還沒有）
4. 創建新的 Messaging API Channel
5. 記下以下資訊：
   - Channel Access Token（長期）
   - Channel Secret
   - Basic ID（用於加好友）

### 2. 設定 Webhook

1. 在 LINE Developers Console 中設定 Webhook URL：
   ```
   https://your-domain.com/webhook
   ```
   或使用 ngrok 進行本地測試：
   ```
   https://xxxxxx.ngrok.io/webhook
   ```

2. 啟用 Webhook 並關閉自動回覆訊息

### 3. 取得 User ID 或 Group ID

#### 取得 User ID：
1. 加入您的 Bot 為好友
2. 發送任意訊息給 Bot
3. 在 webhook 日誌中查看您的 User ID

#### 取得 Group ID：
1. 將 Bot 加入群組
2. 在群組中發送訊息
3. 在 webhook 日誌中查看 Group ID

### 4. 配置環境變數

複製 `.env.example` 為 `.env` 並設定：

```bash
# 啟用 LINE
LINE_ENABLED=true
EMAIL_ENABLED=false

# LINE Bot 憑證
LINE_CHANNEL_ACCESS_TOKEN=your-channel-access-token
LINE_CHANNEL_SECRET=your-channel-secret

# 設定接收者（擇一或兩者都設）
LINE_USER_ID=U1234567890abcdef
# LINE_GROUP_ID=C1234567890abcdef

# 可選：白名單（允許多個使用者/群組）
# LINE_WHITELIST=U1234567890abcdef,U0987654321fedcba

# Webhook 伺服器埠號
LINE_WEBHOOK_PORT=3000
```

### 5. 安裝依賴

```bash
npm install
```

### 6. 啟動服務

#### 啟動 LINE Webhook 伺服器：
```bash
node start-line-webhook.js
```

#### 在另一個終端機啟動 Claude Code：
```bash
# 使用 tmux（推薦）
tmux new-session -s claude-code
claude --help

# 或使用設定的 hooks
claude --hooks-config=./claude-hooks.json
```

## 使用方式

### 接收通知

當 Claude 完成任務或需要輸入時，您會收到 LINE 訊息：

```
✅ Claude 任務 已完成
專案: my-project
會話 Token: ABC12345

📝 您的問題:
請幫我分析這段程式碼...

🤖 Claude 回應:
我已經完成了程式碼分析...

💬 回覆此訊息並輸入:
Token ABC12345 <您的指令>
來發送新指令給 Claude
```

### 發送指令

回覆 LINE 訊息，格式為：
```
Token ABC12345 請繼續優化程式碼
```

系統會自動將指令注入到對應的 Claude 會話中。

## 進階設定

### 使用 ngrok 進行本地測試

1. 安裝 ngrok：
   ```bash
   brew install ngrok  # macOS
   # 或從 https://ngrok.com 下載
   ```

2. 啟動 ngrok：
   ```bash
   ngrok http 3000
   ```

3. 複製 ngrok 提供的 HTTPS URL 並設定到 LINE Webhook URL

### 使用 PM2 管理服務

1. 安裝 PM2：
   ```bash
   npm install -g pm2
   ```

2. 啟動服務：
   ```bash
   pm2 start start-line-webhook.js --name line-webhook
   pm2 save
   pm2 startup
   ```

### 安全建議

1. **使用 HTTPS**：生產環境必須使用 HTTPS
2. **設定白名單**：限制可以發送指令的使用者
3. **Token 過期**：Token 預設 24 小時過期
4. **驗證簽名**：系統會自動驗證 LINE 的請求簽名

## 故障排除

### Webhook 無法接收訊息
- 確認 Webhook URL 正確且可訪問
- 檢查防火牆設定
- 查看 webhook 伺服器日誌

### 無法發送 LINE 訊息
- 確認 Channel Access Token 正確
- 檢查 Bot 是否已加為好友/加入群組
- 確認 User ID / Group ID 正確

### Token 無效
- Token 區分大小寫（統一使用大寫）
- 檢查 Token 是否已過期
- 確認使用正確的 Token

## 支援

如有問題，請提交 Issue 到 GitHub repository。