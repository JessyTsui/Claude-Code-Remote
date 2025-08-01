# Subagent Activity Details Configuration

## The Problem

When Claude Code executes subagents, the activity tracking captures the tmux session content at the moment the `SubagentStop` hook fires. This often results in capturing only initialization messages like "Initializing... Concocting..." rather than the actual subagent output.

## Why This Happens

1. **Timing Issue**: The `SubagentStop` hook fires when the subagent starts, not when it completes
2. **Async Nature**: Subagents run asynchronously, and their output may not be immediately available
3. **Tmux Capture**: We're capturing the current tmux buffer, which shows real-time status

## Solutions Implemented

### 1. Improved Display Format
- Better visual separation for each subagent activity
- Clear indication when only initialization text was captured
- Increased capture limit from 200 to 1000 characters

### 2. Configuration Option
```json
{
  "subagentActivityDetail": "medium"  // Options: "low", "medium", "high"
}
```

- **low**: Only show subagent task names
- **medium**: Show task names and partial output (default)
- **high**: Show task names and more complete output

### 3. Better Visual Indicators
- ⏳ Icon indicates when subagent was still processing
- Note that full output is available in tmux session
- Formatted output in code blocks for better readability

## Limitations

Due to the way Claude Code hooks work:
- We can't easily capture the final subagent output
- The timing of capture is controlled by Claude Code itself
- Full subagent results are always available in your tmux session

## Workarounds

1. **Check Tmux Session**: The complete subagent output is always available in your tmux session
2. **Enable Subagent Notifications**: If you need to see each subagent's output immediately, set `enableSubagentNotifications: true`
3. **Use Task Summary**: Many subagents provide a summary in their initial description

## Future Improvements

Potential enhancements could include:
- Delayed capture after subagent completes
- Integration with Claude Code's internal task tracking
- Separate subagent result storage mechanism

For now, the email summary provides a helpful overview while keeping notification noise to a minimum.