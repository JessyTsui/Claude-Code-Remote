#!/usr/bin/env node

const ControllerInjector = require('./src/utils/controller-injector');

async function testInjection() {
    console.log('🧪 测试命令注入功能');
    console.log('===================');
    
    const injector = new ControllerInjector();
    
    console.log(`当前模式: ${injector.mode}`);
    console.log(`默认session: ${injector.defaultSession}`);
    
    // 测试列出sessions
    console.log('\n📋 可用的sessions:');
    const sessions = injector.listSessions();
    sessions.forEach((session, index) => {
        console.log(`  ${index + 1}. ${session}`);
    });
    
    // 测试注入命令到claude-hook-test session
    console.log('\n🔧 测试注入命令到 claude-hook-test session...');
    const testCommand = 'echo "Command injection test successful at $(date)"';
    
    try {
        await injector.injectCommand(testCommand, 'claude-hook-test');
        console.log('✅ 命令注入成功！');
        console.log(`注入的命令: ${testCommand}`);
    } catch (error) {
        console.log('❌ 命令注入失败:', error.message);
    }
}

testInjection().catch(console.error); < /dev/null