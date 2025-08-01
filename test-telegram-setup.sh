#!/bin/bash

# Claude Code Remote - Telegram Setup Test Script
# This script tests all components of the Telegram setup

echo "🧪 Claude Code Remote - Telegram Setup Test"
echo "==========================================="

# Load environment variables
if [ -f ".env" ]; then
    echo "✅ .env file found"
    source .env
else
    echo "❌ .env file not found"
    exit 1
fi

# Check required environment variables
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "❌ TELEGRAM_BOT_TOKEN not set in .env"
    exit 1
else
    echo "✅ TELEGRAM_BOT_TOKEN found"
fi

if [ -z "$TELEGRAM_CHAT_ID" ]; then
    echo "❌ TELEGRAM_CHAT_ID not set in .env"
    exit 1
else
    echo "✅ TELEGRAM_CHAT_ID found"
fi

if [ -z "$TELEGRAM_WEBHOOK_URL" ]; then
    echo "❌ TELEGRAM_WEBHOOK_URL not set in .env"
    exit 1
else
    echo "✅ TELEGRAM_WEBHOOK_URL found: $TELEGRAM_WEBHOOK_URL"
fi

# Test Telegram bot connection
echo ""
echo "🔧 Testing Telegram bot connection..."
response=$(curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": $TELEGRAM_CHAT_ID, \"text\": \"🧪 Setup test from Claude Code Remote\"}")

if echo "$response" | grep -q '"ok":true'; then
    echo "✅ Telegram bot connection successful"
else
    echo "❌ Telegram bot connection failed"
    echo "Response: $response"
    exit 1
fi

# Check webhook status
echo ""
echo "🔧 Checking webhook status..."
webhook_response=$(curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo")
if echo "$webhook_response" | grep -q "$TELEGRAM_WEBHOOK_URL"; then
    echo "✅ Webhook is correctly set"
else
    echo "⚠️  Webhook not set to expected URL"
    echo "Expected: $TELEGRAM_WEBHOOK_URL"
    echo "Response: $webhook_response"
fi

# Check if claude-hooks.json exists
if [ -f "claude-hooks.json" ]; then
    echo "✅ claude-hooks.json found"
else
    echo "❌ claude-hooks.json not found"
    exit 1
fi

# Test notification script
echo ""
echo "🔧 Testing notification script..."
node claude-hook-notify.js completed

# Check if required processes are running
echo ""
echo "🔧 Checking running processes..."

if pgrep -f "ngrok" > /dev/null; then
    echo "✅ ngrok is running"
else
    echo "⚠️  ngrok not found - make sure to run: ngrok http 3001"
fi

if pgrep -f "start-telegram-webhook" > /dev/null; then
    echo "✅ Telegram webhook service is running"
else
    echo "⚠️  Telegram webhook service not running - run: node start-telegram-webhook.js"
fi

# Check tmux sessions
echo ""
echo "🔧 Checking tmux sessions..."
if command -v tmux >/dev/null 2>&1; then
    if tmux list-sessions 2>/dev/null | grep -q "claude-code"; then
        echo "✅ claude-code tmux session found"
    else
        echo "⚠️  claude-code tmux session not found - create with: tmux new-session -s claude-code"
    fi
else
    echo "⚠️  tmux not installed"
fi

echo ""
echo "📋 Setup Test Summary:"
echo "====================="
echo "If all items above show ✅, your setup is ready!"
echo ""
echo "Next steps:"
echo "1. Make sure ngrok is running: ngrok http 3001"
echo "2. Make sure webhook service is running: node start-telegram-webhook.js"
echo "3. Start Claude in tmux with hooks:"
echo "   tmux attach -t claude-code"
echo "   export CLAUDE_HOOKS_CONFIG=$(pwd)/claude-hooks.json"
echo "   claude"
echo ""
echo "Test by running a task in Claude - you should get a Telegram notification!"