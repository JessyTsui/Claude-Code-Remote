/**
 * Enhanced Command Injector
 * Injects commands and triggers completion notifications
 */

const { execSync } = require('child_process');
const path = require('path');

class EnhancedInjector {
    constructor() {
        this.projectDir = __dirname;
    }

    async injectCommandWithNotification(command, sessionName, chatId = null) {
        try {
            // 1. Inject the original command
            execSync(`tmux send-keys -t ${sessionName} '${command}' Enter`);
            console.log(`✅ Command injected: ${command}`);
            
            // 2. Wait a moment for command to start
            await this.sleep(2000);
            
            // 3. Inject a follow-up command to trigger notification
            const notificationCommand = `node ${this.projectDir}/claude-hook-notify.js completed`;
            
            // Create a compound command that waits for the original to finish
            const compoundCommand = `(${command}); ${notificationCommand}`;
            
            // Clear the previous command and send the compound one
            execSync(`tmux send-keys -t ${sessionName} C-c`); // Cancel if needed
            await this.sleep(500);
            execSync(`tmux send-keys -t ${sessionName} '${compoundCommand}' Enter`);
            
            console.log(`✅ Enhanced command with notification injected`);
            return true;
            
        } catch (error) {
            console.error(`❌ Enhanced injection failed:`, error.message);
            throw error;
        }
    }

    async injectWithCallback(command, sessionName) {
        try {
            // Create a wrapper script that executes command and triggers notification
            const wrapperCommand = `
                echo "🚀 Executing: ${command}";
                ${command};
                echo "✅ Command completed, triggering notification...";
                node ${this.projectDir}/claude-hook-notify.js completed;
            `;
            
            execSync(`tmux send-keys -t ${sessionName} '${wrapperCommand}' Enter`);
            console.log(`✅ Command with callback injected: ${command}`);
            return true;
            
        } catch (error) {
            console.error(`❌ Callback injection failed:`, error.message);
            throw error;
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = EnhancedInjector;