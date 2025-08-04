First of all, many thanks to everyone who wants to contribute to Claude-Code-Remote!

# Contributing to Claude Code Remote

## 🚀 Quick Start

```bash
# Fork, clone, and setup
git clone https://github.com/YOUR_USERNAME/Claude-Code-Remote.git
cd Claude-Code-Remote
npm install
cp .env.example .env

# Create feature branch
git checkout -b feature/your-feature

# Test your changes
npm run webhooks
```

## 📝 Coding Standards (Automated Checks)

### 🚫 Strictly Forbidden (CI will auto-reject)
```javascript
// ❌ Hardcoded secrets/tokens
const TELEGRAM_BOT_TOKEN = "123456789:ABC...";
const LINE_CHANNEL_ACCESS_TOKEN = "abc123";
const SMTP_PASS = "mypassword";

// ❌ Hardcoded API URLs
const API_URL = "https://api.telegram.org/bot123456789";
fetch("https://hooks.slack.com/abc123");

// ❌ console.log in production code
console.log("Debug info");
console.error("Error occurred");

// ❌ Async operations without error handling
async function sendMessage() {
  await fetch(url); // No try-catch
}

// ❌ String concatenation with user input
const query = "SELECT * FROM users WHERE id=" + userId;
```

### ✅ Required Standards (CI checks pass)
```javascript
// ✅ Use environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SMTP_PASS = process.env.SMTP_PASS;

// ✅ Use configuration files
const config = require('./config.json');
const API_URL = `${config.telegram.baseUrl}/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ✅ Use proper logging
const logger = require('./src/core/logger');
logger.info('Message sent successfully');
logger.error('Failed to send message:', error);

// ✅ Proper error handling
async function sendMessage(message) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ text: message })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    logger.error('Send message failed:', error);
    throw error; // Re-throw for caller to handle
  }
}

// ✅ Input validation and parameterized queries
function validateUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid user ID');
  }
  return userId.replace(/[^a-zA-Z0-9-]/g, '');
}
```

### 🔧 Enforcement Rules
1. **Automated CI checks**: Every PR automatically checked for code quality
2. **Hardcode detection**: Auto-scan all `.js` files for sensitive data
3. **Log checking**: Prohibit `console.log` in production code
4. **Error handling**: Check async functions for proper error handling

## 📛 Naming Conventions

### Issue Title Format
```bash
[BUG] Short clear description
[FEATURE] Short clear description

Examples:
[BUG] Telegram bot not responding to commands
[FEATURE] Add Discord platform integration
```

### PR Title Format 
```bash
type(scope): description

Types: feat, fix, docs, style, refactor, perf, test, chore, ci
Scopes: telegram, email, line, core, config, docs

Examples:
feat(telegram): add inline keyboard support
fix(email): resolve SMTP timeout issue #123
docs: update installation instructions
```

### Branch Naming
```bash
feature/discord-integration    # New feature
fix/issue-123                 # Bug fix
docs/update-readme            # Documentation
refactor/notification-system  # Refactoring
```

**Note**: Detailed naming rules are shown directly in issue/PR templates when you create them on GitHub.

## 🔄 Workflow

### Before PR
1. Test all affected platforms
2. Run security checks: `grep -r "TOKEN\|SECRET\|PASS" --include="*.js" src/`
3. Ensure no console.log in production code
4. Update docs if API changes

### Commit Format
```bash
feat(telegram): add inline keyboard support
fix(email): resolve SMTP timeout issue #123
docs: update installation instructions
refactor(core): simplify notification logic
chore: update dependencies
```

## ✅ PR Checklist

- [ ] **No hardcoded values** (all config in .env or config files)
- [ ] **No secrets in code** (tokens, passwords, keys)
- [ ] **Input validation added** where needed
- [ ] **Error handling implemented** (try/catch blocks)
- [ ] **Tested locally** with tmux
- [ ] **Tested affected platforms** (Email/Telegram/LINE)
- [ ] **Code follows existing patterns**
- [ ] **Updated documentation** if needed

## 🚨 Important Rules

1. **Never commit .env files**
2. **Always validate external input**
3. **Keep platform code isolated** in `src/channels/`
4. **Follow existing patterns** - check similar code first
5. **Test with tmux** before submitting

## 📞 Get Help

- Issues: [GitHub Issues](https://github.com/JessyTsui/Claude-Code-Remote/issues)
- Twitter: [@Jiaxi_Cui](https://x.com/Jiaxi_Cui)