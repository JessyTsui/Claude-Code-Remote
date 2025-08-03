#!/bin/bash

# Claude Code Remote - Email Startup Script
# Automatically starts email relay service with session management

echo "🚀 Starting Claude Code Remote Email Service..."

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js first."
    exit 1
fi

# Check if tmux is available
if ! command -v tmux &> /dev/null; then
    echo "❌ tmux not found. Please install tmux first."
    exit 1
fi

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found. Please configure email settings first."
    echo "💡 Copy .env.example to .env and configure your email settings."
    exit 1
fi

# Check if email is configured
if ! grep -q "EMAIL_ENABLED=true" .env; then
    echo "❌ Email not enabled in .env file."
    echo "💡 Set EMAIL_ENABLED=true in your .env file."
    exit 1
fi

# Kill any existing email relay processes
echo "🧹 Cleaning up existing processes..."
pkill -f "advanced-email-relay.js" 2>/dev/null || true
pkill -f "debug-email-relay.js" 2>/dev/null || true
pkill -f "claude-remote.js relay" 2>/dev/null || true

# Wait a moment
sleep 2

echo "📧 Starting Advanced Email Relay Service..."
echo "💡 This service supports:"
echo "   - !start-session [name] - Create new Claude sessions"
echo "   - !list-sessions - List active sessions"
echo "   - !status - System status"
echo "   - !help - Show all commands"
echo "   - Regular text commands go to Claude"
echo ""

# Start the advanced email relay service
node advanced-email-relay.js

echo "🛑 Email relay service stopped."