#!/usr/bin/env node

const ControllerInjector = require('./src/utils/controller-injector');

async function testInjection() {
    console.log('Testing command injection');
    console.log('===================');

    const injector = new ControllerInjector();

    console.log(`Current mode: ${injector.mode}`);
    console.log(`Default session: ${injector.defaultSession}`);

    // List available sessions
    console.log('\nAvailable sessions:');
    const sessions = injector.listSessions();
    sessions.forEach((session, index) => {
        console.log(`  ${index + 1}. ${session}`);
    });

    // Test injecting command into claude-hook-test session
    console.log('\nTesting command injection into claude-hook-test session...');
    const testCommand = 'echo "Command injection test successful at $(date)"';

    try {
        await injector.injectCommand(testCommand, 'claude-hook-test');
        console.log('Command injection successful!');
        console.log(`Injected command: ${testCommand}`);
    } catch (error) {
        console.log('Command injection failed:', error.message);
    }
}

testInjection().catch(console.error); < /dev/null