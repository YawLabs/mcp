import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fallbackToolsFor } from "../fallback-tools.js";
import { queryCoverage, type RankableServer, rankServers, rankTools } from "../relevance.js";
import { pickAutoWarmWinner } from "../server.js";

// ═══════════════════════════════════════════════════════════════════════
// Routing-quality gate on REAL server data.
//
// routing-quality.test.ts ranks hand-written intents against 15 hand-written
// servers; foundry-routing.test.ts is dormant (no harvested corpus). Neither
// sees what the ranker actually faces on an install: long, overlapping tool
// descriptions (azure alone has 73 tools), and servers whose tool list was
// never learned. This file does.
//
// fixtures/routing-real/servers.json is one real 21-server install: each
// server's namespace, name and description from bundles.json, plus its
// cached tool names and descriptions from state.json's toolCache (sanitized
// as persistence.ts does: description cut to 2000 chars). Nothing else was
// copied -- no env, headers, args, urls or paths. github, terraform and
// vault have EMPTY tool lists on purpose: their docker prewarm fails, so
// that is the real-world condition. The product then ranks them on the
// bundled lists in fallback-tools.ts (server.ts rankableFor), which match on
// the image the entry runs; the fixture copied no args, so LAUNCH below
// supplies the three public image names that install used, and SERVERS is
// what rankableFor would build. The persisted cache carries no inputSchema,
// so the fixture has none either.
//
// fixtures/routing-real/corpus.json is 192 labeled prompts: 125 written for
// the routing eval (direct / paraphrase / jargon-gap / ambiguous /
// multi-step / negative) plus 67 held-out ones written WITHOUT seeing any
// tool description (heldout, more negatives, and negative_uninstalled --
// asks for a service that is not installed).
//
// The decisions measured are the ones the product makes:
//   * server ranking: rankServers, which dispatch and discover both call via
//     rankIntentCandidates (server.ts). In a fresh session dispatch's health
//     and learning multipliers are 1, so dispatch's pick is the top-1 here.
//   * auto-warm: pickAutoWarmWinner, the gate discover(context) applies.
//   * find_tool: rankTools over every server, as handleFindTool calls it.
//
// The floors below are the values measured on the ranker as it stands, so
// this gate catches regressions; raise them when ranking improves. Counts,
// not percentages, so a floor is exact.
// ═══════════════════════════════════════════════════════════════════════

interface CorpusItem {
  id: string;
  prompt: string;
  category: string;
  expect_servers: string[];
  expect_tools: string[];
}

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/routing-real/${name}`, import.meta.url)), "utf8"));

const FIXTURE: RankableServer[] = (fixture("servers.json") as { servers: RankableServer[] }).servers.map((s) => ({
  namespace: s.namespace,
  name: s.name,
  description: s.description,
  tools: s.tools.map((t) => ({ name: t.name, description: t.description })),
}));
// How the install launched the three servers with no learned list (its
// bundles.json; env names only, no values).
const LAUNCH: Record<string, { command: string; args: string[] }> = {
  github: {
    command: "docker",
    args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
  },
  terraform: {
    command: "docker",
    args: ["run", "-i", "--rm", "-e", "TFE_TOKEN", "-e", "TFE_ADDRESS", "hashicorp/terraform-mcp-server"],
  },
  vault: {
    command: "docker",
    args: [
      "run",
      "-i",
      "--rm",
      "-e",
      "VAULT_ADDR",
      "-e",
      "VAULT_TOKEN",
      "-e",
      "VAULT_NAMESPACE",
      "hashicorp/vault-mcp-server",
    ],
  },
};
// rankableFor's rule: a server with no list gets its bundled one, if any.
const SERVERS: RankableServer[] = FIXTURE.map((s) => {
  const launch = LAUNCH[s.namespace];
  const bundled = s.tools.length === 0 && launch ? fallbackToolsFor(launch) : undefined;
  return bundled ? { ...s, tools: bundled.map((t) => ({ ...t })) } : s;
});
const ITEMS: CorpusItem[] = (fixture("corpus.json") as { items: CorpusItem[] }).items;

interface Row {
  n: number;
  // positives (expect_servers non-empty)
  serverLabeled: number;
  serverTop1: number;
  serverTop3: number;
  // positives with expect_tools
  toolLabeled: number;
  toolTop1: number;
  toolTop5: number;
  // every item
  autoWarm: number;
  autoWarmCorrect: number;
  wouldDispatch: number;
}

function measure(items: CorpusItem[], servers: RankableServer[] = SERVERS): Row {
  const row: Row = {
    n: items.length,
    serverLabeled: 0,
    serverTop1: 0,
    serverTop3: 0,
    toolLabeled: 0,
    toolTop1: 0,
    toolTop5: 0,
    autoWarm: 0,
    autoWarmCorrect: 0,
    wouldDispatch: 0,
  };
  for (const item of items) {
    const ranked = rankServers(item.prompt, servers);
    const order = ranked.map((r) => r.namespace);
    const exp = item.expect_servers;
    if (ranked.length > 0) row.wouldDispatch++;
    // The same inputs discover's gate gets: score plus the server's coverage
    // of the query (server.ts rankIntentCandidates). The health and learning
    // multipliers are 1 in a fresh session, so they are left out.
    const coverage = new Map(queryCoverage(item.prompt, servers).map((c) => [c.namespace, c.coverage]));
    const warm = pickAutoWarmWinner(ranked.map((r) => ({ ...r, coverage: coverage.get(r.namespace) ?? 0 })));
    if (warm) {
      row.autoWarm++;
      if (exp.includes(warm.namespace)) row.autoWarmCorrect++;
    }
    if (exp.length > 0) {
      row.serverLabeled++;
      if (order[0] !== undefined && exp.includes(order[0])) row.serverTop1++;
      // A multi-step prompt needs EVERY server it names within reach; any
      // other positive needs one acceptable server in the top 3.
      const top3 = order.slice(0, 3);
      const hit3 =
        item.category === "multi-step" ? exp.every((ns) => top3.includes(ns)) : top3.some((ns) => exp.includes(ns));
      if (hit3) row.serverTop3++;
    }
    if (exp.length > 0 && item.expect_tools.length > 0) {
      row.toolLabeled++;
      const tools = rankTools(item.prompt, servers);
      const hit = (t: { namespace: string; name: string } | undefined) =>
        t !== undefined && exp.includes(t.namespace) && item.expect_tools.includes(t.name);
      if (hit(tools[0])) row.toolTop1++;
      if (tools.slice(0, 5).some(hit)) row.toolTop5++;
    }
  }
  return row;
}

const CATEGORIES = [
  "direct",
  "paraphrase",
  "jargon-gap",
  "ambiguous",
  "multi-step",
  "heldout",
  "negative",
  "negative_uninstalled",
] as const;
type Category = (typeof CATEGORIES)[number];

// The 105 positives of the original eval corpus, kept as one row so the
// number compares directly with that eval's "overall" figures.
const EVAL_POSITIVES = ["direct", "paraphrase", "jargon-gap", "ambiguous", "multi-step"];

const ROWS = new Map<string, Row>(CATEGORIES.map((c) => [c, measure(ITEMS.filter((i) => i.category === c))]));
ROWS.set("eval positives", measure(ITEMS.filter((i) => EVAL_POSITIVES.includes(i.category))));
// The original eval's 20 negatives (n01-n20), without the held-out ones.
ROWS.set("eval negatives", measure(ITEMS.filter((i) => i.category === "negative" && !i.id.startsWith("ho-"))));

function table(): string {
  const frac = (a: number, b: number) => (b === 0 ? "-" : `${a}/${b} ${((100 * a) / b).toFixed(1)}%`);
  const head = [
    "category",
    "n",
    "server top-1",
    "server top-3",
    "tool top-1",
    "tool top-5",
    "auto-warm (correct)",
    "any match",
  ];
  const lines = [...ROWS].map(([cat, r]) => [
    cat,
    String(r.n),
    frac(r.serverTop1, r.serverLabeled),
    frac(r.serverTop3, r.serverLabeled),
    frac(r.toolTop1, r.toolLabeled),
    frac(r.toolTop5, r.toolLabeled),
    `${r.autoWarm}/${r.n} (${r.autoWarmCorrect})`,
    `${r.wouldDispatch}/${r.n}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(" | ");
  return [fmt(head), widths.map((w) => "-".repeat(w)).join("-|-"), ...lines.map(fmt)].join("\n");
}

// Positive floors: hits that must not drop. Negative ceilings: auto-warms
// that must not grow (a negative is answerable without any server, so every
// auto-warm there loads tools for nothing).
//
// Measured after term normalization (suffix fold, abbreviations, derived
// aliases) and the query function-word drop landed in relevance.ts. Every
// eval-positive total rose (server top-1 79 -> 83, top-3 87 -> 89, tool top-1
// 40 -> 51, top-5 57 -> 73 of 102, correct auto-warms 66 -> 71), but four
// cells went the other way and were lowered to what they now measure:
//   * ambiguous serverTop3 13 -> 12 and autoWarmCorrect 9 -> 8: a05 ("count
//     how many sessions...") lost postgres from the top 3 when "how" and
//     "many" stopped scoring, and a07 ("list the files in /etc/nginx") no
//     longer auto-warms filesystem -- folding "files" onto "file", a term most
//     servers carry, lowered its IDF;
//   * multi-step toolTop1 6 -> 5: m05's top tool is now pg_top_queries
//     ("slow query") rather than pg_explain;
//   * the negative ceilings 11 -> 12 and 6 -> 7: with function words no
//     longer spreading points over every server, a lone remaining match clears
//     the auto-warm margin more easily (n11 "TCP and UDP" now matches only
//     caddy), and the abbreviations do what they are for on prompts that need
//     no tool ("k8s StatefulSet" -> kubernetes, "the db is down" -> postgres).
//     The auto-warm gate (pickAutoWarmWinner), not the ranker, is the place to
//     bring these back down; relevance.ts's queryCoverage exists for it.
//
// Then the auto-warm gate gained its coverage floor (server.ts
// AUTO_ACTIVATE_MIN_COVERAGE = 0.38, chosen on the non-ho items; the reasoning
// is at the constant). Auto-warms on negatives fell to 0 of 30 (from 12) and
// on negative_uninstalled to 3 of 15 (from 7). Correct auto-warms fell with
// them, deliberately -- a withheld warm costs one more call, a wrong one
// spawns a server -- and every autoWarmCorrect floor below was lowered to the
// new measurement: direct 19 -> 15, paraphrase 25 -> 19, jargon-gap 11 -> 9,
// ambiguous 8 -> 5, multi-step 8 -> 6, heldout 27 -> 14. The ranking floors
// are untouched: coverage never changes the order or what dispatch loads.
//
// Then github, terraform and vault started ranking on their bundled tool
// lists (fallback-tools.ts) instead of on name + description alone. Server
// top-1 rose (eval positives 83 -> 85: d15 now picks terraform, a08 terraform;
// heldout 32 -> 33), find_tool now reaches those servers (d14 ->
// github.create_pull_request, d16 -> vault.read_secret), and the floors that
// rose were raised: direct serverTop1 20 -> 21 and autoWarmCorrect 15 -> 16,
// ambiguous serverTop1 11 -> 12 and serverTop3 12 -> 13, heldout serverTop1
// 32 -> 33, serverTop3 35 -> 36, autoWarmCorrect 14 -> 16, and the
// negative_uninstalled ceiling 3 -> 2. Three cells went down, all on words the
// upstream tool names really use, and were lowered:
//   * multi-step serverTop3 7 -> 6: m02 ("...then PULL its current docs")
//     now has github ("pull request") second, which pushes npmjs, one of the
//     two servers it needs, out of the top 3;
//   * ambiguous toolTop5 9 -> 8: a03 ("the docs for Prisma Client's
//     createMany") ranks three terraform tools that fetch "up-to-date
//     documentation" ("docs" is an alias of documentation) above context7's
//     query-docs, which falls to sixth;
//   * jargon-gap autoWarmCorrect 9 -> 8: j10 ("when did they last cut a
//     release?") no longer auto-warms npmjs: github's release tools share the
//     word and github's score (7.31) comes within the margin of npmjs (7.86).
//
// Out-of-sample limit: the 42 heldout items carry no expect_tools, so
// heldout has no tool floor and every rankTools change above (the
// function-word drop, the tie-break order) is checked only on the in-sample
// items it was tuned against, plus the six heldout github / terraform / vault
// labels in BUNDLED_TOOL_LABELS below, which were written in the same change
// as the bundled lists. Held-out tool labels written without reading the
// tool lists would close this.
const FLOORS: Record<Exclude<Category, "negative" | "negative_uninstalled">, Partial<Row>> = {
  direct: { serverTop1: 21, serverTop3: 21, toolTop1: 15, toolTop5: 18, autoWarmCorrect: 16 },
  paraphrase: { serverTop1: 28, serverTop3: 31, toolTop1: 19, toolTop5: 29, autoWarmCorrect: 19 },
  "jargon-gap": { serverTop1: 15, serverTop3: 18, toolTop1: 5, toolTop5: 9, autoWarmCorrect: 8 },
  ambiguous: { serverTop1: 12, serverTop3: 13, toolTop1: 7, toolTop5: 8, autoWarmCorrect: 5 },
  "multi-step": { serverTop1: 9, serverTop3: 6, toolTop1: 5, toolTop5: 8, autoWarmCorrect: 6 },
  heldout: { serverTop1: 33, serverTop3: 36, autoWarmCorrect: 16 },
};
const NEGATIVE_AUTOWARM_CEILING: Record<"negative" | "negative_uninstalled", number> = {
  negative: 0,
  negative_uninstalled: 2,
};

describe("routing on a real 21-server install", () => {
  it("fixture is the real install it claims to be", () => {
    expect(FIXTURE).toHaveLength(21);
    expect(FIXTURE.filter((s) => s.tools.length === 0).map((s) => s.namespace)).toEqual([
      "github",
      "terraform",
      "vault",
    ]);
    expect(FIXTURE.reduce((a, s) => a + s.tools.length, 0)).toBe(487);
    // ...and the bundled lists fill exactly those three.
    expect(SERVERS.filter((s) => s.tools.length === 0)).toEqual([]);
    expect(SERVERS.reduce((a, s) => a + s.tools.length, 0)).toBe(487 + 44 + 9 + 16);
    expect(ITEMS).toHaveLength(192);
    expect(new Set(ITEMS.map((i) => i.id)).size).toBe(ITEMS.length);
    for (const item of ITEMS) expect(CATEGORIES as readonly string[]).toContain(item.category);
  });

  it("every label names a server (and, where its tools are known, a tool) in the fixture", () => {
    const byNs = new Map(FIXTURE.map((s) => [s.namespace, s]));
    for (const item of ITEMS) {
      for (const ns of item.expect_servers) expect(byNs.has(ns), `${item.id}: ${ns}`).toBe(true);
      if (item.expect_tools.length === 0) continue;
      const known = item.expect_servers.flatMap((ns) => byNs.get(ns)?.tools.map((t) => t.name) ?? []);
      for (const tool of item.expect_tools) expect(known, `${item.id}: ${tool}`).toContain(tool);
    }
  });

  it("measures and prints the per-category baseline", () => {
    console.log(`\nrouting-real (21 servers, 487 cached tools, ${ITEMS.length} prompts)\n${table()}\n`);
    expect(ROWS.get("eval positives")?.serverLabeled).toBe(105);
  });

  for (const [cat, floor] of Object.entries(FLOORS)) {
    it(`${cat}: hit counts stay at or above the floor`, () => {
      const row = ROWS.get(cat);
      expect(row).toBeDefined();
      for (const [key, min] of Object.entries(floor) as Array<[keyof Row, number]>) {
        expect(row?.[key], `${cat} ${key}`).toBeGreaterThanOrEqual(min);
      }
    });
  }

  for (const [cat, ceiling] of Object.entries(NEGATIVE_AUTOWARM_CEILING)) {
    it(`${cat}: auto-warm fires no more often than the ceiling`, () => {
      expect(ROWS.get(cat)?.autoWarm).toBeLessThanOrEqual(ceiling);
    });
  }

  // AUTO_ACTIVATE_MIN_COVERAGE was tuned on all 21 servers, but coverage is
  // not install-size neutral: an unmatched word weighs log((N+0.5)/0.5+1)
  // (relevance.ts queryCoverage) and every matched word's IDF moves with N
  // too. So the negative ceilings are also asserted on smaller installs cut
  // from the same fixture: the six servers of a reviewer's repro, and the
  // first twelve. Only the answerable-without-a-tool prompts are counted --
  // a subset drops the expected server of most positives.
  //
  // Measured, and why the gate is unchanged: of the 45 negatives (20 eval,
  // 10 held-out, 15 uninstalled) 2 auto-warm at N=21, 5 at N=6 and 6 at
  // N=12. Re-weighting unseen words was tried on all three sizes -- dropping
  // them from coverage, weighting them at the corpus's highest seen IDF, at
  // half the unseen IDF, or at a flat 1.0 -- and so was waiving the floor
  // above a 3x or 5x score lead. At the same 0.38 floor every variant warmed
  // more negatives at every size than the current gate (dropping unseen
  // words: 16 at N=21, 30 at N=6), because the words no server has are what
  // marks "Redis LRU vs LFU" as a question rather than a task. The closest,
  // highest-seen-IDF, needed a 0.45 floor to get back to 2 at N=21 and then
  // made fewer correct held-out warms (12 vs 16). The cost stays where the
  // constant's comment puts it: a request carrying argument values (package
  // names, an issue title) covers less and is not auto-warmed; dispatch
  // still loads its pick.
  const SUBSETS: Record<string, { servers: string[]; negativeCeiling: number }> = {
    "6 servers": {
      servers: ["postgres", "redis", "kubernetes", "playwright", "npmjs", "tailscale"],
      negativeCeiling: 5,
    },
    "12 servers": { servers: FIXTURE.slice(0, 12).map((s) => s.namespace), negativeCeiling: 6 },
  };

  for (const [label, { servers: names, negativeCeiling }] of Object.entries(SUBSETS)) {
    it(`negatives on a ${label} install stay at or under their auto-warm ceiling`, () => {
      const subset = SERVERS.filter((s) => names.includes(s.namespace));
      expect(subset).toHaveLength(names.length);
      const negatives = ITEMS.filter((i) => i.expect_servers.length === 0);
      const row = measure(negatives, subset);
      expect(row.n).toBe(45);
      expect(row.autoWarm).toBeLessThanOrEqual(negativeCeiling);
    });
  }

  // The corpus gives the github / terraform / vault items no expect_tools
  // (that install never learned their lists), so the tool columns above
  // cannot show what the bundled lists do for find_tool. These labels name
  // the upstream tools fallback-tools.ts lists, per item. Measured: without
  // the bundled lists none of the 10 has its tool anywhere in the top 5 (each
  // top-1 is some other server's tool, e.g. d16 "Read the KV secret ... from
  // Vault" -> tailscale_create_oauth_app); with them, 6 are top-1 and 8 are in
  // the top 5. Misses: ho-github-1 and ho-github-2 are top-5 only,
  // ho-terraform-1 ranks get_provider_capabilities first, and ho-vault-2
  // ("rotate the api key ...") matches no vault tool's words.
  const BUNDLED_TOOL_LABELS: Record<string, string[]> = {
    d14: ["create_pull_request"],
    d15: ["get_latest_provider_version"],
    d16: ["read_secret"],
    a08: ["get_latest_provider_version", "query-docs", "resolve-library-id"],
    "ho-github-1": ["list_pull_requests", "search_pull_requests"],
    "ho-github-2": ["issue_write"],
    "ho-terraform-1": ["search_provider_docs", "get_provider_details"],
    "ho-terraform-2": ["search_modules"],
    "ho-vault-1": ["read_secret"],
    "ho-vault-2": ["write_secret"],
  };

  it("find_tool reaches github, terraform and vault tools through their bundled lists", () => {
    const count = (servers: RankableServer[]) => {
      let top1 = 0;
      let top5 = 0;
      for (const [id, names] of Object.entries(BUNDLED_TOOL_LABELS)) {
        const item = ITEMS.find((i) => i.id === id);
        expect(item, id).toBeDefined();
        const exp = item?.expect_servers ?? [];
        const hit = (t: { namespace: string; name: string } | undefined) =>
          t !== undefined && exp.includes(t.namespace) && names.includes(t.name);
        const tools = rankTools(item?.prompt ?? "", servers);
        if (hit(tools[0])) top1++;
        if (tools.slice(0, 5).some(hit)) top5++;
      }
      return { top1, top5 };
    };
    // Every label is a real upstream name in the bundled lists.
    const bundledNames = new Set(SERVERS.flatMap((s) => s.tools.map((t) => t.name)));
    for (const names of Object.values(BUNDLED_TOOL_LABELS)) {
      expect(names.some((n) => bundledNames.has(n))).toBe(true);
    }
    expect(count(FIXTURE)).toEqual({ top1: 0, top5: 0 });
    const withBundled = count(SERVERS);
    expect(withBundled.top1).toBeGreaterThanOrEqual(6);
    expect(withBundled.top5).toBeGreaterThanOrEqual(8);
  });
});
