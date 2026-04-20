/**
 * CLI adapter selector.
 *
 * Per-feature callers pass the resolved CLI type (e.g. 'claude' | 'codex') and
 * get back a uniform adapter interface. The selector does not read env itself —
 * each feature owns its own flag (ALERT_CLI, DELAY_ALERT_CLI, or a per-message
 * keyword in @mention chat).
 *
 * Adding a new CLI: drop an adapter file next to this one, register it in
 * ADAPTERS, and it's available to every feature — no code changes elsewhere.
 */

const claudeAdapter = require('./claude-adapter');
const codexAdapter = require('./codex-adapter');

const ADAPTERS = {
    claude: claudeAdapter,
    codex: codexAdapter,
};

const DEFAULT_ADAPTER = claudeAdapter;

function getCliAdapter(type) {
    const key = String(type || '').toLowerCase();
    return ADAPTERS[key] || DEFAULT_ADAPTER;
}

function listAdapters() {
    return Object.values(ADAPTERS);
}

function adapterNames() {
    return Object.keys(ADAPTERS);
}

module.exports = { getCliAdapter, listAdapters, adapterNames, claudeAdapter, codexAdapter };
