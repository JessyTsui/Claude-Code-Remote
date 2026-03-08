/**
 * Build a tmux new-session command that runs claudeCmd inside a login shell,
 * ensuring the full user environment (PATH, env vars, shell profiles) is loaded.
 */
function buildTmuxCommand(sessionName, repoPath, claudeCmd) {
    const shell = process.env.SHELL || '/bin/zsh';
    // Escape single quotes for nested shell invocation
    const escapedCmd = claudeCmd.replace(/'/g, "'\\''");
    return `tmux new-session -d -s ${sessionName} -c "${repoPath}" "${shell} -l -c '${escapedCmd}'"`;
}

module.exports = { buildTmuxCommand };
