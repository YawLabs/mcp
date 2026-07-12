# Install

`@yawlabs/mcp` ships as an npm package. There is no per-platform binary to download.

## Recommended: npm

```bash
npm install -g @yawlabs/mcp
yaw-mcp --version
```

Or, for a one-off run without installing:

```bash
npx -y @yawlabs/mcp --version
```

This works on Linux (x64 + arm64), macOS (x64 + arm64), and Windows (x64 + arm64). Node 18.3 or newer is required (the `engines` field in `package.json` enforces this; `npx -y` will pull a recent Node automatically if you're on an older one).

## What happened to the single-binary download

Versions 0.66.0 - 0.70.2 published per-platform Node SEA (Single Executable Application) binaries alongside the npm tarball. The binary track was removed in 0.70.3 because:

- **Node SEA cannot cross-compile.** The single executable is the host Node binary with the bundled CLI injected, so a win32-x64 build needs a real Windows x64 host, an arm64 Linux build needs an arm64 Linux host, and so on. The per-host provisioning was the bulk of the work.
- **No install story advantage.** `npm install -g @yawlabs/mcp` already works on every platform we ship to and resolves the same single-file UX the SEA build was chasing. The two install stores differ only in where the bytes live on disk.
- **The non-npm stores are stale.** The `YawLabs/scoop-yaw` and `YawLabs/homebrew-yaw` taps were tied to the SEA release flow. They will lag during the transition to the npm-only flow. Use `npm install -g` until the taps catch up.

Full rationale and the three options evaluated are in `docs/v0.70.3-binary-track-decision.md`.
