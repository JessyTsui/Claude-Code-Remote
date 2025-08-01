/**
 * Tmux Monitor - Enhanced for real-time monitoring with Telegram/LINE automation
 * Monitors tmux session output for Claude completion patterns
 * Based on the original email automation mechanism but adapted for real-time notifications
 */

const { execSync } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const TraceCapture = require('./trace-capture');

class TmuxMonitor extends EventEmitter {
    constructor(sessionName = null) {
        super();
        this.sessionName = sessionName || process.env.TMUX_SESSION || 'claude-real';
        this.captureDir = path.join(__dirname, '../data/tmux-captures');
        this.isMonitoring = false;
        this.monitorInterval = null;
        this.lastPaneContent = '';
        this.outputBuffer = [];
        this.maxBufferSize = 1000; // Keep last 1000 lines
        this.checkInterval = 2000; // Check every 2 seconds
        
        // Claude completion patterns (adapted for Claude Code's actual output format)
        this.completionPatterns = [
            // Task completion indicators
            /task.*completed/i,
            /successfully.*completed/i,
            /completed.*successfully/i,
            /implementation.*complete/i,
            /changes.*made/i,
            /created.*successfully/i,
            /updated.*successfully/i,
            /file.*created/i,
            /file.*updated/i,
            /finished/i,
            /done/i,
            /✅/,
            /All set/i,
            /Ready/i,
            
            // Claude Code specific patterns
            /The file.*has been updated/i,
            /File created successfully/i,
            /Command executed successfully/i,
            /Operation completed/i,
            
            // Look for prompt return (indicating Claude finished responding)
            /╰.*╯\s*$/,  // Box ending
            /^\s*>\s*$/  // Empty prompt ready for input
        ];
        
        // Waiting patterns (when Claude needs input)
        this.waitingPatterns = [
            /waiting.*for/i,
            /need.*input/i,
            /please.*provide/i,
            /what.*would you like/i,
            /how.*can I help/i,
            /⏳/,
            /What would you like me to/i,
            /Is there anything else/i,
            /Any other/i,
            /Do you want/i,
            /Would you like/i,
            
            // Claude Code specific waiting patterns
            /\? for shortcuts/i,  // Claude Code waiting indicator
            /╭.*─.*╮/,  // Start of response box
            />\s*$/     // Empty prompt
        ];
        
        this._ensureCaptureDir();
        this.traceCapture = new TraceCapture();
    }

    _ensureCaptureDir() {
        if (!fs.existsSync(this.captureDir)) {
            fs.mkdirSync(this.captureDir, { recursive: true });
        }
    }

    // Real-time monitoring methods (new functionality)
    start() {
        if (this.isMonitoring) {
            console.log('⚠️ TmuxMonitor already running');
            return;
        }

        // Verify tmux session exists
        if (!this._sessionExists()) {
            console.error(`❌ Tmux session '${this.sessionName}' not found`);
            throw new Error(`Tmux session '${this.sessionName}' not found`);
        }

        this.isMonitoring = true;
        this._startRealTimeMonitoring();
        console.log(`🔍 Started monitoring tmux session: ${this.sessionName}`);
    }

    stop() {
        if (!this.isMonitoring) {
            return;
        }

        this.isMonitoring = false;
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        console.log('⏹️ TmuxMonitor stopped');
    }

    _sessionExists() {
        try {
            const sessions = execSync('tmux list-sessions -F "#{session_name}"', { 
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim().split('\n');
            
            return sessions.includes(this.sessionName);
        } catch (error) {
            return false;
        }
    }

    _startRealTimeMonitoring() {
        // Initial capture
        this._captureCurrentContent();
        
        // Set up periodic monitoring
        this.monitorInterval = setInterval(() => {
            if (this.isMonitoring) {
                this._checkForChanges();
            }
        }, this.checkInterval);
    }

    _captureCurrentContent() {
        try {
            // Capture current pane content
            const content = execSync(`tmux capture-pane -t ${this.sessionName} -p`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            
            return content;
        } catch (error) {
            console.error('Error capturing tmux content:', error.message);
            return '';
        }
    }

    _checkForChanges() {
        const currentContent = this._captureCurrentContent();
        
        if (currentContent !== this.lastPaneContent) {
            // Get new content (lines that were added)
            const newLines = this._getNewLines(this.lastPaneContent, currentContent);
            
            if (newLines.length > 0) {
                // Add to buffer
                this.outputBuffer.push(...newLines);
                
                // Trim buffer if too large
                if (this.outputBuffer.length > this.maxBufferSize) {
                    this.outputBuffer = this.outputBuffer.slice(-this.maxBufferSize);
                }
                
                // Check for completion patterns
                this._analyzeNewContent(newLines);
            }
            
            this.lastPaneContent = currentContent;
        }
    }

    _getNewLines(oldContent, newContent) {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        
        // Find lines that were added
        const addedLines = [];
        
        // Simple approach: compare line by line from the end
        const oldLength = oldLines.length;
        const newLength = newLines.length;
        
        if (newLength > oldLength) {
            // New lines were added
            const numNewLines = newLength - oldLength;
            addedLines.push(...newLines.slice(-numNewLines));
        } else if (newLength === oldLength) {
            // Same number of lines, check if last lines changed
            for (let i = Math.max(0, newLength - 5); i < newLength; i++) {
                if (i < oldLength && newLines[i] !== oldLines[i]) {
                    addedLines.push(newLines[i]);
                }
            }
        }
        
        return addedLines.filter(line => line.trim().length > 0);
    }

    _analyzeNewContent(newLines) {
        const recentText = newLines.join('\n');
        
        // Also check the entire recent buffer for context
        const bufferText = this.outputBuffer.slice(-20).join('\n');
        
        console.log('🔍 Analyzing new content:', newLines.slice(0, 2).map(line => line.substring(0, 50))); // Debug log
        
        // Look for Claude response completion patterns
        const hasResponseEnd = this._detectResponseCompletion(recentText, bufferText);
        const hasTaskCompletion = this._detectTaskCompletion(recentText, bufferText);
        
        if (hasTaskCompletion || hasResponseEnd) {
            console.log('🎯 Task completion detected');
            this._handleTaskCompletion(newLines);
        }
        // Don't constantly trigger waiting notifications for static content
        else if (this._shouldTriggerWaitingNotification(recentText)) {
            console.log('⏳ New waiting state detected');
            this._handleWaitingForInput(newLines);
        }
    }
    
    _detectResponseCompletion(recentText, bufferText) {
        // Look for Claude response completion indicators
        const completionIndicators = [
            /The file.*has been updated/i,
            /File created successfully/i,
            /successfully/i,
            /completed/i,
            /✅/,
            /done/i
        ];
        
        // Claude Code specific pattern: ⏺ response followed by box
        const hasClaudeResponse = /⏺.*/.test(bufferText) || /⏺.*/.test(recentText);
        const hasBoxStart = /╭.*╮/.test(recentText);
        const hasBoxEnd = /╰.*╯/.test(recentText);
        
        // Look for the pattern: ⏺ response -> box -> empty prompt
        const isCompleteResponse = hasClaudeResponse && (hasBoxStart || hasBoxEnd);
        
        return completionIndicators.some(pattern => pattern.test(recentText)) ||
               isCompleteResponse;
    }
    
    _detectTaskCompletion(recentText, bufferText) {
        // Look for specific completion patterns
        return this.completionPatterns.some(pattern => pattern.test(recentText));
    }
    
    _shouldTriggerWaitingNotification(recentText) {
        // Only trigger waiting notification for new meaningful content
        // Avoid triggering on static "? for shortcuts" that doesn't change
        const meaningfulWaitingPatterns = [
            /waiting.*for/i,
            /need.*input/i,
            /please.*provide/i,
            /what.*would you like/i,
            /Do you want/i,
            /Would you like/i
        ];
        
        return meaningfulWaitingPatterns.some(pattern => pattern.test(recentText)) &&
               !recentText.includes('? for shortcuts'); // Ignore static shortcuts line
    }

    _handleTaskCompletion(newLines) {
        const conversation = this._extractRecentConversation();
        
        console.log('🎉 Claude task completion detected!');
        
        this.emit('taskCompleted', {
            type: 'completed',
            sessionName: this.sessionName,
            timestamp: new Date().toISOString(),
            newOutput: newLines,
            conversation: conversation,
            triggerText: newLines.join('\n')
        });
    }

    _handleWaitingForInput(newLines) {
        const conversation = this._extractRecentConversation();
        
        console.log('⏳ Claude waiting for input detected!');
        
        this.emit('waitingForInput', {
            type: 'waiting',
            sessionName: this.sessionName,
            timestamp: new Date().toISOString(),
            newOutput: newLines,
            conversation: conversation,
            triggerText: newLines.join('\n')
        });
    }

    _extractRecentConversation() {
        // Extract recent conversation from buffer
        const recentBuffer = this.outputBuffer.slice(-50); // Last 50 lines
        const text = recentBuffer.join('\n');
        
        // Try to identify user question and Claude response using Claude Code patterns
        let userQuestion = '';
        let claudeResponse = '';
        
        // Look for Claude Code specific patterns
        const lines = recentBuffer;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Look for user input (after > prompt)
            if (line.startsWith('> ') && line.length > 2) {
                userQuestion = line.substring(2).trim();
                continue;
            }
            
            // Look for Claude response (⏺ prefix)
            if (line.startsWith('⏺ ') && line.length > 2) {
                claudeResponse = line.substring(2).trim();
                break;
            }
        }
        
        // If we didn't find the specific format, use fallback
        if (!userQuestion || !claudeResponse) {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Skip system lines
                if (!line || line.startsWith('[') || line.startsWith('$') || 
                    line.startsWith('#') || line.includes('? for shortcuts') ||
                    line.match(/^[╭╰│─]+$/)) {
                    continue;
                }
                
                if (!userQuestion && line.length > 2) {
                    userQuestion = line;
                } else if (userQuestion && !claudeResponse && line.length > 5 && line !== userQuestion) {
                    claudeResponse = line;
                    break;
                }
            }
        }
        
        return {
            userQuestion: userQuestion || 'Recent command',
            claudeResponse: claudeResponse || 'Task completed',
            fullContext: text
        };
    }

    // Manual trigger methods for testing
    triggerCompletionTest() {
        this._handleTaskCompletion(['Test completion notification']);
    }

    triggerWaitingTest() {
        this._handleWaitingForInput(['Test waiting notification']);
    }

    // Original capture methods (legacy support)
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

    // Enhanced status method
    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            sessionName: this.sessionName,
            sessionExists: this._sessionExists(),
            bufferSize: this.outputBuffer.length,
            checkInterval: this.checkInterval,
            patterns: {
                completion: this.completionPatterns.length,
                waiting: this.waitingPatterns.length
            },
            lastCheck: new Date().toISOString()
        };
    }
}

module.exports = TmuxMonitor;