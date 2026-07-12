#!/bin/bash
# =============================================================================
# Release Script -- Bump, tag, publish to npm + MCP registry.
#
# Single-machine flow: lint + typecheck + tests, bump package.json +
# server.json in lockstep, commit + tag + push, publish to npm via
# ~/.npmrc, publish server.json to the MCP registry via mcp-publisher.
# No GitHub release creation, no per-platform build orchestration, no
# SEA binaries. Install story is `npm install -g @yawlabs/mcp` (or
# `npx -y @yawlabs/mcp`) -- see docs/v0.70.3-binary-track-decision.md
# for the rationale on dropping the SEA binary track.
# =============================================================================
# Replaces the earlier .github/workflows/release.yml-driven flow + the
# per-platform SEA build orchestration that briefly lived in
# scripts/build-platforms-all.sh (removed in v0.70.3). The script is
# the single source of truth: it runs the pre-flight gates (lint,
# typecheck, tests, build), bumps package.json + server.json in
# lockstep, commits and tags, publishes to npm via the ~/.npmrc
# automation token, publishes server.json to the MCP registry via
# mcp-publisher, and exits.
#
# Usage:
#   ./release.sh <version>           -- full release (the only mode)
#   ./release.sh -y <version>        -- skip the y/N confirm prompt
#
# Environment:
#   SKIP_CONFIRM=1                   skip the y/N confirm prompt
#   NO_COLOR=1                       disable ANSI colors
#
# Required tools on PATH: node, npm, curl, tar, sha256sum, openssl, git.
# The first run also needs `mcp-publisher` (downloaded to a temp dir on
# demand, sha256-verified against the registry's per-release
# `registry_<ver>_checksums.txt`) and a one-time `mcp-publisher login
# github` (interactive device flow) which persists a JWT at
# ~/.config/mcp-publisher/token.json for subsequent runs.
#
# If interrupted, re-run with the same version -- each step is idempotent.
# =============================================================================

set -euo pipefail
# Single EXIT trap: if we're exiting because of an error, print the failure
# banner; either way, clean up the mcp-publisher temp dir. (Two `trap` calls
# would override each other; bash only runs the most recent one.)
WORKDIR=""
cleanup() {
  rc=$?
  if [ $rc -ne 0 ]; then
    echo -e "\n  ✗ Release failed at line $LINENO (exit code $rc)\n" >&2
  fi
  if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
if [ "${NO_COLOR:-0}" = "1" ] || [ ! -t 1 ]; then
  RED=''; GREEN=''; YELLOW=''; NC=''
fi

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# MCP publisher version -- pinned like any other tool we shell out to. The
# sha256 is fetched at release time from the registry's per-release
# `registry_<ver>_checksums.txt` (NOT a hard-coded constant), so the script
# works for any host platform and any future version bump (just update
# MCP_PUBLISHER_VERSION; the checksums file is the source of truth for both
# tarball selection and verification).
#
# `login github-oidc` is GitHub-Actions-only (requires `id-token: write`), so
# the script's workstation path uses the regular `login github` OAuth device
# flow. One-time interactive setup: `mcp-publisher login github` -- the JWT
# persists at ~/.config/mcp-publisher/token.json for every subsequent run.
MCP_PUBLISHER_VERSION="v1.7.9"

# MINGW64 on Windows ARM64 intermittently segfaults in npm's exit cleanup AFTER
# a tool has finished and printed its report. The tool's OUTPUT is authoritative:
# a 139/134 from `npm run` is tolerated only if the tool's own success marker is
# in the captured output (or a direct re-run bypasses the wrapper). Other
# platforms treat any non-zero as a hard failure.
IS_MINGW_ARM64=false
case "$(uname -s 2>/dev/null)" in
  MINGW*ARM64* | MSYS*ARM64* | CYGWIN*ARM64*) IS_MINGW_ARM64=true ;;
esac

# Run an npm-run-script tool that may segfault on this box. $1 label, $2 script,
# $3 ERE for real failures, $4 (opt) ERE proving the tool ran, $5 (opt) direct
# verify command (no npm-run wrapper) for tools that print no completion marker.
run_npm_check() {
  local label="$1" script="$2" fail_re="$3" done_re="${4:-}" verify_cmd="${5:-}" out rc=0
  # `|| rc=$?` is load-bearing: under `set -e` a bare `out=$(npm run ...)` whose
  # command substitution exits non-zero aborts the function THERE, before the
  # analysis below runs.
  out=$(npm run "$script" 2>&1) || rc=$?
  printf '%s\n' "$out"
  if echo "$out" | grep -qE "$fail_re"; then
    fail "$label failed"
  fi
  [ "$rc" -eq 0 ] && return 0
  if [ "$IS_MINGW_ARM64" = true ] && { [ "$rc" -eq 139 ] || [ "$rc" -eq 134 ]; }; then
    if [ -n "$done_re" ] && echo "$out" | grep -qE "$done_re"; then
      warn "$label: npm exited $rc (ARM64 npm-run cleanup segfault) but the tool completed with no findings -- tolerating"
      return 0
    fi
    if [ -n "$verify_cmd" ] && $verify_cmd >/dev/null 2>&1; then
      warn "$label: npm exited $rc (ARM64 npm-run cleanup segfault); a direct re-run is clean -- tolerating"
      return 0
    fi
  fi
  fail "$label failed (exit $rc)"
}

# Arg parsing -- manual loop. Flags: -y/--yes. Version is positional and
# required. (The --build-only + --upload-asset subcommands were removed in
# v0.70.3 when the SEA binary track was dropped -- npm install is the install
# story now; see docs/v0.70.3-binary-track-decision.md.)
# Env may pre-set SKIP_CONFIRM=1 to skip the y/N prompt (e.g. CI, scripted
# release). Default off. The -y/--yes arg below overrides the env to true.
SKIP_CONFIRM="${SKIP_CONFIRM:-false}"
REMAINING=()
i=0
while [ $i -lt $# ]; do
  arg="${@:$((i+1)):1}"
  case "$arg" in
    -y|--yes) SKIP_CONFIRM=true ;;
    --*) fail "Unrecognized flag: '$arg' (--build-only and --upload-asset were removed in v0.70.3; npm install is the install story now)" ;;
    *) REMAINING+=("$arg") ;;
  esac
  i=$((i+1))
done

VERSION=""
if [ "${#REMAINING[@]}" -gt 0 ]; then
  for arg in "${REMAINING[@]}"; do
    case "$arg" in
      [0-9]*.[0-9]*.[0-9]*)
        [ -n "$VERSION" ] && fail "Multiple versions passed: '$VERSION' and '$arg'"
        VERSION="$arg"
        ;;
      *) fail "Unrecognized argument: '$arg' (expected version X.Y.Z)" ;;
    esac
  done
fi

[ -n "$VERSION" ] || fail "Usage: ./release.sh [-y] <version>"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm  >/dev/null || fail "npm not installed"
command -v git  >/dev/null || fail "git not installed"

# Re-read state from disk at every step boundary (per project rule: release
# scripts must not cache at script-start). Functions call these helpers to
# always reflect the current on-disk state.
current_pkg_version() { node -p "require('./package.json').version"; }
current_server_version() { node -p "require('./server.json').version"; }
current_head_sha() { git rev-parse HEAD; }

# ---------- Main path: full release -------------------------------------------
# 5 steps. The build is just `npm run build` (tsup -> dist/index.js); npm
# publish ships the tarball directly. Install method is
# `npm install -g @yawlabs/mcp` or `npx -y @yawlabs/mcp`. See
# docs/v0.70.3-binary-track-decision.md for the rationale and the
# install-store union follow-up.
TOTAL_STEPS=5

echo -e "${CYAN}Pre-flight checks...${NC}"
CURRENT_VERSION=$(current_pkg_version)
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} -- resuming"
else
  if [ -n "$(git status --porcelain)" ]; then
    fail "Working directory not clean. Commit or stash changes first."
  fi
  info "Current: v${CURRENT_VERSION} -> v${VERSION}"
fi

# Pull the latest remote tags + commits so we can detect a stale local view of
# HEAD (e.g. a previous interrupted run that already pushed the bump).
git fetch --tags --prune origin >/dev/null 2>&1 || warn "git fetch failed (offline?) -- proceeding with local state"
LOCAL_HEAD=$(current_head_sha)
REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  if [ "$RESUMING" = true ]; then
    info "Local HEAD differs from origin/main (resuming after a prior push) -- proceeding"
  else
    fail "Local main is not at origin/main. Pull first: git pull --ff-only origin main"
  fi
fi

# --- Guard: refuse a backward or duplicate version, BEFORE the expensive
# lint/test/build. npm only rejects a below-latest version at publish time
# (step 4), with a cryptic "Cannot implicitly apply the latest tag" error, after
# a full build + tag + push has already happened. Catch it here with a clear
# message. A version that is ALREADY published is a legitimate resume (later
# steps skip it), so only a not-yet-published version at or below the current
# npm latest is blocked.
LATEST_NPM=$(npm view "@yawlabs/mcp" version 2>/dev/null || echo "")
ALREADY_PUBLISHED=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
if [ -n "$LATEST_NPM" ] && [ "$ALREADY_PUBLISHED" != "$VERSION" ]; then
  if node -e 'const a=process.argv[1].split(".").map(Number),b=process.argv[2].split(".").map(Number);for(let i=0;i<3;i++){if((a[i]||0)>(b[i]||0))process.exit(0);if((a[i]||0)<(b[i]||0))process.exit(1);}process.exit(1);' "$VERSION" "$LATEST_NPM"; then
    info "Version ${VERSION} > published latest ${LATEST_NPM}"
  else
    fail "Version ${VERSION} is not greater than the published latest ${LATEST_NPM} -- npm will not move the 'latest' tag backward. This is almost always a fat-finger; pick a version > ${LATEST_NPM}."
  fi
fi

# --- Guard: on a FRESH bump, a tag v${VERSION} that already exists is a
# collision (e.g. a fat-finger reusing an old release number, as 0.8.0 did with
# the 2026-04 tag). Step 3's "tag already exists" branch would silently keep
# the OLD tag and ship the wrong commit. On a resume the tag legitimately
# already points at the bump commit, so this only fires on a fresh bump.
if [ "$RESUMING" != true ] && git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null 2>&1; then
  EXISTING_TAG_COMMIT=$(git rev-list -n1 "v${VERSION}")
  fail "Tag v${VERSION} already exists (at ${EXISTING_TAG_COMMIT:0:9}) -- refusing to reuse an existing release number on a new commit. Pick an unused version, or delete the stale tag if it is wrong."
fi

if [ "$SKIP_CONFIRM" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run lint + typecheck + tests"
  echo "  2. Build the bundled CLI (npm run build)"
  echo "  3. Bump version in package.json + server.json, commit, tag, push"
  echo "  4. Publish to npm (using ~/.npmrc automation token)"
  echo "  5. Publish server.json to the MCP registry (mcp-publisher)"
  echo ""
  echo -e "  Install method is ${CYAN}npm install -g @yawlabs/mcp${NC} (or ${CYAN}npx -y @yawlabs/mcp${NC})."
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

step 1 "Lint + typecheck + tests"
run_npm_check "Lint" lint 'Found [0-9]+ error' 'Checked [0-9]+ files'
run_npm_check "Type check" typecheck 'error TS[0-9]' '' 'npx tsc --noEmit'
npm test || fail "Tests failed"
info "Lint + typecheck + tests passed"

step 2 "Build"
npm run build || fail "Build failed"
info "Build complete"

step 3 "Bump version to $VERSION, commit, tag, and push"
# Re-read current version (the resume path can skip a bump that's already done).
CURRENT_VERSION=$(current_pkg_version)
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "package.json already at v${VERSION} -- skipping bump"
else
  npm version "$VERSION" --no-git-tag-version
  info "package.json bumped"
  # Keep server.json in lockstep -- mcp-publisher's `publish` validates that
  # the referenced npm package exists AND that the version field matches
  # what npm reports (the registry 400s on drift). The script is the
  # single source of truth now; CI no longer rewrites server.json.
  node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('server.json','utf-8')); j.version=process.argv[1]; if(j.packages&&j.packages[0]) j.packages[0].version=process.argv[1]; fs.writeFileSync('server.json', JSON.stringify(j, null, 2) + '\n');" "$VERSION"
  info "server.json bumped"
fi

if [ -n "$(git status --porcelain package.json package-lock.json server.json 2>/dev/null)" ]; then
  git add package.json package-lock.json server.json
  git -c core.hooksPath=/dev/null commit -m "v${VERSION}"
  info "Committed version bump"
else
  info "Nothing to commit (already at v${VERSION})"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "Tag v${VERSION} already exists"
else
  # Annotated (-a) so --follow-tags picks it up; lightweight tags are ignored
  # by --follow-tags and would silently fail to push.
  git tag -a "v${VERSION}" -m "v${VERSION}"
  info "Tag v${VERSION} created"
fi

# Re-verify package.json matches the tag BEFORE pushing -- catching a stale
# local index that was bumped-after-tag here prevents the "tag pushed without
# the matching version bump" failure mode.
PKG_NOW=$(current_pkg_version)
if [ "$PKG_NOW" != "$VERSION" ]; then
  fail "package.json shows $PKG_NOW but tag is v${VERSION} -- refusing to push"
fi
SERVER_NOW=$(current_server_version)
if [ "$SERVER_NOW" != "$VERSION" ]; then
  fail "server.json shows $SERVER_NOW but tag is v${VERSION} -- refusing to push (registry would 400 on drift)"
fi

git push origin main --follow-tags
info "Pushed to origin"

step 4 "Publish to npm"
# The script is the publisher now. ~/.npmrc must carry the automation token
# (NOT a WebAuthn web session -- the npm publishing rule in CLAUDE.md is
# explicit on this: `npm login --auth-type=web` overwrites the automation
# token and the next publish EOTPs on WebAuthn).
PUBLISHED_VERSION=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "@yawlabs/mcp@${VERSION} already on npm -- skipping"
else
  # Retry up to 3 times on EOTP/EAUTH/OTP (WebAuthn-fresh sessions sometimes
  # need ~30s for the auth backend to propagate); fail fast on everything else
  # so a packaging error or duplicate-version doesn't waste 60s spinning.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  while true; do
    PUBLISH_LOG=$(mktemp)
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    if ! grep -qE 'EOTP|EAUTH|one-time password|OTP' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above). If E401/E404, your ~/.npmrc session is stale: see CLAUDE.md npm-token-restore."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  info "Published @yawlabs/mcp@${VERSION} to npm"
fi

step 5 "Publish server.json to MCP registry"
# Check the published-npm first; mcp-publisher's `publish` validates that the
# referenced npm package exists, and the registry mirror can lag the write
# path by seconds.
NPM_NOW=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  NPM_NOW=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
  [ "$NPM_NOW" = "$VERSION" ] && break
  sleep 6
done
if [ "$NPM_NOW" != "$VERSION" ]; then
  fail "npm does not show @yawlabs/mcp@${VERSION} after 60s -- refusing to publish to MCP registry (it would 400)"
fi

# Download + sha256-verify mcp-publisher to a temp dir. Pinned + digest-verified
# the same way the old CI workflow did.
WORKDIR=$(mktemp -d)
# mcp-publisher ships a tarball per (platform, arch). Map the current host to
# the matching tarball name so this works on a Linux, macOS, or Windows
# release-driver machine.
#
# We use node (already a hard dep) rather than `uname` because MINGW64 on
# Windows ARM64 reports x86_64 via `uname -m` even when the kernel is arm64,
# which would pick the wrong Windows binary.
HOST_INFO=$(node -e 'process.stdout.write(process.platform + " " + process.arch)')
case "$HOST_INFO" in
  "linux x64")    GOOS=linux;   GOARCH=amd64 ;;
  "linux arm64")  GOOS=linux;   GOARCH=arm64 ;;
  "darwin x64")   GOOS=darwin;  GOARCH=amd64 ;;
  "darwin arm64") GOOS=darwin;  GOARCH=arm64 ;;
  "win32 x64")    GOOS=windows; GOARCH=amd64 ;;
  "win32 arm64")  GOOS=windows; GOARCH=arm64 ;;
  *) fail "Unsupported host for mcp-publisher: $HOST_INFO" ;;
esac
TARBALL="mcp-publisher_${GOOS}_${GOARCH}.tar.gz"
info "Downloading mcp-publisher ${MCP_PUBLISHER_VERSION} (${GOOS}/${GOARCH})"
curl -fsSL -o "${WORKDIR}/${TARBALL}" \
  "https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}/${TARBALL}"

# Verify against the registry's per-release checksums file. This is the
# source of truth (signed via the release's attestation) and is the only
# correct sha256 to check against for the per-platform tarball we picked.
info "Verifying ${TARBALL} against the release's checksums.txt"
curl -fsSL -o "${WORKDIR}/checksums.txt" \
  "https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}/registry_${MCP_PUBLISHER_VERSION#v}_checksums.txt"
(cd "$WORKDIR" && sha256sum -c --ignore-missing < checksums.txt) || fail "sha256 verification failed for ${TARBALL} -- refusing to run an unverified binary"

# Windows tarballs extract to mcp-publisher.exe, POSIX ones to mcp-publisher.
BIN_NAME="mcp-publisher"
if [ "$GOOS" = "windows" ]; then BIN_NAME="mcp-publisher.exe"; fi
tar -xzf "${WORKDIR}/${TARBALL}" -C "$WORKDIR" "$BIN_NAME"
chmod +x "${WORKDIR}/${BIN_NAME}"
"${WORKDIR}/${BIN_NAME}" --help >/dev/null
info "mcp-publisher ${MCP_PUBLISHER_VERSION} ready (sha256 verified)"

# Auth: the registry's `login github` accepts a pre-set GitHub token via
# `MCP_GITHUB_TOKEN` (or `--token`) and skips the OAuth device flow -- it
# exchanges the GitHub token for a fresh Registry JWT and writes it to
# ~/.config/mcp-publisher/token.json.
TOKEN_FILE="${HOME}/.config/mcp-publisher/token.json"
TOKEN_REFRESHED=false
# Return 0 (true in shell `if`) iff the persisted token is missing, unparseable,
# or expired. Reads the JWT's `exp` claim via node so we don't reinvent the
# JWT parser in bash.
TOKEN_STATUS=$(mktemp)
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  if (!fs.existsSync(path)) { process.stdout.write("missing"); process.exit(0); }
  let t;
  try { t = JSON.parse(fs.readFileSync(path, "utf-8")); } catch { process.stdout.write("unparseable"); process.exit(0); }
  const p = (t.token || "").split(".")[1];
  if (!p) { process.stdout.write("unparseable"); process.exit(0); }
  let claims;
  try { claims = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { process.stdout.write("unparseable"); process.exit(0); }
  if (typeof claims.exp === "number" && claims.exp * 1000 > Date.now()) {
    process.stdout.write("valid");
  } else {
    process.stdout.write("expired");
  }
' "$TOKEN_FILE" > "$TOKEN_STATUS" 2>/dev/null || echo "unparseable" > "$TOKEN_STATUS"
TOKEN_STATE=$(cat "$TOKEN_STATUS")
rm -f "$TOKEN_STATUS"
if [ "$TOKEN_STATE" != "valid" ]; then
  # Token refresh needs a GitHub token with publish rights on
  # `io.github.YawLabs/*` (per the prior release memory for the parallel
  # ssh-mcp repo, the MCP Registry `mcp-publisher` auth needs `read:org`).
  # Resolution order:
  #   1. $GITHUB_TOKEN (explicit env, takes priority -- the operator's
  #      workstation with a fine-grained PAT)
  #   2. $MCP_REGISTRY_TOKEN (an explicit override name some setups use)
  #   3. `gh auth token` (works on any host that has the `gh` CLI
  #      authenticated -- the established fallback for the parallel
  #      ssh-mcp / npmjs-mcp release scripts per their memory)
  # The mcp-publisher binary only needs a GitHub token at login time; it
  # persists its own registry JWT to ${TOKEN_FILE} afterward, so the
  # GitHub token does NOT need to be in env for subsequent releases.
  REGISTRY_GH_TOKEN="${GITHUB_TOKEN:-${MCP_REGISTRY_TOKEN:-}}"
  if [ -z "$REGISTRY_GH_TOKEN" ] && command -v gh >/dev/null 2>&1; then
    if REGISTRY_GH_TOKEN=$(gh auth token 2>/dev/null) && [ -n "$REGISTRY_GH_TOKEN" ]; then
      info "MCP-registry auth: using \`gh auth token\` (fallback)"
    else
      REGISTRY_GH_TOKEN=""
    fi
  fi
  if [ -z "$REGISTRY_GH_TOKEN" ]; then
    fail "mcp-publisher token ${TOKEN_STATE} and no GitHub token available. Set GITHUB_TOKEN (a PAT with publish rights on io.github.YawLabs/*), or run \`gh auth login\` so the \`gh auth token\` fallback works, or run once interactively: ${WORKDIR}/${BIN_NAME} login github"
  fi
  info "MCP-registry token ${TOKEN_STATE} -- refreshing via \`mcp-publisher login github\`"
  MCP_GITHUB_TOKEN="$REGISTRY_GH_TOKEN" "${WORKDIR}/${BIN_NAME}" login github
  TOKEN_REFRESHED=true
else
  info "Reusing persisted mcp-publisher token at ${TOKEN_FILE}"
fi

"${WORKDIR}/${BIN_NAME}" publish
info "Published server.json to MCP registry"

# Final verification across the channels this script owns: npm, the
# MCP registry, and the local git tag.
echo ""
echo -e "${CYAN}Verifying...${NC}"
NPM_FINAL=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$NPM_FINAL" = "$VERSION" ]; then
  info "npm: @yawlabs/mcp@${NPM_FINAL}"
else
  warn "npm shows ${NPM_FINAL:-nothing} (expected $VERSION)"
fi

PKG_FINAL=$(current_pkg_version)
if [ "$PKG_FINAL" = "$VERSION" ]; then
  info "package.json: ${PKG_FINAL}"
else
  warn "package.json shows ${PKG_FINAL} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

echo ""
echo -e "${GREEN}  v${VERSION} released to npm + MCP registry.${NC}"
echo ""
echo -e "  npm:        https://www.npmjs.com/package/@yawlabs/mcp"
echo -e "  registry:   https://registry.modelcontextprotocol.io"
echo ""
echo -e "  Install:    ${CYAN}npm install -g @yawlabs/mcp${NC}"
echo -e "  Or run:     ${CYAN}npx -y @yawlabs/mcp${NC}"
echo ""
