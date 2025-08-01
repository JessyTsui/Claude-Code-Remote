#!/usr/bin/env node

/**
 * Claude-Code-Remote - Claude Code Smart Notification System
 * Main entry point for the CLI tool
 */

// Load environment variables from Claude-Code-Remote directory
const path = require('path');
const envPath = path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

const Logger = require('./src/core/logger');
const Notifier = require('./src/core/notifier');
const ConfigManager = require('./src/core/config');

class ClaudeCodeRemoteCLI {
    constructor() {
        this.logger = new Logger('CLI');
        this.config = new ConfigManager();
        this.notifier = new Notifier(this.config);
    }

    async init() {
        // Load configuration
        this.config.load();
        
        // Initialize channels
        await this.notifier.initializeChannels();
    }

    async run() {
        const args = process.argv.slice(2);
        const command = args[0];

        try {
            await this.init();

            switch (command) {
                case 'notify':
                    await this.handleNotify(args.slice(1));
                    break;
                case 'test':
                    await this.handleTest(args.slice(1));
                    break;
                case 'status':
                    await this.handleStatus(args.slice(1));
                    break;
                case 'config':
                    await this.handleConfig(args.slice(1));
                    break;
                case 'install':
                    await this.handleInstall(args.slice(1));
                    break;
                case 'relay':
                    await this.handleRelay(args.slice(1));
                    break;
                case 'edit-config':
                    await this.handleEditConfig(args.slice(1));
                    break;
                case 'setup-email':
                    await this.handleSetupEmail(args.slice(1));
                    break;
                case 'daemon':
                    await this.handleDaemon(args.slice(1));
                    break;
                case 'commands':
                    await this.handleCommands(args.slice(1));
                    break;
                case 'test-paste':
                    await this.handleTestPaste(args.slice(1));
                    break;
                case 'test-simple':
                    await this.handleTestSimple(args.slice(1));
                    break;
                case 'test-claude':
                    await this.handleTestClaude(args.slice(1));
                    break;
                case 'setup-permissions':
                    await this.handleSetupPermissions(args.slice(1));
                    break;
                case 'diagnose':
                    await this.handleDiagnose(args.slice(1));
                    break;
                case '--help':
                case '-h':
                case undefined:
                    this.showHelp();
                    break;
                default:
                    console.error(`Unknown command: ${command}`);
                    this.showHelp();
                    process.exit(1);
            }
        } catch (error) {
            this.logger.error('CLI error:', error.message);
            process.exit(1);
        }
    }

    async handleNotify(args) {
        const typeIndex = args.findIndex(arg => arg === '--type');
        
        if (typeIndex === -1 || typeIndex + 1 >= args.length) {
            console.error('Usage: claude-remote notify --type <completed|waiting>');
            process.exit(1);
        }

        const type = args[typeIndex + 1];
        
        if (!['completed', 'waiting'].includes(type)) {
            console.error('Invalid type. Use: completed or waiting');
            process.exit(1);
        }

        // Automatically capture current tmux session conversation content
        const metadata = await this.captureCurrentConversation();
        
        const result = await this.notifier.notify(type, metadata);
        
        if (result.success) {
            this.logger.info(`${type} notification sent successfully`);
            process.exit(0);
        } else {
            this.logger.error(`Failed to send ${type} notification`);
            process.exit(1);
        }
    }

    async captureCurrentConversation() {
        try {
            const { execSync } = require('child_process');
            const TmuxMonitor = require('./src/utils/tmux-monitor');
            
            // Get current tmux session name
            let currentSession = null;
            try {
                currentSession = execSync('tmux display-message -p "#S"', { 
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                }).trim();
            } catch (e) {
                // Not running in tmux, return empty metadata
                return {};
            }
            
            if (!currentSession) {
                return {};
            }
            
            // Use TmuxMonitor to capture conversation
            const tmuxMonitor = new TmuxMonitor();
            const conversation = tmuxMonitor.getRecentConversation(currentSession);
            
            return {
                userQuestion: conversation.userQuestion,
                claudeResponse: conversation.claudeResponse,
                tmuxSession: currentSession
            };
        } catch (error) {
            this.logger.debug('Failed to capture conversation:', error.message);
            return {};
        }
    }

    async handleTest(args) {
        console.log('Testing notification channels...\n');
        
        const results = await this.notifier.test();
        
        for (const [channel, result] of Object.entries(results)) {
            const status = result.success ? '✅ PASS' : '❌ FAIL';
            console.log(`${channel}: ${status}`);
            if (result.error) {
                console.log(`   Error: ${result.error}`);
            }
        }
        
        const passCount = Object.values(results).filter(r => r.success).length;
        const totalCount = Object.keys(results).length;
        
        console.log(`\nTest completed: ${passCount}/${totalCount} channels passed`);
        
        if (passCount === 0) {
            process.exit(1);
        }
    }

    async handleStatus(args) {
        const status = this.notifier.getStatus();
        
        console.log('Claude-Code-Remote Status\n');
        console.log('Configuration:');
        console.log(`  Enabled: ${status.enabled ? 'Yes' : 'No'}`);
        console.log(`  Language: ${status.config.language}`);
        console.log(`  Sounds: ${status.config.sound.completed} / ${status.config.sound.waiting}`);
        
        console.log('\nChannels:');
        
        // Display all available channels, including disabled ones
        const allChannels = this.config._channels || {};
        const activeChannels = status.channels || {};
        
        // Merge all channel information
        const channelNames = new Set([
            ...Object.keys(allChannels),
            ...Object.keys(activeChannels)
        ]);
        
        for (const name of channelNames) {
            const channelConfig = allChannels[name] || {};
            const channelStatus = activeChannels[name];
            
            let enabled, configured, relay;
            
            if (channelStatus) {
                // Active channel, use actual status
                enabled = channelStatus.enabled ? '✅' : '❌';
                configured = channelStatus.configured ? '✅' : '❌';
                relay = channelStatus.supportsRelay ? '✅' : '❌';
            } else {
                // Inactive channel, use configuration status
                enabled = channelConfig.enabled ? '✅' : '❌';
                configured = this._isChannelConfigured(name, channelConfig) ? '✅' : '❌';
                relay = this._supportsRelay(name) ? '✅' : '❌';
            }
            
            console.log(`  ${name}:`);
            console.log(`    Enabled: ${enabled}`);
            console.log(`    Configured: ${configured}`);
            console.log(`    Supports Relay: ${relay}`);
        }
    }

    _isChannelConfigured(name, config) {
        switch (name) {
            case 'desktop':
                return true; // Desktop notifications don't need special configuration
            case 'email':
                return config.config && 
                       config.config.smtp && 
                       config.config.smtp.host && 
                       config.config.smtp.auth && 
                       config.config.smtp.auth.user &&
                       config.config.to;
            default:
                return false;
        }
    }

    _supportsRelay(name) {
        switch (name) {
            case 'email':
                return true;
            case 'desktop':
            default:
                return false;
        }
    }

    async handleConfig(args) {
        // Launch the configuration tool
        const ConfigTool = require('./src/tools/config-manager');
        const configTool = new ConfigTool(this.config);
        await configTool.run(args);
    }

    async handleInstall(args) {
        // Launch the installer
        const Installer = require('./src/tools/installer');
        const installer = new Installer(this.config);
        await installer.run(args);
    }

    async handleRelay(args) {
        const subcommand = args[0];
        
        switch (subcommand) {
            case 'start':
                await this.startRelay(args.slice(1));
                break;
            case 'stop':
                await this.stopRelay(args.slice(1));
                break;
            case 'status':
                await this.relayStatus(args.slice(1));
                break;
            case 'cleanup':
                await this.cleanupRelay(args.slice(1));
                break;
            default:
                console.error('Usage: claude-remote relay <start|stop|status|cleanup>');
                console.log('');
                console.log('Commands:');
                console.log('  start    Start email command relay service');
                console.log('  stop     Stop email command relay service');
                console.log('  status   View relay service status');
                console.log('  cleanup  Clean up completed command history');
                process.exit(1);
        }
    }

    async startRelay(args) {
        try {
            const CommandRelayService = require('./src/relay/command-relay');
            const emailConfig = this.config.getChannel('email');
            
            if (!emailConfig || !emailConfig.enabled) {
                console.error('❌ Email channel not configured or disabled');
                console.log('Please run first: claude-remote config');
                process.exit(1);
            }

            console.log('🚀 Starting email command relay service...');
            
            const relayService = new CommandRelayService(emailConfig.config);
            
            // Listen for events
            relayService.on('started', () => {
                console.log('✅ Command relay service started');
                console.log('📧 Listening for email replies...');
                console.log('💡 You can now remotely execute Claude Code commands by replying to emails');
                console.log('');
                console.log('Press Ctrl+C to stop the service');
            });

            relayService.on('commandQueued', (command) => {
                console.log(`📨 Received new command: ${command.command.substring(0, 50)}...`);
            });

            relayService.on('commandExecuted', (command) => {
                console.log(`✅ Command executed successfully: ${command.id}`);
            });

            relayService.on('commandFailed', (command, error) => {
                console.log(`❌ Command execution failed: ${command.id} - ${error.message}`);
            });

            // Handle graceful shutdown
            process.on('SIGINT', async () => {
                console.log('\n🛑 Stopping command relay service...');
                await relayService.stop();
                console.log('✅ Service stopped');
                process.exit(0);
            });

            // Start service
            await relayService.start();
            
            // Keep process running
            process.stdin.resume();
            
        } catch (error) {
            console.error('❌ Failed to start relay service:', error.message);
            process.exit(1);
        }
    }

    async stopRelay(args) {
        console.log('💡 Command relay service usually stopped with Ctrl+C');
        console.log('If the service is still running, please find the corresponding process and terminate it manually');
    }

    async relayStatus(args) {
        try {
            const fs = require('fs');
            const path = require('path');
            const stateFile = path.join(__dirname, 'src/data/relay-state.json');
            
            console.log('📊 Command relay service status\n');
            
            // Check email configuration
            const emailConfig = this.config.getChannel('email');
            if (!emailConfig || !emailConfig.enabled) {
                console.log('❌ Email channel not configured');
                return;
            }
            
            console.log('✅ Email configuration enabled');
            console.log(`📧 SMTP: ${emailConfig.config.smtp.host}:${emailConfig.config.smtp.port}`);
            console.log(`📥 IMAP: ${emailConfig.config.imap.host}:${emailConfig.config.imap.port}`);
            console.log(`📬 Recipient: ${emailConfig.config.to}`);
            
            // Check relay status
            if (fs.existsSync(stateFile)) {
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                console.log(`\n📋 Command queue: ${state.commandQueue?.length || 0} commands`);
                
                if (state.commandQueue && state.commandQueue.length > 0) {
                    console.log('\nRecent commands:');
                    state.commandQueue.slice(-5).forEach(cmd => {
                        const status = cmd.status === 'completed' ? '✅' : 
                                     cmd.status === 'failed' ? '❌' : 
                                     cmd.status === 'executing' ? '⏳' : '⏸️';
                        console.log(`  ${status} ${cmd.id}: ${cmd.command.substring(0, 50)}...`);
                    });
                }
            } else {
                console.log('\n📋 No command history found');
            }
            
        } catch (error) {
            console.error('❌ Failed to get status:', error.message);
        }
    }

    async cleanupRelay(args) {
        try {
            const fs = require('fs');
            const path = require('path');
            const stateFile = path.join(__dirname, 'src/data/relay-state.json');
            
            if (!fs.existsSync(stateFile)) {
                console.log('📋 No cleanup needed, no command history found');
                return;
            }
            
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            const beforeCount = state.commandQueue?.length || 0;
            
            // Clean up completed commands (keep those within 24 hours)
            const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
            state.commandQueue = (state.commandQueue || []).filter(cmd => 
                cmd.status !== 'completed' || 
                new Date(cmd.completedAt || cmd.queuedAt) > cutoff
            );
            
            const afterCount = state.commandQueue.length;
            const removedCount = beforeCount - afterCount;
            
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
            
            console.log(`🧹 Cleanup completed: removed ${removedCount} completed commands`);
            console.log(`📋 ${afterCount} commands remaining in queue`);
            
        } catch (error) {
            console.error('❌ Cleanup failed:', error.message);
        }
    }

    async handleEditConfig(args) {
        const { spawn } = require('child_process');
        const path = require('path');
        
        const configType = args[0];
        
        if (!configType) {
            console.log('Available configuration files:');
            console.log('  user      - User personal configuration (config/user.json)');
            console.log('  channels  - Notification channel configuration (config/channels.json)');
            console.log('  default   - Default configuration template (config/default.json)');
            console.log('');
            console.log('Usage: claude-remote edit-config <configuration-type>');
            console.log('Example: claude-remote edit-config channels');
            return;
        }

        const configFiles = {
            'user': path.join(__dirname, 'config/user.json'),
            'channels': path.join(__dirname, 'config/channels.json'),
            'default': path.join(__dirname, 'config/default.json')
        };

        const configFile = configFiles[configType];
        if (!configFile) {
            console.error('❌ Invalid configuration type:', configType);
            console.log('Available types: user, channels, default');
            return;
        }

        // Check if file exists
        const fs = require('fs');
        if (!fs.existsSync(configFile)) {
            console.error('❌ Configuration file does not exist:', configFile);
            return;
        }

        console.log(`📝 Opening configuration file: ${configFile}`);
        console.log('💡 Save and close the editor after editing to take effect');
        console.log('');

        // Determine the editor to use
        const editor = process.env.EDITOR || process.env.VISUAL || this._getDefaultEditor();
        
        try {
            const editorProcess = spawn(editor, [configFile], {
                stdio: 'inherit'
            });

            editorProcess.on('close', (code) => {
                if (code === 0) {
                    console.log('✅ Configuration file saved');
                    console.log('💡 Run "claude-remote status" to view updated configuration');
                } else {
                    console.log('❌ Editor exited abnormally');
                }
            });

            editorProcess.on('error', (error) => {
                console.error('❌ Unable to start editor:', error.message);
                console.log('');
                console.log('💡 You can manually edit the configuration file:');
                console.log(`   ${configFile}`);
            });

        } catch (error) {
            console.error('❌ Failed to start editor:', error.message);
            console.log('');
            console.log('💡 You can manually edit the configuration file:');
            console.log(`   ${configFile}`);
        }
    }

    _getDefaultEditor() {
        // Determine default editor based on platform
        if (process.platform === 'win32') {
            return 'notepad';
        } else if (process.platform === 'darwin') {
            return 'nano'; // Use nano on macOS as most users have it
        } else {
            return 'nano'; // Linux default to nano
        }
    }

    async handleSetupEmail(args) {
        const readline = require('readline');
        const fs = require('fs');
        const path = require('path');

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const question = (prompt) => {
            return new Promise((resolve) => {
                rl.question(prompt, resolve);
            });
        };

        try {
            console.log('🚀 Claude-Code-Remote Email Quick Setup Wizard\n');

            // Select email provider
            console.log('Please select your email provider:');
            console.log('1. Gmail');
            console.log('2. QQ Email');
            console.log('3. 163 Email');
            console.log('4. Outlook/Hotmail');
            console.log('5. Custom');

            const providerChoice = await question('\nPlease select (1-5): ');
            
            let smtpHost, smtpPort, imapHost, imapPort, secure;
            
            switch (providerChoice) {
                case '1':
                    smtpHost = 'smtp.gmail.com';
                    smtpPort = 587;
                    imapHost = 'imap.gmail.com';
                    imapPort = 993;
                    secure = false;
                    console.log('\n📧 Gmail Configuration');
                    console.log('💡 Need to enable two-factor authentication and generate app password first');
                    break;
                case '2':
                    smtpHost = 'smtp.qq.com';
                    smtpPort = 587;
                    imapHost = 'imap.qq.com';
                    imapPort = 993;
                    secure = false;
                    console.log('\n📧 QQ Email Configuration');
                    break;
                case '3':
                    smtpHost = 'smtp.163.com';
                    smtpPort = 587;
                    imapHost = 'imap.163.com';
                    imapPort = 993;
                    secure = false;
                    console.log('\n📧 163 Email Configuration');
                    break;
                case '4':
                    smtpHost = 'smtp.live.com';
                    smtpPort = 587;
                    imapHost = 'imap-mail.outlook.com';
                    imapPort = 993;
                    secure = false;
                    console.log('\n📧 Outlook Configuration');
                    break;
                case '5':
                    console.log('\n📧 Custom Configuration');
                    smtpHost = await question('SMTP Host: ');
                    smtpPort = parseInt(await question('SMTP Port (default 587): ') || '587');
                    imapHost = await question('IMAP Host: ');
                    imapPort = parseInt(await question('IMAP Port (default 993): ') || '993');
                    const secureInput = await question('Use SSL/TLS? (y/n): ');
                    secure = secureInput.toLowerCase() === 'y';
                    break;
                default:
                    console.log('❌ Invalid selection');
                    rl.close();
                    return;
            }

            // Get email account information
            console.log('\n📝 Please enter email account information:');
            const email = await question('Email address: ');
            const password = await question('Password/App password: ');
            
            // Build configuration
            const emailConfig = {
                type: "email",
                enabled: true,
                config: {
                    smtp: {
                        host: smtpHost,
                        port: smtpPort,
                        secure: secure,
                        auth: {
                            user: email,
                            pass: password
                        }
                    },
                    imap: {
                        host: imapHost,
                        port: imapPort,
                        secure: true,
                        auth: {
                            user: email,
                            pass: password
                        }
                    },
                    from: `Claude-Code-Remote <${email}>`,
                    to: email,
                    template: {
                        checkInterval: 30
                    }
                }
            };

            // Read existing configuration
            const channelsFile = path.join(__dirname, 'config/channels.json');
            let channels = {};
            
            if (fs.existsSync(channelsFile)) {
                channels = JSON.parse(fs.readFileSync(channelsFile, 'utf8'));
            }

            // Update email configuration
            channels.email = emailConfig;

            // Save configuration
            fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));

            console.log('\n✅ Email configuration saved!');
            console.log('\n🧪 You can now test email functionality:');
            console.log('  claude-remote test');
            console.log('\n🚀 Start command relay service:');
            console.log('  claude-remote relay start');

            // Ask if user wants to test immediately
            const testNow = await question('\nTest email sending now? (y/n): ');
            if (testNow.toLowerCase() === 'y') {
                rl.close();
                
                // Reload configuration and test
                await this.init();
                await this.handleTest([]);
            } else {
                rl.close();
            }

        } catch (error) {
            console.error('❌ Configuration failed:', error.message);
            rl.close();
        }
    }

    async handleDaemon(args) {
        const ClaudeCodeRemoteDaemon = require('./src/daemon/taskping-daemon');
        const daemon = new ClaudeCodeRemoteDaemon();
        
        const command = args[0];
        
        switch (command) {
            case 'start':
                await daemon.start();
                break;
            case 'stop':
                await daemon.stop();
                break;
            case 'restart':
                await daemon.restart();
                break;
            case 'status':
                daemon.showStatus();
                break;
            default:
                console.log('Usage: claude-remote daemon <start|stop|restart|status>');
                console.log('');
                console.log('Commands:');
                console.log('  start    Start background daemon process');
                console.log('  stop     Stop background daemon process');
                console.log('  restart  Restart background daemon process');
                console.log('  status   View daemon process status');
                break;
        }
    }

    async handleCommands(args) {
        const ClaudeCommandBridge = require('./src/relay/claude-command-bridge');
        const bridge = new ClaudeCommandBridge();
        
        const command = args[0];
        
        switch (command) {
            case 'list':
                const pending = bridge.getPendingCommands();
                console.log(`📋 Pending commands: ${pending.length}\n`);
                if (pending.length > 0) {
                    pending.forEach((cmd, index) => {
                        console.log(`${index + 1}. ${cmd.id}`);
                        console.log(`   Command: ${cmd.command}`);
                        console.log(`   Time: ${cmd.timestamp}`);
                        console.log(`   Session: ${cmd.sessionId}`);
                        console.log('');
                    });
                }
                break;
                
            case 'status':
                const status = bridge.getStatus();
                console.log('📊 Command bridge status\n');
                console.log(`Pending commands: ${status.pendingCommands}`);
                console.log(`Processed commands: ${status.processedCommands}`);
                console.log(`Commands directory: ${status.commandsDir}`);
                console.log(`Response directory: ${status.responseDir}`);
                if (status.recentCommands.length > 0) {
                    console.log('\nRecent commands:');
                    status.recentCommands.forEach(cmd => {
                        console.log(`  • ${cmd.command} (${cmd.timestamp})`);
                    });
                }
                break;
                
            case 'cleanup':
                bridge.cleanup();
                console.log('🧹 Old command files cleaned up');
                break;
                
            case 'clear':
                const pending2 = bridge.getPendingCommands();
                for (const cmd of pending2) {
                    bridge.markCommandProcessed(cmd.id, 'cancelled', 'Manually cancelled');
                }
                console.log(`🗑️ Cleared ${pending2.length} pending commands`);
                break;
                
            default:
                console.log('Usage: claude-remote commands <list|status|cleanup|clear>');
                console.log('');
                console.log('Commands:');
                console.log('  list     Show pending email commands');
                console.log('  status   Show command bridge status');
                console.log('  cleanup  Clean up old command files');
                console.log('  clear    Clear all pending commands');
                break;
        }
    }

    async handleTestPaste(args) {
        const ClipboardAutomation = require('./src/automation/clipboard-automation');
        const automation = new ClipboardAutomation();
        
        const testCommand = args.join(' ') || 'echo "Testing email reply auto-paste functionality"';
        
        console.log('🧪 Testing auto-paste functionality');
        console.log(`📝 Test command: ${testCommand}`);
        console.log('\n⚠️  Please ensure Claude Code or Terminal window is open and active');
        console.log('⏳ Command will be sent automatically in 3 seconds...\n');
        
        // Countdown
        for (let i = 3; i > 0; i--) {
            process.stdout.write(`${i}... `);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log('\n');
        
        try {
            const success = await automation.sendCommand(testCommand);
            if (success) {
                console.log('✅ Command has been auto-pasted!');
                console.log('💡 If you don\'t see the effect, please check app permissions and window status');
            } else {
                console.log('❌ Auto-paste failed');
                console.log('💡 Please ensure automation permissions are granted and target app is open');
            }
        } catch (error) {
            console.error('❌ Test failed:', error.message);
        }
    }

    async handleSetupPermissions(args) {
        const PermissionSetup = require('./setup-permissions');
        const setup = new PermissionSetup();
        await setup.checkAndSetup();
    }

    async handleTestSimple(args) {
        const SimpleAutomation = require('./src/automation/simple-automation');
        const automation = new SimpleAutomation();
        
        const testCommand = args.join(' ') || 'echo "Testing simple automation functionality"';
        
        console.log('🧪 Testing simple automation functionality');
        console.log(`📝 Test command: ${testCommand}`);
        console.log('\nThis test will:');
        console.log('1. 📋 Copy command to clipboard');
        console.log('2. 📄 Save command to file');
        console.log('3. 🔔 Send notification (including dialog box)');
        console.log('4. 🤖 Attempt auto-paste (if permissions granted)');
        console.log('\n⏳ Starting test...\n');
        
        try {
            const success = await automation.sendCommand(testCommand, 'test-session');
            if (success) {
                console.log('✅ Test successful!');
                console.log('\n📋 Next steps:');
                console.log('1. Check if you received notification');
                console.log('2. Check if command was copied to clipboard');
                console.log('3. If you see dialog box, you can choose to open command file');
                console.log('4. Manually paste to Claude Code (if auto-paste didn\'t work)');
                
                const status = automation.getStatus();
                console.log(`\n📄 Command file: ${status.commandFile}`);
                if (status.commandFileExists) {
                    console.log('💡 You can run "open -t ' + status.commandFile + '" to view command file');
                }
            } else {
                console.log('❌ Test failed');
            }
        } catch (error) {
            console.error('❌ Error occurred during test:', error.message);
        }
    }

    async handleTestClaude(args) {
        const ClaudeAutomation = require('./src/automation/claude-automation');
        const automation = new ClaudeAutomation();
        
        const testCommand = args.join(' ') || 'echo "This is an automated test command from email reply"';
        
        console.log('🤖 Testing Claude Code specialized automation');
        console.log(`📝 Test command: ${testCommand}`);
        console.log('\n⚠️  Please ensure:');
        console.log('   1. Claude Code application is open');
        console.log('   2. Or Terminal/iTerm2 etc. terminal applications are open');
        console.log('   3. Necessary accessibility permissions have been granted');
        console.log('\n⏳ Full automation test will start in 5 seconds...\n');
        
        // Countdown
        for (let i = 5; i > 0; i--) {
            process.stdout.write(`${i}... `);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log('\n🚀 Starting automation...\n');
        
        try {
            // Check permissions
            const hasPermission = await automation.requestPermissions();
            if (!hasPermission) {
                console.log('⚠️ Permission check failed, but will still attempt execution...');
            }
            
            // Execute full automation
            const success = await automation.sendCommand(testCommand, 'test-session');
            
            if (success) {
                console.log('✅ Full automation test successful!');
                console.log('💡 Command should have been automatically input to Claude Code and started execution');
                console.log('🔍 Please check Claude Code window to see if command was received');
            } else {
                console.log('❌ Automation test failed');
                console.log('💡 Possible reasons:');
                console.log('   • Claude Code or terminal application not found');
                console.log('   • Insufficient permissions');
                console.log('   • Application not responding');
                console.log('\n🔧 Suggestions:');
                console.log('   1. Run "claude-remote setup-permissions" to check permissions');
                console.log('   2. Ensure Claude Code is running in foreground');
                console.log('   3. Try manually clicking input box in Claude Code first');
            }
        } catch (error) {
            console.error('❌ Error occurred during test:', error.message);
        }
    }

    async handleDiagnose(args) {
        const AutomationDiagnostic = require('./diagnose-automation');
        const diagnostic = new AutomationDiagnostic();
        await diagnostic.runDiagnostic();
    }

    showHelp() {
        console.log(`
Claude-Code-Remote - Claude Code Smart Notification System

Usage: claude-remote <command> [options]

Commands:
  notify --type <type>    Send a notification (completed|waiting)
  test                    Test all notification channels
  status                  Show system status
  config                  Launch configuration manager
  setup-email             Quick email setup wizard
  edit-config <type>      Edit configuration files directly
  install                 Install and configure Claude Code hooks
  relay <subcommand>      Manage email command relay service
  daemon <subcommand>     Manage background daemon service
  commands <subcommand>   Manage email commands and bridge
  test-paste [command]    Test automatic paste functionality
  test-simple [command]   Test simple automation (recommended)
  test-claude [command]   Test Claude Code full automation
  setup-permissions       Setup macOS permissions for automation
  diagnose                Diagnose automation issues
  
Options:
  -h, --help             Show this help message

Relay Subcommands:
  relay start            Start email command relay service
  relay stop             Stop email command relay service  
  relay status           Show relay service status
  relay cleanup          Clean up completed command history

Daemon Subcommands:
  daemon start           Start background daemon service
  daemon stop            Stop background daemon service
  daemon restart         Restart background daemon service
  daemon status          Show daemon service status

Commands Subcommands:
  commands list          Show pending email commands
  commands status        Show command bridge status
  commands cleanup       Clean up old command files
  commands clear         Clear all pending commands

Examples:
  claude-remote notify --type completed
  claude-remote test
  claude-remote setup-email             # Quick email setup (recommended)
  claude-remote edit-config channels    # Edit configuration files directly
  claude-remote config                  # Interactive configuration
  claude-remote install
  claude-remote daemon start              # Start background service (recommended)
  claude-remote daemon status             # View service status  
  claude-remote test-claude               # Test full automation (recommended)
  claude-remote commands list             # View pending email commands
  claude-remote relay start               # Run in foreground (need to keep window open)

For more information, visit: https://github.com/Claude-Code-Remote/Claude-Code-Remote
        `);
    }
}

// Run CLI if this file is executed directly
if (require.main === module) {
    const cli = new ClaudeCodeRemoteCLI();
    cli.run().catch(error => {
        console.error('Fatal error:', error.message);
        process.exit(1);
    });
}

module.exports = ClaudeCodeRemoteCLI;