# Contributing

Thanks for your interest in contributing! This guide covers the workflow for both human contributors and AI coding agents.

## Quick Start

```bash
# 1. Fork this repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/mcp.git
cd mcp

# 2. Install dependencies
npm install

# 3. Create a branch
git checkout -b your-branch-name

# 4. Make your changes, then verify everything passes
npm run lint:fix
npm run build
npm test
```

## Submitting a Pull Request

1. **One PR per change.** Keep PRs focused — a bug fix, a new feature, or a refactor, not all three.
2. **Branch from `main`** (or `master` if that's the default branch).
3. **Run `npm run lint:fix`** before committing — CI will reject formatting issues.
4. **Run `npm test`** and confirm all tests pass.
5. **Write a clear PR title and description** — explain *what* changed and *why*.
6. **All PRs require approval** from a maintainer before merging.

## Development Workflow

| Command | What it does |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript |
| `npm run dev` | Run in development mode |
| `npm test` | Run the test suite |
| `npm run lint` | Check for lint errors |
| `npm run lint:fix` | Auto-fix lint and formatting |

## Code Style

- TypeScript, strict mode
- Formatting and linting are enforced by the project's linter — run `lint:fix` and let the tooling handle it
- No unnecessary abstractions — keep code simple and direct
- Add tests for new functionality

## For AI Coding Agents

If you're an AI agent (Claude Code, Copilot, Cursor, etc.) submitting a PR:

1. **Fork the repo** and work on a branch — direct pushes to the default branch are blocked.
2. **Always run `npm run lint:fix && npm run build && npm test`** before committing. Do not skip this.
3. **Do not add unrelated changes** — no drive-by refactors, no extra comments, no unrelated formatting fixes.
4. **PR description must explain the change clearly** — what problem does it solve, how does it work, how was it tested.
5. **One logical change per PR.** If you're fixing a bug and adding a feature, that's two PRs.

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment details (OS, Node version, etc.)

## License and Contributor Sign-Off

This project is source-available under the [Yaw MCP Source-Available License](LICENSE), not an open-source license. Read it before you contribute — in particular, it does not grant the right to offer this software to third parties as a competing product.

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) 1.1. It is a short statement that you wrote the patch, or otherwise have the right to submit it under this project's license. There is no CLA to sign and no copyright assignment.

Certify it by adding a `Signed-off-by` line to each commit, using your real name:

```
Signed-off-by: Jane Developer <jane@example.com>
```

`git commit -s` adds this for you. Configure it once with:

```bash
git config user.name "Jane Developer"
git config user.email "jane@example.com"
```

By signing off, you agree that Yaw Labs may distribute your contribution as part of this project under the terms of the LICENSE file, including in future versions released under different terms.
