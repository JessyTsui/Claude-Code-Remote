/**
 * Controller Injector
 * Injects commands into tmux sessions or PTY
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Logger = require('../core/logger');

class ControllerInjector {
    constructor(config = {}) {
        this.logger = new Logger('ControllerInjector');
        this.mode = config.mode || process.env.INJECTION_MODE || 'pty';
        this.defaultSession = config.defaultSession || process.env.TMUX_SESSION || 'claude-code';
    }

    async injectCommand(command, sessionName = null) {
        const session = sessionName || this.defaultSession;
        
        if (this.mode === 'tmux') {
            return this._injectTmux(command, session);
        } else {
            return this._injectPty(command, session);
        }
    }

    _injectTmux(command, sessionName) {
        try {
            // Check if tmux session exists
            try {
                execSync(`tmux has-session -t ${sessionName}`, { stdio: 'ignore' });
            } catch (error) {
                throw new Error(`Tmux session '${sessionName}' not found`);
            }

            // Send command to tmux session and execute it
            const escapedCommand = command.replace(/'/g, "'\\''");
            
            // Send command first
            execSync(`tmux send-keys -t ${sessionName} '${escapedCommand}'`);
            // Then send Enter as separate command
            execSync(`tmux send-keys -t ${sessionName} Enter`);
            
            this.logger.info(`Command injected to tmux session '${sessionName}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to inject command via tmux:', error.message);
            throw error;
        }
    }

    _injectPty(command, sessionName) {
        try {
            // Find PTY session file
            const sessionMapPath = process.env.SESSION_MAP_PATH || 
                                   path.join(__dirname, '../data/session-map.json');
            
            if (!fs.existsSync(sessionMapPath)) {
                throw new Error('Session map file not found');
            }

            const sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
            const sessionInfo = sessionMap[sessionName];
            
            if (!sessionInfo || !sessionInfo.ptyPath) {
                throw new Error(`PTY session '${sessionName}' not found`);
            }

            // Write command to PTY
            fs.writeFileSync(sessionInfo.ptyPath, command + '\n');
            
            this.logger.info(`Command injected to PTY session '${sessionName}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to inject command via PTY:', error.message);
            throw error;
        }
    }

    listSessions() {
        if (this.mode === 'tmux') {
            try {
                const output = execSync('tmux list-sessions -F "#{session_name}"', { 
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                });
                return output.trim().split('\n').filter(Boolean);
            } catch (error) {
                return [];
            }
        } else {
            try {
                const sessionMapPath = process.env.SESSION_MAP_PATH || 
                                       path.join(__dirname, '../data/session-map.json');
                
                if (!fs.existsSync(sessionMapPath)) {
                    return [];
                }

                const sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
                return Object.keys(sessionMap);
            } catch (error) {
                return [];
            }
        }
    }
}

module.exports = ControllerInjector;