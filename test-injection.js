#!/usr/bin/env node

/**
 * Test Command Injection
 * Direct test of the controller injector
 */

const ControllerInjector = require('./src/utils/controller-injector');

async function testInjection() {
    console.log('🧪 Testing command injection...\n');
    
    const injector = new ControllerInjector({
        mode: 'tmux',
        defaultSession: 'claude-real'
    });
    
    try {
        console.log('📤 Injecting test command: "echo Hello from Telegram injection"');
        await injector.injectCommand('echo "Hello from Telegram injection"', 'claude-real');
        console.log('✅ Command injection completed');
        
        console.log('\n🔍 Check your claude-real tmux session to see if the command was executed.');
        console.log('📋 You should see: Hello from Telegram injection');
        
    } catch (error) {
        console.error('❌ Injection failed:', error.message);
    }
}

testInjection();