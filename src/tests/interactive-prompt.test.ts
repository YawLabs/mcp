// isInteractivePrompt -- THE TTY verdict for every confirmation the commands
// ask. Nine command files used to carry a private copy; the copies agreed on
// the two test hooks and had drifted on which streams they judged.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isInteractivePrompt } from "../readline-question.js";

const tty = (isTTY: boolean): PassThrough => Object.assign(new PassThrough(), { isTTY });

describe("isInteractivePrompt", () => {
  it("isTTY forces the verdict, over a canned answer and over the streams", () => {
    const io = { stdin: tty(true), stdout: tty(true) };
    expect(isInteractivePrompt({ isTTY: false, promptAnswer: "y", io })).toBe(false);
    expect(isInteractivePrompt({ isTTY: true, io: { stdin: tty(false), stdout: tty(false) } })).toBe(true);
  });

  it("a canned promptAnswer is interactive: nothing is read, so nothing need be a TTY", () => {
    expect(isInteractivePrompt({ promptAnswer: "n", io: { stdin: tty(false), stdout: tty(false) } })).toBe(true);
    // An EMPTY canned answer is still a canned answer.
    expect(isInteractivePrompt({ promptAnswer: "", io: { stdin: tty(false), stdout: tty(false) } })).toBe(true);
  });

  it("otherwise BOTH injected ends must be a TTY -- the streams the prompt would use", () => {
    expect(isInteractivePrompt({ io: { stdin: tty(true), stdout: tty(true) } })).toBe(true);
    expect(isInteractivePrompt({ io: { stdin: tty(true), stdout: tty(false) } })).toBe(false);
    expect(isInteractivePrompt({ io: { stdin: tty(false), stdout: tty(true) } })).toBe(false);
    // A plain stream has no isTTY at all.
    expect(isInteractivePrompt({ io: { stdin: new PassThrough(), stdout: new PassThrough() } })).toBe(false);
  });

  it("falls back to process.std* for an end that was not injected", () => {
    const real = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    expect(isInteractivePrompt({})).toBe(real);
    expect(isInteractivePrompt({ io: { stdin: tty(true) } })).toBe(Boolean(process.stdout.isTTY));
  });

  it("is the only TTY verdict in src/: no command re-derives it from process.std*", () => {
    // The shape every private copy had. secrets-cmd.ts's ttyEnds is not one:
    // it reports each end separately, for the refusal that names which failed.
    // install-cmd.ts is left out by name: its prompt options are a different
    // shape (`io.isTTY`, one flag for the injected streams, and a
    // three-valued promptAnswer), which this helper does not model.
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders = readdirSync(src)
      .filter((f) => f.endsWith(".ts") && f !== "readline-question.ts" && f !== "install-cmd.ts")
      .filter((f) =>
        /process\.stdin\.isTTY\)? *&& *(Boolean\()?process\.stdout\.isTTY/.test(readFileSync(join(src, f), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});
