#!/bin/bash

# Open monitoring terminals for existing Claude Code Remote session

SESSION_NAME=${1:-claude-session}

echo "🖥️  Mở terminal windows để theo dõi session: $SESSION_NAME"

# Check if session exists
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "❌ Tmux session '$SESSION_NAME' không tồn tại!"
    echo "📋 Các sessions hiện có:"
    tmux list-sessions 2>/dev/null || echo "Không có session nào"
    echo ""
    echo "💡 Để tạo session mới, chạy:"
    echo "./create-new-session.sh"
    exit 1
fi

# Get current token
CURRENT_TOKEN=$(node -e "
try {
    const fs = require('fs');
    const sessions = JSON.parse(fs.readFileSync('src/data/session-map.json', 'utf8'));
    const tokens = Object.keys(sessions);
    console.log(tokens[tokens.length - 1]);
} catch(e) {
    console.log('NO_TOKEN');
}
" 2>/dev/null)

# Open Claude Code terminal (attach to tmux session)
osascript -e "
tell application \"Terminal\"
    do script \"echo '🤖 Claude Code Session - $SESSION_NAME'; echo 'Đang attach vào tmux session...'; echo ''; tmux attach-session -t $SESSION_NAME\"
    set custom title of front window to \"Claude Code - $SESSION_NAME\"
end tell
"

# Wait a moment
sleep 2

# Open monitoring terminal
osascript -e "
tell application \"Terminal\"
    do script \"
echo '📊 Claude Code Remote Monitor'
echo '=============================='
echo 'Session: $SESSION_NAME'
echo 'Token: $CURRENT_TOKEN'
echo ''
echo '🔍 Monitoring Commands:'
echo '  tmux list-sessions'
echo '  tmux capture-pane -t $SESSION_NAME -p'
echo '  ps aux | grep claude'
echo ''
echo '📱 Telegram Command Format:'
echo '  /cmd $CURRENT_TOKEN your-command-here'
echo ''
echo '🔧 Debug Commands:'
echo '  tmux send-keys -t $SESSION_NAME \\\"echo test\\\" Enter'
echo '  tmux kill-session -t $SESSION_NAME'
echo ''
echo '📋 Nhấn Enter để xem tmux output realtime:'
read
while true; do
    clear
    echo '=== CLAUDE CODE TMUX OUTPUT ==='
    echo 'Session: $SESSION_NAME | Token: $CURRENT_TOKEN'
    echo '================================'
    tmux capture-pane -t $SESSION_NAME -p 2>/dev/null || echo 'Session không tồn tại'
    echo ''
    echo '=== NHẤN ENTER ĐỂ REFRESH ==='
    read
done
\"
    set custom title of front window to \"Monitor - $SESSION_NAME\"
end tell
"

echo "✅ Đã mở 2 terminal windows:"
echo "  1. 🤖 Claude Code Session (tmux attach)"
echo "  2. 📊 Monitor Terminal (debug tools)"
echo ""
echo "💡 Tips:"
echo "  - Trong Claude terminal: Ctrl+B, D để detach"
echo "  - Trong Monitor terminal: Enter để refresh output"
echo "  - Để đóng: Cmd+W trong mỗi terminal"