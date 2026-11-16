// THE npm-registry "latest version" probe.
//
// A LEAF module (no imports) on purpose. Three callers need it -- upgrade-cmd's
// fetchLatestVersion (for @yawlabs/mcp itself), doctor-cmd's per-sidecar
// check, and sidecar-refresh's background check on the serve startup path --
// and the last of those must not import a command module for one fetch. Each
// used to carry its own copy of this request and its response validation.
//
// What stays with the CALLER, because it is where they really differ: the
// timeout budget (a parameter here), whether the probe runs at all (each
// caller's own test-sandbox / opt-out gate), and any injected stand-in.

/**
 * Ask registry.npmjs.org for the newest published version of `pkg`
 * (`GET /<pkg>/latest`), or null on ANY failure: a non-2xx answer, a body
 * that is not JSON or carries no string `version`, no network, or a stall
 * past `timeoutMs` (a hard abort through an AbortController). Never throws.
 *
 * `pkg` goes into the URL unencoded, scope and all (`@yawlabs/mcp`) -- the
 * shape every caller has always used against this registry.
 *
 * Always registry.npmjs.org: npm's configured `registry` (.npmrc,
 * npm_config_registry) is NOT read. Callers that go on to run an install
 * document what that mismatch costs them.
 */
export async function fetchLatestVersion(pkg: string, timeoutMs: number): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
