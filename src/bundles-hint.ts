// Which bundles.json a user-facing message sends the reader to edit.
//
// A module of its own so the two places that name that file share one
// spelling: server.ts (the meta-tool messages) and upstream.ts (the pointer
// withConfigPointer appends to every activation and connect failure).
// upstream.ts cannot import it from server.ts -- server.ts imports upstream.ts.

/** The bundles.json a message points the model at, in the one spelling every
 *  such message shares: "the bundles.json that defines it (...)" for a
 *  configured server's entry, "the bundles.json in effect (...)" for a
 *  namespace no entry defines.
 *
 *  Not a hardcoded ~/.yaw-mcp/bundles.json: a trusted project-local
 *  .yaw-mcp/bundles.json defines servers too, and while one is in effect it
 *  replaces the user-global file outright (local-bundles.ts -- no merge), so
 *  an edit sent to ~/.yaw-mcp/bundles.json would land in a file this session
 *  never reads. Where `yaw-mcp add` WRITES is a different fact -- always the
 *  user-global file -- so server.ts's NO_SERVERS_INSTALLED_TEXT names that one
 *  alone. */
export function bundlesFileHint(which: "defines-it" | "in-effect"): string {
  const file = which === "defines-it" ? "the bundles.json that defines it" : "the bundles.json in effect";
  return `${file} (~/.yaw-mcp/bundles.json, or a trusted project-local .yaw-mcp/bundles.json)`;
}
