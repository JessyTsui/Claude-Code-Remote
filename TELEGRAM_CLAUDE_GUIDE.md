# 🤖 Telegram Claude Remote Control System

透過 Telegram 遠程控制 Claude 的完整自動化系統

## 🚀 快速開始

### 1. 環境配置

確保 `.env` 文件包含以下配置：

```bash
# Telegram Bot 配置
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

# Tmux 會話名稱
TMUX_SESSION=claude-real
```

### 2. 啟動系統

```bash
# 一鍵啟動所有服務
./start-telegram-claude.sh

# 或者使用其他選項
./start-telegram-claude.sh start     # 啟動服務
./start-telegram-claude.sh stop      # 停止服務
./start-telegram-claude.sh restart   # 重啟服務
./start-telegram-claude.sh status    # 查看狀態
./start-telegram-claude.sh logs      # 查看日誌
```

### 3. 使用方式

啟動後，直接在 Telegram 發送訊息即可與 Claude 對話：

```
你好，Claude
幫我列出當前目錄的文件
今天的日期是什麼？
分析這段代碼...
```

## 📋 系統架構

### 核心組件

1. **Telegram Direct Mode** (`telegram-direct-mode.js`)
   - 接收 Telegram 訊息
   - 將訊息注入 Claude 會話
   - 發送確認訊息給用戶

2. **Smart Monitor** (`smart-monitor.js`)
   - 監控 Claude 回應
   - 自動檢測任務完成
   - 發送結果通知

### 工作流程

```
用戶發送訊息 → Telegram Bot → 注入 Claude → Claude 處理 → 監控檢測 → 自動回傳
```

## 🔧 進階配置

### 環境變數說明

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | 必須設定 |
| `TELEGRAM_CHAT_ID` | 允許的 Chat ID | 必須設定 |
| `TMUX_SESSION` | Tmux 會話名稱 | `claude-real` |

### 日誌文件

所有日誌存儲在 `logs/` 目錄：

- `telegram-direct.log` - Telegram 直接對話模式日誌
- `smart-monitor.log` - 智能監控器日誌

### 手動控制

```bash
# 檢查進程狀態
ps aux | grep -E "(telegram-direct|smart-monitor)"

# 手動停止服務
pkill -f telegram-direct-mode.js
pkill -f smart-monitor.js

# 查看實時日誌
tail -f logs/telegram-direct.log
tail -f logs/smart-monitor.log
```

## 🛠️ 故障排除

### 常見問題

1. **Bot 無法接收訊息**
   - 檢查 `TELEGRAM_BOT_TOKEN` 是否正確
   - 確認 Bot 已啟動對話

2. **無法注入 Claude**
   - 檢查 `TMUX_SESSION` 是否存在
   - 確認 Claude 正在 tmux 會話中運行

3. **沒有收到回應**
   - 檢查 Smart Monitor 是否運行
   - 查看 `smart-monitor.log` 日誌

### 除錯模式

```bash
# 前台運行服務以查看詳細輸出
node telegram-direct-mode.js
node smart-monitor.js
```

## 📈 系統監控

### 狀態檢查

```bash
# 查看服務狀態
./start-telegram-claude.sh status

# 查看最近日誌
./start-telegram-claude.sh logs
```

### 性能指標

- **回應時間**：通常 5-15 秒
- **監控頻率**：每 1 秒檢查一次
- **自動重試**：失敗時自動重試

## 🔒 安全考慮

1. **Chat ID 驗證**：只允許指定的 Chat ID 訪問
2. **Token 保護**：Bot Token 存儲在環境變數中
3. **會話隔離**：每個用戶獨立的會話管理

## 📚 API 參考

### 直接測試工具

```bash
# 手動發送通知
node notify.js

# 測試完整流程
node test-full-flow.js

# 直接測試通知
node test-direct.js
```

### 功能擴展

系統支持擴展以下功能：
- LINE 訊息支援
- 多用戶管理
- 指令白名單
- 回應過濾

## 📝 更新日誌

### v2.0.0 (當前版本)
- ✅ 完整的直接對話模式
- ✅ 智能回應監控
- ✅ 自動化啟動腳本
- ✅ 完善的錯誤處理
- ✅ 歷史回應檢測

### 主要改進
- 從 token 模式升級到直接對話
- 智能監控器避免錯過回應
- 一鍵啟動所有服務
- 完整的故障排除機制

## 🤝 支援

如有問題，請檢查：
1. 日誌文件內容
2. 環境變數配置
3. Tmux 會話狀態
4. Telegram Bot 設定

---

**🎉 享受與 Claude 的遠程對話吧！**