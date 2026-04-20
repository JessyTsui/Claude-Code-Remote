#!/usr/bin/env node

/**
 * Manage CLI hooks for Claude-Code-Remote.
 *
 * Each adapter is isolated — installing/uninstalling one CLI's hooks never
 * touches another CLI's config file. You must name the CLI you want to manage
 * (or pass `all` to target every registered adapter).
 *
 * Usage:
 *   node hooks-manage.js install <claude|codex|all>
 *   node hooks-manage.js uninstall <claude|codex|all>
 *   node hooks-manage.js status [claude|codex|all]
 */

const { getCliAdapter, listAdapters, adapterNames } = require('./src/cli');

function resolveTargets(name) {
    if (!name || name === 'all') return listAdapters();
    const adapter = getCliAdapter(name);
    if (!adapter || adapter.type !== name.toLowerCase()) {
        console.error(`Unknown CLI: "${name}". Available: ${adapterNames().join(', ')}, or "all".`);
        process.exit(1);
    }
    return [adapter];
}

function printInstall(adapter, result) {
    if (result.changed) {
        console.log(`[${adapter.type}] hooks installed in ${result.path}`);
        if (result.commands) {
            for (const [event, cmd] of Object.entries(result.commands)) {
                console.log(`  ${event.padEnd(13)} → ${cmd}`);
            }
        }
        if (result.command) {
            console.log(`  Stop          → ${result.command}`);
        }
        if (result.notifyLine) {
            console.log(`  ${result.notifyLine}`);
        }
    } else {
        console.log(`[${adapter.type}] hooks already installed in ${result.path}`);
    }
    if (result.warning) console.log(`[${adapter.type}] warning: ${result.warning}`);
}

function install(targets) {
    let anyChanged = false;
    for (const adapter of targets) {
        const result = adapter.installHooks();
        if (result.changed) anyChanged = true;
        printInstall(adapter, result);
    }
    if (!anyChanged) console.log('Nothing to do.');
}

function uninstall(targets) {
    let anyChanged = false;
    for (const adapter of targets) {
        const result = adapter.uninstallHooks();
        if (result.changed) {
            anyChanged = true;
            console.log(`[${adapter.type}] hooks removed from ${result.path}`);
        } else {
            console.log(`[${adapter.type}] no hooks found at ${result.path}`);
        }
    }
    if (!anyChanged) console.log('Nothing to remove.');
}

function status(targets) {
    for (const adapter of targets) {
        const s = adapter.hooksStatus();
        console.log(`[${adapter.type}] hooks status:`);
        for (const [event, installed] of Object.entries(s.installed || {})) {
            console.log(`  ${event.padEnd(13)} ${installed ? '✓ installed' : '✗ not installed'}`);
        }
        console.log(`  Settings file: ${s.path}`);
        if (s.line) console.log(`  Line:          ${s.line}`);
        if (s.featureEnabled === false) {
            console.log(`  ⚠ codex_hooks feature NOT enabled in config.toml — hooks will be ignored`);
        }
    }
}

function usage() {
    const names = adapterNames().join('|');
    console.log(`Usage: node hooks-manage.js <install|uninstall|status> <${names}|all>`);
    console.log(`  or:  npm run hooks:install <${names}|all>`);
    console.log('');
    console.log('Each CLI is managed independently — installing codex hooks does NOT touch claude config, and vice versa.');
    process.exit(1);
}

const [, , command, target] = process.argv;

if (!command) usage();

// status defaults to "all" when no target given; install/uninstall require explicit target.
const requiresTarget = command === 'install' || command === 'uninstall';
if (requiresTarget && !target) {
    console.error(`"${command}" requires a CLI name so you don't accidentally edit another CLI's config.`);
    usage();
}

const targets = resolveTargets(target || 'all');

switch (command) {
    case 'install':   install(targets);   break;
    case 'uninstall': uninstall(targets); break;
    case 'status':    status(targets);    break;
    default:          usage();
}
