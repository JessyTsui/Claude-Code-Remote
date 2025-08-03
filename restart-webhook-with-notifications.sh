#!/bin/bash

echo "🔄 Restarting Telegram webhook with completion notifications..."

# Kill existing webhook
echo "🛑 Stopping existing webhook..."
pkill -f "start-telegram-webhook" 2>/dev/null || true
sleep 2

# Start new webhook
echo "🚀 Starting enhanced webhook..."
npm run telegram &

# Wait for webhook to start
sleep 3

echo "✅ Enhanced webhook started!"
echo ""
echo "📋 New features:"
echo "  - Commands now trigger compact completion notifications"
echo "  - Format: command; compact notification trigger"
echo "  - Automatic Telegram notification with execution info"
echo "  - Compact format: Question + Response + Time + Tokens"
echo ""
echo "📱 Test with current token:"

# Get current token
CURRENT_TOKEN=$(node -e "
const fs = require('fs');
const sessions = JSON.parse(fs.readFileSync('src/data/session-map.json', 'utf8'));
const tokens = Object.keys(sessions);
console.log(tokens[tokens.length - 1]);
" 2>/dev/null)

echo "/cmd $CURRENT_TOKEN echo 'Hello from enhanced webhook!'"