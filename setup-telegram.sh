#!/bin/bash

# Claude Code Remote - Telegram Quick Setup Script
# This script helps you quickly set up Telegram notifications

echo "🚀 Claude Code Remote - Telegram Setup"
echo "====================================="

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "📋 Creating .env from template..."
    cp .env.example .env
else
    echo "✅ .env file already exists"
fi

# Get project directory
PROJECT_DIR=$(pwd)
echo "📁 Project directory: $PROJECT_DIR"

# Check if claude-hooks.json exists
if [ ! -f "claude-hooks.json" ]; then
    echo "📝 Creating claude-hooks.json..."
    cat > claude-hooks.json << EOF
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node $PROJECT_DIR/claude-hook-notify.js completed",
        "timeout": 5
      }]
    }],
    "SubagentStop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node $PROJECT_DIR/claude-hook-notify.js waiting",
        "timeout": 5
      }]
    }]
  }
}
EOF
    echo "✅ claude-hooks.json created"
else
    echo "✅ claude-hooks.json already exists"
fi

# Create data directory
mkdir -p src/data
echo "✅ Data directory ready"

echo ""
echo "📋 Next Steps:"
echo "1. Edit .env and add your Telegram credentials:"
echo "   - TELEGRAM_BOT_TOKEN (from @BotFather)"
echo "   - TELEGRAM_CHAT_ID (your chat ID)"
echo "   - TELEGRAM_WEBHOOK_URL (your ngrok URL)"
echo ""
echo "2. Start ngrok in a terminal:"
echo "   ngrok http 3001"
echo ""
echo "3. Start Telegram webhook in another terminal:"
echo "   node start-telegram-webhook.js"
echo ""
echo "4. Start Claude with hooks in a third terminal:"
echo "   export CLAUDE_HOOKS_CONFIG=$PROJECT_DIR/claude-hooks.json"
echo "   claude"
echo ""
echo "5. Test by running a task in Claude!"
echo ""
echo "For detailed instructions, see README.md"