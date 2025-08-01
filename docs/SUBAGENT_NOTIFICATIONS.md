# Subagent Notifications Configuration

## Overview

When Claude Code executes subagent tasks, it triggers `SubagentStop` hooks which send "waiting" notifications. This can be noisy and distracting for some users.

## Configuration

You can control whether subagent notifications are sent by modifying the `enableSubagentNotifications` setting in your configuration.

### Disable Subagent Notifications (Default)

By default, subagent notifications are disabled. The configuration looks like this:

```json
{
  "language": "zh-CN",
  "sound": {
    "completed": "Submarine",
    "waiting": "Hero"
  },
  "enabled": true,
  "enableSubagentNotifications": false,
  "timeout": 5,
  "customMessages": {
    "completed": null,
    "waiting": null
  }
}
```

### Enable Subagent Notifications

If you want to receive notifications when subagents stop/start, change the setting to `true`:

```json
{
  "enableSubagentNotifications": true
}
```

## How It Works

1. When Claude Code triggers a `SubagentStop` hook, it calls:
   ```bash
   node claude-remote.js notify --type waiting
   ```

2. The notification system checks the `enableSubagentNotifications` setting
3. If disabled (default), the notification is skipped
4. If enabled, the notification is sent as normal

## Command Examples

Test if subagent notifications are working:
```bash
# This will be skipped if enableSubagentNotifications is false
node claude-remote.js notify --type waiting

# This will always work (not a subagent notification)
node claude-remote.js notify --type completed
```

## Why Disable by Default?

- Subagent notifications can be frequent and distracting
- When working with Claude Code, you're already aware of what's happening
- The main task completion notification is usually sufficient
- Reduces email/notification noise