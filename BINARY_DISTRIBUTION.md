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

This works on Linux (x64 + arm64), macOS (x64 + arm64), and Windows (x64 + arm64). Node 20 or newer is required: with the `npm install -g` above, the package's `preinstall` script refuses to install on anything older (the `engines` field alone only makes npm warn). That check is an install script, so an install that skips lifecycle scripts (`--ignore-scripts`, or a package manager set not to run them) is not stopped by it. `npx -y` runs under whatever Node is on your PATH -- it never fetches a newer one -- so upgrade Node first.

## What happened to the single-binary download

Versions 0.66.0 - 0.70.2 published per-platform Node SEA (Single Executable Application) binaries alongside the npm tarball. The binary track was removed in 0.70.3 because:

- **Node SEA cannot cross-compile.** The single executable is the host Node binary with the bundled CLI injected, so a win32-x64 build needs a real Windows x64 host, an arm64 Linux build needs an arm64 Linux host, and so on. The per-host provisioning was the bulk of the work.
- **No install story advantage.** `npm install -g @yawlabs/mcp` already works on every platform we ship to and resolves the same single-file UX the SEA build was chasing. The two install stores differ only in where the bytes live on disk.
- **The non-npm stores are deprecated.** The `YawLabs/scoop-yaw` and `YawLabs/homebrew-yaw` taps were tied to the SEA release flow. No new manifests are published to them; an existing install from one still works but gets no newer version. Use `npm install -g`.

Full rationale and the three options evaluated are in `docs/v0.70.3-binary-track-decision.md`.
