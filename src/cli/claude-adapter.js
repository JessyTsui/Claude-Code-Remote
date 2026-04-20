/**
 * Claude CLI adapter — current baseline behaviour.
 * Used for all features unless a per-feature flag opts into Codex.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_MARKERS = ['cli-hook-notify', 'claude-hook-notify'];
const HOOK_TIMEOUT = 15;

function hookScriptPath() {
    const preferred = path.join(REPO_ROOT, 'cli-hook-notify.js');
    if (fs.existsSync(preferred)) return preferred;
    return path.join(REPO_ROOT, 'claude-hook-notify.js');
}

function loadSettings() {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function saveSettings(settings) {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function hookIsOurs(hook) {
    return hook && hook.command && HOOK_MARKERS.some(m => hook.command.includes(m));
}

function listHasOurHook(list) {
    return Array.isArray(list) && list.some(e =>
        Array.isArray(e.hooks) && e.hooks.some(hookIsOurs)
    );
}

function upsertHook(list, command) {
    if (!Array.isArray(list)) list = [];
    if (list.some(e => Array.isArray(e.hooks) && e.hooks.some(h => h.command === command))) {
        return list;
    }
    list.push({
        matcher: '*',
        hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }]
    });
    return list;
}

function removeOurHooks(list) {
    if (!Array.isArray(list)) return list;
    const filtered = list
        .map(entry => {
            if (!Array.isArray(entry.hooks)) return entry;
            const remaining = entry.hooks.filter(h => !hookIsOurs(h));
            return remaining.length > 0 ? { ...entry, hooks: remaining } : null;
        })
        .filter(Boolean);
    return filtered.length > 0 ? filtered : undefined;
}

module.exports = {
    type: 'claude',

    buildLaunchCommand(/* sessionName, repoPath, sessionKey */) {
        return process.env.SLACK_CLAUDE_COMMAND || 'claude --dangerously-skip-permissions';
    },

    // How long to wait for the TUI to be ready before injecting the first command.
    readinessTimeoutMs: 30000,

    // Claude Code shows ) or ❯ or > alone on a line when it's accepting input.
    isReady(output) {
        return /^[)❯>]\s*$/m.test(output);
    },

    buildAlertPrompt({ skill, permalink, fallbackText = '', imageInstruction = '', fallbackIntro = 'Investigate this alert' } = {}) {
        const snippet = (fallbackText || '').substring(0, 500);
        if (skill && permalink) {
            return `execute ${skill} skill with argument ${permalink}${imageInstruction}`;
        }
        if (skill) {
            return `execute ${skill} skill with argument Alert: ${snippet}${imageInstruction}`;
        }
        if (permalink) {
            return `${fallbackIntro}: ${permalink}${imageInstruction}`;
        }
        return `${fallbackIntro}: ${snippet}${imageInstruction}`;
    },

    // Substrings checked (case-insensitive) against tmux output to detect "the CLI is busy".
    // Used both by _injectCommand (paste/Enter verification) and by _pollForResponse.
    workingIndicators: [
        'brewing', 'thinking', 'working', 'clauding', 'processing',
        'flibbertigibbeting', 'esc to interrupt', '● skill(', 'crunching',
        'metamorphosing', 'burrowing', 'running…', '⏳'
    ],

    // Extra regexes evaluated against lowercased tail text. Claude Code renders a
    // per-turn timer like "(54s · ↓ 331 tokens)" that always shows while the
    // agent is thinking — a reliable signal even when the verb words rotate.
    workingRegexes: [
        /\(\d+[sm]\d*s?\s+·\s+↓/
    ],

    // Substrings that indicate the CLI is waiting for numbered-choice / yes-no confirmation.
    confirmationPrompts: [
        'Do you want to proceed?',
        '(y/n)',
        '1. Yes'
    ],

    // Whether _injectCommand + poller should auto-approve confirmation dialogs.
    handlesConfirmationPrompts: true,

    installHooks() {
        const settings = loadSettings();
        settings.hooks = settings.hooks || {};
        settings.hooks.SessionStart = settings.hooks.SessionStart || [];
        settings.hooks.Stop = settings.hooks.Stop || [];
        settings.hooks.SubagentStop = settings.hooks.SubagentStop || [];

        const script = hookScriptPath();
        const quoted = script.includes(' ') ? `"${script}"` : script;
        const commands = {
            SessionStart: `node ${quoted} session_start`,
            Stop: `node ${quoted} completed`,
            SubagentStop: `node ${quoted} waiting`,
        };

        let changed = false;
        for (const [event, command] of Object.entries(commands)) {
            const before = JSON.stringify(settings.hooks[event] || []);
            settings.hooks[event] = upsertHook(settings.hooks[event], command);
            if (JSON.stringify(settings.hooks[event]) !== before) changed = true;
        }

        if (changed) saveSettings(settings);
        return { path: SETTINGS_PATH, changed, commands };
    },

    uninstallHooks() {
        const settings = loadSettings();
        if (!settings.hooks) return { path: SETTINGS_PATH, changed: false };
        let changed = false;
        for (const event of ['SessionStart', 'Stop', 'SubagentStop']) {
            if (listHasOurHook(settings.hooks[event])) {
                settings.hooks[event] = removeOurHooks(settings.hooks[event]);
                if (!settings.hooks[event]) delete settings.hooks[event];
                changed = true;
            }
        }
        if (changed) saveSettings(settings);
        return { path: SETTINGS_PATH, changed };
    },

    hooksStatus() {
        const settings = loadSettings();
        const hooks = settings.hooks || {};
        return {
            path: SETTINGS_PATH,
            installed: {
                SessionStart: listHasOurHook(hooks.SessionStart),
                Stop: listHasOurHook(hooks.Stop),
                SubagentStop: listHasOurHook(hooks.SubagentStop),
            },
        };
    },
};
