import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_DIR } from "./source-files.js";

// index.ts dispatches at import time, so a test cannot import it and call
// what it defines. These read its SOURCE instead, for the things nothing else
// can reach: that the serve path's shutdown closure hands its teardown to
// runShutdown (whose BEHAVIOUR -- the watchdog, the rejecting-shutdown exit --
// is tested by calling it, in shutdown-triggers.test.ts), two entries of the
// --help Environment block, and the --help note on deprecated config keys.

const INDEX = readFileSync(join(SRC_DIR, "index.ts"), "utf8").replace(/\r\n/g, "\n");

describe("index.ts shutdown closure", () => {
  it("runs server.shutdown() through runShutdown, with process.exit and the logger", () => {
    // The one thing a call-level test of runShutdown cannot see: that the
    // serve path actually uses it, rather than awaiting server.shutdown()
    // bare (an uncaught rejection then idles until the 10 s force-exit).
    expect(INDEX).toContain("await runShutdown(() => server.shutdown(), { exit: (code) => process.exit(code), log });");
    // ...and nowhere awaits it bare.
    expect(INDEX).not.toMatch(/await server\.shutdown\(\)/);
  });
});

/** One variable's entry in the --help Environment block: its own line and
 *  every continuation line up to the next line that starts a variable name. */
function environmentEntry(name: string): string {
  const lines = INDEX.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s+${name}\\s`).test(l));
  expect(start, name).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {4}[A-Z][A-Z0-9_]+\s/.test(l));
  expect(end, name).toBeGreaterThan(-1);
  return [lines[start], ...rest.slice(0, end)].join("\n");
}

describe("index.ts --help Environment block", () => {
  it("names every request MCP_CALL_TIMEOUT bounds", () => {
    // proxy.ts runs callTool, readResource and getPrompt under callTimeout();
    // the help named only tools/call after the README row was widened.
    const entry = environmentEntry("MCP_CALL_TIMEOUT");
    for (const request of ["tools/call", "resources/read", "prompts/get"]) {
      expect(entry, request).toContain(request);
    }
    const proxy = readFileSync(join(SRC_DIR, "proxy.ts"), "utf8");
    expect(proxy.match(/timeout: callTimeout\(\)/g)?.length).toBe(3);
  });

  it("names every command that reads YAW_MCP_CATALOG_URL", () => {
    // search-cmd.ts resolves its catalog from the same variable as add and
    // try; a user who set it for a private catalog has to be told it applies.
    const entry = environmentEntry("YAW_MCP_CATALOG_URL");
    for (const command of ["add", "try", "search"]) {
      expect(entry, command).toContain(`\\\`${command}\\\``);
    }
    for (const reader of ["local-add-cmd.ts", "try-cmd.ts", "search-cmd.ts"]) {
      expect(readFileSync(join(SRC_DIR, reader), "utf8"), reader).toContain("env.YAW_MCP_CATALOG_URL");
    }
  });
});

describe("index.ts --help deprecated-keys note", () => {
  it("does not send the user to revoke a token whose issuing service is retired", () => {
    // config-loader.ts and install-cmd.ts already say there is nowhere left to
    // revoke it; the top-level help was the last surface saying "revoke it at
    // its source".
    expect(INDEX).not.toContain("revoke it at its source");
    expect(INDEX).toContain("If you have a token on disk, delete it. There is nowhere left to revoke");
    expect(INDEX).toContain("the hosted service that issued it is retired");
  });
});
