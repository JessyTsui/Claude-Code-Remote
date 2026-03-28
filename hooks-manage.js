#!/usr/bin/env node

/**
 * Manage Claude Code hooks for Claude-Code-Remote.
 *
 * Usage:
 *   node hooks-manage.js install    — Add Stop/SubagentStop hooks to ~/.claude/settings.json
 *   node hooks-manage.js uninstall  — Remove them
 *   node hooks-manage.js status     — Show current hook state
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const hookScript = path.join(__dirname, 'claude-hook-notify.js');
const HOOK_MARKER = 'claude-hook-notify';
const TIMEOUT = 15;

function loadSettings() {
    if (!fs.existsSync(settingsPath)) return {};
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function saveSettings(settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function hasHook(list) {
    return Array.isArray(list) && list.some(e =>
        Array.isArray(e.hooks) && e.hooks.some(h => h.command?.includes(HOOK_MARKER))
    );
}

function removeHook(list) {
    if (!Array.isArray(list)) return list;
    const filtered = list
        .map(entry => {
            if (!Array.isArray(entry.hooks)) return entry;
            const remaining = entry.hooks.filter(h => !h.command?.includes(HOOK_MARKER));
            return remaining.length > 0 ? { ...entry, hooks: remaining } : null;
        })
        .filter(Boolean);
    return filtered.length > 0 ? filtered : undefined;
}

// ─── Commands ────────────────────────────────────────────────────

function install() {
    const settings = loadSettings();
    settings.hooks = settings.hooks || {};
    settings.hooks.SessionStart = settings.hooks.SessionStart || [];
    settings.hooks.Stop = settings.hooks.Stop || [];
    settings.hooks.SubagentStop = settings.hooks.SubagentStop || [];

    let changed = false;

    if (!hasHook(settings.hooks.SessionStart)) {
        settings.hooks.SessionStart.push({
            matcher: '*',
            hooks: [{ type: 'command', command: `node ${hookScript} session_start`, timeout: TIMEOUT }]
        });
        changed = true;
    }

    if (!hasHook(settings.hooks.Stop)) {
        settings.hooks.Stop.push({
            matcher: '*',
            hooks: [{ type: 'command', command: `node ${hookScript} completed`, timeout: TIMEOUT }]
        });
        changed = true;
    }

    if (!hasHook(settings.hooks.SubagentStop)) {
        settings.hooks.SubagentStop.push({
            matcher: '*',
            hooks: [{ type: 'command', command: `node ${hookScript} waiting`, timeout: TIMEOUT }]
        });
        changed = true;
    }

    if (changed) {
        saveSettings(settings);
        console.log('Hooks installed in', settingsPath);
        console.log('  SessionStart →', `node ${hookScript} session_start`);
        console.log('  Stop         →', `node ${hookScript} completed`);
        console.log('  SubagentStop →', `node ${hookScript} waiting`);
    } else {
        console.log('Hooks already installed.');
    }
}

function uninstall() {
    const settings = loadSettings();
    if (!settings.hooks) {
        console.log('No hooks found.');
        return;
    }

    let changed = false;

    if (hasHook(settings.hooks.Stop)) {
        settings.hooks.Stop = removeHook(settings.hooks.Stop);
        if (!settings.hooks.Stop) delete settings.hooks.Stop;
        changed = true;
    }

    if (hasHook(settings.hooks.SessionStart)) {
        settings.hooks.SessionStart = removeHook(settings.hooks.SessionStart);
        if (!settings.hooks.SessionStart) delete settings.hooks.SessionStart;
        changed = true;
    }

    if (hasHook(settings.hooks.SubagentStop)) {
        settings.hooks.SubagentStop = removeHook(settings.hooks.SubagentStop);
        if (!settings.hooks.SubagentStop) delete settings.hooks.SubagentStop;
        changed = true;
    }

    if (changed) {
        saveSettings(settings);
        console.log('Hooks removed from', settingsPath);
    } else {
        console.log('No Claude-Code-Remote hooks found to remove.');
    }
}

function status() {
    const settings = loadSettings();
    const sessionStartInstalled = hasHook(settings.hooks?.SessionStart);
    const stopInstalled = hasHook(settings.hooks?.Stop);
    const subagentInstalled = hasHook(settings.hooks?.SubagentStop);

    console.log('Claude-Code-Remote hooks status:');
    console.log(`  SessionStart  ${sessionStartInstalled ? '✓ installed' : '✗ not installed'}`);
    console.log(`  Stop          ${stopInstalled ? '✓ installed' : '✗ not installed'}`);
    console.log(`  SubagentStop  ${subagentInstalled ? '✓ installed' : '✗ not installed'}`);
    console.log(`  Settings file: ${settingsPath}`);
}

// ─── CLI ─────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
    case 'install':   install();   break;
    case 'uninstall': uninstall(); break;
    case 'status':    status();    break;
    default:
        console.log('Usage: node hooks-manage.js [install|uninstall|status]');
        console.log('  or:  npm run hooks:install / hooks:uninstall / hooks:status');
        process.exit(1);
}
