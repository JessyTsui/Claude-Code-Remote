# Issue: Sub-agent notifications cause confusion in email workflow

## Problem

Currently, both main agents and sub-agents send email notifications when they complete:
- Main agent sends "completed" notification when your task is done
- Sub-agents send "waiting" notifications when they finish their sub-tasks

This creates several issues:
1. **Notification noise**: A single Claude Code request might trigger multiple email notifications
2. **Confusing reply context**: Users might reply to sub-agent notifications, but the session is for the sub-agent, not the main conversation
3. **Unclear status**: Sub-agent completion doesn't mean the main task is finished

## Example Scenario

User asks: "Please review my code and suggest improvements"

What happens:
1. Main agent starts processing
2. Spawns `code-reviewer` sub-agent  
3. Sub-agent completes → Sends "waiting" notification ❌
4. Main agent continues processing
5. Main agent completes → Sends "completed" notification ✅

Result: User receives 2 emails for 1 request, and might reply to the wrong one.

## Solution

Disable sub-agent notifications by default in the hooks configuration:

```json
"SubagentStop": [{
  "matcher": "*",
  "enabled": false,  // Add this line
  "hooks": [{
    "type": "command",
    "command": "node claude-remote.js notify --type waiting"
  }]
}]
```

Users who need sub-agent tracking can manually enable it in their configuration.

## Benefits

- Cleaner email workflow
- Less confusion about which email to reply to
- Notifications only for actual task completion
- Power users can still enable sub-agent notifications if needed