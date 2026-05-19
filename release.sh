#!/bin/bash
# =============================================================================
# Release Script — Build, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>    — full release from local machine
#   ./release.sh                  — CI mode (derives version from git tag)
#
# If interrupted, re-run with the same version — each step is idempotent.
#
# Prerequisites:
#   - Node.js 18+ and npm installed
#   - npm authenticated (npm whoami) or NODE_AUTH_TOKEN set
#   - gh CLI authenticated (or GITHUB_TOKEN set)
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  ✗ Release failed at line $LINENO (exit code $?)\033[0m"' ERR

# ---- Helpers ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

TOTAL_STEPS=7

# ---- Resolve version ----
VERSION="${1:-}"
IS_CI="${CI:-false}"

if [ -z "$VERSION" ]; then
  if [ "$IS_CI" = "true" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#v}"
    info "CI mode — version $VERSION from tag $GITHUB_REF_NAME"
  else
    echo "Usage: ./release.sh <version>"
    echo "  e.g. ./release.sh 0.3.1"
    exit 1
  fi
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

# ---- Pre-flight checks ----
echo -e "${CYAN}Pre-flight checks...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} — resuming"
else
  if [ "$IS_CI" != "true" ]; then
    if [ -n "$(git status --porcelain)" ]; then
      fail "Working directory not clean. Commit or stash changes first."
    fi
  fi
  info "Current: v${CURRENT_VERSION} → v${VERSION}"
fi

if [ "$IS_CI" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run lint + tests"
  echo "  2. Build"
  echo "  3. Bump version in package.json"
  echo "  4. Commit, push, wait for ci.yml green on the SHA, then tag"
  echo "  5. Publish to npm"
  echo "  6. Create GitHub release"
  echo "  7. Verify"
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# =============================================================================
# Step 1: Lint
# =============================================================================
step 1 "Lint"

npm run lint || fail "Lint failed"
npm run typecheck || fail "Type check failed"
info "Lint passed"

# =============================================================================
# Step 2: Test
# =============================================================================
step 2 "Test"

npm run build || fail "Build failed"
npm test || fail "Tests failed"
info "All tests passed"

# =============================================================================
# Step 3: Bump version
# =============================================================================
step 3 "Bump version to $VERSION"

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} — skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "Version bumped"
fi

# =============================================================================
# Step 4: Commit, push, gate on green CI, then tag
# =============================================================================
# Why the split:
#   v0.11.0 burned a tag because Linux-only test failures only surfaced
#   inside CI. The fix is: push the version-bump commit first, wait for
#   ci.yml to go green on that exact SHA, THEN create and push the tag.
#   That way bad commits never become bad tags. The tag space stays clean
#   and re-tagging the same version slot becomes unnecessary.
step 4 "Commit, push, wait for CI green, then tag"

if [ "$IS_CI" = "true" ]; then
  info "CI mode — skipping commit/tag/push (already tagged)"
else
  if [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
    git add package.json package-lock.json
    git commit -m "v${VERSION}"
    info "Committed version bump"
  else
    info "Nothing to commit"
  fi

  # Push the commit alone (no tag yet) so ci.yml runs on this SHA.
  git push origin main
  info "Pushed v${VERSION} commit"

  if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
    info "Tag v${VERSION} already exists locally — skipping CI gate"
  else
    SHA=$(git rev-parse HEAD)
    info "Waiting for ci.yml to pass on ${SHA:0:7} before tagging..."

    # Poll ci.yml status on this SHA. Timeout: 15 minutes (90 * 10s).
    GATE_MAX=90
    for i in $(seq 1 $GATE_MAX); do
      RUN_JSON=$(gh run list --workflow=ci.yml --commit="$SHA" --limit 1 --json status,conclusion,databaseId 2>/dev/null || echo "[]")
      if [ "$RUN_JSON" = "[]" ] || [ -z "$RUN_JSON" ]; then
        echo "    ci.yml not started yet for $SHA (attempt $i/$GATE_MAX)..."
        sleep 10
        continue
      fi
      RUN_STATUS=$(echo "$RUN_JSON" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); console.log(j[0]?.status||"")})')
      RUN_CONCLUSION=$(echo "$RUN_JSON" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); console.log(j[0]?.conclusion||"")})')
      RUN_ID=$(echo "$RUN_JSON" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); console.log(j[0]?.databaseId||"")})')

      if [ "$RUN_STATUS" = "completed" ]; then
        if [ "$RUN_CONCLUSION" = "success" ]; then
          info "ci.yml passed on $SHA (run $RUN_ID)"
          break
        fi
        fail "ci.yml ${RUN_CONCLUSION} on $SHA (run $RUN_ID).
       Tag NOT created. Inspect with: gh run view $RUN_ID --log-failed
       Fix the issue, bump version again, and re-run release.sh."
      fi
      echo "    ci.yml ${RUN_STATUS} (attempt $i/$GATE_MAX)..."
      sleep 10
    done

    # If we fell out of the loop without break, the run never completed.
    if [ "$RUN_STATUS" != "completed" ] || [ "$RUN_CONCLUSION" != "success" ]; then
      fail "ci.yml did not finish within 15 minutes. Tag NOT created. Re-run when ci.yml has settled."
    fi

    git tag "v${VERSION}"
    info "Tag v${VERSION} created"
  fi

  git push origin "v${VERSION}"
  info "Pushed tag v${VERSION} — release.yml will publish from green commit"
fi

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
# Two publish paths, and they must not collide:
#   - CI mode: this script IS release.yml — it publishes directly.
#   - Local mode: step 4 already pushed the tag, which triggers
#     release.yml to publish via the org NPM_TOKEN. A local `npm publish`
#     here is redundant, and on a workstation without an `npm login`
#     session it 404s and — under `set -e` — fails the whole script even
#     though the release itself succeeded (this burned every local
#     release into looking broken). So in local mode we WAIT for
#     release.yml to publish — polling `npm view`, same shape as the
#     ci.yml gate in step 4 — and only fall back to a local publish if
#     CI never lands the version.
step 5 "Publish to npm"

PUBLISHED_VERSION=$(npm view @yawlabs/mcph version 2>/dev/null || echo "")

if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm — skipping"
elif [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/mcph@${VERSION} to npm"
else
  # Local mode: release.yml (triggered by the step-4 tag push) is the
  # publish path. Poll npm for up to 10 minutes — release.yml normally
  # finishes in under a minute, so this breaks out almost immediately.
  # Also peek at the release.yml run for THIS tag: if GitHub reports it
  # `completed/failure`, short-circuit to the local-publish fallback
  # rather than burning the full timeout on a run that's already dead.
  info "Waiting for release.yml to publish v${VERSION} (tag pushed in step 4)..."
  PUBLISH_MAX=60
  for i in $(seq 1 $PUBLISH_MAX); do
    PUBLISHED_VERSION=$(npm view @yawlabs/mcph version 2>/dev/null || echo "")
    if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
      info "release.yml published @yawlabs/mcph@${VERSION}"
      break
    fi

    # Server-side filter on the tag name: `--branch="v$VERSION"` matches
    # gh's `headBranch` column, which for tag-push workflows holds the
    # tag name. Avoids the previous post-filter that could miss the
    # target run after several quick releases. --limit 10 is belt and
    # braces in case the branch filter isn't honored by an older gh CLI;
    # if no record matches, the parse below yields empty strings and the
    # poll degrades cleanly to the original 10-minute timeout.
    RELEASE_JSON=$(gh run list --workflow=release.yml --branch="v${VERSION}" --limit 10 \
      --json status,conclusion,databaseId 2>/dev/null || echo "[]")
    # Single node parse extracts status, conclusion, run ID into one
    # tab-separated line so we don't spawn 3 node processes per poll.
    RELEASE_FIELDS=$(echo "$RELEASE_JSON" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); const r=j[0]; console.log([r?.status||"",r?.conclusion||"",r?.databaseId||""].join("\t"))})')
    IFS=$'\t' read -r RELEASE_STATUS RELEASE_CONCLUSION RELEASE_ID <<< "$RELEASE_FIELDS"
    if [ "$RELEASE_STATUS" = "completed" ] && [ "$RELEASE_CONCLUSION" != "success" ]; then
      warn "release.yml ${RELEASE_CONCLUSION} for tag v${VERSION} (run ${RELEASE_ID}) — falling back to local publish."
      warn "Inspect with: gh run view ${RELEASE_ID} --log-failed"
      break
    fi

    echo "    not on npm yet (attempt $i/$PUBLISH_MAX)..."
    sleep 10
  done

  # CI never landed it — fall back to a local publish. This is the only
  # path that needs an `npm login` session; if it also fails, the
  # release genuinely needs a human (check the release.yml run).
  if [ "$PUBLISHED_VERSION" != "$VERSION" ]; then
    warn "release.yml did not publish within 10 minutes — attempting a local publish."
    warn "(needs an \`npm login\` session; if it fails, inspect the release.yml run)"
    npm publish --access public
    info "Published @yawlabs/mcph@${VERSION} to npm (local fallback)"
  fi
fi

# =============================================================================
# Step 6: Create GitHub release
# =============================================================================
step 6 "Create GitHub release"

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists — skipping"
else
  PREV_TAG=$(git tag --sort=-v:refname | grep -A1 "^v${VERSION}$" | tail -1)
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v${VERSION}" ]; then
    CHANGELOG=$(git log --oneline "${PREV_TAG}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /')
  else
    CHANGELOG="Initial release"
  fi

  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "$CHANGELOG"
  info "GitHub release created"
fi

# =============================================================================
# Step 7: Verify
# =============================================================================
step 7 "Verify"

sleep 3

NPM_VERSION=$(npm view @yawlabs/mcph version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/mcph@${NPM_VERSION}"
else
  warn "npm shows ${NPM_VERSION:-nothing} (expected $VERSION — may still be propagating)"
fi

PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$PKG_VERSION" = "$VERSION" ]; then
  info "package.json: ${PKG_VERSION}"
else
  warn "package.json shows ${PKG_VERSION} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}  v${VERSION} released successfully!${NC}"
echo ""
echo -e "  npm: https://www.npmjs.com/package/@yawlabs/mcph"
echo -e "  git: https://github.com/YawLabs/mcph/releases/tag/v${VERSION}"
echo ""
