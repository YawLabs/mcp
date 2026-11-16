// killAndDetach: the expiry teardown uv-bootstrap.ts (probePath, runCommand)
// and oam-spawn.ts (spawnVersionProbe) share. Each of its four steps is
// guarded on its own, so these drive it with a fake child whose steps can be
// made to throw one at a time.

import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killAndDetach } from "../bounded-child.js";

interface FakeOptions {
  /** Steps that throw when called. */
  throws?: Array<"kill" | "stdout" | "stderr" | "unref">;
  /** false: the child was spawned without that pipe (stdio "ignore"). */
  stdout?: boolean;
  stderr?: boolean;
}

function fakeChild(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const step = (name: "kill" | "stdout" | "stderr" | "unref", record: string): void => {
    calls.push(record);
    if (opts.throws?.includes(name)) throw new Error(`${name} failed`);
  };
  const child = {
    kill: (signal?: NodeJS.Signals) => {
      step("kill", `kill:${String(signal)}`);
      return true;
    },
    stdout: opts.stdout === false ? null : { destroy: () => step("stdout", "stdout.destroy") },
    stderr: opts.stderr === false ? null : { destroy: () => step("stderr", "stderr.destroy") },
    unref: () => step("unref", "unref"),
  };
  return { child: child as unknown as ChildProcess, calls };
}

describe("killAndDetach", () => {
  it("kills with SIGKILL by default, destroys both pipes, then unrefs", () => {
    const { child, calls } = fakeChild();
    killAndDetach(child);
    expect(calls).toEqual(["kill:SIGKILL", "stdout.destroy", "stderr.destroy", "unref"]);
  });

  it("sends the signal the caller names instead", () => {
    const { child, calls } = fakeChild();
    killAndDetach(child, "SIGTERM");
    expect(calls[0]).toBe("kill:SIGTERM");
  });

  it("skips a pipe the child was spawned without, and does not throw", () => {
    const { child, calls } = fakeChild({ stdout: false, stderr: false });
    expect(() => killAndDetach(child)).not.toThrow();
    expect(calls).toEqual(["kill:SIGKILL", "unref"]);
  });

  // One guard per step: a throw from any step must not skip the ones after
  // it. The originals shared a guard between a destroy and the unref, so a
  // throwing destroy left the child holding the parent's event loop open.
  it.each([
    "kill",
    "stdout",
    "stderr",
    "unref",
  ] as const)("a throwing %s neither escapes nor skips a later step", (name) => {
    const { child, calls } = fakeChild({ throws: [name] });
    expect(() => killAndDetach(child)).not.toThrow();
    expect(calls).toEqual(["kill:SIGKILL", "stdout.destroy", "stderr.destroy", "unref"]);
  });

  it("still unrefs when every earlier step throws", () => {
    const { child, calls } = fakeChild({ throws: ["kill", "stdout", "stderr"] });
    expect(() => killAndDetach(child)).not.toThrow();
    expect(calls.at(-1)).toBe("unref");
  });
});
