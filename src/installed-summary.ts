// One bounded line naming the installed servers, appended to a routing
// meta-tool's description in tools/list.
//
// Why a tool description and not the initialize `instructions`: the
// instructions are answered from static data before any file is read
// (ConnectServer.start serves first and loads config after, so Claude Code's
// server/discover probe is never held behind a disk read), which means they
// cannot know what is installed. tools/list waits on the config load, so it
// can. On Claude Code the meta-tools are deferred: the model sees their names
// until it searches for one, and a search can only match on what a deferred
// tool exposes, its name and its description. A prompt like "list my PRs"
// shares no word with "mcp_connect_dispatch"; it can share "github" with
// this line.
//
// Bounded on purpose. A description is paid on every tools/list, and on a
// client with no deferred loading it is inlined into every request (see the
// wire-size pins in meta-tools.test.ts), so the line has a hard character
// cap. Naming every server beats describing a few, so labels shrink before
// any server is dropped, and only then does the overflow become a count.

import { resolveShadowedClis } from "./cli-shadows.js";
import { META_TOOLS } from "./meta-tools.js";
import { compareNamespaces } from "./proxy.js";
import type { UpstreamServerConfig } from "./types.js";

/** Ceiling on the whole installed line, in characters, suffix included. */
export const INSTALLED_LINE_MAX_CHARS = 800;

/** Tried in turn until the whole line fits: keyword count per server, and
 *  whether the shadowed-CLI note stays. */
const TIERS: ReadonlyArray<{ words: number; shadow: boolean }> = [
  { words: 4, shadow: true },
  { words: 3, shadow: true },
  { words: 2, shadow: true },
  { words: 1, shadow: true },
  { words: 0, shadow: true },
  { words: 0, shadow: false },
];

// Words that say nothing about a server's domain: closed-class words, the
// verbs every server's tools start with, and the vocabulary of MCP server
// descriptions themselves ("tools", "assistants", "directly").
const FILLER = new Set(
  (
    "the and for are that this with what which how does from into about can any all some when where " +
    "you your our its their them they via using use through over also just only more most other " +
    "get list create update delete search set add remove read write run find fetch query info new edit " +
    "covering manage management configure execute talk directly provide provides access tool tools server servers " +
    "mcp assistant assistants model models intelligence development data date demand pulled up-to-date"
  ).split(" "),
);

export type InstalledServer = Pick<UpstreamServerConfig, "namespace" | "name" | "description" | "toolCache">;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Domain keywords, in order of first appearance, lowercased and deduped:
 *  from the description when there is one, else from the display name and
 *  the tool names. Only [a-z0-9] runs survive, so nothing from bundles.json
 *  or an upstream's tool list reaches the description as markup or control
 *  characters. */
export function serverKeywords(server: InstalledServer): string[] {
  const ns = server.namespace.toLowerCase();
  const source = server.description
    ? server.description
    : [server.name ?? "", ...(server.toolCache ?? []).map((t) => t.name)].join(" ");
  const out: string[] = [];
  for (const raw of source
    .replace(CONTROL_CHARS, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^[0-9]+$/.test(raw) || FILLER.has(raw) || raw === ns) continue;
    // A plural next to its singular adds nothing ("issue", "issues").
    const singular = raw.endsWith("s") ? raw.slice(0, -1) : raw;
    if (out.includes(raw) || out.includes(singular) || out.includes(`${raw}s`)) continue;
    out.push(raw);
  }
  return out;
}

/** One server's entry: `ns (kw1, kw2; over `cli`)`, or the bare namespace. */
export function formatInstalledEntry(server: InstalledServer, words = TIERS[0].words, shadow = true): string {
  const keywords = words > 0 ? serverKeywords(server).slice(0, words) : [];
  const clis = shadow ? resolveShadowedClis(server).map((s) => `\`${s.cli}\``) : [];
  const parts = [keywords.join(", "), clis.length > 0 ? `over ${clis.join(", ")}` : ""].filter(Boolean);
  return parts.length > 0 ? `${server.namespace} (${parts.join("; ")})` : server.namespace;
}

/** The whole line, namespaces in code-unit order so the same installed set
 *  always renders the same bytes, or null when nothing is installed. Entries
 *  narrow tier by tier (TIERS) until every server fits under `maxChars`; only
 *  when even bare namespaces do not fit does the rest become a "+N more"
 *  count. */
export function formatInstalledServers(
  servers: readonly InstalledServer[],
  maxChars: number = INSTALLED_LINE_MAX_CHARS,
): string | null {
  if (servers.length === 0) return null;
  const sorted = [...servers].sort((a, b) => compareNamespaces(a.namespace, b.namespace));
  const head = "Installed servers: ";
  for (const tier of TIERS) {
    const line = `${head}${sorted.map((s) => formatInstalledEntry(s, tier.words, tier.shadow)).join(", ")}.`;
    if (line.length <= maxChars) return line;
  }
  const more = (n: number) => ` +${n} more (mcp_connect_discover lists all).`;
  let line = head;
  let shown = 0;
  for (const server of sorted) {
    const sep = shown === 0 ? "" : ", ";
    // Room for this namespace plus the "+N more" the rest would then need;
    // the loop only runs when they cannot all fit.
    const reserve = more(sorted.length - shown - 1).length;
    if (line.length + sep.length + server.namespace.length + reserve > maxChars) break;
    line += sep + server.namespace;
    shown++;
  }
  if (shown === 0) return `${head}${sorted.length} (mcp_connect_discover lists them).`;
  return line + more(sorted.length - shown);
}

/** Append the installed line to the routing tool the exposure advertises:
 *  dispatch normally, find_tool under `lite` (which does not list dispatch).
 *  Returns a new array; the descriptions in META_TOOLS are never mutated. */
export function withInstalledServers<T extends { name: string; description?: string }>(
  tools: T[],
  line: string | null,
  exposure: "gateway" | "lite" | "full",
): T[] {
  if (!line) return tools;
  const target = exposure === "lite" ? META_TOOLS.findTool.name : META_TOOLS.dispatch.name;
  return tools.map((t) => (t.name === target ? { ...t, description: `${t.description ?? ""} ${line}`.trim() } : t));
}
