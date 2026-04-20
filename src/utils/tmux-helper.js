/**
 * Build a tmux new-session command that runs the chosen CLI inside a login shell,
 * ensuring the full user environment (PATH, env vars, shell profiles) is loaded.
 *
 * @param {string} sessionName - tmux session name
 * @param {string} repoPath - working directory
 * @param {string} cliCmd - CLI command to run (e.g. `claude --dangerously-skip-permissions`
 *                         or `codex --dangerously-bypass-approvals-and-sandbox`)
 * @param {string} [sessionKey] - Slack session key (channelId-threadTs) passed as SLACK_SESSION_KEY env var
 * @param {string} [cliType] - 'claude' | 'codex'. Exported as CLI_SOURCE so the hook
 *                             script can branch on payload shape.
 */
function buildTmuxCommand(sessionName, repoPath, cliCmd, sessionKey, cliType) {
    const shell = process.env.SHELL || '/bin/zsh';
    const escapedCmd = cliCmd.replace(/'/g, "'\\''");
    const exports = [];
    if (sessionKey) exports.push(`export SLACK_SESSION_KEY='${sessionKey}'`);
    if (cliType) exports.push(`export CLI_SOURCE='${cliType}'`);
    const envExport = exports.length ? exports.join(' && ') + ' && ' : '';
    // Use -li (login + interactive) so .zshrc is sourced and the full user
    // environment (PATH, custom env vars) is available. Without -i, non-interactive
    // login shells skip .zshrc and tools like claude (in ~/.local/bin) aren't found.
    return `tmux new-session -d -s ${sessionName} -c "${repoPath}" "${shell} -li -c '${envExport}${escapedCmd}'"`;
}

module.exports = { buildTmuxCommand };
