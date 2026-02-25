# Contributing to ACP

Thanks for your interest in contributing to ACP! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/RbrtDdds/acp.git
cd acp
pnpm install
pnpm build
```

### Prerequisites

- Node.js >= 18
- pnpm >= 9

### Project Structure

```
packages/
  core/        — models, adapters, engines (the brain)
  cli/         — CLI tool (acp init, acp recall, etc.)
  mcp/         — MCP server for Claude Code integration
  embeddings/  — optional local embedding provider (transformers.js)
```

## Making Changes

1. **Fork the repo** and create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes** and ensure everything builds:
   ```bash
   pnpm build
   pnpm test
   ```

3. **Add a changeset** describing your change:
   ```bash
   pnpm changeset
   ```
   This will prompt you to select which packages are affected and whether it's a patch, minor, or major change.

4. **Commit using conventional commits:**
   ```
   feat(core): add new recall strategy
   fix(cli): handle missing config gracefully
   docs(repo): update contributing guide
   ```
   Commits are validated by commitlint via a pre-commit hook.

   **Types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`
   **Scopes:** `core`, `cli`, `mcp`, `embeddings`, `deps`, `release`, `repo`

5. **Open a pull request** against `main`. PRs require review before merging.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Add tests for new functionality when possible
- Make sure CI passes (build + lint)
- Link related issues using `Closes #123` in the PR description

## Reporting Bugs

Open an issue using the **Bug Report** template. Include:

- Steps to reproduce
- Expected vs. actual behavior
- Node.js version, OS, and ACP version (`acp --version`)

## Suggesting Features

Open an issue using the **Feature Request** template. Describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Code Style

- TypeScript strict mode
- ESM modules (`"type": "module"`)
- No `any` types unless absolutely necessary (document why)
- Named constants over magic numbers
- Parameterized SQL queries (never string concatenation)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
