#!/usr/bin/env bash
# Orchestrator: build + stage + attach binaries for ALL 5 SEA platforms to a
# single release. Mirrors the parallel-remote-leg pattern from
# `yaw/release.sh` step 6 + `scripts/build-platforms-{tailnet,gcp-iap}.sh`.
#
# The hard physical constraint for @yawlabs/mcp is that Node SEA cannot
# cross-compile -- the carrier is the host `node` binary. So unlike Yaw
# Terminal (one Linux VM + one MacBook Air builds 5 electron-forge targets
# with cross-compile), we need one host per target: linux-x64, linux-arm64,
# darwin-x64, darwin-arm64, win32-x64 (win32-arm64 is the orchestrator's
# own host by default). This script runs the per-host leg
# (scripts/build-platform-remote.sh) on each, in parallel, pulls the
# staged artifacts back to a single LOCAL_CI_ARTIFACTS_DIR, verifies
# them, and attaches each to the existing GitHub release via
# ./release.sh --upload-asset.
#
# Usage:
#   scripts/build-platforms-all.sh <version> [--config PATH] [--only PLATFORM]...
#
# Config (default: bin/platforms.json):
#   {
#     "linux-x64":    { "host": "linux-builder",   "ssh_user": "builder", "ssh_key": "~/.ssh/gh_woods", "ssh_port": 22 },
#     "linux-arm64":  { "host": "linux-arm-builder", ... },
#     "darwin-x64":   { "host": "macintel",        ... },
#     "darwin-arm64": { "host": "macbook-air",     ... },
#     "win32-x64":    { "host": "win10-builder",   ... }
#   }
#
# The orchestrator's own host (whatever it is) is auto-detected; the
# matching config entry is overridden to use the local host (no SSH).
#
# Pre-staging: set LOCAL_CI_ARTIFACTS_DIR=/path to skip legs whose
# artifacts are already at $LOCAL_CI_ARTIFACTS_DIR/<platform>/. Mirrors
# Yaw Terminal's contract.
#
# Resume: re-running with --only <platform> re-runs just that leg. A leg
# whose artifact is already attached to the release (or already in
# LOCAL_CI_ARTIFACTS_DIR) is skipped. The release's asset list is the
# source of truth for "what's already shipped."
#
# Output: per-leg logs to stderr; final "all assets attached" line to
# stdout. Suitable for piping to CI dashboards.

set -euo pipefail

# ---- Args ----
VERSION=""
CONFIG_PATH=""
ONLY_PLATFORMS=()

usage() {
  cat <<'EOF'
Usage: scripts/build-platforms-all.sh <version> [--config PATH] [--only PLATFORM]...

Builds the @yawlabs/mcp SEA binary on every configured host in parallel,
rsync-pulls the artifacts back to a single staging dir, verifies each,
and attaches every asset (binary + sha256 sidecar) to the v<version>
GitHub release.

Options:
  --config PATH       Path to platforms.json (default: bin/platforms.json)
  --only PLATFORM     Limit to one or more platforms (e.g. linux-x64)
  -h, --help          This help

Environment:
  LOCAL_CI_ARTIFACTS_DIR
                     If set, skip legs whose <platform>/ subdir already
                     has a staged asset. Mirrors yaw/release.sh's
                     pre-staging contract.
  SSH_CMD            Override the SSH command (default: ssh -o
                     IdentitiesOnly=yes). Useful for tailnet / IAP
                     wrappers.
  DRY_RUN            If set, print the leg commands without executing.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --only)
      shift
      while [ $# -gt 0 ] && [[ "$1" != --* ]]; do
        ONLY_PLATFORMS+=("$1")
        shift
      done
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown flag: $1" >&2
      usage >&2
      exit 64
      ;;
    *)
      if [ -n "$VERSION" ]; then
        echo "Multiple versions supplied: '$VERSION' and '$1'" >&2
        exit 64
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  usage >&2
  exit 64
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version: $VERSION (expected X.Y.Z)" >&2
  exit 64
fi

# ---- Detect the orchestrator's own host ----
# MINGW on Windows ARM64 reports x86_64 via uname -m (MINGW quirk); node
# reports arm64 correctly. Use node to avoid the wrong-arch-on-arm64-box
# trap that bit the mcp-publisher selection in release.sh.
HOST_INFO=$(node -e 'process.stdout.write(process.platform + " " + process.arch)')
case "$HOST_INFO" in
  "linux x64")    THIS_PLATFORM=linux-x64 ;;
  "linux arm64")  THIS_PLATFORM=linux-arm64 ;;
  "darwin x64")   THIS_PLATFORM=darwin-x64 ;;
  "darwin arm64") THIS_PLATFORM=darwin-arm64 ;;
  "win32 x64")    THIS_PLATFORM=win32-x64 ;;
  "win32 arm64")  THIS_PLATFORM=win32-arm64 ;;
  *) echo "Unsupported orchestrator host: $HOST_INFO" >&2; exit 1 ;;
esac

# ---- Resolve config ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="${CONFIG_PATH:-$REPO_ROOT/bin/platforms.json}"
if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config not found: $CONFIG_PATH" >&2
  echo "Copy bin/platforms.json.example to bin/platforms.json and fill in the hosts." >&2
  exit 1
fi

# Validate the release + tag exist on origin BEFORE we burn 5+ minutes
# building (a typo in the version would otherwise produce 5 orphans in
# LOCAL_CI_ARTIFACTS_DIR).
if ! git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | grep -qE 'refs/tags/v[0-9]'; then
  echo "Tag v${VERSION} not found on origin -- run the main release path (./release.sh $VERSION) on the release-driver machine first." >&2
  exit 1
fi
if ! gh release view "v${VERSION}" >/dev/null 2>&1; then
  echo "GitHub release v${VERSION} does not exist -- run the main release path first." >&2
  exit 1
fi

# ---- Pre-flight: every needed tool exists ----
command -v gh    >/dev/null || { echo "gh not installed" >&2; exit 1; }
command -v rsync >/dev/null || echo "rsync not installed (will fall back to scp)" >&2
command -v ssh   >/dev/null || { echo "ssh not installed" >&2; exit 1; }
command -v scp   >/dev/null || { echo "scp not installed" >&2; exit 1; }
command -v node  >/dev/null || { echo "node not installed" >&2; exit 1; }

# ---- Load + filter the platform list ----
# Read platforms.json via node (already a hard dep) instead of jq (may not
# be on every host). node prints one platform per line in the order they
# appear in the config.
ALL_PLATFORMS=$(node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
  // Skip keys starting with "_" (JSON-with-comments uses _comment) so a
  // misconfigured example file doesnt trigger a "no config for platform:
  // _comment" warning.
  for (const k of Object.keys(cfg)) {
    if (k.startsWith("_")) continue;
    process.stdout.write(k + "\n");
  }
' "$CONFIG_PATH")

# Apply --only filter. Empty filter = all platforms.
if [ ${#ONLY_PLATFORMS[@]} -gt 0 ]; then
  FILTERED=""
  for plat in $ALL_PLATFORMS; do
    for want in "${ONLY_PLATFORMS[@]}"; do
      if [ "$plat" = "$want" ]; then
        FILTERED="$FILTERED $plat"
        break
      fi
    done
  done
  ALL_PLATFORMS=$(echo $FILTERED | tr ' ' '\n' | grep -v '^$' || true)
  if [ -z "$ALL_PLATFORMS" ]; then
    echo "No matching platforms in $CONFIG_PATH for: ${ONLY_PLATFORMS[*]}" >&2
    exit 1
  fi
fi

# ---- Local artifact staging dir ----
LOCAL_CI_ARTIFACTS_DIR="${LOCAL_CI_ARTIFACTS_DIR:-$(mktemp -d)}"
mkdir -p "$LOCAL_CI_ARTIFACTS_DIR"
echo "[orchestrator] staging dir: $LOCAL_CI_ARTIFACTS_DIR" >&2
echo "[orchestrator] target release: v${VERSION}" >&2
echo "[orchestrator] orchestrator host: $THIS_PLATFORM" >&2
echo "[orchestrator] platforms: $(echo $ALL_PLATFORMS | tr '\n' ' ')" >&2

# ---- SSH command template ----
# Default: -i ~/.ssh/gh_woods + IdentitiesOnly=yes. Override via SSH_CMD
# to wrap in tailnet or IAP-specific transports.
SSH_DEFAULT="ssh -o IdentitiesOnly=yes -o BatchMode=yes"
SSH_CMD="${SSH_CMD:-$SSH_DEFAULT}"

# ---- Build one leg ----
# Args: platform, host, ssh_user, ssh_key, ssh_port
# Stdout: nothing (logs go to a per-leg log file in $STAGE_LOG_DIR)
# Stderr: per-leg log (the file)
# Exit: 0 on success; non-zero on failure
# Side effects: $LOCAL_CI_ARTIFACTS_DIR/<platform>/ contains the binary
# and .sha256 sidecar.
run_leg() {
  local plat="$1"
  local host="$2"
  local ssh_user="$3"
  local ssh_key="$4"
  local ssh_port="$5"

  local plat_dir="$LOCAL_CI_ARTIFACTS_DIR/$plat"
  mkdir -p "$plat_dir"

  # Pre-staged? An existing binary + sha256 means a prior run (this
  # session, or a manual pre-stage) already produced the artifact.
  if [ -n "$(ls "$plat_dir"/yaw-mcp-* 2>/dev/null | grep -v '\.sha256$' | head -1)" ]; then
    echo "[$plat] pre-staged, skipping leg" >&2
    return 0
  fi

  # The orchestrator's own host runs the leg locally. SSH to a remote
  # host for the others.
  if [ "$plat" = "$THIS_PLATFORM" ]; then
    echo "[$plat] local leg (orchestrator host)" >&2
    if [ -n "${DRY_RUN:-}" ]; then
      echo "[$plat] DRY: ./scripts/build-platform-remote.sh $VERSION" >&2
      echo "$plat_dir/yaw-mcp-$plat"  # placeholder for dry-run
      return 0
    fi
    local asset
    asset=$(cd "$REPO_ROOT" && bash scripts/build-platform-remote.sh "$VERSION")
    # Place into $plat_dir (build-platform-remote writes to $REPO_ROOT/dist-release;
    # for the local case the binary lives at $REPO_ROOT/dist-release already and
    # the orchestrator just needs the path). Copy to plat_dir for uniformity.
    cp "$asset" "$plat_dir/" || true
    cp "${asset}.sha256" "$plat_dir/" 2>/dev/null || true
  else
    echo "[$plat] remote leg -> $ssh_user@$host:$ssh_port" >&2
    if [ -n "${DRY_RUN:-}" ]; then
      echo "[$plat] DRY: $SSH_CMD -i $ssh_key -p $ssh_port $ssh_user@$host 'cd $REPO_ROOT && bash scripts/build-platform-remote.sh $VERSION'" >&2
      echo "$plat_dir/yaw-mcp-$plat"  # placeholder
      return 0
    fi
    # Capture the asset path on the LAST stdout line. Everything else
    # goes to stderr. Mirrors the Yaw Terminal contract.
    local asset
    asset=$(
      $SSH_CMD -i "$ssh_key" -p "$ssh_port" "$ssh_user@$host" \
        "cd '$REPO_ROOT' && bash scripts/build-platform-remote.sh '$VERSION'" \
        2>>"$plat_dir/leg.log"
    )
    # `tail -n1` of the captured stdout is the asset path; defensive
    # against a stray trailing newline or info line the leg added.
    asset=$(echo "$asset" | tail -n1 | tr -d '\r')
    if [ -z "$asset" ] || [ ! -f "$asset" ]; then
      echo "[$plat] leg did not return a valid asset path (got: '$asset'). See $plat_dir/leg.log" >&2
      return 1
    fi
    # rsync (or scp fallback) the staged binary + .sha256 back to the
    # orchestrator. rsync preserves the executable bit; scp does too on
    # POSIX, but the binary is then chmod +x on arrival.
    if command -v rsync >/dev/null 2>&1; then
      rsync -a -e "$SSH_CMD -i $ssh_key -p $ssh_port" \
        "$ssh_user@$host:$asset" "$plat_dir/" || return 1
      rsync -a -e "$SSH_CMD -i $ssh_key -p $ssh_port" \
        "$ssh_user@$host:${asset}.sha256" "$plat_dir/" 2>/dev/null || true
    else
      scp -i "$ssh_key" -P "$ssh_port" "$ssh_user@$host:$asset" "$plat_dir/" || return 1
      scp -i "$ssh_key" -P "$ssh_port" "$ssh_user@$host:${asset}.sha256" "$plat_dir/" 2>/dev/null || true
    fi
    chmod +x "$plat_dir/$(basename "$asset")" 2>/dev/null || true
  fi
}

# ---- Per-leg status tracking ----
declare -A LEG_PIDS LEG_LOGS
STAGE_LOG_DIR="$LOCAL_CI_ARTIFACTS_DIR/_logs"
mkdir -p "$STAGE_LOG_DIR"

# ---- Dispatch all legs in parallel ----
echo "[orchestrator] starting parallel legs" >&2
STARTED_AT=$(date +%s)
FAIL=0
for plat in $ALL_PLATFORMS; do
  # Read per-platform config via node
  read -r host ssh_user ssh_key ssh_port < <(node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
    const p = cfg[process.argv[2]];
    if (!p) { process.stderr.write("no config for platform: " + process.argv[2] + "\n"); process.exit(1); }
    process.stdout.write((p.host || "") + " " + (p.ssh_user || "") + " " + (p.ssh_key || "") + " " + (p.ssh_port || 22) + "\n");
  ' "$CONFIG_PATH" "$plat")

  if [ -z "$host" ]; then
    echo "[$plat] no host in config -- skipping" >&2
    continue
  fi

  LEG_LOGS[$plat]="$STAGE_LOG_DIR/$plat.log"
  (
    run_leg "$plat" "$host" "$ssh_user" "$ssh_key" "$ssh_port" \
      > "${LEG_LOGS[$plat]}" 2>&1
  ) &
  LEG_PIDS[$plat]=$!
done

# Wait for all legs; fail-closed on any failure (no GitHub Actions
# fallback). Yaw Terminal's contract: any leg failing aborts the release.
for plat in "${!LEG_PIDS[@]}"; do
  if wait "${LEG_PIDS[$plat]}"; then
    echo "[$plat] OK" >&2
  else
    echo "[$plat] FAILED (see ${LEG_LOGS[$plat]})" >&2
    FAIL=1
  fi
done

ELAPSED=$(( $(date +%s) - STARTED_AT ))
if [ "$FAIL" -ne 0 ]; then
  echo "[orchestrator] one or more legs failed after ${ELAPSED}s -- aborting attach" >&2
  exit 1
fi
echo "[orchestrator] all legs completed in ${ELAPSED}s" >&2

# ---- Verify each staged artifact ----
# A binary can arrive structurally wrong (zero bytes, missing sidecar,
# wrong arch). Same gate Yaw Terminal runs for the electron-forge zips.
for plat in $ALL_PLATFORMS; do
  plat_dir="$LOCAL_CI_ARTIFACTS_DIR/$plat"
  asset=$(ls "$plat_dir"/yaw-mcp-* 2>/dev/null | grep -v '\.sha256$' | head -1 || true)
  if [ -z "$asset" ] || [ ! -s "$asset" ]; then
    echo "[$plat] no asset in $plat_dir or zero bytes" >&2
    FAIL=1
    continue
  fi
  if [ ! -f "${asset}.sha256" ]; then
    echo "[$plat] no .sha256 sidecar for $asset" >&2
    FAIL=1
    continue
  fi
  # Verify the sidecar's hash matches the binary
  expected=$(awk '{print $1}' "${asset}.sha256")
  actual=$(sha256sum "$asset" | awk '{print $1}')
  if [ "$expected" != "$actual" ]; then
    echo "[$plat] sha256 mismatch: sidecar says $expected, file is $actual" >&2
    FAIL=1
    continue
  fi
  echo "[$plat] verified: $(basename "$asset") ($actual)" >&2
done
if [ "$FAIL" -ne 0 ]; then
  echo "[orchestrator] verification failed -- refusing to attach" >&2
  exit 1
fi

# ---- Attach each asset to the existing release ----
# Delegate to ./release.sh --upload-asset, which is the canonical attach
# path. Idempotent: re-running on an already-attached asset is a no-op.
ATTACHED=0
SKIPPED=0
for plat in $ALL_PLATFORMS; do
  plat_dir="$LOCAL_CI_ARTIFACTS_DIR/$plat"
  asset=$(ls "$plat_dir"/yaw-mcp-* 2>/dev/null | grep -v '\.sha256$' | head -1 || true)
  if [ -z "$asset" ]; then
    continue
  fi
  bn=$(basename "$asset")
  # Skip if the release already has this asset (resume / re-run).
  if gh release view "v${VERSION}" --json assets --jq ".assets[].name" 2>/dev/null | grep -qxF "$bn"; then
    echo "[$plat] already attached: $bn" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  echo "[$plat] attaching $bn" >&2
  if [ -n "${DRY_RUN:-}" ]; then
    # DRY_RUN short-circuits the upload too -- not just the legs. A test
    # pre-staged with fake assets would otherwise pollute the real
    # release (we hit this once during development: DRY_RUN=1 still
    # attached the pre-staged binaries to v0.70.1 because the upload
    # delegates to a child script that does not see DRY_RUN).
    echo "[$plat] DRY: would attach $bn to v${VERSION}" >&2
    ATTACHED=$((ATTACHED + 1))
    continue
  fi
  (cd "$REPO_ROOT" && ./release.sh --upload-asset "$asset" "$VERSION") || {
    echo "[$plat] upload failed" >&2
    FAIL=1
  }
  ATTACHED=$((ATTACHED + 1))
done

if [ "$FAIL" -ne 0 ]; then
  echo "[orchestrator] one or more uploads failed" >&2
  exit 1
fi
echo "[orchestrator] done -- attached: $ATTACHED, skipped (already present): $SKIPPED"
echo "Staging dir: $LOCAL_CI_ARTIFACTS_DIR"
echo "Run scripts/update-manifests.mjs --version $VERSION --push to refresh Scoop + Homebrew"
