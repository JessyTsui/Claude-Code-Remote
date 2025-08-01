# Email Notification Redesign Plan

## Overview
Redesign the email notification layout to improve readability and provide better user experience by reorganizing content hierarchy and implementing smart execution trace capture.

## Current Issues
1. Execution trace takes too much visual space
2. Important information (user input/output) is buried in the middle
3. Session info footer is unnecessary noise
4. Execution trace captures too much irrelevant content

## Proposed Changes

### 1. Email Layout Reorganization

**New Structure (top to bottom):**
```
1. Header (Terminal-style title bar)
2. Main Content Section
   - User Question (most prominent)
   - Claude's Response (second most prominent)
3. Subagent Activities (if any)
4. Execution Trace (at the bottom, visually de-emphasized)
5. Reply Instructions
```

**Remove:**
- Session info footer (`$echo $SESSION_INFO`)
- Unnecessary terminal styling elements

### 2. Smart Execution Trace Capture

**Current Behavior:**
- Captures last 1000 lines or entire session
- Includes everything from session start

**Improved Behavior:**
- Start capture: When user input is detected (line starting with `> `)
- End capture: When notification is triggered
- Clean up: Remove command prompt boxes and status lines

**Implementation Details:**

1. **Track User Input Timestamp**
   - In `TmuxMonitor`, detect when user input starts
   - Store timestamp of last user input

2. **Capture Window**
   - Only capture content between last user input and notification time
   - This ensures we only show relevant execution context

3. **Content Filtering**
   - Remove command prompt boxes (`╭──╮`)
   - Remove status lines (`? for shortcuts`)
   - Remove empty prompt lines

### 3. Visual Design Improvements

**Main Content Section:**
```html
<!-- User Question - Most Prominent -->
<div style="background: linear-gradient(135deg, #ff9800 0%, #ff5722 100%); 
            padding: 20px; margin-bottom: 20px; border-radius: 8px;">
    <h2 style="color: white; margin: 0 0 10px 0;">📝 Your Request</h2>
    <div style="background: rgba(255,255,255,0.9); color: #333; 
                padding: 15px; border-radius: 4px;">
        {{userQuestion}}
    </div>
</div>

<!-- Claude's Response - Second Prominent -->
<div style="background: #1a1a1a; padding: 20px; border-radius: 8px;">
    <h2 style="color: #00ff00; margin: 0 0 10px 0;">🤖 Claude's Response</h2>
    <div style="color: #f0f0f0; line-height: 1.6;">
        {{claudeResponse}}
    </div>
</div>
```

**Execution Trace Section:**
```html
<!-- De-emphasized, at the bottom -->
<div style="margin-top: 40px; opacity: 0.8;">
    <details open style="border: 1px solid #333; border-radius: 4px;">
        <summary style="background: #1a1a1a; padding: 10px; 
                        color: #999; font-size: 12px;">
            Execution Details ({{lineCount}} lines)
        </summary>
        <div style="max-height: 300px; overflow-y: auto; 
                    background: #0d0d0d; padding: 10px;">
            <pre>{{executionTrace}}</pre>
        </div>
    </details>
</div>
```

## Implementation Steps

### Phase 1: Update Email Template Structure
1. Reorder sections in `src/channels/email/smtp.js`
2. Remove session info footer
3. Update styling for better visual hierarchy

### Phase 2: Implement Smart Trace Capture
1. Add `TraceCapture` class to track user input timestamps
2. Modify `TmuxMonitor.getFullExecutionTrace()` to use time window
3. Enhance trace cleaning logic

### Phase 3: Testing & Refinement
1. Test with various task types
2. Ensure trace captures correct time window
3. Verify email renders correctly in different clients

## Success Criteria
1. User question and response are immediately visible
2. Execution trace only shows relevant task execution
3. Email is more scannable and less cluttered
4. Technical details are available but not overwhelming

## Technical Considerations
- Maintain backward compatibility with existing sessions
- Handle edge cases where user input timestamp isn't available
- Ensure trace capture doesn't impact performance