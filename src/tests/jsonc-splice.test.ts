// Byte-exact pins for the comment-preserving splice in jsonc.ts.
//
// Every expectation here is a whole file, compared with toBe: the bug these
// guard against was never a wrong VALUE (the parsed result was always right)
// but wrong BYTES next to the edit -- a neighbouring entry re-rendered in
// another indent step, its `// comment` moved onto the new entry, or deleted
// outright on removal. A parse-and-compare assertion passes on all of that.

import { describe, expect, it } from "vitest";
import { editJsoncEntry, editJsoncPath, parseJsonc, removeJsoncEntry } from "../jsonc.js";

const lf = (...lines: string[]): string => lines.join("\n");
const crlf = (...lines: string[]): string => lines.join("\r\n");

const ENTRY = { command: "npx", args: ["-y", "@yawlabs/mcp"] };

/** The cursor repro: a 4-space file whose only server is written on one line
 *  with a trailing `// comment`. */
const CURSOR_4SPACE = lf(
  "{",
  '    "mcpServers": {',
  '        "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] } // fs server',
  "    }",
  "}",
  "",
);

const TAB_FILE = lf("{", '\t"mcpServers": {', '\t\t"a": { "command": "x" } // c', "\t}", "}", "");

const CRLF_FILE = crlf("{", '  "mcpServers": {', '    "a": 1 // c', "  }", "}", "");

const TRAILING_COMMA = lf("{", '  "mcpServers": {', '    "a": 1, // c', "  }", "}", "");

const NESTED_LOCAL = lf(
  "{",
  '  "projects": {',
  '    "/work/app": {',
  '      "allowedTools": [], // mine',
  '      "mcpServers": {',
  '        "db": { "command": "pg" } // local db',
  "      }",
  "    }",
  "  }",
  "}",
  "",
);

describe("editJsoncEntry -- insert leaves the previous entry's bytes alone", () => {
  it("cursor repro: sibling line gains only its separator comma; new entry below the comment, 4-space step", () => {
    expect(editJsoncEntry(CURSOR_4SPACE, ["mcpServers"], "mcp", ENTRY)).toBe(
      lf(
        "{",
        '    "mcpServers": {',
        '        "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }, // fs server',
        '        "mcp": {',
        '            "command": "npx",',
        '            "args": [',
        '                "-y",',
        '                "@yawlabs/mcp"',
        "            ]",
        "        }",
        "    }",
        "}",
        "",
      ),
    );
  });

  it("tab-indented file: the new entry is tab-indented", () => {
    expect(editJsoncEntry(TAB_FILE, ["mcpServers"], "mcp", ENTRY)).toBe(
      lf(
        "{",
        '\t"mcpServers": {',
        '\t\t"a": { "command": "x" }, // c',
        '\t\t"mcp": {',
        '\t\t\t"command": "npx",',
        '\t\t\t"args": [',
        '\t\t\t\t"-y",',
        '\t\t\t\t"@yawlabs/mcp"',
        "\t\t\t]",
        "\t\t}",
        "\t}",
        "}",
        "",
      ),
    );
  });

  it("CRLF file: every new line ends in CRLF", () => {
    const out = editJsoncEntry(CRLF_FILE, ["mcpServers"], "mcp", ENTRY);
    expect(out).toBe(
      crlf(
        "{",
        '  "mcpServers": {',
        '    "a": 1, // c',
        '    "mcp": {',
        '      "command": "npx",',
        '      "args": [',
        '        "-y",',
        '        "@yawlabs/mcp"',
        "      ]",
        "    }",
        "  }",
        "}",
        "",
      ),
    );
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("trailing comma + end-of-line comment: the comment stays put and the new entry copies the trailing comma", () => {
    expect(editJsoncEntry(TRAILING_COMMA, ["mcpServers"], "mcp", ENTRY)).toBe(
      lf(
        "{",
        '  "mcpServers": {',
        '    "a": 1, // c',
        '    "mcp": {',
        '      "command": "npx",',
        '      "args": [',
        '        "-y",',
        '        "@yawlabs/mcp"',
        "      ]",
        "    },",
        "  }",
        "}",
        "",
      ),
    );
  });

  it("steps over a trailing /* block */ comment the same way", () => {
    expect(editJsoncEntry(lf("{", '  "s": {', '    "a": 1 /* c */', "  }", "}", ""), ["s"], "mcp", 2)).toBe(
      lf("{", '  "s": {', '    "a": 1, /* c */', '    "mcp": 2', "  }", "}", ""),
    );
  });

  it("nested containerPath (claude-code local scope): indents at the nested depth, siblings untouched", () => {
    expect(editJsoncEntry(NESTED_LOCAL, ["projects", "/work/app", "mcpServers"], "mcp", ENTRY)).toBe(
      lf(
        "{",
        '  "projects": {',
        '    "/work/app": {',
        '      "allowedTools": [], // mine',
        '      "mcpServers": {',
        '        "db": { "command": "pg" }, // local db',
        '        "mcp": {',
        '          "command": "npx",',
        '          "args": [',
        '            "-y",',
        '            "@yawlabs/mcp"',
        "          ]",
        "        }",
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ),
    );
  });

  it("creates missing containers as one new member, after the last sibling's comment", () => {
    expect(editJsoncEntry(lf("{", '  "a": 1 // c', "}", ""), ["mcpServers"], "mcp", ENTRY)).toBe(
      lf(
        "{",
        '  "a": 1, // c',
        '  "mcpServers": {',
        '    "mcp": {',
        '      "command": "npx",',
        '      "args": [',
        '        "-y",',
        '        "@yawlabs/mcp"',
        "      ]",
        "    }",
        "  }",
        "}",
        "",
      ),
    );
  });

  it("creates two missing levels (projects[<dir>].mcpServers) beside an existing project", () => {
    const src = lf("{", '  "projects": {', '    "/other": {} // keep', "  }", "}", "");
    expect(editJsoncEntry(src, ["projects", "/work/app", "mcpServers"], "mcp", ENTRY)).toBe(
      lf(
        "{",
        '  "projects": {',
        '    "/other": {}, // keep',
        '    "/work/app": {',
        '      "mcpServers": {',
        '        "mcp": {',
        '          "command": "npx",',
        '          "args": [',
        '            "-y",',
        '            "@yawlabs/mcp"',
        "          ]",
        "        }",
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ),
    );
  });

  it("opens an empty {} in a multi-line file onto lines of its own", () => {
    expect(editJsoncEntry(lf("{", '  "mcpServers": {}', "}", ""), ["mcpServers"], "mcp", ENTRY)).toBe(
      lf(
        "{",
        '  "mcpServers": {',
        '    "mcp": {',
        '      "command": "npx",',
        '      "args": [',
        '        "-y",',
        '        "@yawlabs/mcp"',
        "      ]",
        "    }",
        "  }",
        "}",
        "",
      ),
    );
  });

  it("an empty container whose `{` carries a comment keeps it; the entry goes on the next line", () => {
    const src = lf("{", '  "mcpServers": { // none yet', "  }", "}", "");
    expect(editJsoncEntry(src, ["mcpServers"], "mcp", 1)).toBe(
      lf("{", '  "mcpServers": { // none yet', '    "mcp": 1', "  }", "}", ""),
    );
  });

  it("a one-line container stays on one line: compact value, the container's own spacing", () => {
    const src = lf("{", '  "mcpServers": { "a": { "command": "x" } }', "}", "");
    expect(editJsoncEntry(src, ["mcpServers"], "mcp", ENTRY)).toBe(
      lf(
        "{",
        '  "mcpServers": { "a": { "command": "x" }, "mcp": {"command":"npx","args":["-y","@yawlabs/mcp"]} }',
        "}",
        "",
      ),
    );
  });

  it("copies the container's own member step when it differs from the file's shallowest indent", () => {
    // Top level at 2 spaces, this container's members 4 deeper than its line:
    // the new value's step comes from the members, not from the file.
    const src = lf("{", '  "mcpServers": {', '      "a": 1', "  }", "}", "");
    expect(editJsoncEntry(src, ["mcpServers"], "mcp", ENTRY)).toBe(
      lf(
        "{",
        '  "mcpServers": {',
        '      "a": 1,',
        '      "mcp": {',
        '          "command": "npx",',
        '          "args": [',
        '              "-y",',
        '              "@yawlabs/mcp"',
        "          ]",
        "      }",
        "  }",
        "}",
        "",
      ),
    );
  });

  it("a minified document stays minified, into a non-empty and an empty container alike", () => {
    expect(editJsoncEntry('{"mcpServers":{"a":1}}', ["mcpServers"], "mcp", ENTRY)).toBe(
      '{"mcpServers":{"a":1,"mcp":{"command":"npx","args":["-y","@yawlabs/mcp"]}}}',
    );
    expect(editJsoncEntry('{"mcpServers":{}}', ["mcpServers"], "mcp", ENTRY)).toBe(
      '{"mcpServers":{"mcp":{"command":"npx","args":["-y","@yawlabs/mcp"]}}}',
    );
  });
});

describe("editJsoncEntry -- replacing a value", () => {
  it("re-renders only the value, in the file's step, and keeps the comment after it (permissions.allow)", () => {
    const src = lf(
      "{",
      '    "permissions": {',
      '        "allow": ["a"], // mine',
      '        "deny": []',
      "    }",
      "}",
      "",
    );
    expect(editJsoncEntry(src, ["permissions"], "allow", ["a", "b"])).toBe(
      lf(
        "{",
        '    "permissions": {',
        '        "allow": [',
        '            "a",',
        '            "b"',
        "        ], // mine",
        '        "deny": []',
        "    }",
        "}",
        "",
      ),
    );
  });

  it("a value in a one-line container is replaced compact, on that line (claude-code permissions)", () => {
    const src = lf("{", '  "permissions": { "allow": ["Bash(ls)"] } // mine', "}", "");
    expect(editJsoncEntry(src, ["permissions"], "allow", ["Bash(ls)", "mcp__mcp__*"])).toBe(
      lf("{", '  "permissions": { "allow": ["Bash(ls)","mcp__mcp__*"] } // mine', "}", ""),
    );
  });

  it("keeps CRLF inside the replaced value", () => {
    const src = crlf("{", '  "p": {', '    "allow": ["a"]', "  }", "}", "");
    expect(editJsoncEntry(src, ["p"], "allow", ["a", "b"])).toBe(
      crlf("{", '  "p": {', '    "allow": [', '      "a",', '      "b"', "    ]", "  }", "}", ""),
    );
  });

  it("refuses a value JSON cannot represent instead of writing `undefined` into the file", () => {
    expect(() => editJsoncEntry(lf("{", '  "a": 1', "}", ""), [], "f", () => 1)).toThrow(
      /cannot write a function value as JSON/,
    );
  });
});

describe("removeJsoncEntry -- removal takes the entry's own lines and nothing of its neighbours", () => {
  it("gemini repro: middle entry goes; the comments on the lines around it stay", () => {
    const src = lf(
      "{",
      '  "mcpServers": {',
      '    "filesystem": { "command": "x" }, // keep me',
      '    "mcp": { "command": "npx" },',
      '    "other": { "command": "y" } /* tail */',
      "  }",
      "}",
      "",
    );
    expect(removeJsoncEntry(src, ["mcpServers"], "mcp")).toBe(
      lf(
        "{",
        '  "mcpServers": {',
        '    "filesystem": { "command": "x" }, // keep me',
        '    "other": { "command": "y" } /* tail */',
        "  }",
        "}",
        "",
      ),
    );
  });

  it("last entry: the previous entry loses its separator comma and keeps its comment", () => {
    const src = lf(
      "{",
      '  "mcpServers": {',
      '    "filesystem": { "command": "x" }, // keep me',
      '    "mcp": { "command": "npx" }',
      "  }",
      "}",
      "",
    );
    expect(removeJsoncEntry(src, ["mcpServers"], "mcp")).toBe(
      lf("{", '  "mcpServers": {', '    "filesystem": { "command": "x" } // keep me', "  }", "}", ""),
    );
  });

  it("first entry: its own comment goes with it, the next entry's stays", () => {
    const src = lf(
      "{",
      '  "mcpServers": {',
      '    "mcp": { "command": "npx" }, // ours',
      '    "other": 1 // theirs',
      "  }",
      "}",
      "",
    );
    expect(removeJsoncEntry(src, ["mcpServers"], "mcp")).toBe(
      lf("{", '  "mcpServers": {', '    "other": 1 // theirs', "  }", "}", ""),
    );
  });

  it("legacy-trim shape: a multi-line entry between two commented siblings", () => {
    const src = lf(
      "{",
      '  "mcpServers": {',
      '    "a": 1, // first',
      '    "yaw-mcp": {',
      '      "command": "npx",',
      '      "args": ["-y", "@yawlabs/mcp"]',
      "    }, // legacy",
      '    "b": 2 /* last */',
      "  }",
      "}",
      "",
    );
    expect(removeJsoncEntry(src, ["mcpServers"], "yaw-mcp")).toBe(
      lf("{", '  "mcpServers": {', '    "a": 1, // first', '    "b": 2 /* last */', "  }", "}", ""),
    );
  });

  it("last entry in a trailing-comma file: the previous entry's comma stays (the file uses them)", () => {
    const src = lf("{", '  "s": {', '    "a": 1, // c', '    "mcp": 2,', "  }", "}", "");
    expect(removeJsoncEntry(src, ["s"], "mcp")).toBe(lf("{", '  "s": {', '    "a": 1, // c', "  }", "}", ""));
  });

  it("only entry: its line goes and the braces stay where they were", () => {
    const src = lf("{", '  "mcpServers": {', '    "mcp": 1', "  }", "}", "");
    expect(removeJsoncEntry(src, ["mcpServers"], "mcp")).toBe(lf("{", '  "mcpServers": {', "  }", "}", ""));
  });

  it("CRLF: the removed line takes its CRLF with it", () => {
    const src = crlf("{", '  "s": {', '    "a": 1, // c', '    "mcp": 2', "  }", "}", "");
    expect(removeJsoncEntry(src, ["s"], "mcp")).toBe(crlf("{", '  "s": {', '    "a": 1 // c', "  }", "}", ""));
  });

  it("one-line containers: first, last and only entry", () => {
    expect(removeJsoncEntry('{ "a": 1, "mcp": 2 }', [], "mcp")).toBe('{ "a": 1 }');
    expect(removeJsoncEntry('{ "mcp": 2, "a": 1 }', [], "mcp")).toBe('{ "a": 1 }');
    expect(removeJsoncEntry('{ "mcp": 2 }', [], "mcp")).toBe("{}");
    expect(removeJsoncEntry('{"mcpServers":{"mcp":2}}', ["mcpServers"], "mcp")).toBe('{"mcpServers":{}}');
  });

  it("comma-first style: never strands a comma", () => {
    const src = lf("{", '  "s": {', '    "a": 1', '    , "mcp": 2', '    , "b": 3', "  }", "}", "");
    const out = removeJsoncEntry(src, ["s"], "mcp");
    expect(out).toBe(lf("{", '  "s": {', '    "a": 1', '    , "b": 3', "  }", "}", ""));
    expect(JSON.parse(out)).toEqual({ s: { a: 1, b: 3 } });
  });

  it("comma-first style, FIRST member: its separator is on the next line, so the member and that comma go", () => {
    const src = lf("{", '  "s": {', '    "mcp": 2', '    , "a": 1', '    , "b": 3', "  }", "}", "");
    const out = removeJsoncEntry(src, ["s"], "mcp");
    expect(out).toBe(lf("{", '  "s": {', '    "a": 1', '    , "b": 3', "  }", "}", ""));
    expect(JSON.parse(out)).toEqual({ s: { a: 1, b: 3 } });
  });

  it("comma-first style, FIRST member with a comment before its separator: the comment goes with it", () => {
    const src = lf("{", '  "s": {', '    "mcp": 2 // ours', '    , "a": 1', "  }", "}", "");
    const out = removeJsoncEntry(src, ["s"], "mcp");
    expect(out).toBe(lf("{", '  "s": {', '    "a": 1', "  }", "}", ""));
    expect(JSON.parse(out)).toEqual({ s: { a: 1 } });
  });
});

describe("install then uninstall restores the original file byte for byte", () => {
  const cases: Array<[string, string, string[]]> = [
    ["4-space + one-line sibling + // comment", CURSOR_4SPACE, ["mcpServers"]],
    ["tab-indented", TAB_FILE, ["mcpServers"]],
    ["CRLF", CRLF_FILE, ["mcpServers"]],
    ["trailing comma + comment", TRAILING_COMMA, ["mcpServers"]],
    ["nested claude-code local container", NESTED_LOCAL, ["projects", "/work/app", "mcpServers"]],
  ];
  for (const [name, src, path] of cases) {
    it(name, () => {
      const installed = editJsoncEntry(src, path, "mcp", ENTRY);
      expect(installed).not.toBe(src);
      expect(removeJsoncEntry(installed, path, "mcp")).toBe(src);
    });
  }
});

describe("editJsoncPath -- the bundles.json splice (yaw-mcp set)", () => {
  const BUNDLES = lf(
    "{",
    '  "servers": [',
    "    {",
    '      "namespace": "gh", // hub',
    '      "env": {',
    '        "A": "1" // first',
    "      }",
    "    }",
    "  ]",
    "}",
    "",
  );
  const WITH_B = lf(
    "{",
    '  "servers": [',
    "    {",
    '      "namespace": "gh", // hub',
    '      "env": {',
    '        "A": "1", // first',
    '        "B": "2"',
    "      }",
    "    }",
    "  ]",
    "}",
    "",
  );

  it("adding an env key keeps the previous key's comment on the previous key", () => {
    expect(editJsoncPath(BUNDLES, ["servers", 0, "env", "B"], "2")).toBe(WITH_B);
  });

  it("clearing that key again restores the file exactly", () => {
    expect(editJsoncPath(WITH_B, ["servers", 0, "env", "B"], undefined)).toBe(BUNDLES);
  });

  it("setting a scalar inside a one-line server object touches only the value", () => {
    const src = lf("{", '  "servers": [', '    { "namespace": "gh", "isActive": true } // on', "  ]", "}", "");
    expect(editJsoncPath(src, ["servers", 0, "isActive"], false)).toBe(
      lf("{", '  "servers": [', '    { "namespace": "gh", "isActive": false } // on', "  ]", "}", ""),
    );
  });

  it("replacing an existing array element touches only that element", () => {
    expect(editJsoncPath(lf("{", '  "xs": [1, 2] // two', "}", ""), ["xs", 1], 3)).toBe(
      lf("{", '  "xs": [1, 3] // two', "}", ""),
    );
  });
});

describe("shapes left to jsonc-parser keep its behaviour and its messages", () => {
  it("a container key holding a non-object throws jsonc-parser's own message (install-cmd names the key first)", () => {
    expect(() => editJsoncEntry(lf("{", '  "mcpServers": null', "}", ""), ["mcpServers"], "mcp", ENTRY)).toThrow(
      "Can not add index to parent of type null",
    );
  });

  it("deleting under a container that does not exist throws (try-cmd walks the path first)", () => {
    expect(() => removeJsoncEntry(lf("{", '  "a": 1', "}", ""), ["mcpServers"], "mcp")).toThrow(
      "Can not delete in empty document",
    );
  });

  it("an empty document still gets a fresh object", () => {
    expect(parseJsonc(editJsoncEntry("", ["mcpServers"], "mcp", ENTRY))).toEqual({ mcpServers: { mcp: ENTRY } });
  });
});
