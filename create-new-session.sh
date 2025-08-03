#!/bin/bash

echo "🚀 Tạo phiên làm việc Claude Code Remote mới..."
echo "================================================"
echo "⚙️  Cấu hình: Dangerously Skip Permissions (tự động approve tools)"

# Kill existing sessions
echo "🧹 Dọn dẹp sessions cũ..."
tmux kill-session -t claude-session 2>/dev/null || true
pkill -f "claude-code" 2>/dev/null || true

# Wait a moment
sleep 2

# Create new tmux session
echo "📱 Tạo tmux session mới 'claude-session'..."
tmux new-session -d -s claude-session

# Wait for session to be ready
sleep 1

# Start Claude Code with bypassing permissions in the session
echo "🤖 Khởi động Claude Code với Bypassing Permissions trong tmux session..."
tmux send-keys -t claude-session 'claude --dangerously-skip-permissions' Enter

# Wait for Claude to start
echo "⏳ Đợi Claude Code khởi động (10 giây)..."
sleep 10

# Check if Claude is running
if ps aux | grep -q "[c]laude"; then
    echo "✅ Claude Code đã khởi động thành công!"
else
    echo "❌ Claude Code chưa khởi động. Thử lại với bypass permissions..."
    tmux send-keys -t claude-session 'claude --dangerously-skip-permissions' Enter
    sleep 5
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
    do script \"echo '🤖 Claude Code Session - claude-session'; tmux attach-session -t claude-session\"
    set custom title of front window to \"Claude Code - claude-session\"
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
    do script \"echo '📊 Claude Code Remote Monitor'; echo 'Session: claude-session'; echo 'Token: $CURRENT_TOKEN'; echo ''; echo '🔍 Commands để monitor:'; echo 'tmux list-sessions'; echo 'tmux capture-pane -t claude-session -p'; echo 'ps aux | grep claude'; echo ''; echo '📱 Test command format:'; echo '/cmd $CURRENT_TOKEN your-command-here'; echo ''; echo '📋 Nhấn Enter để xem tmux output:'; read; while true; do clear; echo '=== TMUX OUTPUT ==='; tmux capture-pane -t claude-session -p; echo ''; echo '=== PRESS ENTER TO REFRESH ==='; read; done\"
    set custom title of front window to \"Monitor - claude-session\"
end tell
"

echo ""
echo "📋 Các bước tiếp theo:"
echo "1. Kiểm tra Telegram để nhận notification với token mới"
echo "2. Sử dụng token mới để gửi commands"
echo "3. Claude sẽ tự động approve tool permissions (bypass mode)"
echo "4. Theo dõi Claude Code trong terminal window đã mở"
echo "5. Sử dụng Monitor terminal để debug"
echo ""
echo "🔍 Để kiểm tra tmux session:"
echo "tmux list-sessions"
echo "tmux capture-pane -t claude-session -p"