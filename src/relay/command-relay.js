/**
 * Command Relay Service
 * Manages email listening and command execution for Claude Code
 */

const EventEmitter = require('events');
const EmailListener = require('./email-listener');
const ClaudeCommandBridge = require('./claude-command-bridge');
const ClipboardAutomation = require('../automation/clipboard-automation');
const SimpleAutomation = require('../automation/simple-automation');
const ClaudeAutomation = require('../automation/claude-automation');
const Logger = require('../core/logger');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class CommandRelayService extends EventEmitter {
    constructor(config) {
        super();
        this.logger = new Logger('CommandRelay');
        this.config = config;
        this.emailListener = null;
        this.commandBridge = new ClaudeCommandBridge();
        this.clipboardAutomation = new ClipboardAutomation();
        this.simpleAutomation = new SimpleAutomation();
        this.claudeAutomation = new ClaudeAutomation();
        this.isRunning = false;
        this.commandQueue = [];
        this.processingQueue = false;
        this.stateFile = path.join(__dirname, '../data/relay-state.json');
        
        this._ensureDirectories();
        this._loadState();
    }

    _ensureDirectories() {
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }

    _loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
                this.commandQueue = state.commandQueue || [];
                this.logger.debug(`Loaded ${this.commandQueue.length} queued commands`);
            }
        } catch (error) {
            this.logger.warn('Failed to load relay state:', error.message);
            this.commandQueue = [];
        }
    }

    _saveState() {
        try {
            const state = {
                commandQueue: this.commandQueue,
                lastSaved: new Date().toISOString()
            };
            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
        } catch (error) {
            this.logger.error('Failed to save relay state:', error.message);
        }
    }

    async start() {
        if (this.isRunning) {
            this.logger.warn('Command relay service already running');
            return;
        }

        try {
            // Validate email configuration
            if (!this.config.imap) {
                throw new Error('IMAP configuration required for command relay');
            }

            // Start email listener
            this.emailListener = new EmailListener(this.config);
            
            // Listen for command events
            this.emailListener.on('command', (commandData) => {
                this._queueCommand(commandData);
            });

            // Start email listening
            await this.emailListener.start();
            
            // Start command processing
            this._startCommandProcessor();
            
            this.isRunning = true;
            this.logger.info('Command relay service started successfully');
            
            // Send startup notification
            this.emit('started');
            
        } catch (error) {
            this.logger.error('Failed to start command relay service:', error.message);
            throw error;
        }
    }

    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;

        // Stop email listener
        if (this.emailListener) {
            await this.emailListener.stop();
            this.emailListener = null;
        }

        // Save state
        this._saveState();

        this.logger.info('Command relay service stopped');
        this.emit('stopped');
    }

    _queueCommand(commandData) {
        const queueItem = {
            id: this._generateId(),
            ...commandData,
            queuedAt: new Date().toISOString(),
            status: 'queued',
            retries: 0,
            maxRetries: 3
        };

        this.commandQueue.push(queueItem);
        this._saveState();
        
        this.logger.info(`Command queued:`, {
            id: queueItem.id,
            sessionId: queueItem.sessionId,
            command: queueItem.command.substring(0, 50) + '...'
        });

        this.emit('commandQueued', queueItem);
    }

    _startCommandProcessor() {
        // Process queue immediately
        this._processCommandQueue();
        
        // Process queue periodically
        setInterval(() => {
            if (this.isRunning) {
                this._processCommandQueue();
            }
        }, 5000); // Check every 5 seconds
    }

    async _processCommandQueue() {
        if (this.processingQueue || this.commandQueue.length === 0) {
            return;
        }

        this.processingQueue = true;

        try {
            const pendingCommands = this.commandQueue.filter(cmd => cmd.status === 'queued');
            
            for (const command of pendingCommands) {
                try {
                    await this._executeCommand(command);
                } catch (error) {
                    this.logger.error(`Failed to execute command ${command.id}:`, error.message);
                    this._handleCommandError(command, error);
                }
            }
        } finally {
            this.processingQueue = false;
        }
    }

    async _executeCommand(commandItem) {
        this.logger.info(`Executing command ${commandItem.id}:`, {
            sessionId: commandItem.sessionId,
            command: commandItem.command.substring(0, 100)
        });

        commandItem.status = 'executing';
        commandItem.executedAt = new Date().toISOString();

        try {
            // Check if Claude Code process is running
            const claudeProcess = await this._findClaudeCodeProcess();
            
            if (!claudeProcess || !claudeProcess.available) {
                throw new Error('Claude Code not available');
            }

            // Execute command - try multiple methods
            const success = await this._sendCommandToClaudeCode(commandItem.command, claudeProcess, commandItem.sessionId);
            
            if (success) {
                commandItem.status = 'completed';
                commandItem.completedAt = new Date().toISOString();
                
                // Update session command count
                if (this.emailListener) {
                    await this.emailListener.updateSessionCommandCount(commandItem.sessionId);
                }
                
                this.logger.info(`Command ${commandItem.id} executed successfully`);
                this.emit('commandExecuted', commandItem);
            } else {
                throw new Error('Failed to send command to Claude Code');
            }

        } catch (error) {
            commandItem.status = 'failed';
            commandItem.error = error.message;
            commandItem.failedAt = new Date().toISOString();
            
            this.logger.error(`Command ${commandItem.id} failed:`, error.message);
            this.emit('commandFailed', commandItem, error);
            
            throw error;
        } finally {
            this._saveState();
        }
    }

    async _findClaudeCodeProcess() {
        // Always return available for tmux mode
        this.logger.debug('Using tmux mode - Claude Code assumed available');
        return { pid: null, available: true, tmuxMode: true };
    }

    async _sendCommandToClaudeCode(command, claudeProcess, sessionId) {
        return new Promise(async (resolve) => {
            try {
                // For tmux mode, use direct tmux injection first
                if (process.env.INJECTION_MODE === 'tmux') {
                    this.logger.info('Using direct tmux injection...');
                    const tmuxSuccess = await this._sendCommandViaTmux(command);
                    
                    if (tmuxSuccess) {
                        this.logger.info('Command sent successfully via tmux injection');
                        resolve(true);
                        return;
                    }
                }
                
                // Method 1: Claude Code dedicated automation (most direct and reliable)
                this.logger.info('Attempting to send command via Claude automation...');
                const claudeSuccess = await this.claudeAutomation.sendCommand(command, sessionId);
                
                if (claudeSuccess) {
                    this.logger.info('Command sent and executed successfully via Claude automation');
                    resolve(true);
                    return;
                }
                
                // Method 2: Clipboard automation (requires permissions)
                if (this.clipboardAutomation.isSupported()) {
                    this.logger.info('Attempting to send command via clipboard automation...');
                    const clipboardSuccess = await this.clipboardAutomation.sendCommand(command);
                    
                    if (clipboardSuccess) {
                        this.logger.info('Command sent successfully via clipboard automation');
                        resolve(true);
                        return;
                    }
                    this.logger.warn('Clipboard automation failed, trying other methods...');
                }
                
                // Method 3: Simple automation solution (includes multiple fallback options)
                this.logger.info('Attempting to send command via simple automation...');
                const simpleSuccess = await this.simpleAutomation.sendCommand(command, sessionId);
                
                if (simpleSuccess) {
                    this.logger.info('Command sent successfully via simple automation');
                    resolve(true);
                    return;
                }
                
                // Method 4: Use command bridge (file-based approach)
                this.logger.info('Attempting to send command via bridge...');
                const bridgeSuccess = await this.commandBridge.sendCommand(command, sessionId);
                
                if (bridgeSuccess) {
                    this.logger.info('Command sent successfully via bridge');
                    resolve(true);
                    return;
                }
                
                // Method 5: Send notification as final fallback
                this.logger.info('Using notification as final fallback...');
                this._sendCommandViaNotification(command)
                    .then((success) => {
                        this.logger.info('Command notification sent as fallback');
                        resolve(success);
                    })
                    .catch(() => resolve(false));
                
            } catch (error) {
                this.logger.error('Error sending command to Claude Code:', error.message);
                resolve(false);
            }
        });
    }

    async _sendCommandViaTmux(command) {
        return new Promise((resolve) => {
            try {
                const tmuxSession = process.env.TMUX_SESSION || 'claude-session';
                this.logger.info(`Injecting command into tmux session: ${tmuxSession}`);
                
                const tmuxProcess = spawn('tmux', ['send-keys', '-t', tmuxSession, command, 'Enter']);
                
                tmuxProcess.on('close', (code) => {
                    if (code === 0) {
                        this.logger.info('✅ Command injected successfully via tmux');
                        resolve(true);
                    } else {
                        this.logger.warn('❌ Tmux injection failed with code:', code);
                        resolve(false);
                    }
                });
                
                tmuxProcess.on('error', (error) => {
                    this.logger.error('❌ Tmux injection error:', error.message);
                    resolve(false);
                });
                
            } catch (error) {
                this.logger.error('❌ Tmux injection failed:', error.message);
                resolve(false);
            }
        });
    }

    async _sendCommandViaMacOS(command) {
        return new Promise((resolve, reject) => {
            // Use AppleScript automation to input to active window
            const escapedCommand = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
            const script = `
                tell application "System Events"
                    -- Get current active application
                    set activeApp to name of first application process whose frontmost is true
                    
                    -- Try to find Claude Code, Terminal or other development tools
                    set targetApps to {"Claude Code", "Terminal", "iTerm2", "iTerm", "Visual Studio Code", "Code"}
                    set foundApp to null
                    
                    repeat with appName in targetApps
                        try
                            if application process appName exists then
                                set foundApp to application process appName
                                exit repeat
                            end if
                        end try
                    end repeat
                    
                    if foundApp is not null then
                        -- Switch to target application
                        set frontmost of foundApp to true
                        delay 1
                        
                        -- Send command
                        keystroke "${escapedCommand}"
                        delay 0.3
                        keystroke return
                        
                        return "success"
                    else
                        -- If no specific application found, try current active window
                        keystroke "${escapedCommand}"
                        delay 0.3
                        keystroke return
                        return "fallback"
                    end if
                end tell
            `;

            const osascript = spawn('osascript', ['-e', script]);
            let output = '';
            let error = '';

            osascript.stdout.on('data', (data) => {
                output += data.toString().trim();
            });

            osascript.stderr.on('data', (data) => {
                error += data.toString();
            });

            osascript.on('close', (code) => {
                if (code === 0 && (output === 'success' || output === 'fallback')) {
                    this.logger.debug(`Command sent via macOS automation (${output})`);
                    resolve(true);
                } else {
                    this.logger.warn('AppleScript failed:', { code, output, error });
                    reject(new Error(`macOS automation failed: ${error || output}`));
                }
            });

            osascript.on('error', (error) => {
                reject(error);
            });
        });
    }

    async _sendCommandViaNotification(command) {
        // As fallback option, send desktop notification to remind user
        return new Promise((resolve) => {
            try {
                const commandPreview = command.length > 50 ? command.substring(0, 50) + '...' : command;
                
                if (process.platform === 'darwin') {
                    // macOS notification with more information
                    const script = `
                        display notification "Command: ${commandPreview.replace(/"/g, '\\"')}" with title "TaskPing - Email Command" subtitle "Click Terminal or Claude Code window, then paste command" sound name "default"
                    `;
                    const notification = spawn('osascript', ['-e', script]);
                    
                    notification.on('close', () => {
                        this.logger.info('macOS notification sent to user');
                        resolve(true);
                    });
                    
                    notification.on('error', () => {
                        resolve(false);
                    });
                } else {
                    // Linux notification
                    const notification = spawn('notify-send', [
                        'TaskPing - Email Command',
                        `Command: ${commandPreview}`
                    ]);
                    
                    notification.on('close', () => {
                        this.logger.info('Linux notification sent to user');
                        resolve(true);
                    });

                    notification.on('error', () => {
                        resolve(false);
                    });
                }

            } catch (error) {
                this.logger.warn('Failed to send notification:', error.message);
                resolve(false);
            }
        });
    }

    _handleCommandError(commandItem, error) {
        commandItem.retries = (commandItem.retries || 0) + 1;
        
        if (commandItem.retries < commandItem.maxRetries) {
            // Retry
            commandItem.status = 'queued';
            commandItem.retryAt = new Date(Date.now() + (commandItem.retries * 60000)).toISOString(); // Delayed retry
            this.logger.info(`Command ${commandItem.id} will be retried (attempt ${commandItem.retries + 1})`);
        } else {
            // Reached maximum retry count
            commandItem.status = 'failed';
            this.logger.error(`Command ${commandItem.id} failed after ${commandItem.retries} retries`);
        }
        
        this._saveState();
    }

    _generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            queueLength: this.commandQueue.length,
            processing: this.processingQueue,
            emailListener: this.emailListener ? {
                connected: this.emailListener.isConnected,
                listening: this.emailListener.isListening
            } : null,
            recentCommands: this.commandQueue.slice(-5).map(cmd => ({
                id: cmd.id,
                status: cmd.status,
                queuedAt: cmd.queuedAt,
                command: cmd.command.substring(0, 50) + '...'
            }))
        };
    }

    // Manually cleanup completed commands
    cleanupCompletedCommands() {
        const beforeCount = this.commandQueue.length;
        this.commandQueue = this.commandQueue.filter(cmd => 
            cmd.status !== 'completed' || 
            new Date(cmd.completedAt) > new Date(Date.now() - 24 * 60 * 60 * 1000) // Keep records within 24 hours
        );
        
        const removedCount = beforeCount - this.commandQueue.length;
        if (removedCount > 0) {
            this.logger.info(`Cleaned up ${removedCount} completed commands`);
            this._saveState();
        }
    }
}

module.exports = CommandRelayService;