#!/bin/bash

echo "🚀 Setting up Claude Code in tmux session..."

# Kill existing session if exists
tmux kill-session -t claude-session 2>/dev/null || true

# Create new tmux session
echo "📱 Creating tmux session 'claude-session'..."
tmux new-session -d -s claude-session

# Wait a moment
sleep 1

# Start Claude Code in the session
echo "🤖 Starting Claude Code in tmux session..."
tmux send-keys -t claude-session 'claude-code' Enter

# Wait for Claude to start
sleep 3

echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Run: node claude-hook-notify.js completed"
echo "2. Get new token from Telegram notification"
echo "3. Test with: /cmd TOKEN your command"
echo ""
echo "🔍 To check tmux session:"
echo "tmux list-sessions"
echo "tmux attach-session -t claude-session"