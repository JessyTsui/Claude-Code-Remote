#!/bin/bash

# Advanced Claude Code Remote Session Creator
# Supports multiple Claude Code configurations

show_help() {
    echo "🚀 Claude Code Remote - Advanced Session Creator"
    echo "================================================"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -b, --bypass-permissions    Start Claude with dangerously skip permissions (default)"
    echo "  -n, --normal               Start Claude in normal mode (with permission prompts)"
    echo "  -c, --config FILE          Use custom Claude config file"
    echo "  -s, --session NAME         Use custom tmux session name (default: claude-session)"
    echo "  -h, --help                 Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                         # Start with dangerously skip permissions"
    echo "  $0 --normal                # Start in normal mode"
    echo "  $0 --config ~/.claude/custom.json"
    echo "  $0 --session my-claude --bypass-permissions"
    echo ""
}

# Default values
BYPASS_PERMISSIONS=true
SESSION_NAME="claude-session"
CONFIG_FILE=""
CLAUDE_COMMAND="claude"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -b|--bypass-permissions)
            BYPASS_PERMISSIONS=true
            shift
            ;;
        -n|--normal)
            BYPASS_PERMISSIONS=false
            shift
            ;;
        -c|--config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        -s|--session)
            SESSION_NAME="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Build Claude command
if [ "$BYPASS_PERMISSIONS" = true ]; then
    CLAUDE_COMMAND="claude --dangerously-skip-permissions"
    PERMISSION_MODE="Dangerously Skip Permissions (tự động approve tools)"
else
    CLAUDE_COMMAND="claude"
    PERMISSION_MODE="Normal Mode (yêu cầu user approval)"
fi

if [ -n "$CONFIG_FILE" ]; then
    CLAUDE_COMMAND="$CLAUDE_COMMAND --config $CONFIG_FILE"
fi

echo "🚀 Tạo phiên làm việc Claude Code Remote mới..."
echo "================================================"
echo "⚙️  Session: $SESSION_NAME"
echo "⚙️  Mode: $PERMISSION_MODE"
if [ -n "$CONFIG_FILE" ]; then
    echo "⚙️  Config: $CONFIG_FILE"
fi
echo "⚙️  Command: $CLAUDE_COMMAND"
echo ""

# Kill existing sessions
echo "🧹 Dọn dẹp sessions cũ..."
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
pkill -f "claude" 2>/dev/null || true

# Wait a moment
sleep 2

# Create new tmux session
echo "📱 Tạo tmux session mới '$SESSION_NAME'..."
tmux new-session -d -s "$SESSION_NAME"

# Wait for session to be ready
sleep 1

# Start Claude Code in the session
echo "🤖 Khởi động Claude Code trong tmux session..."
tmux send-keys -t "$SESSION_NAME" "$CLAUDE_COMMAND" Enter

# Wait for Claude to start
echo "⏳ Đợi Claude Code khởi động (10 giây)..."
sleep 10

# Check if Claude is running
if ps aux | grep -q "[c]laude"; then
    echo "✅ Claude Code đã khởi động thành công!"
else
    echo "❌ Claude Code chưa khởi động. Thử lại..."
    tmux send-keys -t "$SESSION_NAME" "$CLAUDE_COMMAND" Enter
    sleep 5
fi

# Update .env with session name if different from default
if [ "$SESSION_NAME" != "claude-session" ]; then
    echo "🔧 Cập nhật TMUX_SESSION trong .env..."
    if grep -q "TMUX_SESSION=" .env; then
        sed -i.bak "s/TMUX_SESSION=.*/TMUX_SESSION=$SESSION_NAME/" .env
    else
        echo "TMUX_SESSION=$SESSION_NAME" >> .env
    fi
fi

# Generate new token
echo "🔑 Tạo token mới..."
node claude-hook-notify.js completed

# Get the new token
echo ""
echo "📋 Thông tin session mới:"
node -e "
const fs = require('fs');
const sessions = JSON.parse(fs.readFileSync('src/data/session-map.json', 'utf8'));
const tokens = Object.keys(sessions);
const latestToken = tokens[tokens.length - 1];
const latestSession = sessions[latestToken];
console.log('🔑 TOKEN MỚI:', latestToken);
console.log('📋 Type:', latestSession.type);
console.log('🖥️ Tmux session:', latestSession.tmuxSession);
console.log('📅 Created:', new Date(latestSession.createdAt * 1000).toLocaleString());
console.log('');
console.log('📱 Sử dụng trong Telegram:');
console.log('/cmd', latestToken, 'your command here');
"

echo ""
echo "✅ Setup hoàn tất!"

# Open terminal windows for monitoring
echo "🖥️  Mở terminal windows để theo dõi..."

# Open Claude Code terminal (attach to tmux session)
osascript -e "
tell application \"Terminal\"
    do script \"echo '🤖 Claude Code Session - $SESSION_NAME'; tmux attach-session -t $SESSION_NAME\"
    set custom title of front window to \"Claude Code - $SESSION_NAME\"
end tell
"

# Wait a moment
sleep 2

# Get current token for monitoring
CURRENT_TOKEN=$(node -e "
const fs = require('fs');
const sessions = JSON.parse(fs.readFileSync('src/data/session-map.json', 'utf8'));
const tokens = Object.keys(sessions);
console.log(tokens[tokens.length - 1]);
")

# Open monitoring terminal
osascript -e "
tell application \"Terminal\"
    do script \"echo '📊 Claude Code Remote Monitor'; echo 'Session: $SESSION_NAME'; echo 'Token: $CURRENT_TOKEN'; echo ''; echo '🔍 Commands để monitor:'; echo 'tmux list-sessions'; echo 'tmux capture-pane -t $SESSION_NAME -p'; echo 'ps aux | grep claude'; echo ''; echo '📱 Test command format:'; echo '/cmd $CURRENT_TOKEN your-command-here'; echo ''; echo '📋 Nhấn Enter để xem tmux output:'; read; while true; do clear; echo '=== TMUX OUTPUT ==='; tmux capture-pane -t $SESSION_NAME -p; echo ''; echo '=== PRESS ENTER TO REFRESH ==='; read; done\"
    set custom title of front window to \"Monitor - $SESSION_NAME\"
end tell
"

echo ""
echo "📋 Các bước tiếp theo:"
echo "1. Kiểm tra Telegram để nhận notification với token mới"
echo "2. Sử dụng token mới để gửi commands"
if [ "$BYPASS_PERMISSIONS" = true ]; then
    echo "3. Claude sẽ tự động approve tool permissions (bypass mode)"
else
    echo "3. Claude sẽ yêu cầu approval cho tool permissions"
fi
echo "4. Theo dõi Claude Code trong terminal window đã mở"
echo "5. Sử dụng Monitor terminal để debug"
echo ""
echo "🔍 Để kiểm tra tmux session:"
echo "tmux list-sessions"
echo "tmux capture-pane -t $SESSION_NAME -p"
echo ""
echo "🛑 Để stop session:"
echo "tmux kill-session -t $SESSION_NAME"