# Contributing

Install Node.js 20.11+, FFmpeg, and dependencies with `npm install`. Run `npm run build`, then `dumbeditor setup` to create user-level configuration. Run `npm run quality` before opening a change.

Keep direct edits deterministic and reversible. Add a validated local tool when an operation has a bounded parameter shape. Use the agent tool loop and sandboxed workspace for custom multi-step work.

Keep Windows, macOS, and Linux paths portable. Use Node path APIs, spawn tools with argument arrays, keep shell-specific behavior inside explicit platform branches, and preserve the ANSI preview fallback. Pull requests should pass `npm run quality`; changes to startup or packaging should also pass `npm run release:check`.

Never commit API keys, source videos, rendered versions, or agent workspaces.

## Release

1. Run `npm run release:check` and inspect the printed tarball contents.
2. Install the packed tarball in a clean directory and run `dumbeditor --version` and `dumbeditor --help`.
3. Confirm the intended version in `package.json`, a clean Git worktree, and `npm whoami`.
4. Publish the unscoped public package with `npm publish`.

Published name and version pairs cannot be reused. Increment the version before every later release.
