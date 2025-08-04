<!--
🏷️ PR TITLE NAMING RULES:
Format: type(scope): description

📋 AVAILABLE PR TYPES (choose one for title):
- feat: New feature or enhancement
- fix: Bug fix
- docs: Documentation only changes
- style: Code formatting, whitespace, semicolons
- refactor: Code refactoring (no functionality change)
- perf: Performance improvements
- test: Adding or updating tests
- chore: Maintenance, dependencies, build tools
- ci: CI/CD configuration changes

📍 SCOPES (optional but recommended):
- telegram: Telegram platform
- email: Email platform
- line: LINE platform
- discord: Discord platform
- core: Core functionality
- config: Configuration files
- docs: Documentation

✅ GOOD PR TITLE EXAMPLES:
- feat(telegram): add inline keyboard support
- fix(email): resolve SMTP timeout issue #123
- feat(discord): add Discord platform integration
- docs: update installation instructions
- refactor(core): simplify notification logic
- perf(telegram): optimize message sending speed
- fix(line): handle webhook authentication error
- chore: update dependencies to latest versions
- style(core): fix code formatting and indentation
- test(email): add unit tests for SMTP connection
- ci: add automated security scanning

❌ BAD PR TITLE EXAMPLES:
- Add feature (no type, no scope)
- Fix bug (too vague, no scope)
- Update code (not descriptive)
- telegram fix (wrong format)
- New Discord support (missing type prefix)
-->

## PR Type (REQUIRED: select at least one)
- [ ] 🐛 **fix**: Bug fix (non-breaking change)
- [ ] ✨ **feat**: New feature (non-breaking change)
- [ ] 🔌 **feat**: Platform integration (new platform support)
- [ ] 💥 **feat**: Breaking change (changes existing functionality)
- [ ] 📚 **docs**: Documentation only changes
- [ ] ♻️ **refactor**: Code refactoring (no functionality change)
- [ ] ⚡ **perf**: Performance improvements
- [ ] 🎨 **style**: Code formatting, whitespace, semicolons
- [ ] 🔧 **chore**: Maintenance, dependencies, build tools
- [ ] 🚨 **test**: Adding or updating tests
- [ ] 🔄 **ci**: CI/CD configuration changes

## What does this PR do?
<!-- Clear description -->

## Related Issue
<!-- Fixes #123 or Closes #123 -->

## Code Quality Checklist (ALL REQUIRED)
- [ ] **No hardcoded secrets** (use process.env.* or config files)
- [ ] **No console.log** in production code (use logger.*)
- [ ] **Error handling** implemented (try/catch blocks)
- [ ] **Input validation** where needed
- [ ] **Tested locally** with tmux

## Platform Testing
- [ ] Email
- [ ] Telegram  
- [ ] LINE
- [ ] Desktop notifications

## How did you test this?
1. 
2. 