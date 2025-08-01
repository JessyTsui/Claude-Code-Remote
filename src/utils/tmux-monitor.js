/**
 * Tmux Session Monitor
 * Captures input/output from tmux sessions for email notifications
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class TmuxMonitor {
    constructor() {
        this.captureDir = path.join(__dirname, '../data/tmux-captures');
        this._ensureCaptureDir();
    }

    _ensureCaptureDir() {
        if (!fs.existsSync(this.captureDir)) {
            fs.mkdirSync(this.captureDir, { recursive: true });
        }
    }

    /**
     * Start capturing a tmux session
     * @param {string} sessionName - The tmux session name
     */
    startCapture(sessionName) {
        try {
            const captureFile = path.join(this.captureDir, `${sessionName}.log`);
            
            // Start pipe-pane to capture all session output
            execSync(`tmux pipe-pane -t ${sessionName} -o "cat >> ${captureFile}"`, { 
                encoding: 'utf8',
                stdio: 'ignore' 
            });
            
            return captureFile;
        } catch (error) {
            console.error(`Failed to start capture for session ${sessionName}:`, error.message);
            return null;
        }
    }

    /**
     * Stop capturing a tmux session
     * @param {string} sessionName - The tmux session name
     */
    stopCapture(sessionName) {
        try {
            execSync(`tmux pipe-pane -t ${sessionName}`, { 
                encoding: 'utf8',
                stdio: 'ignore' 
            });
        } catch (error) {
            console.error(`Failed to stop capture for session ${sessionName}:`, error.message);
        }
    }

    /**
     * Get recent conversation from a tmux session
     * @param {string} sessionName - The tmux session name
     * @param {number} lines - Number of lines to retrieve
     * @returns {Object} - { userQuestion, claudeResponse }
     */
    getRecentConversation(sessionName, lines = 200) {
        try {
            const captureFile = path.join(this.captureDir, `${sessionName}.log`);
            
            if (!fs.existsSync(captureFile)) {
                // If no capture file, try to get from tmux buffer
                return this.getFromTmuxBuffer(sessionName, lines);
            }

            // Read the capture file
            const content = fs.readFileSync(captureFile, 'utf8');
            const allLines = content.split('\n');
            const recentLines = allLines.slice(-lines);

            return this.extractConversation(recentLines.join('\n'));
        } catch (error) {
            console.error(`Failed to get conversation for session ${sessionName}:`, error.message);
            return { userQuestion: '', claudeResponse: '' };
        }
    }

    /**
     * Get conversation from tmux buffer
     * @param {string} sessionName - The tmux session name
     * @param {number} lines - Number of lines to retrieve
     */
    getFromTmuxBuffer(sessionName, lines = 200) {
        try {
            // Capture the pane contents
            const buffer = execSync(`tmux capture-pane -t ${sessionName} -p -S -${lines}`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });

            return this.extractConversation(buffer);
        } catch (error) {
            console.error(`Failed to get tmux buffer for session ${sessionName}:`, error.message);
            return { userQuestion: '', claudeResponse: '' };
        }
    }

    /**
     * Extract user question and Claude response from captured text
     * @param {string} text - The captured text
     * @returns {Object} - { userQuestion, claudeResponse }
     */
    extractConversation(text) {
        const lines = text.split('\n');
        
        let userQuestion = '';
        let claudeResponse = '';
        let responseLines = [];
        let inResponse = false;

        // Find the most recent user question and Claude response
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Detect user input (line starting with "> " followed by content)
            if (line.startsWith('> ') && line.length > 2) {
                userQuestion = line.substring(2).trim();
                inResponse = false; // Reset response capture
                responseLines = []; // Clear previous response
                continue;
            }
            
            // Detect Claude response (line starting with "⏺ " or other response indicators)
            if (line.startsWith('⏺ ') || 
                (inResponse && line.length > 0 && 
                 !line.startsWith('╭') && !line.startsWith('│') && !line.startsWith('╰') &&
                 !line.startsWith('> ') && !line.includes('? for shortcuts'))) {
                
                if (line.startsWith('⏺ ')) {
                    inResponse = true;
                    responseLines = [line.substring(2).trim()]; // Remove "⏺ " prefix
                } else if (inResponse) {
                    responseLines.push(line);
                }
            }
            
            // Stop capturing response when we hit another prompt or box boundary
            if (inResponse && (line.startsWith('╭') || line.startsWith('│ > ') || line.includes('? for shortcuts'))) {
                inResponse = false;
            }
        }

        // Join response lines and clean up
        claudeResponse = responseLines.join('\n').trim();
        
        // Remove box characters but preserve formatting
        claudeResponse = claudeResponse
            .replace(/[╭╰│]/g, '')
            .replace(/^\s*│\s*/gm, '')
            // Don't collapse multiple spaces - preserve code formatting
            // .replace(/\s+/g, ' ')
            .trim();

        // Don't limit response length - we want the full response
        // if (claudeResponse.length > 500) {
        //     claudeResponse = claudeResponse.substring(0, 497) + '...';
        // }

        // If we didn't find a question in the standard format, look for any recent text input
        if (!userQuestion) {
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (line.startsWith('> ') && line.length > 2) {
                    userQuestion = line.substring(2).trim();
                    break;
                }
            }
        }

        return { 
            userQuestion: userQuestion || 'No user input',
            claudeResponse: claudeResponse || 'No Claude response'
        };
    }

    /**
     * Clean up old capture files
     * @param {number} daysToKeep - Number of days to keep capture files
     */
    cleanupOldCaptures(daysToKeep = 7) {
        try {
            const files = fs.readdirSync(this.captureDir);
            const now = Date.now();
            const maxAge = daysToKeep * 24 * 60 * 60 * 1000;

            files.forEach(file => {
                const filePath = path.join(this.captureDir, file);
                const stats = fs.statSync(filePath);
                
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`Cleaned up old capture file: ${file}`);
                }
            });
        } catch (error) {
            console.error('Failed to cleanup captures:', error.message);
        }
    }
}

module.exports = TmuxMonitor;