#!/usr/bin/env node

/**
 * Simple Test Hook
 * Just writes to a log file to verify hooks are working
 */

const fs = require('fs');
const path = require('path');

const logFile = '/Users/laihenyi/Documents/GitHub/claude-code-line/hook-test.log';
const timestamp = new Date().toISOString();
const logMessage = `${timestamp} - Hook triggered from: ${process.cwd()}\n`;

console.log('🔔 Test hook executed!');
console.log('Current directory:', process.cwd());
console.log('Script arguments:', process.argv);

// Write to log file
fs.appendFileSync(logFile, logMessage);

console.log('✅ Log written to:', logFile);