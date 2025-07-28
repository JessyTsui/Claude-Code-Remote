#!/usr/bin/env node

/**
 * Multi-Platform Webhook Server
 * Starts all enabled webhook servers (Telegram, LINE) in parallel
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

console.log('🚀 Starting Claude Code Remote Multi-Platform Webhook Server...\n');

const processes = [];

// Start Telegram webhook if enabled
if (process.env.TELEGRAM_ENABLED === 'true' && process.env.TELEGRAM_BOT_TOKEN) {
    console.log('📱 Starting Telegram webhook server...');
    const telegramProcess = spawn('node', ['start-telegram-webhook.js'], {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: process.env
    });
    
    telegramProcess.on('exit', (code) => {
        console.log(`📱 Telegram webhook server exited with code ${code}`);
    });
    
    processes.push({ name: 'Telegram', process: telegramProcess });
}

// Start LINE webhook if enabled
if (process.env.LINE_ENABLED === 'true' && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.log('📱 Starting LINE webhook server...');
    const lineProcess = spawn('node', ['start-line-webhook.js'], {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: process.env
    });
    
    lineProcess.on('exit', (code) => {
        console.log(`📱 LINE webhook server exited with code ${code}`);
    });
    
    processes.push({ name: 'LINE', process: lineProcess });
}

// Start Email daemon if enabled
if (process.env.EMAIL_ENABLED === 'true' && process.env.SMTP_USER) {
    console.log('📧 Starting email daemon...');
    const emailProcess = spawn('node', ['claude-remote.js', 'daemon', 'start'], {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: process.env
    });
    
    emailProcess.on('exit', (code) => {
        console.log(`📧 Email daemon exited with code ${code}`);
    });
    
    processes.push({ name: 'Email', process: emailProcess });
}

if (processes.length === 0) {
    console.log('❌ No platforms enabled. Please configure at least one platform in .env file:');
    console.log('   - Set TELEGRAM_ENABLED=true and configure TELEGRAM_BOT_TOKEN');
    console.log('   - Set LINE_ENABLED=true and configure LINE_CHANNEL_ACCESS_TOKEN');
    console.log('   - Set EMAIL_ENABLED=true and configure SMTP_USER');
    process.exit(1);
}

console.log(`\n✅ Started ${processes.length} webhook server(s):`);
processes.forEach(p => {
    console.log(`   - ${p.name}`);
});

console.log('\n📋 Platform Command Formats:');
if (process.env.TELEGRAM_ENABLED === 'true') {
    console.log('   Telegram: /cmd TOKEN123 <command>');
}
if (process.env.LINE_ENABLED === 'true') {
    console.log('   LINE: Token TOKEN123 <command>');
}
if (process.env.EMAIL_ENABLED === 'true') {
    console.log('   Email: Reply to notification emails');
}

console.log('\n🔧 To stop all services, press Ctrl+C\n');

// Handle graceful shutdown
function shutdown() {
    console.log('\n🛑 Shutting down all webhook servers...');
    
    processes.forEach(p => {
        console.log(`   Stopping ${p.name}...`);
        p.process.kill('SIGTERM');
    });
    
    setTimeout(() => {
        console.log('✅ All services stopped');
        process.exit(0);
    }, 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the main process alive
process.stdin.resume();