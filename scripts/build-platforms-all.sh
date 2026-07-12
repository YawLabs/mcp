#!/usr/bin/env bash
# Orchestrator: build + stage + verify binaries for ALL 5 SEA platforms
# in a single release. Mirrors the parallel-remote-leg pattern from
# `yaw/release.sh` step 6 + `scripts/build-platforms-{tailnet,gcp-iap}.sh`.
#
# The hard physical constraint for @yawlabs/mcp is that Node SEA cannot
# cross-compile -- the carrier is the host `node` binary. So unlike Yaw
# Terminal (one Linux VM + one MacBook Air builds 5 electron-forge targets
# with cross-compile), we need one host per target: linux-x64, linux-arm64,
# darwin-x64, darwin-arm64, win32-x64 (win32-arm64 is the orchestrator's
# own host by default). This script runs the per-host leg
# (scripts/build-platform-remote.sh) on each, in parallel, pulls the
# staged artifacts back to a single LOCAL_CI_ARTIFACTS_DIR, and verifies
# each (binary present, non-zero, .sha256 sidecar matches).
#
# Asset attachment is NOT this script's job. The operator (or a separate
# release driver) runs ./release.sh --upload-asset for each staged asset
# after the orchestrator prints the handoff. This split is intentional:
# the orchestrator depends only on git + ssh + scp (no `gh` CLI), so it
# can run on any host that has build access to the per-platform build
# machines, even hosts without a GitHub login. It also keeps the build
# step pure -- a broken build cannot corrupt the GitHub release, and a
# broken release cannot retroactively un-stage a built artifact.
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
# whose artifact is already in LOCAL_CI_ARTIFACTS_DIR is skipped; a leg
# with an empty host in the config is skipped (build manually and drop
# the artifact into $LOCAL_CI_ARTIFACTS_DIR/<platform>/ when ready).
#
# Tag validation: `git ls-remote --tags origin` confirms v<version>
# exists on origin BEFORE dispatching. This is the only remote lookup
# the orchestrator does -- no GitHub API, no `gh` CLI, no auth token.
# That's the point of removing `gh` from this script: tag existence is
# a git concern, asset upload is a release concern, and conflating them
# forced the orchestrator onto a host that has GitHub auth.
#
# Queue: --status prints the per-platform build queue (host + transport)
# and exits 0 WITHOUT building. Mirrors how Yaw Terminal's release.sh
# Step 6 reports the parallel-leg dispatch plan before any leg fires --
# the operator (and the chat transcript) see "linux-x64 -> gcp-iap:
# yaw-linux-builder" / "win32-x64 -> gcp-iap: yaw-linux-builder" /
# "win32-arm64 -> local (orchestrator)" before ssh/scp starts, so a
# misconfigured host is visible in chat and not buried in a 10-minute
# leg log. The same queue is also printed at the top of every normal
# run (right after the platform list is resolved) so the transcript
# records what was about to dispatch.
#
# Output: per-leg logs to stderr; final "all assets attached" line to
# stdout. Suitable for piping to CI dashboards.

set -euo pipefail

# ---- Args ----
VERSION=""
CONFIG_PATH=""
ONLY_PLATFORMS=()
STATUS_ONLY=0

usage() {
  cat <<'EOF'
Usage: scripts/build-platforms-all.sh <version> [--config PATH] [--only PLATFORM]...

Builds the @yawlabs/mcp SEA binary on every configured host in parallel,
rsync-pulls the artifacts back to a single staging dir, and verifies
each (binary present, .sha256 sidecar matches). Does NOT attach to the
GitHub release -- run ./release.sh --upload-asset <asset> <version>
per staged artifact after the orchestrator prints the handoff.

Options:
  --config PATH       Path to platforms.json (default: bin/platforms.json)
  --only PLATFORM     Limit to one or more platforms (e.g. linux-x64)
  --status            Print the build queue (platform -> host + transport)
                      and exit 0. No version required; no build, no ssh,
                      no remote lookup. Useful for verifying a config
                      change before kicking off a real run.
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
    --status)
      STATUS_ONLY=1
      shift
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

if [ -z "$VERSION" ] && [ "$STATUS_ONLY" -ne 1 ]; then
  usage >&2
  exit 64
fi
if [ -n "$VERSION" ] && ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
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

# ---- Validate the tag exists on origin BEFORE we burn 5+ minutes
# building (a typo in the version would otherwise produce 5 orphans in
# LOCAL_CI_ARTIFACTS_DIR). Pure git -- no `gh`, no GitHub API, no auth
# token. The release *asset* existence is the upload step's
# responsibility (./release.sh --upload-asset), not the orchestrator's.
# Skipped under --status: a status read should work with no version
# and no remote lookup, so the operator can verify a config change
# before the real run.
if [ "$STATUS_ONLY" -ne 1 ]; then
  if ! git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | grep -qE 'refs/tags/v[0-9]'; then
    echo "Tag v${VERSION} not found on origin -- push the tag first (git push origin v${VERSION})." >&2
    exit 1
  fi
fi

# ---- Pre-flight: every needed tool exists (skipped under --status,
# which never invokes ssh/scp, so a missing tool is irrelevant to
# the queue print). Note: no `gh` here -- asset attach is a separate
# release.sh step that the operator runs after the orchestrator
# finishes.
if [ "$STATUS_ONLY" -ne 1 ]; then
  command -v rsync >/dev/null || echo "rsync not installed (will fall back to scp)" >&2
  command -v ssh   >/dev/null || { echo "ssh not installed" >&2; exit 1; }
  command -v scp   >/dev/null || { echo "scp not installed" >&2; exit 1; }
  command -v node  >/dev/null || { echo "node not installed" >&2; exit 1; }
fi

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

# ---- Classify a host into a transport label ----
# Mirrors Yaw Terminal's release.sh Step 6 vocabulary so the queue is
# readable in chat by anyone who knows the Yaw Terminal build flow:
#   (local)        orchestrator's own host -- no SSH, runs the leg itself
#   (gcp-iap)      GCP Linux VM reached over Identity-Aware Proxy
#   (tailnet)      Mac reached over Tailscale
#   (remote)       generic SSH (tailnet, public IP, DNS -- not specifically
#                  tagged in this script; the operator knows the network)
#   (unconfigured) empty host in platforms.json -- leg will be SKIPPED,
#                  which is what bin/platforms.json does for win32-x64
#                  when the operator builds it manually
# The classification is heuristic (host string match), not a hard
# contract -- it's there to make the queue readable, not to gate runs.
classify_host() {
  local plat="$1"
  local host="$2"
  if [ -z "$host" ]; then
    echo "unconfigured"
    return
  fi
  if [ "$plat" = "$THIS_PLATFORM" ]; then
    echo "local"
    return
  fi
  # GCP IAP builder -- the canonical host string from yaw-linux-builder
  # and its aliases. Keep these strings in sync with
  # scripts/build-platforms-gcp-iap.sh and release.sh.
  case "$host" in
    *yaw-linux-builder*|*linux-builder*) echo "gcp-iap"; return ;;
  esac
  # Tailscale hostname convention. The MCP currently uses real DNS names
  # (e.g. yaw-mac-air.tailnet.example) for the Mac, so anything with
  # .tailnet. is also tailnet.
  case "$host" in
    *.tailnet*|*macbook-air*|*mac-air*) echo "tailnet"; return ;;
  esac
  echo "remote"
}

# ---- Print the build queue (platform -> host + transport) ----
# Goes to stdout -- chat transcripts capture it, and the operator
# sees the dispatch plan before any leg fires. The same lines are
# logged on stderr too so they land in the per-run log file even
# when the operator redirects stdout.
print_queue() {
  # Header line
  if [ "$STATUS_ONLY" -eq 1 ]; then
    printf 'build queue (--status, no build):\n'
  else
    printf 'build queue:\n'
  fi
  # Body -- one line per platform in config order. We use a pipe
  # delimiter between fields because the default IFS (space+tab+newline)
  # collapses empty fields -- `read` with default IFS on
  # "||" (empty host, empty user) puts the next non-empty field (port)
  # into the wrong variable. The '|' character cannot appear in any
  # of the four fields (hostname, user, key path, port) so it's safe.
  for plat in $ALL_PLATFORMS; do
    IFS='|' read -r host ssh_user ssh_key ssh_port < <(node -e '
      const fs = require("fs");
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
      const p = cfg[process.argv[2]] || {};
      process.stdout.write(
        (p.host || "") + "|" +
        (p.ssh_user || "") + "|" +
        (p.ssh_key || "") + "|" +
        String(p.ssh_port || 22) + "\n"
      );
    ' "$CONFIG_PATH" "$plat")
    # Restore default IFS for the rest of the loop body
    unset IFS
    local transport
    transport=$(classify_host "$plat" "$host")
    local where
    if [ "$transport" = "local" ]; then
      where="local (orchestrator: $THIS_PLATFORM)"
    elif [ "$transport" = "unconfigured" ]; then
      where="unconfigured -- leg will be skipped (build manually or set host in $CONFIG_PATH)"
    else
      where="$transport: $ssh_user@$host:$ssh_port"
    fi
    printf '  %-12s -> %s\n' "$plat" "$where"
  done
}

# Always print the queue so the transcript records what was about to
# dispatch. --status exits here without building anything.
print_queue
if [ "$STATUS_ONLY" -eq 1 ]; then
  exit 0
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
      local dry_remote_repo_dir="/tmp/yaw-mcp-build-${VERSION}"
      echo "[$plat] DRY: tar+scp the local repo to $ssh_user@$host:$dry_remote_repo_dir" >&2
      echo "[$plat] DRY: $SSH_CMD -i $ssh_key -p $ssh_port $ssh_user@$host 'REPO_DIR=$dry_remote_repo_dir bash $dry_remote_repo_dir/scripts/build-platform-remote.sh $VERSION'" >&2
      echo "$plat_dir/yaw-mcp-$plat"  # placeholder
      return 0
    fi

    # ---- Push the repo to the remote host ----
    # The per-platform hosts may not have the mcp repo checked out (the
    # yaw-mcp release flow is workstation-driven; the per-host machines
    # are configured for the Yaw Terminal release flow, not for mcp). So
    # we tar+scp a snapshot of the orchestrator's local working tree
    # (excluding node_modules, build artifacts, .git) and extract on
    # the remote. Mirrors yaw/build-platforms-gcp-iap.sh:130, which
    # gcp_scp_to a tarball and untar's it on the GCP VM before each
    # build. The remote leg runs from REMOTE_REPO_DIR (passed via
    # REPO_DIR env var) instead of the script's own location.
    #
    # The remote side uses /tmp/ (the per-host machines are Linux/Mac, where
    # /tmp/ is well-defined). The local (orchestrator) staging path must NOT
    # be a literal /tmp/ -- the orchestrator may run on Windows MSYS where
    # /tmp/ doesn't resolve, and even on POSIX using a per-leg dir avoids
    # collision between concurrent legs from the same orchestrator process.
    # mktemp on MSYS bash hard-codes /tmp/ regardless of -p, so we use
    # a deterministic path under the staging dir instead. The path is
    # PER-LEG (includes $plat) so concurrent legs to the same host don't
    # race on the same file.
    local remote_repo_dir="/tmp/yaw-mcp-build-${VERSION}"
    local tarball_dir="${LOCAL_CI_ARTIFACTS_DIR:-${STAGE_LOG_DIR:-.}}/_tarballs"
    mkdir -p "$tarball_dir"
    local tarball="${tarball_dir}/yaw-mcp-build-${VERSION}-${plat}.tar.gz"
    echo "[$plat] pushing repo snapshot to $ssh_user@$host:$remote_repo_dir" >&2
    # Build the tarball from the orchestrator's local working tree.
    # Exclude everything that gets regenerated on first build (node_modules,
    # bin, build-tmp, dist, dist-release) and the .git dir (we don't
    # need the remote to have the full git history -- the orchestrator's
    # `git rev-parse HEAD` is the source of truth for "what was built").
    # Also exclude the LOCAL_CI_ARTIFACTS_DIR (the staging dir lives
    # under the repo, so without this exclusion tar would try to include
    # its own output file and fail with "file changed as we read it").
    # NOTE: package-lock.json is INCLUDED -- the per-host leg runs `npm ci`
    # for a deterministic install, and `npm ci` errors out without the
    # lockfile.
    (cd "$REPO_ROOT" && tar --exclude='./node_modules' --exclude='./bin' \
        --exclude='./build-tmp' --exclude='./dist' --exclude='./dist-release' \
        --exclude='./.git' \
        --exclude='./.build-staging' \
        -czf "$tarball" .) || {
      echo "[$plat] failed to build tarball at $tarball" >&2
      rm -f "$tarball"
      return 1
    }
    # scp the tarball. -P for port on POSIX scp; MSYS-Windows scp on
    # this box uses -P the same way. Use -o for the ssh options. We
    # scp TO a per-leg deterministic remote filename
    # (`/tmp/yaw-mcp-build-${VERSION}-${plat}.tar.gz`) rather than to a
    # directory, so the local mktemp'd name doesn't leak across to the
    # remote side -- the remote untar below references that exact path.
    # Per-leg names matter when the same host is hit by multiple legs
    # (linux-x64 + linux-arm64 both target yaw-linux-builder in the
    # default config).
    scp -i "$ssh_key" -P "$ssh_port" -o IdentitiesOnly=yes \
      "$tarball" "$ssh_user@$host:/tmp/yaw-mcp-build-${VERSION}-${plat}.tar.gz" || {
      echo "[$plat] scp of repo tarball failed" >&2
      rm -f "$tarball"
      return 1
    }
    # Remote side: extract into a clean dir, then rm the tarball.
    # Idempotent: re-running overwrites the previous checkout, so the
    # remote leg always runs against the orchestrator's current HEAD.
    # We unconditionally rm -rf first (the tarball ships without a
    # top-level dir entry, so re-extracting into a non-empty dir would
    # leave stale files).
    $SSH_CMD -i "$ssh_key" -p "$ssh_port" "$ssh_user@$host" \
      "rm -rf '$remote_repo_dir' && mkdir -p '$remote_repo_dir' && \
       tar -xzf '/tmp/yaw-mcp-build-${VERSION}-${plat}.tar.gz' -C '$remote_repo_dir' && \
       rm -f '/tmp/yaw-mcp-build-${VERSION}-${plat}.tar.gz'" \
      || {
      echo "[$plat] remote untar failed" >&2
      rm -f "$tarball"
      return 1
    }
    rm -f "$tarball"

    # ---- Run the per-host leg on the remote ----
    # Capture the asset path on the LAST stdout line. Everything else
    # goes to stderr. Mirrors the Yaw Terminal contract.
    local asset
    asset=$(
      $SSH_CMD -i "$ssh_key" -p "$ssh_port" "$ssh_user@$host" \
        "REPO_DIR='$remote_repo_dir' bash '$remote_repo_dir/scripts/build-platform-remote.sh' '$VERSION'" \
        2>>"$plat_dir/leg.log"
    )
    # `tail -n1` of the captured stdout is the asset path; defensive
    # against a stray trailing newline or info line the leg added.
    # Note: the asset path is REMOTE (e.g. /tmp/yaw-mcp-build-0.70.2/
    # dist-release/yaw-mcp-linux-x64) -- a local `[-f $asset]` would
    # always fail. We don't try to verify the file here; the rsync/scp
    # below will fail if the remote path doesn't exist, and the post-
    # leg local `[-f]` check on $plat_dir/<basename> covers the rest.
    asset=$(echo "$asset" | tail -n1 | tr -d '\r')
    if [ -z "$asset" ]; then
      echo "[$plat] leg did not return an asset path. See $plat_dir/leg.log" >&2
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
  # Read per-platform config via node. Pipe-delimited to preserve empty
  # fields (default IFS on `read` collapses "||" into a single
  # separator, putting the next non-empty field into the wrong var --
  # this is the same bug print_queue() was fixed for; if a future refactor
  # moves the two readers, keep them in sync).
  IFS='|' read -r host ssh_user ssh_key ssh_port < <(node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
    const p = cfg[process.argv[2]];
    if (!p) { process.stderr.write("no config for platform: " + process.argv[2] + "\n"); process.exit(1); }
    process.stdout.write(
      (p.host || "") + "|" +
      (p.ssh_user || "") + "|" +
      (p.ssh_key || "") + "|" +
      String(p.ssh_port || 22) + "\n"
    );
  ' "$CONFIG_PATH" "$plat")
  unset IFS

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
  echo "[orchestrator] verification failed -- refusing to hand off" >&2
  exit 1
fi

# ---- Handoff summary ----
# Asset upload is NOT this script's job (the orchestrator depends only
# on git + ssh + scp -- no `gh` CLI, no GitHub auth). Print the per-
# platform handoff so the operator (or a downstream release driver) can
# run ./release.sh --upload-asset for each artifact.
STAGED=0
echo "[orchestrator] verified artifacts (NOT attached -- run ./release.sh --upload-asset per artifact):"
for plat in $ALL_PLATFORMS; do
  plat_dir="$LOCAL_CI_ARTIFACTS_DIR/$plat"
  asset=$(ls "$plat_dir"/yaw-mcp-* 2>/dev/null | grep -v '\.sha256$' | head -1 || true)
  if [ -z "$asset" ]; then
    continue
  fi
  bn=$(basename "$asset")
  echo "  $plat -> $asset"
  echo "    attach: ./release.sh --upload-asset '$asset' $VERSION"
  STAGED=$((STAGED + 1))
done

echo "[orchestrator] done -- staged: $STAGED"
echo "Staging dir: $LOCAL_CI_ARTIFACTS_DIR"
echo "Run scripts/update-manifests.mjs --version $VERSION --push to refresh Scoop + Homebrew"
