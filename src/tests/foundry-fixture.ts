import { fileURLToPath } from "node:url";

// The routing gate's corpus fixture, as an absolute path. ONE spelling, shared
// by the gate (foundry-routing.test.ts) and by foundry-cmd.test.ts's pin that
// `foundry export`'s DEFAULT_OUT writes exactly here -- so moving either side
// alone fails a test instead of `foundry export` writing where the gate never
// looks. Resolved from this module's URL, not process.cwd(), so a run started
// anywhere but the repo root still finds a committed fixture.
export const FOUNDRY_FIXTURE = fileURLToPath(new URL("./fixtures/foundry-corpus.json", import.meta.url));

// The repo root (this module sits in src/tests/), which DEFAULT_OUT is
// relative to.
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
