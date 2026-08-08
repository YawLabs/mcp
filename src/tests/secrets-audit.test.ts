import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_TAIL_CAP, type AuditEvent, appendAuditEvent, auditLogPath, readAuditLog } from "../secrets-audit.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-audit-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("appendAuditEvent + readAuditLog", () => {
  it("appends events and reads them back in order", async () => {
    await appendAuditEvent({ server: "gh", secret: "token", event: "injected" }, home);
    await appendAuditEvent({ server: "aws", secret: "key", event: "missing" }, home);

    const events = await readAuditLog({}, home);
    expect(events).toHaveLength(2);
    expect(events[0].server).toBe("gh");
    expect(events[0].secret).toBe("token");
    expect(events[0].event).toBe("injected");
    expect(events[1].server).toBe("aws");
    expect(events[1].event).toBe("missing");
    // Every event carries an ISO timestamp.
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("readAuditLog returns [] when the log does not exist", async () => {
    expect(await readAuditLog({}, home)).toEqual([]);
  });

  it("filters by secret name", async () => {
    await appendAuditEvent({ server: "gh", secret: "alpha", event: "injected" }, home);
    await appendAuditEvent({ server: "gh", secret: "beta", event: "injected" }, home);
    const events = await readAuditLog({ secret: "beta" }, home);
    expect(events.map((e) => e.secret)).toEqual(["beta"]);
  });

  it("filters by server namespace", async () => {
    await appendAuditEvent({ server: "gh", secret: "x", event: "injected" }, home);
    await appendAuditEvent({ server: "slack", secret: "x", event: "injected" }, home);
    const events = await readAuditLog({ server: "slack" }, home);
    expect(events.map((e) => e.server)).toEqual(["slack"]);
  });

  it("combines secret + server filters", async () => {
    await appendAuditEvent({ server: "gh", secret: "x", event: "injected" }, home);
    await appendAuditEvent({ server: "gh", secret: "y", event: "missing" }, home);
    await appendAuditEvent({ server: "slack", secret: "x", event: "injected" }, home);
    const events = await readAuditLog({ server: "gh", secret: "y" }, home);
    expect(events).toHaveLength(1);
    expect(events[0].secret).toBe("y");
    expect(events[0].event).toBe("missing");
  });

  it("skips malformed/torn lines without throwing", async () => {
    await appendAuditEvent({ server: "gh", secret: "ok", event: "injected" }, home);
    // Manually append a junk line + a valid-JSON-but-wrong-shape line.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(auditLogPath(home), "this is not json\n");
    appendFileSync(auditLogPath(home), `${JSON.stringify({ ts: "x", server: "y" })}\n`); // missing fields
    const events = await readAuditLog({}, home);
    expect(events).toHaveLength(1);
    expect(events[0].secret).toBe("ok");
  });

  it("NEVER writes a secret value -- the log line carries only names + ts + event", async () => {
    await appendAuditEvent({ server: "gh", secret: "MY_SECRET_NAME", event: "injected" }, home);
    const raw = readFileSync(auditLogPath(home), "utf8");
    const line = JSON.parse(raw.trim());
    expect(Object.keys(line).sort()).toEqual(["event", "secret", "server", "ts"]);
    // No "value"-shaped field, and no extra keys leaked in.
    expect(line).not.toHaveProperty("value");
  });

  it("appendAuditEvent fails open: a write error is swallowed, never thrown", async () => {
    // Force atomicWriteFile (first-write path) to reject. The function must
    // swallow it rather than propagate.
    const atomic = await import("../atomic-write.js");
    const spy = vi.spyOn(atomic, "atomicWriteFile").mockRejectedValue(new Error("disk full"));
    await expect(appendAuditEvent({ server: "gh", secret: "x", event: "injected" }, home)).resolves.toBeUndefined();
    // Without this the test passes vacuously the moment the ESM spy stops
    // intercepting: appendAuditEvent would succeed for real and "did not
    // throw" would prove nothing about the fail-open path.
    expect(spy).toHaveBeenCalled();
  });

  it("tail-caps the log to AUDIT_TAIL_CAP lines on append", async () => {
    // Pre-seed the file just over the cap, then one more append trims it.
    const { writeFileSync } = await import("node:fs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    const overCap = AUDIT_TAIL_CAP + 50;
    const lines: string[] = [];
    for (let i = 0; i < overCap; i++) {
      lines.push(JSON.stringify({ ts: new Date().toISOString(), server: "s", secret: `n${i}`, event: "injected" }));
    }
    writeFileSync(auditLogPath(home), `${lines.join("\n")}\n`);

    await appendAuditEvent({ server: "s", secret: "newest", event: "injected" }, home);

    const events = await readAuditLog({}, home);
    expect(events.length).toBeLessThanOrEqual(AUDIT_TAIL_CAP);
    // The newest event is retained; the oldest were trimmed.
    expect((events as AuditEvent[])[events.length - 1].secret).toBe("newest");
    expect(events.some((e) => e.secret === "n0")).toBe(false);
  });
});

describe("appendAuditEvent -- perms requested on first write", () => {
  it("asks for a 0o600 log inside a 0o700 .yaw-mcp/", async () => {
    // Fresh home: neither the log nor its parent .yaw-mcp/ exists yet, so the
    // first append takes atomicWriteFile's create path -- the log born 0o600
    // (plus a post-hoc chmod) and the parent dir born 0o700. The dir gets NO
    // redundant chmod backup, so the dirMode is the only thing locking it
    // down, matching saveVault.
    //
    // The MODES REQUESTED are the decision this module makes; whether the
    // filesystem then honours POSIX bits is the OS's business, and Windows
    // does not (stat reports a synthetic 0o666), so statting the finished file
    // pinned nothing on the only machine that runs this suite. That the
    // request reaches creat(2)/mkdir(2) is covered in atomic-write.test.ts.
    const atomic = await import("../atomic-write.js");
    const spy = vi.spyOn(atomic, "atomicWriteFile");

    await appendAuditEvent({ server: "gh", secret: "token", event: "injected" }, home);

    const logPath = auditLogPath(home);
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(join(home, ".yaw-mcp"))).toBe(true);
    const call = spy.mock.calls.find((c) => c[0] === logPath);
    expect(call, "the first append did not take the create path").toBeDefined();
    expect(call?.[3]).toBe(0o600);
    expect(call?.[4]).toBe(0o700);
  });

  it("appends to an existing log instead of rewriting it (no second create)", async () => {
    // The counterweight: if the create path ran on every append, the modes
    // above would be asserted about a call the real code only makes once.
    await appendAuditEvent({ server: "gh", secret: "first", event: "injected" }, home);
    const atomic = await import("../atomic-write.js");
    const spy = vi.spyOn(atomic, "atomicWriteFile");
    await appendAuditEvent({ server: "gh", secret: "second", event: "injected" }, home);
    expect(spy.mock.calls.filter((c) => c[0] === auditLogPath(home))).toEqual([]);
    expect((await readAuditLog({}, home)).map((e) => e.secret)).toEqual(["first", "second"]);
  });
});
