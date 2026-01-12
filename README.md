# CI Standards

Centralized CI/CD workflows and code standards for GitHub Actions.

## What's Included

- **PR Code Review Automation** - Automatic inline comments on violations
- **JSDoc Validation** - Using ESLint plugin
- **Custom Code Standards** - console.log, TODO/FIXME detection
- **Tailwind CSS Standards** - CSS property checks
- **Context-Aware Checking** - Only checks changed code (+/- 100 lines)

## Usage

### In Your Application Repository

Add this to `.github/workflows/pr-review.yml`:

```yaml
name: Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  code-review:
    uses: JakoLantern/CI-Standards/.github/workflows/pr-inline-comments.yml@main
    secrets: inherit
```

## Workflows Included

### `pr-inline-comments.yml`

Posts inline review comments on PRs for code violations:
- JSDoc validation
- Console.log detection
- TODO/FIXME comments
- Tailwind CSS standards

**Triggers:** Pull requests (opened, synchronize, reopened)

**Permissions Required:**
- `pull-requests: write`
- `contents: read`
- `issues: read`

## Scripts

- `generate-pr-comments.js` - Analyzes code and generates violations
- `check-code-standards.js` - Local code standards checking
- `check-tailwind-standards.js` - Local CSS standard checking
- `check-jsdoc-standards.js` - Local JSDoc validation
- `post-pr-review.js` - Posts violations to GitHub

## Configuration

### ESLint JSDoc Rules

Configured in `.eslintrc.json`:
- Requires JSDoc on all function declarations
- Requires parameter descriptions
- Requires return descriptions

Customize by editing `.eslintrc.json`.

### Custom Standards

Edit scripts to modify:
- Patterns detected (console.log, TODO, etc.)
- Severity levels
- Messages shown to developers

## Local Development

### Install Dependencies

```bash
npm install
```

### Run Linting Locally

```bash
# Check code standards on changed files
node scripts/check-code-standards.js --changed

# Check Tailwind standards
node scripts/check-tailwind-standards.js src/**/*.css

# Run ESLint for JSDoc
npx eslint src/
```

## Branch Protection

Recommend enabling in GitHub:
1. Go to repository Settings → Branches
2. Create rule for `main`
3. ✅ Require status checks to pass
4. ✅ Require pull request reviews
5. ✅ Require code owner approval
6. ✅ Dismiss stale pull request approvals

## Security

This repo should be **private** and only accessible to maintainers. Changes to CI/CD standards require approval.

Add CODEOWNERS to enforce:

```
.github/workflows/ @owner-username
scripts/ @owner-username
.eslintrc.json @owner-username
```

## License

ISC
