---
name: claude-remote-codebase
description: "Use when looking up Claude-Code-Remote setup, Telegram bot configuration, ngrok webhook, or token security model. Triggers on \"telegram bot\", \"ngrok setup\", \"webhook URL\", \"remote control\", \"token security\". Do NOT use for general Claude Code or Agent SDK usage."
metadata:
  skill-type: codebase
  scope: project
  version: 1.0.0
---

# Claude-Code-Remote Reference

## Quick Start

Every time you want to use Telegram to control Claude:

```bash
# 1. Start tmux with Claude
tmux new-session -s default
claude
# (Detach later: Ctrl+B, then D)

# 2. In another terminal, start the services
cd /Users/tpellet/Projects/Claude-Code-Remote
ngrok http 3001 &
npm run telegram
```

## If ngrok URL Changed

ngrok generates a new URL on every restart. Update the webhook:

```bash
# Get new URL
curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*'

# Set it (replace YOUR-NEW-NGROK-URL)
curl -X POST "https://api.telegram.org/bot$(grep TELEGRAM_BOT_TOKEN .env | cut -d= -f2)/setWebhook" \
  -d "url=https://YOUR-NEW-NGROK-URL/webhook/telegram"
```

## Usage

1. Claude finishes a task → Telegram notification with token
2. Reply: `/cmd TOKEN123 your next instruction`
3. Command runs in Claude

## Token Security

- Only you can send commands (tied to your chat ID + token)
- Each token is linked to a specific Claude session
- Tokens expire after 24 hours
- Prevents unauthorized command injection

**Tip**: Pay for ngrok ($8/mo) for a static URL — skip the webhook update step.
