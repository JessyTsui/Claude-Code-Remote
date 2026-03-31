/**
 * Build a tmux new-session command that runs claudeCmd inside a login shell,
 * ensuring the full user environment (PATH, env vars, shell profiles) is loaded.
 *
 * @param {string} sessionName - tmux session name
 * @param {string} repoPath - working directory
 * @param {string} claudeCmd - Claude CLI command to run
 * @param {string} [sessionKey] - Slack session key (channelId-threadTs) passed as SLACK_SESSION_KEY env var
 */
function buildTmuxCommand(sessionName, repoPath, claudeCmd, sessionKey) {
    const shell = process.env.SHELL || '/bin/zsh';
    // Escape single quotes for nested shell invocation
    const escapedCmd = claudeCmd.replace(/'/g, "'\\''");
    const envExport = sessionKey ? `export SLACK_SESSION_KEY='${sessionKey}' && ` : '';
    // Use -li (login + interactive) so .zshrc is sourced and the full user
    // environment (PATH, custom env vars) is available. Without -i, non-interactive
    // login shells skip .zshrc and tools like claude (in ~/.local/bin) aren't found.
    return `tmux new-session -d -s ${sessionName} -c "${repoPath}" "${shell} -li -c '${envExport}${escapedCmd}'"`;
}

module.exports = { buildTmuxCommand };
