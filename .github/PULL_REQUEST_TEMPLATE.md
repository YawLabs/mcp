<!--
One logical change per PR (CONTRIBUTING.md). Delete any section that genuinely
does not apply -- an empty heading is noise.
-->

## What this changes

<!-- One or two sentences. What behavior is different after this merges? -->

## Why

<!-- The problem, not the patch. Link the issue if there is one: Fixes #NNN -->

## How it was verified

<!--
CI here is script-driven, not GitHub Actions: nothing runs on push, and
`release.sh` is the gate. State what you ran, so a reviewer knows what is
actually covered.
-->

- [ ] `npm run lint:fix`, `npx tsc --noEmit`, and the full test suite pass locally
- [ ] New or changed behavior has a test that **fails without this change** --
      verified by breaking the code and watching a named test go red, not by
      the test merely passing

<!-- Paste the relevant tail of the gate output, or say which steps you skipped and why. -->

## Behavior change for existing users

<!--
This package has real installs. A default that changes without an opt-in
changes what already-working setups do on their next upgrade, silently.
-->

- [ ] Nothing here changes behavior for an existing user without them opting in
- [ ] It does. The off switch is: <!-- e.g. YAW_MCP_MAX_RESULT_BYTES=0 -->
      and it is documented in `CHANGELOG.md` and the env table

## Overlap with work already in flight

<!--
Two PRs can each report "mergeable: CLEAN" against main and still conflict with
each other -- GitHub only checks each one pairwise against the base. Two
branches can also implement the same feature independently.
-->

- [ ] Checked the other open PRs and branches for file and feature overlap
- [ ] Where more than one is open: `git merge-tree --write-tree <thisBranch> <otherBranch>`
      reports no conflict, or the overlap is called out below

## Checklist

- [ ] Public behavior changes are reflected in `CHANGELOG.md` under `## Unreleased`
- [ ] Docs updated if this changes a flag, an env var, a meta-tool schema, or a config field
- [ ] No credential, token, or internal URL appears in the diff
- [ ] No new `.github/workflows/*` -- releases here are script-gated, not Actions
