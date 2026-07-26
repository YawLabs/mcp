// Single source of truth for the `${secret:NAME}` reference shape. This
// file used to keep a byte-identical private copy; importing the real one
// means a change to the reference syntax can't leave the values-free
// secrets report matching the old shape. (secrets-vault does touch the
// filesystem elsewhere in the module, but nothing runs at import time --
// computeSecretsReport below stays pure.)
import { SECRET_REF_RE } from "./secrets-vault.js";

export const META_TOOLS = {
  discover: {
    name: "mcp_connect_discover",
    description:
      'List the MCP servers configured in the user\'s local ~/.yaw-mcp/bundles.json and ready to use. Call this when browsing what\'s available or when the task isn\'t specific yet. If the task is already clear ("file a github issue", "query postgres", "post to slack"), prefer `mcp_connect_dispatch` — it picks the right server and loads its tools in one call. Load only the servers the CURRENT task needs; each one adds tools to your context. Shows names, namespaces, tool counts, a token-cost estimate per server (e.g. "22 tools, ~2.8k tokens") so you can budget context before activating — tilde values are estimates based on cached tool metadata, unprefixed values reflect live tool schemas. Scored servers carry an inline `[A]`–`[F]` compliance grade from the Yaw MCP test suite — treat it as a trust signal and prefer higher-graded alternatives when otherwise equivalent (ungraded servers are unmarked, not penalized). Also surfaces whether each server is loaded, any local CLI it shadows (prefer the MCP tools over the CLI when a shadow is listed), and usage hints ("used Nx" or "often loaded with X") when the signals are present (counts persist across yaw-mcp restarts). Recurring packs that have been loaded together ≥2 times get their own block at the top with a ready-to-run `activate` call — skip the extra `mcp_connect_suggest` round-trip when the signal is already there. If a `yaw-mcp://guide` resource is listed, read it FIRST: it carries project/user-specific routing rules and credential conventions that override generic defaults.',
    inputSchema: {
      type: "object" as const,
      properties: {
        context: {
          type: "string",
          description:
            "Optional: describe the current task or conversation context. Servers will be sorted by relevance to help you pick the right one.",
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
      'Load one or more installed MCP servers\' tools into the current session by namespace. Each server adds its tools to your context, so load only what the current task needs. When you move on, unload servers you\'re done with via `mcp_connect_deactivate` before loading new ones. Tools are prefixed by namespace (e.g., "gh_create_issue"). Pass "server" for one or "servers" for multiple. Optionally pass `tools: [...]` to expose only those tools by name — the rest stay proxyable via mcp_connect_dispatch. If `YAW_MCP_MIN_COMPLIANCE` is set, activation refuses servers whose reported grade is below the floor (ungraded servers always pass); the refusal message names the grade and the env var to unset.',
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
            "Optional per-server tool filter (bare tool names, not namespace-prefixed). When set, only the listed tools surface in tools/list — others stay reachable via mcp_connect_dispatch. Omit (or re-activate without it) to expose the full tool set. Only applied when activating a single server.",
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
      'Unload one or more MCP servers\' tools from the current session to free context. The server stays configured in ~/.yaw-mcp/bundles.json and can be reloaded via `mcp_connect_activate` when needed again. Unload servers you\'re done with; yaw-mcp also auto-unloads any server idle for 10+ tool calls to other servers. Pass "server" for one or "servers" for multiple.',
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
    description:
      "Show health stats for MCP servers loaded in the current session: total calls, error count, average latency, and last error. Installed-but-unloaded servers aren't included — load them first if you need their stats.",
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
      'PREFERRED entry point when the task is already concrete. Picks the best-matching installed MCP server(s) for a natural-language task and loads their tools in ONE call — no separate discover + load step. Describe what you want to do ("create a github issue for the login bug", "post a summary to slack", "query the prod postgres") and yaw-mcp will rank the user\'s installed servers with BM25, load the top match into the session, and expose its tools so you can call them. Use `mcp_connect_discover` only when browsing what\'s installed without a specific task. When an installed MCP server shadows a local CLI (e.g. npmjs shadows `npm`, tailscale shadows `tailscale`, github shadows `gh`), prefer dispatching to the server over running the CLI via Bash. Default budget is 1 to keep the tool list focused; raise it only if the task genuinely spans multiple servers. If `yaw-mcp://guide` is listed as a resource, read it first — the project may have explicit routing rules (e.g. "use `gh` not bash for GitHub").',
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: {
          type: "string",
          description:
            'What you want to accomplish, in plain English (e.g., "file a github issue titled Fix login bug")',
        },
        budget: {
          type: "number",
          default: 1,
          description:
            "How many top-ranked servers to load into the session. Defaults to 1. Cap is 10. Raise only when one task genuinely spans multiple servers.",
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
      "Return one tool's full input schema without loading its server into the session. Use this when you need to inspect an MCP tool's arguments before deciding whether to activate its server, or to compare schemas across two tools. For already-loaded servers this is free (schema is in memory). For not-loaded servers yaw-mcp spawns a transient upstream connection, reads the schema, and tears the connection down — no tools are added to your context, and `mcp_connect_health` will not show the server as loaded. When you're ready to actually call the tool, pass the server namespace to `mcp_connect_activate` (or use `mcp_connect_dispatch` with the task intent).",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: 'Namespace of the server that exposes the tool (e.g., "gh", "slack").',
        },
        tool: {
          type: "string",
          description:
            'Tool name. The namespace prefix is optional — both "create_issue" and "gh_create_issue" are accepted.',
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
  suggest: {
    name: "mcp_connect_suggest",
    description:
      "Surface recurring multi-server tool-call patterns as suggested 'packs' to activate in one step. Observation-only — this never loads or unloads anything. When the same 2-3 servers get used together in short bursts more than once, the pattern is surfaced here so the next workflow can call `mcp_connect_activate` once with the whole pack's namespaces instead of juggling discover + load for each server. Patterns persist across yaw-mcp restarts (via ~/.yaw-mcp/state.json) so a fresh process already knows what you usually use together. As a general rule: prefer loaded MCP servers over matching local CLIs (a loaded `npmjs` server replaces `npm audit`, `tailscale` replaces the `tailscale` CLI, etc.) — see `mcp_connect_discover` for which CLIs each installed server shadows. Returns a friendly 'no patterns yet' message when nothing has recurred.",
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
      "List curated multi-server 'bundles' — presets like `pr-review` (github + linear) or `devops-incident` (github + pagerduty + slack) that commonly ship together. Use this BEFORE mcp_connect_discover when the user's intent maps to a known workflow (on-call triage, PR review, data pipeline debugging) — it returns a ready-to-run `mcp_connect_activate namespaces=[...]` call per bundle. With `action=\"match\"` (recommended after the user's installed list is known) the response partitions bundles into READY (every namespace already in the user's bundles.json — activate now) and PARTIAL (some present, some missing — names the missing namespaces so you can tell the user to run `yaw-mcp add <slug>`; the slug catalog is at https://yaw.sh/mcp/catalog/). With `action=\"list\"` (default) it returns the full curated catalog. Bundles are static client-side data, not a network call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "match"],
          description:
            'Either "list" (return the full curated catalog; default) or "match" (partition bundles against installed servers into ready-to-activate vs partially-installed).',
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
      "List, per installed server, which local-vault secrets its `${secret:NAME}` env references resolve to -- by NAME only, never a value. Use this to confirm a server will get the credentials it needs before activating it, or to spot a typo'd / un-set secret reference. `injectedSecrets` are the names the local vault HAS and the server references; `missing` are names the server references but the vault LACKS (set them via `yaw-mcp secrets set <name>`). This is a values-free preview: it reads the vault's KEY LIST and the server's env-reference NAMES, and never decrypts or returns any secret value. Servers with no `${secret:...}` references are omitted. Requires no passphrase (no decryption happens).",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description:
            'Optional: restrict the report to a single server namespace (e.g. "gh"). Omit to report every installed server that references a vault secret.',
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
    description:
      "Run a short DECLARATIVE pipeline of upstream tool calls in a single round-trip. Use this when you already know the exact 2-4 tool calls to make and one call's output feeds another's args — e.g. `a = gh_list_prs(); b = gh_get_pr(a[0].number); return b`. NOT a code sandbox: there is no expression language, no loops, no branching, no arithmetic. The only control flow is sequential step execution; the only data-flow primitive is `{\"$ref\": \"<stepId>[.path.to.value]\"}` which substitutes a prior step's output (or a nested field of it) into the next step's args. Paths support dot keys and `[N]` / `.N` array indexing. Each step's `tool` must be a namespaced, already-loaded tool name (the exec does not auto-activate — call `mcp_connect_activate` first). Max 16 steps per exec. If any step fails, the whole pipeline fails and returns `{ ok: false, failedStep, error, partial: { ...completed outputs } }`. On success returns `{ ok: true, result: <return-step output>, steps: { ...all outputs } }`. Prefer this over back-to-back tool calls when the chain is deterministic — it saves prompt-token replay and client round-trips.",
    inputSchema: {
      type: "object" as const,
      properties: {
        steps: {
          type: "array",
          description:
            'Ordered list of tool calls to run. Each step is `{ id?: string, tool: string, args?: object }`. `args` values may be `{"$ref": "<stepId>.path"}` to inject a prior step\'s output.',
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Optional binding name for this step's output. Later steps reference it via `$ref`. Defaults to the step's positional index as a string.",
              },
              tool: {
                type: "string",
                description:
                  'Namespaced tool name (e.g. "gh_list_prs"). Must be a tool currently loaded in the session. Meta-tools (mcp_connect_*) are not callable from exec.',
              },
              args: {
                type: "object",
                description:
                  'Arguments for the tool call. Any value (including deeply nested) may be `{"$ref": "<stepId>[.path]"}` to substitute a prior step\'s output at that position.',
                additionalProperties: true,
              },
            },
            required: ["tool"],
          },
        },
        return: {
          type: "string",
          description:
            "Optional: id of the step whose output should be surfaced as `result`. Defaults to the last step's id (or its positional index).",
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

export interface SecretsReportRow {
  server: string;
  /** Names the vault HAS and this server references (sorted). */
  injectedSecrets: string[];
  /** Names this server references but the vault LACKS (sorted). */
  missing: string[];
}

/**
 * Pure, values-free computation backing the `mcp_connect_secrets`
 * meta-tool. Given each server's namespace + env map and the SET of secret
 * names the vault holds, returns one row per server that references at
 * least one `${secret:...}`:
 *   - injectedSecrets = referenced names ∩ vaultKeys
 *   - missing         = referenced names \ vaultKeys
 * Never decrypts; takes only NAMES in and emits only NAMES out. Servers
 * with no references are omitted.
 */
export function computeSecretsReport(
  servers: Array<{ namespace: string; env?: Record<string, string> }>,
  vaultKeys: Set<string>,
): SecretsReportRow[] {
  const rows: SecretsReportRow[] = [];
  for (const server of servers) {
    const referenced = new Set<string>();
    for (const v of Object.values(server.env ?? {})) {
      if (typeof v !== "string") continue;
      // String.matchAll clones the regex internally, so sharing the
      // global-flagged SECRET_REF_RE with secrets-vault's own callers
      // carries no lastIndex state between calls.
      for (const m of v.matchAll(SECRET_REF_RE)) referenced.add(m[1]);
    }
    if (referenced.size === 0) continue;
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
    });
  }
  return rows;
}

export const META_TOOL_NAMES = new Set([
  META_TOOLS.discover.name,
  META_TOOLS.activate.name,
  META_TOOLS.deactivate.name,
  META_TOOLS.health.name,
  META_TOOLS.dispatch.name,
  META_TOOLS.read_tool.name,
  META_TOOLS.suggest.name,
  META_TOOLS.exec.name,
  META_TOOLS.bundles.name,
  META_TOOLS.secrets.name,
]);
