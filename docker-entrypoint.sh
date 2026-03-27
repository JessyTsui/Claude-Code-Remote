#!/bin/bash
set -e

# Ensure data directories exist (volume may be empty on first run)
mkdir -p /app/src/data/reports /app/src/logs /app/tmp

# Install Claude hooks with correct container paths
node /app/hooks-manage.js install 2>/dev/null || true

# Start tmux server (required before sessions can be created)
tmux start-server || true

# Replace shell with node process (PID 1 for proper signal handling)
exec node /app/start-slack-socket.js
