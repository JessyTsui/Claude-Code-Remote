#!/bin/bash

# =============================================================================
# Telegram Claude Remote Control Startup Script
# 遠程 Claude 控制系統啟動腳本
# =============================================================================

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[$(date '+%H:%M:%S')] ✅ $1${NC}"
}

print_error() {
    echo -e "${RED}[$(date '+%H:%M:%S')] ❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}[$(date '+%H:%M:%S')] ⚠️  $1${NC}"
}

print_info() {
    echo -e "${CYAN}[$(date '+%H:%M:%S')] ℹ️  $1${NC}"
}

# Function to check if a process is running
check_process() {
    local process_name="$1"
    pgrep -f "$process_name" > /dev/null 2>&1
}

# Function to stop existing processes
stop_existing_processes() {
    print_status "Stopping existing processes..."
    
    # Stop telegram services
    if check_process "telegram-direct-mode.js"; then
        pkill -f "telegram-direct-mode.js"
        print_info "Stopped telegram-direct-mode"
    fi
    
    if check_process "telegram-polling.js"; then
        pkill -f "telegram-polling.js"
        print_info "Stopped telegram-polling"
    fi
    
    # Stop monitoring services
    if check_process "smart-monitor.js"; then
        pkill -f "smart-monitor.js"
        print_info "Stopped smart-monitor"
    fi
    
    if check_process "simple-monitor.js"; then
        pkill -f "simple-monitor.js"
        print_info "Stopped simple-monitor"
    fi
    
    if check_process "auto-notification-daemon.js"; then
        pkill -f "auto-notification-daemon.js"
        print_info "Stopped auto-notification-daemon"
    fi
    
    # Wait for processes to terminate
    sleep 2
}

# Function to check environment configuration
check_environment() {
    print_status "Checking environment configuration..."
    
    if [ ! -f "$SCRIPT_DIR/.env" ]; then
        print_error ".env file not found!"
        print_info "Please create .env file with required variables:"
        echo "  TELEGRAM_BOT_TOKEN=your_bot_token"
        echo "  TELEGRAM_CHAT_ID=your_chat_id"
        echo "  TMUX_SESSION=claude-real"
        exit 1
    fi
    
    # Source environment variables
    source "$SCRIPT_DIR/.env"
    
    if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
        print_error "TELEGRAM_BOT_TOKEN not configured in .env"
        exit 1
    fi
    
    if [ -z "$TELEGRAM_CHAT_ID" ]; then
        print_error "TELEGRAM_CHAT_ID not configured in .env"
        exit 1
    fi
    
    print_success "Environment configuration OK"
}

# Function to check tmux session
check_tmux_session() {
    local session_name="${TMUX_SESSION:-claude-real}"
    print_status "Checking tmux session: $session_name"
    
    if ! tmux list-sessions 2>/dev/null | grep -q "^$session_name:"; then
        print_error "Tmux session '$session_name' not found!"
        print_info "Please start Claude Code in a tmux session named '$session_name'"
        print_info "Example: tmux new-session -d -s $session_name 'claude'"
        exit 1
    fi
    
    print_success "Tmux session '$session_name' found"
}

# Function to check Node.js dependencies
check_dependencies() {
    print_status "Checking Node.js dependencies..."
    
    cd "$SCRIPT_DIR"
    
    # Check if required files exist
    local required_files=(
        "telegram-direct-mode.js"
        "smart-monitor.js"
        "src/channels/telegram/telegram.js"
        "src/utils/controller-injector.js"
    )
    
    for file in "${required_files[@]}"; do
        if [ ! -f "$file" ]; then
            print_error "Required file not found: $file"
            exit 1
        fi
    done
    
    print_success "All required files found"
}

# Function to start services
start_services() {
    print_status "Starting Telegram Claude Remote Control services..."
    
    cd "$SCRIPT_DIR"
    
    # Start Telegram Direct Mode (message receiver)
    print_status "Starting Telegram Direct Mode..."
    nohup node telegram-direct-mode.js > "$LOG_DIR/telegram-direct.log" 2>&1 &
    TELEGRAM_PID=$!
    sleep 2
    
    if check_process "telegram-direct-mode.js"; then
        print_success "Telegram Direct Mode started (PID: $TELEGRAM_PID)"
    else
        print_error "Failed to start Telegram Direct Mode"
        cat "$LOG_DIR/telegram-direct.log"
        exit 1
    fi
    
    # Start Smart Monitor (response detector)
    print_status "Starting Smart Monitor..."
    nohup node smart-monitor.js > "$LOG_DIR/smart-monitor.log" 2>&1 &
    MONITOR_PID=$!
    sleep 2
    
    if check_process "smart-monitor.js"; then
        print_success "Smart Monitor started (PID: $MONITOR_PID)"
    else
        print_error "Failed to start Smart Monitor"
        cat "$LOG_DIR/smart-monitor.log"
        exit 1
    fi
}

# Function to show status
show_status() {
    print_status "Service Status:"
    echo ""
    
    if check_process "telegram-direct-mode.js"; then
        print_success "Telegram Direct Mode: Running"
    else
        print_error "Telegram Direct Mode: Stopped"
    fi
    
    if check_process "smart-monitor.js"; then
        print_success "Smart Monitor: Running"
    else
        print_error "Smart Monitor: Stopped"
    fi
    
    echo ""
    print_info "Log files location: $LOG_DIR"
    print_info "Telegram Direct Mode log: $LOG_DIR/telegram-direct.log"
    print_info "Smart Monitor log: $LOG_DIR/smart-monitor.log"
}

# Function to show usage
show_usage() {
    echo ""
    echo -e "${PURPLE}=== Telegram Claude Remote Control ===${NC}"
    echo ""
    echo "Usage: $0 [OPTION]"
    echo ""
    echo "Options:"
    echo "  start     Start all services (default)"
    echo "  stop      Stop all services"
    echo "  restart   Restart all services"
    echo "  status    Show service status"
    echo "  logs      Show recent logs"
    echo "  help      Show this help message"
    echo ""
    echo "Configuration:"
    echo "  Edit .env file to configure Telegram settings"
    echo ""
    echo "Usage after starting:"
    echo "  - Send any message directly to your Telegram bot"
    echo "  - Claude will respond automatically"
    echo "  - No need for /cmd token format"
    echo ""
}

# Function to show logs
show_logs() {
    print_status "Recent logs:"
    echo ""
    
    if [ -f "$LOG_DIR/telegram-direct.log" ]; then
        echo -e "${CYAN}=== Telegram Direct Mode (last 10 lines) ===${NC}"
        tail -10 "$LOG_DIR/telegram-direct.log"
        echo ""
    fi
    
    if [ -f "$LOG_DIR/smart-monitor.log" ]; then
        echo -e "${CYAN}=== Smart Monitor (last 10 lines) ===${NC}"
        tail -10 "$LOG_DIR/smart-monitor.log"
    fi
}

# Main function
main() {
    local command="${1:-start}"
    
    echo -e "${PURPLE}"
    echo "================================================================"
    echo "  Telegram Claude Remote Control System"
    echo "  遠程 Claude 控制系統"
    echo "================================================================"
    echo -e "${NC}"
    
    case "$command" in
        "start")
            check_environment
            check_tmux_session
            check_dependencies
            stop_existing_processes
            start_services
            echo ""
            show_status
            echo ""
            print_success "🚀 Telegram Claude Remote Control started successfully!"
            print_info "📱 You can now send messages directly to your Telegram bot"
            print_info "🤖 Claude will respond automatically"
            echo ""
            ;;
        "stop")
            stop_existing_processes
            print_success "All services stopped"
            ;;
        "restart")
            stop_existing_processes
            check_environment
            check_tmux_session
            check_dependencies
            start_services
            show_status
            print_success "Services restarted successfully"
            ;;
        "status")
            show_status
            ;;
        "logs")
            show_logs
            ;;
        "help")
            show_usage
            ;;
        *)
            print_error "Unknown command: $command"
            show_usage
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"