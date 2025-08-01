/**
 * Subagent Activity Tracker
 * Tracks subagent activities for including in completion emails
 */

const fs = require('fs');
const path = require('path');

class SubagentTracker {
    constructor() {
        this.dataDir = path.join(__dirname, '../data');
        this.trackingFile = path.join(this.dataDir, 'subagent-activities.json');
        this._ensureDataDir();
    }

    _ensureDataDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Load existing activities
     */
    _loadActivities() {
        if (!fs.existsSync(this.trackingFile)) {
            return {};
        }
        try {
            return JSON.parse(fs.readFileSync(this.trackingFile, 'utf8'));
        } catch (error) {
            console.error('Failed to load subagent activities:', error);
            return {};
        }
    }

    /**
     * Save activities to file
     */
    _saveActivities(activities) {
        try {
            fs.writeFileSync(this.trackingFile, JSON.stringify(activities, null, 2));
        } catch (error) {
            console.error('Failed to save subagent activities:', error);
        }
    }

    /**
     * Add a subagent activity
     */
    addActivity(sessionId, activity) {
        const activities = this._loadActivities();
        
        if (!activities[sessionId]) {
            activities[sessionId] = {
                startTime: new Date().toISOString(),
                activities: []
            };
        }

        activities[sessionId].activities.push({
            timestamp: new Date().toISOString(),
            type: activity.type || 'subagent',
            description: activity.description || 'Subagent activity',
            details: activity.details || {}
        });

        this._saveActivities(activities);
    }

    /**
     * Get activities for a session
     */
    getActivities(sessionId) {
        const activities = this._loadActivities();
        return activities[sessionId] || null;
    }

    /**
     * Clear activities for a session
     */
    clearActivities(sessionId) {
        const activities = this._loadActivities();
        delete activities[sessionId];
        this._saveActivities(activities);
    }

    /**
     * Clean up old activities (older than 24 hours)
     */
    cleanupOldActivities() {
        const activities = this._loadActivities();
        const now = new Date();
        const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

        for (const sessionId in activities) {
            const startTime = new Date(activities[sessionId].startTime);
            if (startTime < oneDayAgo) {
                delete activities[sessionId];
            }
        }

        this._saveActivities(activities);
    }

    /**
     * Format activities for email
     */
    formatActivitiesForEmail(sessionId) {
        const sessionData = this.getActivities(sessionId);
        if (!sessionData || sessionData.activities.length === 0) {
            return '';
        }

        const activities = sessionData.activities;
        const grouped = {};

        // Group activities by type
        activities.forEach(activity => {
            const type = activity.type;
            if (!grouped[type]) {
                grouped[type] = [];
            }
            grouped[type].push(activity);
        });

        // Format as HTML
        let html = `
            <!-- Subagent Activities -->
            <div style="margin: 20px 0; padding: 15px; background-color: #1f1f1f; border: 1px solid #444; border-radius: 4px;">
                <div style="color: #ff9800; margin-bottom: 10px; font-weight: bold;">📊 Subagent Activities Summary</div>
                <div style="color: #ccc; font-size: 13px; line-height: 1.6;">`;
        
        for (const [type, items] of Object.entries(grouped)) {
            html += `<div style="margin-bottom: 10px;">`;
            html += `<div style="color: #00bcd4; font-weight: bold;">${type} (${items.length} activities)</div>`;
            html += `<ul style="margin: 5px 0 0 20px; padding: 0;">`;
            items.forEach((item, index) => {
                const time = new Date(item.timestamp).toLocaleTimeString();
                html += `<li style="color: #ccc; margin: 3px 0;">`;
                html += `<span style="color: #999;">[${time}]</span> ${item.description}`;
                if (item.details && item.details.claudeResponse) {
                    html += `<div style="color: #888; margin-left: 20px; font-size: 12px; margin-top: 2px;">`;
                    html += `${item.details.claudeResponse}`;
                    html += `</div>`;
                }
                html += `</li>`;
            });
            html += `</ul>`;
            html += `</div>`;
        }

        html += `
                </div>
            </div>`;

        // Also format as plain text for text email
        let text = '\n📊 Subagent Activities Summary\n\n';
        
        for (const [type, items] of Object.entries(grouped)) {
            text += `${type} (${items.length} activities)\n`;
            items.forEach((item, index) => {
                const time = new Date(item.timestamp).toLocaleTimeString();
                text += `  ${index + 1}. [${time}] ${item.description}\n`;
                if (item.details && item.details.claudeResponse) {
                    text += `     ${item.details.claudeResponse}\n`;
                }
            });
            text += '\n';
        }

        // Return HTML for email (the email sender will use it appropriately)
        return html;
    }
}

module.exports = SubagentTracker;