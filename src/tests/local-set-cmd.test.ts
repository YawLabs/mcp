import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSetArgs, runEnableDisable, runSet } from "../local-set-cmd.js";

let synthHome: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-set-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

const bundlesPath = (): string => join(synthHome, ".yaw-mcp", "bundles.json");

/** Written as TEXT rather than via JSON.stringify so the comment and the
 *  one-line entry formatting are real, and a lossy rewrite would be visible. */
function writeBundles(body: string): void {
  mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
  writeFileSync(bundlesPath(), body);
}

const SAMPLE = `{
  // my servers -- keep this comment
  "version": 1,
  "servers": [
    { "namespace": "gh", "name": "GitHub", "command": "npx", "args": ["-y", "gh-mcp"], "env": { "GITHUB_TOKEN": "t", "OTHER": "o" } },
    { "namespace": "pg", "name": "Postgres", "command": "npx", "args": ["-y", "pg-mcp"] }
  ]
}
`;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

function read(): { servers: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(bundlesPath(), "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

describe("parseSetArgs", () => {
  it("takes a target and one or more assignments", () => {
    const r = parseSetArgs(["gh", "isActive=false", "runtime=oam"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.target).toBe("gh");
      expect(r.options.assignments).toEqual(["isActive=false", "runtime=oam"]);
    }
  });

  it("refuses a target with nothing to set", () => {
    const r = parseSetArgs(["gh"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nothing to set");
  });

  it("accepts the documented flags and rejects an unknown one", () => {
    for (const flag of ["--json", "--force", "-y", "--yes"]) {
      expect(parseSetArgs(["gh", "isActive=true", flag]).ok).toBe(true);
    }
    const r = parseSetArgs(["gh", "isActive=true", "--nope"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unknown flag");
  });
});

describe("runSet -- comment preservation", () => {
  it("keeps comments and every untouched entry byte-identical", async () => {
    // The reason this command exists rather than reusing add/remove's writer:
    // that one round-trips through JSON.stringify and would drop the comment.
    writeBundles(SAMPLE);
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["isActive=false"], home: synthHome, ...cap });
    expect(r.exitCode).toBe(0);

    const text = readFileSync(bundlesPath(), "utf8");
    expect(text).toContain("// my servers -- keep this comment");
    // The untouched entry keeps its one-line formatting; only the edited one
    // is reflowed by the formatter.
    expect(text).toContain('{ "namespace": "pg", "name": "Postgres", "command": "npx", "args": ["-y", "pg-mcp"] }');
    expect(read().servers[0].isActive).toBe(false);
  });
});

describe("runSet -- a project file that shadows the write", () => {
  it("warns that the edit will not take effect", async () => {
    // A project bundles.json REPLACES the user-global file on load rather than
    // merging with it, so an edit made while one is in effect is real on disk
    // and invisible in the session. `add` and `remove` both say so; `set` was
    // the worst of the three to leave silent, because there is no new entry to
    // go looking for -- just a reported success that changed nothing.
    writeBundles(SAMPLE);
    const projectDir = mkdtempSync(join(synthHome, "proj-"));
    mkdirSync(join(projectDir, ".yaw-mcp"), { recursive: true });
    writeFileSync(
      join(projectDir, ".yaw-mcp", "bundles.json"),
      JSON.stringify({ version: 1, servers: [{ namespace: "other", name: "Other", command: "npx" }] }),
    );

    const cap = capture();
    const r = await runSet({
      target: "gh",
      assignments: ["isActive=false"],
      home: synthHome,
      cwd: projectDir,
      // The shadow verdict is trust-aware; this is the documented bypass, and
      // passing it explicitly is why the option exists.
      env: { YAW_MCP_TRUST_PROJECT: "1" },
      ...cap,
    });

    expect(r.exitCode).toBe(0);
    expect(cap.errText()).toContain("overrides your user-global bundles.json");
  });

  it("stays quiet when no project file is in effect", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    await runSet({
      target: "gh",
      assignments: ["isActive=false"],
      home: synthHome,
      cwd: synthHome,
      env: {},
      ...cap,
    });
    expect(cap.errText()).not.toContain("overrides your user-global");
  });
});

describe("runSet -- scalar fields", () => {
  it("sets, clears and reports each scalar", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    await runSet({
      target: "gh",
      assignments: ["runtime=oam", "connectTimeoutMs=60000", "description=GitHub API"],
      home: synthHome,
      ...cap,
    });
    let entry = read().servers[0];
    expect(entry.runtime).toBe("oam");
    expect(entry.connectTimeoutMs).toBe(60000);
    expect(entry.description).toBe("GitHub API");
    expect(cap.text()).toContain('runtime: unset -> "oam"');

    const cap2 = capture();
    await runSet({ target: "gh", assignments: ["runtime=", "connectTimeoutMs="], home: synthHome, ...cap2 });
    entry = read().servers[0];
    expect(entry.runtime).toBeUndefined();
    expect(entry.connectTimeoutMs).toBeUndefined();
    expect(cap2.text()).toContain('runtime: "oam" -> unset');
  });

  it("types the value from the FIELD, not from the shape of the text", async () => {
    // `description=true` stores the WORD. Guessing the type from the text
    // would make description and isActive disagree about the same characters.
    writeBundles(SAMPLE);
    await runSet({ target: "gh", assignments: ["description=true"], home: synthHome, ...capture() });
    expect(read().servers[0].description).toBe("true");
  });

  it("refuses a value the field cannot take", async () => {
    writeBundles(SAMPLE);
    for (const [assignment, expected] of [
      ["isActive=yes", "must be exactly"],
      ["runtime=deno", 'must be "oam" or "node"'],
      ["connectTimeoutMs=abc", "whole number"],
      ["connectTimeoutMs=0", "must be in 1.."],
      // Refused rather than accepted-and-clamped: the connect path caps
      // silently, so a larger value would be stored and then replaced.
      ["connectTimeoutMs=3000000000", "must be in 1.."],
    ] as const) {
      const cap = capture();
      const r = await runSet({ target: "gh", assignments: [assignment], home: synthHome, ...cap });
      expect(r.exitCode, assignment).toBe(2);
      expect(cap.errText(), assignment).toContain(expected);
    }
    // Nothing was written on any of those.
    expect(readFileSync(bundlesPath(), "utf8")).toBe(SAMPLE);
  });

  it("refuses a field that decides which program gets spawned", async () => {
    writeBundles(SAMPLE);
    for (const key of ["command", "args", "url", "namespace", "transport", "type"]) {
      const cap = capture();
      const r = await runSet({ target: "gh", assignments: [`${key}=x`], home: synthHome, ...cap });
      expect(r.exitCode, key).toBe(2);
      expect(cap.errText(), key).toContain("is not settable");
    }
  });

  it("pins and unpins a server against the idle reaper", async () => {
    // `pinned` is the write half of the reaper exemption (types.ts). Without a
    // verb for it the only way to keep an expensive-to-start server loaded was
    // a hand edit of bundles.json -- a file `add`/`remove` then rewrite
    // wholesale, dropping the comments around it.
    writeBundles(SAMPLE);
    const cap = capture();
    await runSet({ target: "gh", assignments: ["pinned=true"], home: synthHome, ...cap });
    expect(read().servers[0].pinned).toBe(true);
    expect(cap.text()).toContain("pinned: false -> true");

    const cap2 = capture();
    await runSet({ target: "gh", assignments: ["pinned=false"], home: synthHome, ...cap2 });
    expect(read().servers[0].pinned).toBe(false);
    expect(cap2.text()).toContain("pinned: true -> false");
  });

  it("treats an absent pinned as false rather than as unset", async () => {
    // The mirror of the isActive no-op below, in the other direction. Absent
    // reads as NOT pinned everywhere (validateEntry honours only `true`), so
    // `pinned=false` on an entry that never carried the key must report no
    // change instead of dirtying the file to say what it already said.
    writeBundles(SAMPLE);
    const before = readFileSync(bundlesPath(), "utf8");
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["pinned=false"], home: synthHome, ...cap });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(cap.text()).toContain("pinned: already false");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
  });

  it("reports an edit that was already satisfied without writing", async () => {
    writeBundles(SAMPLE);
    const before = readFileSync(bundlesPath(), "utf8");
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["isActive=true"], home: synthHome, ...cap });
    // Absent reads as true, so this is a no-op rather than a write.
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(cap.text()).toContain("No change");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
  });
});

describe("runSet -- env", () => {
  it("sets one variable and leaves the rest of the map alone", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    // --force because this OVERWRITES a stored value, which is confirmed now;
    // the subject here is the splice (one key changes, its siblings do not).
    await runSet({ target: "gh", assignments: ["env.GITHUB_TOKEN=new"], home: synthHome, force: true, ...cap });
    expect(read().servers[0].env).toEqual({ GITHUB_TOKEN: "new", OTHER: "o" });
    // The value is never echoed: this output gets pasted into bug reports.
    expect(cap.text()).toContain("env.GITHUB_TOKEN: set (value not shown)");
    expect(cap.text()).not.toContain("new");
  });

  it("stores an env value TRIMMED", async () => {
    // Padding is what shell quoting adds, never what the user meant to store:
    // a credential with a leading space is exported with that space and fails
    // at the far end for a reason nothing in the transcript explains. Nothing
    // in the product passes an env value with surrounding whitespace, so the
    // trim is invisible until it stops happening.
    writeBundles(SAMPLE);
    const cap = capture();
    // --force: overwriting a stored value is gated, and the subject here is
    // the trim, not the gate.
    const r = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=  padded  "],
      home: synthHome,
      force: true,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    expect(read().servers[0].env).toEqual({ GITHUB_TOKEN: "padded", OTHER: "o" });
  });

  it("reads a whitespace-only value as the CLEAR, not as a stored blank", async () => {
    // The sharp edge of the trim above, and the reason it is worth pinning. In
    // a script `env.TOKEN="$VAL"` with VAL unset expands to a QUOTED run of
    // spaces, which trims to "" and takes the irreversible-clear path -- so the
    // same line under --force silently drops the stored credential instead of
    // storing a blank. Both halves are asserted: off a TTY the confirmation
    // gate catches it and writes nothing, and with --force nothing does.
    // Storing the blank instead would be no better (the loader drops blank env
    // values, so the key would be written and could never take effect), which
    // is why the rule is pinned rather than "fixed" in either direction.
    writeBundles(SAMPLE);
    const cap = capture();
    const gated = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=   "],
      home: synthHome,
      isTTY: false,
      ...cap,
    });
    expect(gated.exitCode).toBe(2);
    expect(cap.errText()).toContain("This clears a stored value");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(SAMPLE);

    const cap2 = capture();
    const forced = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=   "],
      home: synthHome,
      force: true,
      ...cap2,
    });
    expect(forced.exitCode).toBe(0);
    expect(cap2.text()).toContain("env.GITHUB_TOKEN: cleared");
    expect(read().servers[0].env).toEqual({ OTHER: "o" });
  });

  it("clears one variable with --force, keeping the others", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    await runSet({ target: "gh", assignments: ["env.OTHER="], force: true, home: synthHome, ...cap });
    expect(read().servers[0].env).toEqual({ GITHUB_TOKEN: "t" });
    expect(cap.text()).toContain("env.OTHER: cleared");
  });

  it("removes the whole map rather than leaving an empty husk", async () => {
    writeBundles(SAMPLE);
    await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=", "env.OTHER="],
      force: true,
      home: synthHome,
      ...capture(),
    });
    expect(read().servers[0].env).toBeUndefined();
  });

  it("no-ops on a clear of a variable that is not stored", async () => {
    // Deleting under a missing container throws in the parser rather than
    // no-opping, so this path has to be guarded rather than attempted.
    writeBundles(SAMPLE);
    const cap = capture();
    const r = await runSet({ target: "pg", assignments: ["env.NOPE="], home: synthHome, ...cap });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).toContain("env.NOPE: already unset");
  });

  it("refuses a clear that drops a stored value off a TTY", async () => {
    // The one irreversible edit here, so it is confirmed -- and off a TTY
    // there is nothing to ask on.
    writeBundles(SAMPLE);
    const before = readFileSync(bundlesPath(), "utf8");
    const cap = capture();
    const r = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN="],
      home: synthHome,
      isTTY: false,
      ...cap,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.errText()).toContain("refusing to clear");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(before);
  });

  it("declines the clear on anything but an explicit yes", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    const r = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN="],
      home: synthHome,
      promptAnswer: "",
      ...cap,
    });
    expect(r.exitCode).toBe(1);
    expect(read().servers[0].env).toEqual({ GITHUB_TOKEN: "t", OTHER: "o" });
  });

  it("performs the clear when the confirmation is ACCEPTED", async () => {
    // The accept branch is the entire reason the gate exists, and it was the
    // one branch nothing covered: every clear that reaches a write elsewhere in
    // this file passes --force, and the prompt itself was exercised only for
    // the decline. So a gate that took the yes and then wrote nothing -- or
    // wrote and reported the wrong key -- passed the suite. askYesNo trims and
    // lowercases, so the spellings a user actually types have to land on the
    // same branch; "Y" is what catches a dropped .toLowerCase().
    for (const answer of ["y", "yes", "Y"]) {
      writeBundles(SAMPLE);
      const cap = capture();
      const r = await runSet({
        target: "gh",
        assignments: ["env.GITHUB_TOKEN="],
        home: synthHome,
        promptAnswer: answer,
        ...cap,
      });
      expect(r.exitCode, answer).toBe(0);
      // Reported as written AND actually gone from disk -- the value is the
      // one thing here that does not come back.
      expect(r.written, answer).toEqual([bundlesPath()]);
      expect(read().servers[0].env, answer).toEqual({ OTHER: "o" });
      expect(cap.text(), answer).toContain("env.GITHUB_TOKEN: cleared");
    }
  });

  it("confirms a SET that lands on a stored value, and only that one", async () => {
    // This used to read "does not confirm a SET, only a clear", on the theory
    // that an overwrite is recoverable because "the transcript shows what
    // changed". It does not: every env surface here redacts the value, so the
    // replaced credential was unreadable the moment it was replaced. A set
    // over a STORED value is now gated exactly like a clear; a set of a key
    // that is not there still writes straight through, because nothing is lost.
    writeBundles(SAMPLE);
    const overwrite = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=other"],
      home: synthHome,
      isTTY: false,
      ...capture(),
    });
    expect(overwrite.exitCode).toBe(2);
    expect(read().servers[0].env).toEqual({ GITHUB_TOKEN: "t", OTHER: "o" });

    const fresh = await runSet({
      target: "gh",
      assignments: ["env.NEW_KEY=other"],
      home: synthHome,
      isTTY: false,
      ...capture(),
    });
    expect(fresh.exitCode).toBe(0);
  });
});

describe("runSet -- the clear prompt over a real readline", () => {
  // `promptAnswer` and `--force` both short-circuit askYesNo before it builds
  // an interface, so every other test of this gate skips the readline path and
  // its `finally { rl.close() }` entirely. These two drive it for real over a
  // PassThrough pair, the way the sibling `remove` suite does.
  //
  // The two outcomes print the SAME word on DIFFERENT streams -- a cancel is a
  // diagnostic (stderr), a decline is the command's own result (stdout, which
  // has to stay one parseable line under --json). That split is what a
  // refactor collapsing the two branches into one silently breaks, so each
  // test asserts the stream it does NOT land on as well.

  it("Ctrl+C at the prompt is a cancel: 'Aborted.' on STDERR, exit 130, bytes untouched", async () => {
    // Distinct from EOF below: readline owns the keypress and closes the
    // interface with no process-level signal, so reading that close as "" would
    // turn a cancel into the decline -- exit 1 where every other prompt in the
    // product exits 130. terminal:true is what makes readline own the keypress,
    // as it does on a TTY; ETX is built from its code so no control byte sits
    // in this source file.
    writeBundles(SAMPLE);
    const cap = capture();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume();
    const pending = runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN="],
      home: synthHome,
      isTTY: true,
      io: { stdin, stdout, terminal: true },
      ...cap,
    });
    // Let the interface attach before the keypress lands.
    await new Promise<void>((r) => setImmediate(r));
    stdin.write(String.fromCharCode(3));
    const r = await pending;
    expect(r.exitCode).toBe(130);
    expect(r.written).toEqual([]);
    expect(cap.errText()).toContain("Aborted.");
    expect(cap.text()).not.toContain("Aborted.");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(SAMPLE);
  });

  it("EOF at the prompt is a decline: 'Aborted.' on STDOUT, exit 1, bytes untouched", async () => {
    // A piped stdin that runs dry (or Ctrl+D) leaves rl.question() pending
    // forever unless the wrapper aborts it, and a clear that HANGS on EOF is
    // worse than one that refuses: the process ends by event-loop drain at
    // status 0, so a wrapper reading $? takes the non-answer for a success.
    writeBundles(SAMPLE);
    const cap = capture();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const prompt: string[] = [];
    stdout.on("data", (c: Buffer) => prompt.push(c.toString("utf8")));
    // Ended with nothing written: the interface attaches and sees EOF at once.
    stdin.end();
    const r = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN="],
      home: synthHome,
      isTTY: true,
      io: { stdin, stdout },
      ...cap,
    });
    expect(r.exitCode).toBe(1);
    expect(r.written).toEqual([]);
    // The question went to the INJECTED stdout, not the real process's.
    expect(prompt.join("")).toContain('Clear GITHUB_TOKEN on "gh"? [y/N]');
    expect(cap.text()).toContain("Aborted.");
    expect(cap.errText()).not.toContain("Aborted.");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(SAMPLE);
  });
});

describe("runSet -- an env this command cannot edit", () => {
  // `set` exists to service a hand-edited bundles.json, so the file shape it is
  // likeliest to meet is one a human typed wrong. The loader TOLERATES a
  // non-object env (it ignores it, so the entry still loads), which is exactly
  // what lets a bad one survive long enough to reach this command -- and
  // jsonc-parser answered it with `Can not add index to parent of type null`, a
  // parser internal naming no file, no field and no remedy. A CLI whose whole
  // job is servicing hand edits has to NAME the shape instead.
  const withEnv = (envLiteral: string): string => `{
  "version": 1,
  "servers": [
    { "namespace": "gh", "name": "GitHub", "command": "npx", "env": ${envLiteral} }
  ]
}
`;

  for (const [label, envLiteral, assignment] of [
    ["null", "null", "env.A=1"],
    ["an array", "[]", "env.A=1"],
    ["a string, on a set", '"oops"', "env.A=1"],
    // The clear branch was not safe either: its guard only checked the LIVE
    // map's value, and the spread that builds that map turns a string env into
    // index keys, so this threw the same parser internal. No --force here on
    // purpose: a string env makes `env.0=` look like it drops a stored value,
    // so an exit of 1 (this guard) rather than 2 (the clear confirmation)
    // proves the guard runs first.
    ["a string, on a clear", '"oops"', "env.0="],
  ] as const) {
    it(`names the file and the field when env is ${label}`, async () => {
      const body = withEnv(envLiteral);
      writeBundles(body);
      const cap = capture();
      const r = await runSet({ target: "gh", assignments: [assignment], home: synthHome, ...cap });
      expect(r.exitCode, label).toBe(1);
      expect(r.written, label).toEqual([]);
      expect(cap.errText(), label).toContain(bundlesPath());
      expect(cap.errText(), label).toContain('has an "env"');
      // The parser internal never reaches the user.
      expect(cap.errText(), label).not.toContain("Can not add index");
      // A refusal writes nothing at all, including the other assignments.
      expect(readFileSync(bundlesPath(), "utf8"), label).toBe(body);
    });
  }

  it("still allows a scalar edit on an entry whose env is broken", async () => {
    // The guard is scoped to runs that TARGET env. A scalar edit is
    // well-defined on such an entry -- the loader ignores the bad env either
    // way -- so refusing it would be a bigger change than the bug.
    writeBundles(withEnv("null"));
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["isActive=false"], home: synthHome, ...cap });
    expect(r.exitCode).toBe(0);
    expect(read().servers[0].isActive).toBe(false);
  });

  it("refuses a clear of a key whose value is not a string instead of calling it unset", async () => {
    // `env.A=` on `{"A": 5}` printed "already unset" and exited 0 while "A": 5
    // was still in the file -- the CLI reporting success over a key it left
    // behind. The map is well-formed here, so the guard above does not fire;
    // the value is still the user's to fix, so say which key and exit non-zero.
    const body = withEnv('{ "A": 5 }');
    writeBundles(body);
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["env.A="], home: synthHome, ...cap });
    expect(r.exitCode).toBe(1);
    expect(r.written).toEqual([]);
    expect(cap.errText()).toContain(bundlesPath());
    expect(cap.errText()).toContain("env.A");
    expect(cap.errText()).toContain("not a string");
    expect(cap.text()).not.toContain("already unset");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(body);
  });

  it("reports an ABSENT key named after an Object.prototype member as unset", async () => {
    // The map this reads was a spread literal, so it inherited Object.prototype
    // and a lookup for an absent "constructor" came back with a FUNCTION --
    // non-undefined and not a string, which is exactly what the refusal above
    // tests for. So the CLI reported a broken field in the user file over a key
    // that was never in it, the same false-report class that refusal exists to
    // prevent. Nothing else stops this: parseAssignment puts no name rule on an
    // env key. "is a function" was the tell -- no JSON parse can produce one.
    const body = withEnv('{ "TOKEN": "x" }');
    writeBundles(body);
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const cap = capture();
      const r = await runSet({ target: "gh", assignments: [`env.${name}=`], home: synthHome, ...cap });
      expect(r.exitCode, name).toBe(0);
      expect(cap.text(), name).toContain("already unset");
      expect(cap.errText(), name).not.toContain("not a string");
      expect(readFileSync(bundlesPath(), "utf8"), name).toBe(body);
    }
  });

  it("refuses the unclearable key BEFORE prompting about the clearable one", async () => {
    // A mixed run: A is a string, so clearing it is the irreversible edit that
    // prompts; B is a number, so it is refused. The refusal used to sit inside
    // the apply loop, AFTER the confirmation gate -- so the user was asked to
    // confirm dropping A, answered yes, and only then hit the bail on B with
    // nothing written, left believing the drop they had just confirmed had
    // happened. Exit 1 rather than 2 is what proves the ordering here: 2 is the
    // non-TTY stand-in for the prompt, so seeing 1 means the gate never ran.
    const body = withEnv('{ "A": "secret", "B": 5 }');
    writeBundles(body);
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["env.A=", "env.B="], home: synthHome, ...cap });
    expect(r.exitCode).toBe(1);
    expect(r.written).toEqual([]);
    expect(cap.errText()).toContain("env.B");
    expect(cap.errText()).toContain("Nothing was written");
    expect(cap.errText()).not.toContain("This clears a stored value");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(body);
  });
});

describe("runSet -- target resolution", () => {
  it("resolves a stored slug as well as a namespace", async () => {
    writeBundles(`{
  "version": 1,
  "servers": [
    { "namespace": "bravesearch", "slug": "brave-search", "name": "Brave", "command": "npx" }
  ]
}
`);
    const r = await runSet({ target: "brave-search", assignments: ["isActive=false"], home: synthHome, ...capture() });
    expect(r.exitCode).toBe(0);
    expect(read().servers[0].isActive).toBe(false);
  });

  it("reports a miss without writing", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    const r = await runSet({ target: "nope", assignments: ["isActive=false"], home: synthHome, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain('no server named "nope"');
  });

  it("reports a missing bundles.json rather than creating one", async () => {
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["isActive=false"], home: synthHome, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain("no servers configured yet");
  });

  it("refuses to guess at a malformed file", async () => {
    writeBundles("{oops");
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["isActive=false"], home: synthHome, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain("could not be parsed");
  });
});

describe("runSet -- output", () => {
  it("warns when an edit lands on a disabled entry", async () => {
    // The edit is invisible until the entry is enabled, and saying so costs
    // less than a client restart that changes nothing.
    writeBundles(`{
  "version": 1,
  "servers": [{ "namespace": "gh", "name": "GitHub", "command": "npx", "isActive": false }]
}
`);
    const cap = capture();
    await runSet({ target: "gh", assignments: ["runtime=oam"], home: synthHome, ...cap });
    expect(cap.text()).toContain("will NOT load");
    expect(cap.text()).toContain("yaw-mcp enable gh");
  });

  it("does not warn when the edit is the one that enables it", async () => {
    writeBundles(`{
  "version": 1,
  "servers": [{ "namespace": "gh", "name": "GitHub", "command": "npx", "isActive": false }]
}
`);
    const cap = capture();
    await runSet({ target: "gh", assignments: ["isActive=true"], home: synthHome, ...cap });
    expect(cap.text()).not.toContain("will NOT load");
  });

  it("emits JSON that names changed keys but never an env value", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    await runSet({
      target: "gh",
      assignments: ["isActive=false", "env.GITHUB_TOKEN=shhh"],
      json: true,
      // --force: the env assignment overwrites a stored value, which is
      // confirmed now. The subject here is the success envelope's redaction.
      force: true,
      home: synthHome,
      ...cap,
    });
    const parsed = JSON.parse(cap.text());
    expect(parsed.ok).toBe(true);
    expect(parsed.changed).toBe(true);
    expect(parsed.changes).toContainEqual({ field: "env", key: "GITHUB_TOKEN", action: "set" });
    expect(cap.text()).not.toContain("shhh");
  });
});

describe("runEnableDisable", () => {
  it("is exactly set isActive=<bool>", async () => {
    writeBundles(SAMPLE);
    await runEnableDisable({ target: "gh", enabled: false, home: synthHome, ...capture() });
    expect(read().servers[0].isActive).toBe(false);
    await runEnableDisable({ target: "gh", enabled: true, home: synthHome, ...capture() });
    expect(read().servers[0].isActive).toBe(true);
  });

  it("does not order a restart -- a running broker applies the toggle itself", async () => {
    // `yaw-mcp disable gh` used to end on "Restart your MCP client (or
    // yaw-mcp) to apply." A running broker now re-reads bundles.json at its
    // next meta-tool boundary and unloads the server there, so the restart is
    // work the user does not have to do -- and telling them to do it is the
    // one instruction they are most likely to follow.
    writeBundles(SAMPLE);
    const cap = capture();
    await runEnableDisable({ target: "gh", enabled: false, home: synthHome, ...cap });
    expect(read().servers[0].isActive).toBe(false);
    expect(cap.text()).not.toMatch(/Restart your MCP client/);
    expect(cap.text()).toContain("no client restart");
  });

  it("ignores any assignments the caller passes", async () => {
    // The verb IS the assignment; accepting a second one would make
    // `yaw-mcp enable gh runtime=oam` silently do two things.
    writeBundles(SAMPLE);
    await runEnableDisable({
      target: "gh",
      enabled: false,
      assignments: ["runtime=oam"],
      home: synthHome,
      ...capture(),
    });
    expect(read().servers[0].isActive).toBe(false);
    expect(read().servers[0].runtime).toBeUndefined();
  });
});

// --- ship-readiness gaps ----------------------------------------------------

const REMOTE_SAMPLE = `{
  "version": 1,
  "servers": [
    { "namespace": "remote1", "name": "Remote One", "type": "remote", "transport": "streamable-http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer live-token" } }
  ]
}
`;

describe("runSet -- env on a REMOTE entry", () => {
  it("refuses, naming headers as the field that carries the credential", async () => {
    // A remote server spawns no process, so upstream.ts ignores `env` on it
    // outright: the old accept-and-write path reported "env.FOO: set" for an
    // edit that could never reach the server, and `env.FOO=` could never
    // clear a credential because the credential lives in `headers`.
    writeBundles(REMOTE_SAMPLE);
    const cap = capture();
    const r = await runSet({ target: "remote1", assignments: ["env.FOO=bar"], home: synthHome, ...cap });
    expect(r.exitCode).toBe(1);
    expect(r.written).toEqual([]);
    expect(cap.errText()).toContain("headers");
    // And nothing was written -- the file is byte-identical.
    expect(readFileSync(bundlesPath(), "utf8")).toBe(REMOTE_SAMPLE);
  });

  it("refuses a CLEAR too, since the env path cannot reach a header", async () => {
    writeBundles(REMOTE_SAMPLE);
    const cap = capture();
    const r = await runSet({ target: "remote1", assignments: ["env.Authorization="], home: synthHome, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain("headers");
    expect(readFileSync(bundlesPath(), "utf8")).toBe(REMOTE_SAMPLE);
  });

  it("still allows a scalar edit on a remote entry", async () => {
    // The refusal is scoped to env. isActive/description/connectTimeoutMs all
    // mean the same thing on a remote entry as on a local one.
    writeBundles(REMOTE_SAMPLE);
    const r = await runSet({ target: "remote1", assignments: ["isActive=false"], home: synthHome, ...capture() });
    expect(r.exitCode).toBe(0);
    expect(read().servers[0].isActive).toBe(false);
  });
});

describe("runSet -- overwriting a stored env value", () => {
  it("refuses off a TTY without --force: the stored value is destroyed too", async () => {
    // Overwriting is as irreversible as clearing -- the previous value is gone
    // from the file either way, and a scripted `set` that silently replaced a
    // credential was the one destructive edit with no gate.
    writeBundles(SAMPLE);
    const cap = capture();
    const r = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=new"],
      home: synthHome,
      isTTY: false,
      ...cap,
    });
    expect(r.exitCode).toBe(2);
    expect(r.written).toEqual([]);
    expect(read().servers[0].env).toEqual({ GITHUB_TOKEN: "t", OTHER: "o" });
    expect(cap.errText()).toMatch(/refusing to overwrite/);
  });

  it("--force overwrites without asking", async () => {
    writeBundles(SAMPLE);
    const r = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=new"],
      home: synthHome,
      force: true,
      isTTY: false,
      ...capture(),
    });
    expect(r.exitCode).toBe(0);
    expect(read().servers[0].env).toEqual({ GITHUB_TOKEN: "new", OTHER: "o" });
  });

  it("a yes at the prompt overwrites; a bare Enter does not", async () => {
    writeBundles(SAMPLE);
    const declined = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=new"],
      home: synthHome,
      promptAnswer: "",
      ...capture(),
    });
    expect(declined.exitCode).toBe(1);
    expect(read().servers[0].env).toEqual({ GITHUB_TOKEN: "t", OTHER: "o" });

    const accepted = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=new"],
      home: synthHome,
      promptAnswer: "y",
      ...capture(),
    });
    expect(accepted.exitCode).toBe(0);
    expect(read().servers[0].env).toEqual({ GITHUB_TOKEN: "new", OTHER: "o" });
  });

  it("does not ask when the key is NEW -- nothing is destroyed", async () => {
    writeBundles(SAMPLE);
    const r = await runSet({
      target: "gh",
      assignments: ["env.BRAND_NEW=x"],
      home: synthHome,
      isTTY: false,
      ...capture(),
    });
    expect(r.exitCode).toBe(0);
    expect(read().servers[0].env).toMatchObject({ BRAND_NEW: "x" });
  });

  it("does not ask when the value is unchanged -- that write never happens", async () => {
    writeBundles(SAMPLE);
    const r = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=t"],
      home: synthHome,
      isTTY: false,
      ...capture(),
    });
    expect(r.exitCode).toBe(0);
  });

  it("never prints the old or the new value while asking", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN=brandnewsecret"],
      home: synthHome,
      isTTY: false,
      ...cap,
    });
    const all = cap.text() + cap.errText();
    expect(all).not.toContain("brandnewsecret");
  });
});

describe("runSet --json on a destructive refusal", () => {
  it("emits a parseable {ok:false} envelope instead of only an exit code", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    const r = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN="],
      home: synthHome,
      json: true,
      isTTY: false,
      ...cap,
    });
    expect(r.exitCode).toBe(2);
    const lines = cap.errText().trim().split("\n");
    const envelope = JSON.parse(lines[lines.length - 1]) as { ok: boolean; error: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("GITHUB_TOKEN");
  });

  it("emits one for a DECLINED prompt too", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    const r = await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN="],
      home: synthHome,
      json: true,
      promptAnswer: "n",
      ...cap,
    });
    expect(r.exitCode).toBe(1);
    const lines = cap.errText().trim().split("\n");
    const envelope = JSON.parse(lines[lines.length - 1]) as { ok: boolean; aborted?: boolean };
    expect(envelope.ok).toBe(false);
    expect(envelope.aborted).toBe(true);
  });

  it("keeps stdout free of the refusal so a --json consumer never half-parses one", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    await runSet({
      target: "gh",
      assignments: ["env.GITHUB_TOKEN="],
      home: synthHome,
      json: true,
      isTTY: false,
      ...cap,
    });
    expect(cap.text()).toBe("");
  });
});

describe("runSet -- message quality", () => {
  it("says what to do about a file with no servers array", async () => {
    // The sibling message (no file at all) ends in "Add one with `yaw-mcp add
    // <slug>`". This one used to stop at the diagnosis. `add` REFUSES such a
    // file too, so the fix has to be the one that actually works: repair the
    // array, or start over from a file that is not there.
    writeBundles('{ "version": 1 }');
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["isActive=false"], home: synthHome, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain('has no "servers" array');
    expect(cap.errText()).toContain('"servers": []');
  });

  it("names a DIRECTORY at bundles.json as a directory, like `add` does", async () => {
    // `add` says "is a directory, not a file -- move or remove it"; `set` used
    // to surface the raw errno ("could not be read (EISDIR: illegal operation
    // on a directory, read)"), which reads as a permissions problem.
    mkdirSync(bundlesPath(), { recursive: true });
    const cap = capture();
    const r = await runSet({ target: "gh", assignments: ["isActive=false"], home: synthHome, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain("is a directory, not a file");
    expect(cap.errText()).not.toContain("EISDIR");
  });
});

describe("runEnableDisable -- error prefix", () => {
  it("names the verb the user typed, not `set`", async () => {
    // `yaw-mcp enable nosuch` reported "yaw-mcp set: no server named ..." --
    // a verb the user never ran, which reads as an internal detail leaking.
    writeBundles(SAMPLE);
    const enableCap = capture();
    const enabled = await runEnableDisable({ target: "nosuch", enabled: true, home: synthHome, ...enableCap });
    expect(enabled.exitCode).toBe(1);
    expect(enableCap.errText()).toContain("yaw-mcp enable:");
    expect(enableCap.errText()).not.toContain("yaw-mcp set:");

    const disableCap = capture();
    await runEnableDisable({ target: "nosuch", enabled: false, home: synthHome, ...disableCap });
    expect(disableCap.errText()).toContain("yaw-mcp disable:");
    expect(disableCap.errText()).not.toContain("yaw-mcp set:");
  });

  it("still says `yaw-mcp set:` when set is what ran", async () => {
    writeBundles(SAMPLE);
    const cap = capture();
    await runSet({ target: "nosuch", assignments: ["isActive=true"], home: synthHome, ...cap });
    expect(cap.errText()).toContain("yaw-mcp set:");
  });
});
