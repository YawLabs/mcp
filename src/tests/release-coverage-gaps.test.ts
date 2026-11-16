/**
 * Coverage for release.sh behaviour the existing release-sh.test.ts cases do
 * not reach. Same harness shape as that file: lift the changelog helpers out
 * of release.sh by their marker comments and run them under a real bash in a
 * temp dir holding a fixture CHANGELOG.md.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// Each case spawns a real bash; under a loaded full run that can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const releaseSh = readFileSync(join(repoRoot, "release.sh"), "utf8");

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // A leaked temp dir is not worth failing a suite over.
    }
  }
});

function newTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/** The lines from `start` through the next `end` line, both inclusive; throws when either is missing. */
function extractBlock(start: string, end: string): string {
  const lines = releaseSh.split("\n");
  const from = lines.indexOf(start);
  if (from === -1 || lines.indexOf(start, from + 1) !== -1) {
    throw new Error(`release.sh anchor missing or not unique: ${JSON.stringify(start)}`);
  }
  const to = lines.indexOf(end, from + 1);
  if (to === -1) throw new Error(`release.sh end anchor not found: ${JSON.stringify(end)}`);
  return `${lines.slice(from, to + 1).join("\n")}\n`;
}

/** Run a bash script body in `cwd` without the caller's GIT_* variables, merging stdout and stderr. */
function runBash(body: string, cwd: string): string {
  const file = join(cwd, "harness.sh");
  writeFileSync(file, body);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
  const r = spawnSync("bash", [file], { cwd, encoding: "utf8", env: { ...env, NO_COLOR: "1" } });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

describe("release.sh changelog fence close rule", () => {
  const helpers = extractBlock("# >>> changelog helpers", "# <<< changelog helpers");

  // A fence closes only on a bare line of the opener's character that is at
  // least as long. Each case puts one inner marker inside a ```` fence, right
  // before `## not a heading`, and that marker breaks exactly one clause of the
  // rule. Without that clause the marker closes the fence, the fenced heading
  // ends the section, and the off switch below the fence drops out of the body.
  const cases = [
    { clause: "length: a shorter ``` does not close it", inner: "```" },
    { clause: "character: a ~~~~ does not close it", inner: "~~~~" },
    { clause: "bare line: a ````text does not close it", inner: "````text" },
  ];
  for (const { clause, inner } of cases) {
    it(`keeps a four-backtick fence open (${clause})`, () => {
      const changelog = (heading: string) =>
        [
          "# Changelog",
          "",
          heading,
          "",
          "````",
          inner,
          "## not a heading",
          "````",
          "",
          "Set YAW_MCP_NEW_THING=0 to disable it.",
          "",
          "## 1.1.0",
          "",
          "Old.",
          "",
        ].join("\n");
      const want = `BODY=[|\`\`\`\`|${inner}|## not a heading|\`\`\`\`||Set YAW_MCP_NEW_THING=0 to disable it.||]`;
      for (const heading of ["## Unreleased", "## 1.2.0 -- summary"]) {
        const dir = newTmp("release-fence-close-");
        writeFileSync(join(dir, "CHANGELOG.md"), changelog(heading));
        const out = runBash([helpers, "echo \"BODY=[$(changelog_notes_body 1.2.0 | tr '\\n' '|')]\""].join("\n"), dir);
        expect(out, heading).toContain(want);
      }
    });
  }
});
