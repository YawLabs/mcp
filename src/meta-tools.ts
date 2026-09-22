// Single source of truth for the `${secret:NAME}` reference shape AND for the
// scan over it is secrets-vault's collectSecretRefNames. This file used to keep
// a byte-identical private copy of that loop, re-deriving the fresh-RegExp rule
// the module-shared /g object demands; importing the real scanner means a
// change to the reference syntax can't leave the values-free secrets report
// matching the old shape. (secrets-vault does touch the filesystem elsewhere in
// the module, but nothing runs at import time -- computeSecretsReport below
// stays pure.)
import { MAX_EXEC_STEPS } from "./exec-engine.js";
import { PENALTY_RATE_THRESHOLD } from "./learning.js";
import { collectMalformedSecretRefs, collectSecretRefNames } from "./secrets-vault.js";
import { isRemoteEntry } from "./types.js";

// Numbers the descriptions below quote to the model, interpolated from the
// constants that actually enforce them rather than retyped. learning.ts
// promises that moving PENALTY_RATE_THRESHOLD moves every surface that
// renders it, and exec's step cap is enforced by validateExecRequest --
// a hardcoded "<80%" or "Max 16 steps" is a lie the moment either moves.
const PENALTY_RATE_PCT = Math.round(PENALTY_RATE_THRESHOLD * 100);

/**
 * The server-level `instructions` string sent once in the initialize result.
 *
 * This is where the ROUTING advice lives -- when to dispatch vs discover vs
 * exec, that loading is per session, that the guide resource comes first.
 * It used to be repeated inside the discover, dispatch, exec, suggest and
 * bundles descriptions, and a description is paid on every tools/list (and,
 * on a client with no deferred loading, inlined into EVERY request), while
 * Claude Code injects `instructions` into the system prompt exactly once.
 * Measured before the split: the eleven meta-tools were 17,929 chars of
 * tools/list wire JSON, 10,849 of them description text. The per-tool
 * descriptions below now say only what each tool DOES, and
 * meta-tools.test.ts pins both this string and the wire total so neither
 * silently regrows.
 *
 * Kept exposure-neutral: a `lite` session (proxy.ts ToolExposure) advertises
 * only exec / find_tool / read_tool, but every meta-tool named here is still
 * callable by name, so nothing below is untrue for it.
 */
export const SERVER_INSTRUCTIONS = [
  "yaw-mcp fronts every MCP server the user installed; tools/list shows the mcp_connect_* meta-tools plus servers loaded THIS session. Each load adds tools to your context: unload (mcp_connect_deactivate) when done.",
  "Concrete task: mcp_connect_dispatch loads the best server in one call. Browsing: mcp_connect_discover. Known 2-4 step chain: mcp_connect_exec (calls a cached server's tool by name, no load needed).",
  "Prefer a server over the CLI it shadows. Read yaw-mcp://guide first when listed: this project's routing rules.",
].join(" ");

export const META_TOOLS = {
  discover: {
    name: "mcp_connect_discover",
    description:
      "List the MCP servers installed in the user's ~/.yaw-mcp/bundles.json: name, namespace, tool count, an estimated token cost (a tilde marks an estimate from cached metadata), whether it is loaded, any local CLI it shadows, an inline `[A]`-`[F]` compliance grade when scored (ungraded is unmarked, not penalized), and usage hints. Tool-name lists are truncated; pass `server` for one server's full card. Recurring packs get a ready-to-run `mcp_connect_activate` call at the top.",
    inputSchema: {
      type: "object" as const,
      properties: {
        context: {
          type: "string",
          description: "Optional: the current task. Servers are sorted by relevance to it.",
        },
        server: {
          type: "string",
          description:
            "Optional: one namespace to report on in full -- just that server's card, with its complete tool list.",
        },
      },
    },
    annotations: {
      title: "Discover MCP Servers",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  activate: {
    name: "mcp_connect_activate",
    description:
      "Load one or more installed servers' tools into this session by namespace; tools are prefixed by it (e.g. \"gh_create_issue\"). Pass `server` for one or `servers` for several. `tools: [...]` (single server only) advertises just those tools; the rest stay callable by name. Refused when YAW_MCP_MIN_COMPLIANCE is set and the server's grade is below it (ungraded always passes); the message names the grade and the variable.",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: 'Single server namespace to activate (e.g., "gh")',
        },
        servers: {
          type: "array",
          items: { type: "string" },
          description: 'Multiple server namespaces to activate at once (e.g., ["gh", "slack"])',
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional per-server tool filter (bare names, not namespace-prefixed). Only the listed tools surface in tools/list; the rest stay callable by name. Omit, or re-activate without it, for the full set. Single-server activation only.",
        },
      },
    },
    annotations: {
      title: "Load MCP Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  deactivate: {
    name: "mcp_connect_deactivate",
    description:
      "Unload one or more loaded servers' tools from this session to free context. The server stays installed and can be reloaded with `mcp_connect_activate`. yaw-mcp also auto-unloads a server after a run of calls to other servers (baseline YAW_MCP_IDLE_THRESHOLD, raised for a server used in bursts).",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: "The namespace of the server to deactivate",
        },
        servers: {
          type: "array",
          items: { type: "string" },
          description: 'Multiple server namespaces to deactivate at once (e.g., ["gh", "slack"])',
        },
      },
    },
    annotations: {
      title: "Unload MCP Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  health: {
    name: "mcp_connect_health",
    description: `Health stats for the servers loaded this session: total calls, error count, average latency, last error. Installed-but-unloaded servers with a poor persisted success rate (<${PENALTY_RATE_PCT}% across sessions) are listed in a separate block -- do NOT load a server just to see its history, loading resets its in-session counters.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: {
      title: "Session Health",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  dispatch: {
    name: "mcp_connect_dispatch",
    description:
      'Pick the best-matching installed server(s) for a natural-language task and load their tools in one call. Describe the task ("create a github issue for the login bug", "query the prod postgres"); yaw-mcp ranks the installed servers with BM25 and loads the top match. `budget` defaults to 1; raise it only when one task genuinely spans several servers.',
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: {
          type: "string",
          description:
            'What you want to accomplish, in plain English (e.g., "file a github issue titled Fix login bug")',
        },
        budget: {
          // integer with bounds, matching the server-side clamp
          // (handleDispatch floors into [1,10]). Advisory only -- the
          // low-level Server never validates input against this schema --
          // but it steers well-behaved clients away from the fractional /
          // sub-1 band the clamp exists to absorb.
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 1,
          description: "How many top-ranked servers to load. Default 1, cap 10.",
        },
        routeEffort: {
          type: "string",
          enum: ["off", "auto", "aggressive"],
          description:
            'Per-call routing-effort dial: "off" never asks the client LLM to break a ranking tie, "auto" (default) asks once on genuine ambiguity, "aggressive" samples best-of-3 on milder ambiguity. Falls back to YAW_MCP_ROUTE_EFFORT. Budget 1 only.',
        },
      },
      required: ["intent"],
    },
    annotations: {
      title: "Dispatch to Best Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  read_tool: {
    name: "mcp_connect_read_tool",
    description:
      "Return one tool's full input schema without loading its server. Free for a loaded server; for an unloaded one yaw-mcp opens a transient connection, reads the schema and closes it -- nothing is added to the session. To call the tool, load its server with `mcp_connect_activate` or call it by name from `mcp_connect_exec`.",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: 'Namespace of the server that exposes the tool (e.g., "gh", "slack").',
        },
        tool: {
          type: "string",
          description: 'Tool name; the namespace prefix is optional ("create_issue" and "gh_create_issue" both work).',
        },
      },
      required: ["server", "tool"],
    },
    annotations: {
      title: "Read Tool Schema",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  findTool: {
    name: "mcp_connect_find_tool",
    description:
      'Search every installed server\'s tools by what they DO ("resize an image", "list pull requests") when you do not know which server has it. Ranks tool names and descriptions across loaded and unloaded servers from cache; nothing is loaded and no server is contacted. A match on a loaded server carries its full input schema; one on a never-loaded server carries name and description only -- `mcp_connect_read_tool` returns its arguments.',
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            'What the tool should DO, in plain words -- "create a github issue", "query postgres", "resize an image".',
        },
        limit: {
          type: "number",
          description: "Maximum matches to return. Default 10.",
        },
      },
      required: ["query"],
    },
    annotations: {
      title: "Find a Tool",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  suggest: {
    name: "mcp_connect_suggest",
    description:
      "Surface recurring multi-server 'packs' -- servers used together in short bursts more than once -- each as a ready-to-run `mcp_connect_activate` call with all its namespaces. Observation-only: loads and unloads nothing. Patterns persist across yaw-mcp restarts. Returns a 'no patterns yet' message when nothing has recurred.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: {
      title: "Suggest Server Packs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  bundles: {
    name: "mcp_connect_bundles",
    description:
      'List curated multi-server \'bundles\' (`pr-review` = github + linear, `devops-incident` = github + pagerduty + slack, ...) for a known multi-server WORKFLOW, each with a ready-to-run `mcp_connect_activate namespaces=[...]` call. `action="match"` partitions them against the installed servers into READY (activate now) and PARTIAL (names the missing namespaces; `yaw-mcp add <slug>` installs one, catalog at https://yaw.sh/mcp/catalog/). `action="list"` (default) returns the whole catalog. Static data, no network call.',
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "match"],
          description: '"list" (default): the full curated catalog. "match": partition against installed servers.',
        },
      },
    },
    annotations: {
      title: "Curated Server Bundles",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  secrets: {
    name: "mcp_connect_secrets",
    description:
      "Report, per installed server, which local-vault secrets its `${secret:NAME}` references resolve to -- NAMES only, never a value. `injectedSecrets`: names the vault has. `missing`: names it lacks (`yaw-mcp secrets set <name>`). `malformed`: references that do not parse (a space in the name, a missing `}`), quoted in bounded form behind a `<malformed ref>` marker. yaw-mcp refuses to start a server over a missing or malformed reference. Servers with no references are omitted. Decrypts nothing; needs no passphrase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description:
            'Optional: one server namespace (e.g. "gh"). Omit for every server that references a vault secret.',
        },
      },
    },
    annotations: {
      title: "Inspect Vault Secret Resolution",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  exec: {
    name: "mcp_connect_exec",
    // Joined rather than one literal so the step cap can be interpolated from
    // MAX_EXEC_STEPS -- the constant validateExecRequest actually enforces.
    description: [
      "Run a short DECLARATIVE pipeline of upstream tool calls in one round-trip, when you already know the 2-4 calls and one step's output feeds another's args -- e.g. `a = gh_list_prs(); b = gh_get_pr(a[0].number); return b`. NOT a code sandbox: no expressions, loops, branching or arithmetic. Steps run in order; the only data flow is `{\"$ref\": \"<stepId>[.path.to.value]\"}` (dot keys, `[N]` / `.N` array indexing), which substitutes a prior step's output into a later step's args. Each `tool` is a namespaced upstream name: a loaded server is called directly; a not-yet-loaded server whose tools are cached is loaded on first use, as a direct tools/call would (its tools join this session; it can still be refused). A POLICY refusal (server disabled, project profile, compliance floor) is decided before step 0 runs and refuses the whole pipeline with nothing done, so fixing it and re-running costs no repeated side effect; a server-cap refusal is only knowable when the step is reached and fails it there, with `partial` holding what already ran. A name neither loaded nor cached fails its step.",
      `Max ${MAX_EXEC_STEPS} steps per exec.`,
      "Any failure returns `{ ok: false, failedStep, error, partial }`. Success returns `{ ok: true, result, steps }`; with a named `return`, `result` is that step's output, `stepKeys` is added, and `steps` is dropped once the intermediate outputs exceed about 4 KB. Name a `return` whenever one value is enough: it stops a large intermediate output being replayed into your context.",
    ].join(" "),
    inputSchema: {
      type: "object" as const,
      properties: {
        steps: {
          type: "array",
          description:
            'Ordered tool calls, each `{ id?: string, tool: string, args?: object }`. `args` values may be `{"$ref": "<stepId>.path"}`.',
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Optional name for this step's output, used by later `$ref`s. Defaults to the positional index as a string.",
              },
              tool: {
                type: "string",
                description:
                  'Namespaced tool name (e.g. "gh_list_prs"); a cached-but-unloaded server is loaded on first use. Meta-tools (mcp_connect_*) are not callable from exec.',
              },
              args: {
                type: "object",
                description:
                  'Arguments for the tool call. Any value, however nested, may be `{"$ref": "<stepId>[.path]"}` to substitute a prior step\'s output.',
                additionalProperties: true,
              },
            },
            required: ["tool"],
            // A misspelled `arguments` / `arg` / `input` key would otherwise
            // read as a legal extension and the step would dispatch with no
            // arguments at all. validateExecRequest rejects the same shape at
            // runtime (the low-level Server never validates against this
            // schema); declaring it here is what steers a schema-aware client
            // away from sending it in the first place.
            additionalProperties: false,
          },
        },
        return: {
          type: "string",
          description:
            "Optional: id of the step whose output becomes `result` (default: the last step). Naming one adds `stepKeys` and drops `steps` once the intermediate outputs exceed about 4 KB, so a large payload you skipped is not replayed.",
        },
      },
      required: ["steps"],
    },
    annotations: {
      title: "Exec Pipeline",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
} as const;

/**
 * The meta-tools a `lite` exposure (proxy.ts ToolExposure) advertises: the
 * three that reach any installed tool WITHOUT the client's tool list having
 * to change. exec calls a loaded or cache-known tool by name and loads its
 * server on first use; find_tool returns the exact name; read_tool returns
 * the schema. Every other meta-tool stays callable by name -- lite narrows
 * what tools/list advertises, not what handleToolCall accepts -- so a client
 * that knows the names loses nothing. Derived from META_TOOLS, same as
 * META_TOOL_NAMES below, so a renamed tool cannot leave a stale entry here.
 */
export const LITE_META_TOOL_NAMES: ReadonlySet<string> = new Set([
  META_TOOLS.exec.name,
  META_TOOLS.findTool.name,
  META_TOOLS.read_tool.name,
]);

export interface SecretsReportRow {
  server: string;
  /** Names the vault HAS and this server references (sorted). */
  injectedSecrets: string[];
  /** Names this server references but the vault LACKS (sorted). */
  missing: string[];
  /** `${secret:` references in this server's env that do not PARSE, in
   *  secrets-vault's bounded `display` form (`<malformed ref> ${secret:gh
   *  token}`; sorted). Never a raw env value: the span is control-stripped
   *  and capped before it gets here (see MalformedSecretRef). A server with
   *  only malformed refs still gets a row -- it is exactly the one whose
   *  spawn is being refused with nothing else to explain why. */
  malformed: string[];
}

/**
 * Pure, values-free computation backing the `mcp_connect_secrets`
 * meta-tool. Given each server's namespace + env map and the SET of secret
 * names the vault holds, returns one row per server that references at
 * least one `${secret:...}`, well-formed or not:
 *   - injectedSecrets = referenced names ∩ vaultKeys
 *   - missing         = referenced names \ vaultKeys
 *   - malformed       = references the strict regex cannot parse
 * Never decrypts; takes only NAMES in and emits only NAMES (plus bounded
 * malformed spans) out. Servers with no references at all are omitted.
 */
export function computeSecretsReport(
  // `command` and `url` are here for isRemoteEntry, not for this function:
  // the predicate falls back to command-less-with-a-url because validateEntry
  // defaults a missing `"type"` to "local", so a hand-written url+headers
  // entry is invisible to a `type`-only test.
  servers: Array<{
    namespace: string;
    type?: string;
    command?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  }>,
  vaultKeys: Set<string>,
): SecretsReportRow[] {
  const rows: SecretsReportRow[] = [];
  for (const server of servers) {
    // The shared scanner, not a local matchAll over SECRET_REF_RE: that object
    // carries /g and is module-shared with secrets-vault's own callers, and
    // matchAll does NOT start from zero -- it seeds its internal clone from the
    // source regex's lastIndex, so a stale offset left behind by an
    // `.exec()`/`.test()` elsewhere would make the scan silently skip leading
    // matches, and a skipped `${secret:NAME}` drops a row from the report,
    // which reads as "this server needs no secrets". collectSecretRefNames owns
    // the fresh-instance rule for every name-only caller (upstream.ts's spawn
    // audit and doctor's vault section are the others).
    // A remote server's credentials ride in `headers`, not `env` -- see
    // isRemoteEntry. Scanning `env` for one meant every remote
    // server was omitted from this report, which reads as "needs no
    // secrets" about the exact server whose activation is about to be
    // refused fail-closed for a missing name.
    const credentials = isRemoteEntry(server) ? server.headers : server.env;
    const referenced = collectSecretRefNames(credentials);
    // The strict scanner above cannot see a reference a typo has put outside
    // SECRET_REF_RE, while resolveServerEnv refuses the spawn over it. Without
    // this column the report said "gh: injected" about a server that will not
    // start, and said nothing at all about one whose only ref is the typo.
    const malformed = collectMalformedSecretRefs(credentials);
    if (referenced.size === 0 && malformed.length === 0) continue;
    const injectedSecrets: string[] = [];
    const missing: string[] = [];
    for (const name of referenced) {
      if (vaultKeys.has(name)) injectedSecrets.push(name);
      else missing.push(name);
    }
    rows.push({
      server: server.namespace,
      injectedSecrets: injectedSecrets.sort(),
      missing: missing.sort(),
      malformed: malformed.sort(),
    });
  }
  return rows;
}

/** Every meta-tool name, DERIVED from META_TOOLS rather than re-listed.
 *
 *  The sole consumer (server.ts) uses this to enforce the contract advertised
 *  on mcp_connect_exec: meta-tools are not callable from inside an exec
 *  pipeline. A hand-maintained copy made that a security-shaped invariant
 *  guarded by a list someone has to remember to update -- add an 11th
 *  meta-tool, forget the entry, and that tool becomes exec-callable (a step
 *  could deactivate a server a later step needs, or recurse exec into
 *  itself) with nothing to catch it. Deriving removes the drift surface. */
export const META_TOOL_NAMES = new Set(Object.values(META_TOOLS).map((m) => m.name));
