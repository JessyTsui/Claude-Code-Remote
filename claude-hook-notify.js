#!/usr/bin/env node

// Shim — preserves backward compatibility with already-installed Claude hooks
// whose command strings reference `claude-hook-notify.js`. All logic lives in
// cli-hook-notify.js which also handles Codex notify payloads.
require('./cli-hook-notify.js');
