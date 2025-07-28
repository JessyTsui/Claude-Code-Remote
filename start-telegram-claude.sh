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
    
    if check_process "auto-approver.js"; then
        pkill -f "auto-approver.js"
        print_info "Stopped auto-approver"
    fi
    
    # Wait for processes to terminate
    sleep 2
}

# Function to stop tmux session
stop_tmux_session() {
    local session_name="${TMUX_SESSION:-claude-real}"
    
    if tmux list-sessions 2>/dev/null | grep -q "^$session_name:"; then
        print_status "Stopping tmux session: $session_name"
        read -p "This will terminate the Claude session. Continue? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            tmux kill-session -t "$session_name"
            print_info "Stopped tmux session '$session_name'"
        else
            print_info "Tmux session '$session_name' left running"
        fi
    fi
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

# Function to setup and start tmux session with Claude in new iTerm2 window
setup_tmux_session() {
    local session_name="${TMUX_SESSION:-claude-real}"
    print_status "Setting up tmux session: $session_name"
    
    # Check if session already exists and kill it for clean start
    if tmux list-sessions 2>/dev/null | grep -q "^$session_name:"; then
        print_warning "Existing session '$session_name' found, terminating for clean start..."
        tmux kill-session -t "$session_name" 2>/dev/null || true
        sleep 1
    fi
    
    print_status "Opening new iTerm2 window with tmux and Claude..."
    
    # Create AppleScript to open new iTerm2 window and run tmux + Claude
    local applescript="
    tell application \"iTerm\"
        -- Create new window
        set newWindow to (create window with default profile)
        
        -- Get the session in the new window
        tell current session of newWindow
            -- Change to the correct directory
            write text \"cd '$SCRIPT_DIR'\"
            
            -- Set environment to prevent editor auto-launch
            write text \"export CLAUDECODE_NO_EDITOR=1\"
            write text \"unset EDITOR VISUAL\"
            
            -- Start tmux session
            write text \"tmux new-session -s '$session_name'\"
            
            -- Wait a moment for tmux to start
            delay 2
            
            -- Start Claude in the tmux session with minimal environment
            write text \"claude\"
        end tell
        
        -- Bring iTerm to front
        activate
    end tell"
    
    # Execute the AppleScript
    osascript -e "$applescript"
    
    print_success "New iTerm2 window opened with tmux session '$session_name'"
    print_info "Claude is starting in the new window..."
    
    # Wait and verify the session was created
    local check_count=0
    local max_checks=15
    
    while [ $check_count -lt $max_checks ]; do
        if tmux list-sessions 2>/dev/null | grep -q "^$session_name:"; then
            print_success "Tmux session '$session_name' created successfully"
            
            # Wait a bit more for Claude to start
            sleep 3
            
            # Check if Claude welcome message appears
            local session_output=$(tmux capture-pane -t "$session_name" -p 2>/dev/null || echo "")
            if echo "$session_output" | grep -E "(Welcome to Claude|Claude Code)" > /dev/null; then
                print_success "Claude is running in iTerm2 window"
                return 0
            else
                print_info "Claude is still starting... please wait"
                sleep 2
                return 0
            fi
        fi
        
        check_count=$((check_count + 1))
        print_info "Waiting for tmux session to be created... ($check_count/$max_checks)"
        sleep 2
    done
    
    print_error "Could not verify tmux session was created"
    print_info "Please check the iTerm2 window manually"
    
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
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
    
    # Start Auto Approver (automatic permission granter)
    print_status "Starting Auto Approver..."
    nohup node auto-approver.js > "$LOG_DIR/auto-approver.log" 2>&1 &
    APPROVER_PID=$!
    sleep 1
    
    if check_process "auto-approver.js"; then
        print_success "Auto Approver started (PID: $APPROVER_PID)"
    else
        print_error "Failed to start Auto Approver"
        cat "$LOG_DIR/auto-approver.log"
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
    
    if check_process "auto-approver.js"; then
        print_success "Auto Approver: Running"
    else
        print_error "Auto Approver: Stopped"
    fi
    
    echo ""
    print_info "Log files location: $LOG_DIR"
    print_info "Telegram Direct Mode log: $LOG_DIR/telegram-direct.log"
    print_info "Smart Monitor log: $LOG_DIR/smart-monitor.log"
    print_info "Auto Approver log: $LOG_DIR/auto-approver.log"
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
    echo "  - Script will open new iTerm2 window with tmux session and Claude"
    echo "  - You can see Claude running in real-time in the new window"
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
            setup_tmux_session
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
            stop_tmux_session
            print_success "All services stopped"
            ;;
        "restart")
            stop_existing_processes
            check_environment
            setup_tmux_session
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