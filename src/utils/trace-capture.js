/**
 * Trace Capture Utility
 * Tracks user input timestamps for smart execution trace capture
 */

const fs = require('fs');
const path = require('path');

class TraceCapture {
    constructor() {
        this.dataDir = path.join(__dirname, '../data');
        this.timestampFile = path.join(this.dataDir, 'user-input-timestamps.json');
        this._ensureDataDir();
    }

    _ensureDataDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Load timestamp data
     */
    _loadTimestamps() {
        try {
            if (fs.existsSync(this.timestampFile)) {
                const data = fs.readFileSync(this.timestampFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Failed to load timestamps:', error.message);
        }
        return {};
    }

    /**
     * Save timestamp data
     */
    _saveTimestamps(data) {
        try {
            fs.writeFileSync(this.timestampFile, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Failed to save timestamps:', error.message);
        }
    }

    /**
     * Record user input timestamp for a session
     * @param {string} sessionName - The tmux session name
     * @param {number} timestamp - Unix timestamp in milliseconds
     */
    recordUserInput(sessionName, timestamp = Date.now()) {
        const timestamps = this._loadTimestamps();
        
        if (!timestamps[sessionName]) {
            timestamps[sessionName] = {
                inputs: []
            };
        }
        
        timestamps[sessionName].inputs.push({
            timestamp: timestamp,
            date: new Date(timestamp).toISOString()
        });
        
        // Keep only last 10 inputs per session to avoid growing too large
        if (timestamps[sessionName].inputs.length > 10) {
            timestamps[sessionName].inputs = timestamps[sessionName].inputs.slice(-10);
        }
        
        this._saveTimestamps(timestamps);
    }

    /**
     * Get the most recent user input timestamp for a session
     * @param {string} sessionName - The tmux session name
     * @returns {number|null} - Unix timestamp or null if not found
     */
    getLastUserInputTime(sessionName) {
        const timestamps = this._loadTimestamps();
        
        if (timestamps[sessionName] && timestamps[sessionName].inputs.length > 0) {
            const lastInput = timestamps[sessionName].inputs[timestamps[sessionName].inputs.length - 1];
            return lastInput.timestamp;
        }
        
        return null;
    }

    /**
     * Clean up old session data (older than 7 days)
     */
    cleanup() {
        const timestamps = this._loadTimestamps();
        const now = Date.now();
        const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
        
        for (const sessionName in timestamps) {
            const session = timestamps[sessionName];
            
            // Remove old inputs
            session.inputs = session.inputs.filter(input => input.timestamp > sevenDaysAgo);
            
            // Remove session if no inputs remain
            if (session.inputs.length === 0) {
                delete timestamps[sessionName];
            }
        }
        
        this._saveTimestamps(timestamps);
    }
}

module.exports = TraceCapture;