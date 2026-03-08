#!/bin/bash
# Claude Code Remote - Slack Socket Mode Agent
# Usage: ./enzo.sh [start|stop|restart|status|logs]

APP_NAME="enzo"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$APP_DIR/tmp/$APP_NAME.pid"
LOG_FILE="$APP_DIR/tmp/$APP_NAME.log"

mkdir -p "$APP_DIR/tmp"

start() {
    if is_running; then
        echo "$APP_NAME is already running (PID $(cat "$PID_FILE"))"
        return 1
    fi

    echo "Starting $APP_NAME..."
    cd "$APP_DIR"
    nohup node start-slack-socket.js >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo $pid > "$PID_FILE"
    sleep 1

    if kill -0 $pid 2>/dev/null; then
        echo "$APP_NAME started (PID $pid)"
        echo "Logs: tail -f $LOG_FILE"
    else
        echo "Failed to start $APP_NAME. Check logs:"
        tail -20 "$LOG_FILE"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    if ! is_running; then
        echo "$APP_NAME is not running"
        rm -f "$PID_FILE"
        return 0
    fi

    local pid=$(cat "$PID_FILE")
    echo "Stopping $APP_NAME (PID $pid)..."
    kill "$pid" 2>/dev/null

    # Wait up to 5 seconds for graceful shutdown
    for i in $(seq 1 5); do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "$APP_NAME stopped"
            rm -f "$PID_FILE"
            return 0
        fi
        sleep 1
    done

    # Force kill
    echo "Force killing $APP_NAME..."
    kill -9 "$pid" 2>/dev/null
    rm -f "$PID_FILE"
    echo "$APP_NAME stopped (forced)"
}

restart() {
    stop
    sleep 1
    start
}

status() {
    if is_running; then
        local pid=$(cat "$PID_FILE")
        echo "$APP_NAME is running (PID $pid)"
        echo "Log file: $LOG_FILE"
        echo "Log size: $(du -h "$LOG_FILE" 2>/dev/null | cut -f1)"
        echo ""
        echo "Last 5 log lines:"
        tail -5 "$LOG_FILE" 2>/dev/null
    else
        echo "$APP_NAME is not running"
    fi
}

logs() {
    if [ ! -f "$LOG_FILE" ]; then
        echo "No log file found at $LOG_FILE"
        return 1
    fi
    tail -f "$LOG_FILE"
}

is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

case "${1:-start}" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    logs)    logs ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
