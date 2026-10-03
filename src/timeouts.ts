// Leaf module: NO imports, by design. local-set-cmd.ts needs MAX_TIMEOUT_MS to
// validate `connectTimeoutMs`, and reaching it through upstream.ts pulled the
// whole MCP SDK client graph into a CLI subcommand that never connects to
// anything. Anything added here must stay a pure constant for the same reason.

/** Node's timer ceiling. setTimeout stores its delay in a signed 32-bit int,
 *  so ANY delay above 2^31-1 ms (~24.9 days) silently becomes 1ms and fires
 *  almost immediately. A `connectTimeoutMs` past that -- a typo'd extra digit
 *  in bundles.json, which the loader's `> 0` check happily accepts -- would
 *  therefore fail the connect instantly while the error message quoted a
 *  multi-day ceiling. That per-server CONFIG value is clamped at the connect
 *  site (upstream.ts) so the value used and the value reported match.
 *
 *  For the operator-facing ENV knobs it is the top of the ACCEPTED RANGE
 *  rather than a clamp target -- see resolveTimeoutEnv in upstream.ts for why
 *  the two differ. */
export const MAX_TIMEOUT_MS = 2_147_483_647;
