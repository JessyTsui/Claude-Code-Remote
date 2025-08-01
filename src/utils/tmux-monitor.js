/**
 * Tmux Session Monitor
 * Captures input/output from tmux sessions for email notifications
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const TraceCapture = require('./trace-capture');

class TmuxMonitor {
    constructor() {
        this.captureDir = path.join(__dirname, '../data/tmux-captures');
        this._ensureCaptureDir();
        this.traceCapture = new TraceCapture();
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

            return this.extractConversation(recentLines.join('\n'), sessionName);
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

            return this.extractConversation(buffer, sessionName);
        } catch (error) {
            console.error(`Failed to get tmux buffer for session ${sessionName}:`, error.message);
            return { userQuestion: '', claudeResponse: '' };
        }
    }

    /**
     * Get full execution trace from tmux session
     * @param {string} sessionName - The tmux session name
     * @param {number} lines - Number of lines to retrieve
     * @returns {string} - Full execution trace
     */
    getFullExecutionTrace(sessionName, lines = 1000) {
        try {
            let content;
            if (!fs.existsSync(path.join(this.captureDir, `${sessionName}.log`))) {
                // If no capture file, try to get from tmux buffer
                content = this.getFullTraceFromTmuxBuffer(sessionName, lines);
            } else {
                // Read the capture file
                content = fs.readFileSync(path.join(this.captureDir, `${sessionName}.log`), 'utf8');
            }
            
            // Always filter content to only show from last user input
            content = this._filterByTimestamp(content);
            
            // Clean up the trace by removing the command prompt box
            return this._cleanExecutionTrace(content);
        } catch (error) {
            console.error(`Failed to get full trace for session ${sessionName}:`, error.message);
            return '';
        }
    }
    
    /**
     * Filter content to only include lines after the last user input
     * @param {string} content - The full content
     * @param {number} timestamp - Unix timestamp in milliseconds (not used in current implementation)
     * @returns {string} - Filtered content
     */
    _filterByTimestamp(content, timestamp) {
        const lines = content.split('\n');
        let lastUserInputIndex = -1;
        
        // Find the LAST occurrence of user input (line starting with "> ")
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            // Check for user input pattern: "> " at the start of the line
            if (line.startsWith('> ') && line.length > 2) {
                lastUserInputIndex = i;
                break;
            }
        }
        
        // If we found user input, return everything from that point
        if (lastUserInputIndex >= 0) {
            return lines.slice(lastUserInputIndex).join('\n');
        }
        
        // If no user input found, return last 100 lines as fallback
        return lines.slice(-100).join('\n');
    }
    
    /**
     * Clean execution trace by removing command prompt and status line
     * Also removes the complete user input and final Claude response
     * @param {string} trace - Raw execution trace
     * @returns {string} - Cleaned trace
     */
    _cleanExecutionTrace(trace) {
        const lines = trace.split('\n');
        const cleanedLines = [];
        let inUserInput = false;
        let skipNextEmptyLine = false;
        let lastClaudeResponseStart = -1;
        
        // Find where the last Claude response starts
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].startsWith('⏺ ')) {
                lastClaudeResponseStart = i;
                break;
            }
        }
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Skip everything from the last Claude response onward
            if (lastClaudeResponseStart !== -1 && i >= lastClaudeResponseStart) {
                // But we want to show everything BEFORE the last response
                break;
            }
            
            // Start of user input
            if (line.startsWith('> ')) {
                inUserInput = true;
                skipNextEmptyLine = true;
                continue;
            }
            
            // Still in user input (continuation lines)
            if (inUserInput) {
                // Check if we've reached the end of user input
                if (line.trim() === '' || line.startsWith('⏺')) {
                    inUserInput = false;
                    if (skipNextEmptyLine && line.trim() === '') {
                        skipNextEmptyLine = false;
                        continue;
                    }
                } else {
                    continue; // Skip user input continuation lines
                }
            }
            
            // Check if we've hit the command prompt box
            if (line.includes('╭─') && line.includes('─╮')) {
                break;
            }
            
            // Skip empty command prompt lines
            if (line.match(/^│\s*>\s*│$/)) {
                break;
            }
            
            cleanedLines.push(line);
        }
        
        // Remove empty lines at the beginning and end
        while (cleanedLines.length > 0 && cleanedLines[0].trim() === '') {
            cleanedLines.shift();
        }
        while (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1].trim() === '') {
            cleanedLines.pop();
        }
        
        return cleanedLines.join('\n');
    }

    /**
     * Get full trace from tmux buffer
     * @param {string} sessionName - The tmux session name
     * @param {number} lines - Number of lines to retrieve
     */
    getFullTraceFromTmuxBuffer(sessionName, lines = 1000) {
        try {
            // Capture the pane contents
            const buffer = execSync(`tmux capture-pane -t ${sessionName} -p -S -${lines}`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });

            return buffer;
        } catch (error) {
            console.error(`Failed to get tmux buffer for session ${sessionName}:`, error.message);
            return '';
        }
    }

    /**
     * Extract user question and Claude response from captured text
     * @param {string} text - The captured text
     * @param {string} sessionName - The tmux session name (optional)
     * @returns {Object} - { userQuestion, claudeResponse }
     */
    extractConversation(text, sessionName = null) {
        const lines = text.split('\n');
        
        let userQuestion = '';
        let claudeResponse = '';
        let responseLines = [];
        let inResponse = false;

        // Find the most recent user question and Claude response
        let inUserInput = false;
        let userQuestionLines = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Detect user input (line starting with "> " followed by content)
            if (line.startsWith('> ') && line.length > 2) {
                userQuestionLines = [line.substring(2).trim()];
                inUserInput = true;
                inResponse = false; // Reset response capture
                responseLines = []; // Clear previous response
                
                // Record user input timestamp if session name provided
                if (sessionName) {
                    this.traceCapture.recordUserInput(sessionName);
                }
                
                continue;
            }
            
            // Continue capturing multi-line user input
            if (inUserInput && !line.startsWith('⏺') && line.length > 0) {
                userQuestionLines.push(line);
                continue;
            }
            
            // End of user input
            if (inUserInput && (line.startsWith('⏺') || line.length === 0)) {
                inUserInput = false;
                userQuestion = userQuestionLines.join(' ');
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