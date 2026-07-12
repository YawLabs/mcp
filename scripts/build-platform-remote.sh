#!/usr/bin/env bash
# Per-host leg for the all-platforms orchestrator.
#
# Run this on a remote host (or locally on each host) to build that host's
# platform binary + stage it under dist-release/. The orchestrator
# (scripts/build-platforms-all.sh) SSHes into the host, runs this script,
# captures the staged asset path from the last stdout line, and rsync-pulls
# the artifact back to the orchestrator. Mirrors the contract Yaw Terminal's
# `scripts/build-platforms-{tailnet,gcp-iap}.sh` follow: "the LAST stdout
# line is the staging dir."
#
# Usage:
#   scripts/build-platform-remote.sh <version>
#
# Idempotent: if dist-release/ already has a single staged asset (and only
# one -- more than one is a user error from running --build-only twice in
# a row, which we want to surface), we just print its path and exit. Lets
# the orchestrator re-run a failed leg without rebuilding from scratch.
#
# Output: informational logs to stdout (one per step), a single asset path
# on the LAST stdout line. The orchestrator parses only that last line.
#
# Prerequisites (same as release.sh): node + npm, gh (for --upload-asset on
# the orchestrator side), internet access to npm + esbuild + postject on
# first run.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>" >&2
  exit 64
fi
VERSION="$1"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version: $VERSION (expected X.Y.Z)" >&2
  exit 64
fi

# Re-derive this script's dir so the host can be invoked from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist-release"

# Existing-staged-asset fast path: one .exe (or POSIX binary) means a prior
# build already produced a usable artifact for this host. Re-running the
# build would invalidate the staged file mid-rsync (the orchestrator could
# be reading it). Bail out and let the orchestrator use what we have.
if [ -d "$DIST_DIR" ]; then
  EXISTING=$(find "$DIST_DIR" -maxdepth 1 -type f \( -name "yaw-mcp-*" -o -name "yaw-mcp-*.exe" \) ! -name "*.sha256" 2>/dev/null | head -1 || true)
  if [ -n "$EXISTING" ]; then
    # Sanity: the staged file must have a .sha256 sidecar (produced by
    # stage-release-asset.mjs). Without one the orchestrator's hash check
    # would fail; rebuild in that case rather than ship an unverified asset.
    if [ -f "${EXISTING}.sha256" ]; then
      echo "[build-platform-remote] reusing existing staged asset: $EXISTING"
      echo "$EXISTING"
      exit 0
    fi
    echo "[build-platform-remote] staged asset lacks .sha256 sidecar -- rebuilding" >&2
  fi
fi

cd "$REPO_ROOT"

# --build-only handles lint + typecheck + tests + esbuild + SEA + postject +
# macOS codesign + a `--version` smoke test. We deliberately do NOT
# reproduce that logic here; if the leg ever needs to diverge from
# --build-only, fix it in release.sh, not in two places.
./release.sh --build-only "$VERSION"

# --build-only writes a single binary into dist-release/. Find it and emit
# its path on the last stdout line.
ASSET=$(find "$DIST_DIR" -maxdepth 1 -type f \( -name "yaw-mcp-*" -o -name "yaw-mcp-*.exe" \) ! -name "*.sha256" 2>/dev/null | head -1 || true)
if [ -z "$ASSET" ]; then
  echo "[build-platform-remote] no asset found in $DIST_DIR after --build-only" >&2
  exit 1
fi
if [ ! -f "${ASSET}.sha256" ]; then
  echo "[build-platform-remote] no .sha256 sidecar next to $ASSET -- refusing to publish an unverified asset" >&2
  exit 1
fi

echo "[build-platform-remote] staged: $ASSET"
echo "$ASSET"
