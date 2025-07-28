# Claude Code LINE 測試指南

## 本地測試步驟

### 1. 使用 ngrok 建立公開 URL

```bash
# 安裝 ngrok
brew install ngrok  # macOS
# 或從 https://ngrok.com 下載

# 啟動 ngrok
ngrok http 3000
```

記錄 ngrok 提供的 HTTPS URL（例如：`https://abc123.ngrok.io`）

### 2. 設定 LINE Bot Webhook

1. 前往 [LINE Developers Console](https://developers.line.biz/)
2. 選擇您的 Channel
3. 在 Messaging API 設定中：
   - Webhook URL: `https://abc123.ngrok.io/webhook`
   - 啟用 Use webhook
   - 關閉 Auto-reply messages

### 3. 設定環境變數

創建 `.env` 檔案：

```bash
# LINE 設定
LINE_ENABLED=true
EMAIL_ENABLED=false

# 從 LINE Developers Console 複製
LINE_CHANNEL_ACCESS_TOKEN=你的_Channel_Access_Token
LINE_CHANNEL_SECRET=你的_Channel_Secret

# 設定接收者（測試時通常使用您自己的 User ID）
LINE_USER_ID=你的_LINE_User_ID

# Webhook 埠號
LINE_WEBHOOK_PORT=3000

# 其他必要設定
SESSION_MAP_PATH=/Users/your-username/Documents/GitHub/claude-code-line/src/data/session-map.json
INJECTION_MODE=pty
LOG_LEVEL=debug
```

### 4. 啟動服務

#### Terminal 1 - 啟動 LINE Webhook：
```bash
npm install
node start-line-webhook.js
```

應該看到：
```
[LINE-Webhook-Server] Starting LINE webhook server...
[LINE-Webhook-Server] Configuration:
[LINE-Webhook-Server] - Port: 3000
[LINE-Webhook-Server] - User ID: Uxxxxxxxxxx
[LINE-Webhook-Server] LINE webhook server started on port 3000
```

#### Terminal 2 - 啟動 Claude Code：
```bash
# 使用 tmux（推薦）
tmux new-session -s claude-code

# 在 tmux 中啟動 Claude
claude --hooks-config=./claude-hooks.json
```

### 5. 測試流程

#### 測試 1：Webhook 連接
1. 在 LINE Developers Console 點擊 "Verify"
2. 應該顯示 "Success"

#### 測試 2：接收訊息
1. 在 LINE 中發送訊息給您的 Bot
2. 檢查 webhook 伺服器日誌是否收到訊息

#### 測試 3：完整流程
1. 在 Claude 中執行一個任務：
   ```
   請幫我創建一個簡單的 hello.js 檔案
   ```

2. 當 Claude 完成時，您應該收到 LINE 通知：
   ```
   ✅ Claude 任務 已完成
   專案: claude-code-line
   會話 Token: ABC12345
   ...
   ```

3. 回覆 LINE 訊息：
   ```
   Token ABC12345 請再創建一個 world.js 檔案
   ```

4. 檢查 Claude 是否收到並執行新指令

### 6. 除錯技巧

#### 查看日誌
```bash
# Webhook 伺服器日誌
tail -f webhook.log

# Claude hooks 日誌
tail -f ~/.claude/logs/hooks.log
```

#### 常見問題

1. **Webhook 驗證失敗**
   - 確認 Channel Secret 正確
   - 確認 ngrok 正在運行
   - 檢查防火牆設定

2. **收不到 LINE 訊息**
   - 確認 Bot 已加為好友
   - 確認 Webhook 已啟用
   - 檢查 ngrok URL 是否正確

3. **無法發送訊息**
   - 確認 Channel Access Token 正確
   - 確認 User ID 正確
   - 檢查網路連線

4. **Token 無效**
   - 確認使用大寫字母
   - 檢查 Token 是否過期（24小時）
   - 確認會話檔案存在

### 7. 生產環境部署

1. 使用真實的 HTTPS 域名取代 ngrok
2. 使用 PM2 或 systemd 管理服務
3. 設定適當的日誌輪轉
4. 定期清理過期的會話檔案
5. 監控服務狀態和錯誤率

## 安全建議

1. 生產環境必須使用 HTTPS
2. 定期更新 Channel Access Token
3. 限制白名單中的使用者數量
4. 監控異常的訊息頻率
5. 實施速率限制