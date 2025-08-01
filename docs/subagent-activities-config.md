# Subagent Activities in Email Configuration

## Overview

The Claude Code Remote tool now supports configurable display of subagent activities in email notifications. This allows users to choose whether they want to see a summary of subagent activities in their completion emails.

## Configuration

Add the following setting to your `config.json`:

```json
{
  "showSubagentActivitiesInEmail": false  // Default: false
}
```

## Behavior

- **When `false` (default)**: Email notifications will only include the execution trace, not the separate subagent activities summary section
- **When `true`**: Email notifications will include both:
  - Subagent Activities Summary section
  - Full Execution Trace section

## Why This Matters

Since the execution trace already contains all subagent activity information, having a separate subagent activities summary can be redundant. This configuration allows users to:

1. Keep emails concise by showing only the execution trace (default)
2. Have both summaries for users who prefer the structured subagent view

## Example

To enable subagent activities in emails:

```json
{
  "language": "zh-CN",
  "enabled": true,
  "enableSubagentNotifications": false,
  "showSubagentActivitiesInEmail": true,  // Enable this
  "subagentActivityDetail": "medium"
}
```