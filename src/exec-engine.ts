// Pure ref-resolution logic for the `mcp_connect_exec` meta-tool.
//
// The exec surface is deliberately narrow: a declarative pipeline of
// upstream tool calls where one step's output can feed another step's
// args via `{"$ref": "<stepId>[.path]"}` markers. No expression
// language, no eval — just dot/bracket path lookup on previously-bound
// step outputs.
//
// Keeping this file pure (no I/O, no SDK) makes it trivial to unit-test
// the resolver without spinning up a whole server harness, and keeps
// the "no code execution" sandbox guarantee auditable in one place.

// Parse a ref path like "stepA.content[0].text" or "stepA.items.0.name"
// into an array of string keys / numeric indices. Supports both bracket
// ("[0]") and dot-numeric (".0") array indexing. Returns null if the
// path is malformed.
//
// NOTE: the first segment is always the step id. Subsequent segments
// drill into the bound value. An empty trailing bracket, unbalanced
// brackets, or a leading dot (other than via the expected shape) all
// return null so callers fail loudly instead of silently reading `undefined`.
export function parseRefPath(raw: string): Array<string | number> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  const tokens: Array<string | number> = [];
  let i = 0;
  let current = "";
  // Tracks whether the last token emitted was a bracket index — in
  // that case `.` is legal as a separator even though `current` is
  // empty. Plain `.` right after another `.` (or at the start) is
  // always malformed.
  let lastWasBracket = false;

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === ".") {
      // Leading dot, double dot, or trailing dot is malformed. After a
      // bracket ']' we tolerate a following '.' because "a[0].b" is
      // the canonical mixed form.
      if (current.length === 0 && !lastWasBracket) return null;
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      lastWasBracket = false;
      i++;
      continue;
    }
    if (ch === "[") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      const close = raw.indexOf("]", i + 1);
      if (close === -1) return null;
      const inside = raw.slice(i + 1, close);
      if (inside.length === 0) return null;
      // Bracket contents must be an unsigned integer index — string keys
      // inside brackets (e.g. a["foo"]) are not supported. Rejecting
      // them here means the resolver only ever sees well-formed numeric
      // indices from the bracket path.
      if (!/^\d+$/.test(inside)) return null;
      tokens.push(Number(inside));
      i = close + 1;
      lastWasBracket = true;
      // After ']' we either hit end-of-string, another '[', or a '.'.
      // A bare identifier here ("foo[0]bar") is malformed.
      if (i < raw.length && raw[i] !== "." && raw[i] !== "[") return null;
      continue;
    }
    current += ch;
    lastWasBracket = false;
    i++;
  }
  // Trailing dot is malformed — if the last char was '.' then `current`
  // is empty and `lastWasBracket` is false (dots reset it), so neither
  // a flush nor a trailing identifier closes the path.
  if (raw.endsWith(".")) return null;
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) return null;

  // Post-pass: convert dot-numeric segments ("foo.0.bar") into numeric
  // indices so downstream resolution uses Array[n] uniformly. The first
  // token (step id) is always treated as a string even if it looks
  // numeric, since step ids may be any string.
  for (let j = 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (typeof tok === "string" && /^\d+$/.test(tok)) {
      tokens[j] = Number(tok);
    }
  }

  return tokens;
}

export interface RefResolutionError {
  ref: string;
  reason: string;
}

export class RefError extends Error {
  constructor(public readonly detail: RefResolutionError) {
    super(`Bad $ref "${detail.ref}": ${detail.reason}`);
    this.name = "RefError";
  }
}

// True for plain `{ $ref: "..." }` leaf markers. The `$ref` key must be
// the only own-property on the object — anything extra (e.g. `{ $ref,
// default }`) is treated as a regular object, not a ref, to avoid
// accidentally hiding merge bugs behind "I meant that."
export function isRefNode(node: unknown): node is { $ref: string } {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== "$ref") return false;
  return typeof obj.$ref === "string";
}

// Resolve a single ref against the bindings map. Throws RefError on any
// failure (unknown step id, missing intermediate key, index out of range,
// attempt to drill into a primitive). The thrown error carries the
// original ref string so the caller can surface it to the user.
export function resolveRef(refRaw: string, bindings: Record<string, unknown>): unknown {
  const tokens = parseRefPath(refRaw);
  if (!tokens) throw new RefError({ ref: refRaw, reason: "malformed path" });

  const [stepIdToken, ...rest] = tokens;
  if (typeof stepIdToken !== "string") {
    // LOAD-BEARING -- do not delete as "unreachable". parseRefPath does NOT
    // always emit a string first: a bracket-leading ref like "[0]" parses to
    // the single token [0] (a NUMBER), because the dot-numeric post-pass
    // starts at index 1 and never touches the first token. Without this
    // guard such a ref would look up `bindings[0]` instead of failing.
    throw new RefError({ ref: refRaw, reason: "missing step id" });
  }
  if (!Object.hasOwn(bindings, stepIdToken)) {
    throw new RefError({ ref: refRaw, reason: `no step named "${stepIdToken}" has run yet` });
  }

  let cursor: unknown = bindings[stepIdToken];
  for (const seg of rest) {
    if (cursor === null || cursor === undefined) {
      throw new RefError({ ref: refRaw, reason: `cannot read "${String(seg)}" of ${String(cursor)}` });
    }
    if (typeof seg === "number") {
      if (!Array.isArray(cursor)) {
        throw new RefError({ ref: refRaw, reason: `index [${seg}] applied to non-array` });
      }
      if (seg < 0 || seg >= cursor.length) {
        throw new RefError({ ref: refRaw, reason: `index [${seg}] out of range (length ${cursor.length})` });
      }
      cursor = cursor[seg];
      continue;
    }
    // String segment: only valid on a plain object. Arrays can only be
    // indexed by numeric segments — `.length` / `.0` on an array would
    // be ambiguous otherwise, and the numeric-dot canonicalization in
    // parseRefPath already takes care of `.0`.
    if (typeof cursor !== "object" || Array.isArray(cursor)) {
      throw new RefError({ ref: refRaw, reason: `cannot read "${seg}" of non-object` });
    }
    const obj = cursor as Record<string, unknown>;
    if (!Object.hasOwn(obj, seg)) {
      throw new RefError({ ref: refRaw, reason: `no property "${seg}" on step output` });
    }
    cursor = obj[seg];
  }
  return cursor;
}

// Maximum nesting depth either args walker will descend. The tree comes from
// client-supplied JSON, and JSON.parse happily accepts nesting far deeper
// than the JS stack can recurse over -- so without a cap a
// `{"a":{"a":{"a": ...}}}` args blob turns into a RangeError thrown from
// inside the walker, which reads as an internal crash rather than as bad
// input. 64 is orders of magnitude past any real tool's args shape (the
// deepest thing exec is meant to carry is a step output nested a few levels
// in), so the cap only ever fires on input that was never going to work.
export const MAX_REF_DEPTH = 64;

/** Thrown when args nest deeper than MAX_REF_DEPTH. Separate from RefError
 *  because the failure is about the args TREE, not about any one `$ref`:
 *  blaming a ref string that may not even exist at that depth would send the
 *  reader looking for a ref bug. handleExec reports it the same way -- the
 *  step fails with this message and the pipeline stops. */
export class ExecDepthError extends Error {
  constructor(public readonly limit: number) {
    super(`args nested deeper than the ${limit}-level exec limit`);
    this.name = "ExecDepthError";
  }
}

// Walk the args tree and replace every `{"$ref": "..."}` leaf with the
// resolved value from `bindings`. Returns a NEW tree — the input is not
// mutated — so callers can safely reuse the original args shape across
// retries or logging.
//
// Non-object primitives (string/number/boolean/null/undefined) pass
// through unchanged. Arrays are walked element-by-element. Objects are
// walked key-by-key, preserving insertion order. The recursion has no
// cycle guard because the caller constructs args from JSON that the
// LLM produced — it cannot contain cycles. It DOES have a depth cap: a
// non-cyclic tree can still be deep enough to blow the stack, and
// MAX_REF_DEPTH turns that into a loud, attributable step failure.
export function resolveArgs(args: unknown, bindings: Record<string, unknown>): unknown {
  return resolveArgsAt(args, bindings, 0);
}

// `depth` counts containers entered: the root value is 0, its members are 1.
function resolveArgsAt(args: unknown, bindings: Record<string, unknown>, depth: number): unknown {
  if (depth > MAX_REF_DEPTH) throw new ExecDepthError(MAX_REF_DEPTH);
  if (isRefNode(args)) {
    return resolveRef(args.$ref, bindings);
  }
  if (Array.isArray(args)) {
    return args.map((v) => resolveArgsAt(v, bindings, depth + 1));
  }
  if (args !== null && typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      const resolved = resolveArgsAt(v, bindings, depth + 1);
      // `out[k] = v` is wrong for k === "__proto__". JSON.parse produces
      // __proto__ as an OWN property, but plain assignment hits
      // Object.prototype's __proto__ setter instead of creating an own key,
      // so the key vanishes from the rebuilt object -- and since
      // JSON.stringify only serializes own properties, the argument is
      // silently dropped from the outgoing tools/call. (This is not
      // prototype pollution: only `out`'s own prototype is affected, never
      // Object.prototype.) defineProperty stores it as the plain data
      // property the input actually had. Branching keeps the common path
      // on plain assignment.
      if (k === "__proto__") {
        Object.defineProperty(out, k, { value: resolved, writable: true, enumerable: true, configurable: true });
      } else {
        out[k] = resolved;
      }
    }
    return out;
  }
  return args;
}

// Collect the set of step ids that a step's args depend on via {"$ref": ...}
// markers. Walks the SAME tree shape resolveArgs walks, finds every $ref
// leaf, and returns the unique first path-segments (the producer step ids).
// Used for cascading-blame attribution in exec: if a step fails on bad input
// it consumed via $ref, the upstream producer shares the blame. Pure; never
// throws (a malformed ref simply contributes no dep).
//
// Same MAX_REF_DEPTH bound as resolveArgs, but it STOPS rather than throws.
// Two reasons: this runs inside exec's failure-reporting path (server.ts
// blames the producers of a failed step), where an exception would replace a
// structured `{ok:false, failedStep, partial}` report with a raw error; and
// it is only ever called on args resolveArgs already walked successfully, so
// anything past the cap belongs to a tree that could never have reached a
// tools/call in the first place. Refusing to descend loses no real dep and
// keeps the "never throws" contract this function is called under.
export function collectRefDeps(args: unknown): string[] {
  const deps = new Set<string>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_REF_DEPTH) return;
    if (isRefNode(node)) {
      const tokens = parseRefPath(node.$ref);
      // A malformed ref (parseRefPath -> null) contributes no dep. The
      // typeof check is not redundant: a bracket-leading ref ("[0]") parses
      // to a NUMBER first token, which names no producer step -- same case
      // resolveRef guards against.
      if (tokens && tokens.length > 0 && typeof tokens[0] === "string") {
        deps.add(tokens[0]);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1);
      return;
    }
    // Primitives contribute nothing.
  };

  walk(args, 0);
  return Array.from(deps);
}

// Hard cap on steps per exec. Keeps the pipeline small enough to reason
// about while still letting the common a→b→c chains through. Tuned by
// vibes, not measurement — if someone actually needs more, bump it.
export const MAX_EXEC_STEPS = 16;

export interface ExecStepInput {
  id?: string;
  tool: string;
  args?: Record<string, unknown>;
}

export interface ExecRequest {
  steps: ExecStepInput[];
  return?: string;
}

// Validate the exec input shape. Returns a typed error string on any
// violation (caller surfaces it verbatim); returns null when the input
// is clean. Pure — no I/O, no side effects.
export function validateExecRequest(req: unknown): { ok: true } | { ok: false; message: string } {
  if (req === null || typeof req !== "object" || Array.isArray(req)) {
    return { ok: false, message: "exec input must be an object with a `steps` array" };
  }
  const { steps, return: ret } = req as { steps?: unknown; return?: unknown };
  if (!Array.isArray(steps)) {
    return { ok: false, message: "`steps` must be an array" };
  }
  if (steps.length === 0) {
    return { ok: false, message: "`steps` must contain at least one step" };
  }
  if (steps.length > MAX_EXEC_STEPS) {
    return { ok: false, message: `too many steps (${steps.length}); max is ${MAX_EXEC_STEPS}` };
  }
  const seenIds = new Set<string>();
  // Positional fallback slots ("0".."N-1") reserved by UNNAMED steps. An
  // explicit id that is a pure-integer string colliding with one of these
  // slots would silently overwrite the other step in the bindings map, so
  // a later `$ref:"0.foo"` / `return:"0"` resolves to the wrong step.
  const positionalSlots = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      return { ok: false, message: `step ${i}: must be an object` };
    }
    const s = step as Record<string, unknown>;
    if (typeof s.tool !== "string" || s.tool.length === 0) {
      return { ok: false, message: `step ${i}: \`tool\` is required and must be a string` };
    }
    if (s.id !== undefined) {
      if (typeof s.id !== "string" || s.id.length === 0) {
        return { ok: false, message: `step ${i}: \`id\` must be a non-empty string` };
      }
      // `.`, `[` and `]` are the $ref path separators (see parseRefPath), so
      // an id containing one can never be named by a ref: "a.b" parses as
      // step "a" drilling into key "b", and the runtime error then blames a
      // step id the request never declared. Refusing the id up front is the
      // only place the mismatch is still explainable.
      if (/[.[\]]/.test(s.id)) {
        return {
          ok: false,
          message: `step ${i}: \`id\` "${s.id}" may not contain '.', '[' or ']' (they are $ref path separators)`,
        };
      }
      // The id becomes a key in the plain-object bindings map (server.ts:
      // `bindings[key] = ...`), where assigning "__proto__" hits
      // Object.prototype's setter instead of creating an own key: the step's
      // output silently vanishes from the result and a later $ref to it
      // reports `no step named "__proto__"` for a step that actually ran.
      // resolveArgs hardens the ARGS side of this same key via
      // defineProperty; on the id side refusing up front is cheaper than
      // threading defineProperty through every bindings writer/reader.
      if (s.id === "__proto__") {
        return { ok: false, message: `step ${i}: \`id\` "__proto__" is reserved; use a different id` };
      }
      if (seenIds.has(s.id)) {
        return { ok: false, message: `step ${i}: duplicate id "${s.id}"` };
      }
      seenIds.add(s.id);
    } else {
      positionalSlots.add(String(i));
    }
    if (s.args !== undefined && (s.args === null || typeof s.args !== "object" || Array.isArray(s.args))) {
      return { ok: false, message: `step ${i}: \`args\` must be an object if provided` };
    }
    // Unknown keys are a typo, not an extension point. A step written as
    // `{tool, arguments: {...}}` (or `arg` / `input` / `params`) otherwise
    // validates clean and dispatches the tool with `{}` -- a real call with
    // every argument silently dropped. The advertised item schema carries a
    // matching `additionalProperties: false` (meta-tools.ts), but the
    // low-level Server never validates against it, so the check has to live
    // here too.
    for (const k of Object.keys(s)) {
      if (k !== "id" && k !== "tool" && k !== "args") {
        return { ok: false, message: `step ${i}: unknown key "${k}" (allowed: id, tool, args)` };
      }
    }
  }
  // Reject explicit ids that collide with another step's positional slot --
  // both would bind under the same key and the second overwrites the first.
  for (const id of seenIds) {
    if (positionalSlots.has(id)) {
      return {
        ok: false,
        message: `step id "${id}" collides with the positional binding key of an unnamed step; rename it`,
      };
    }
  }
  if (ret !== undefined) {
    if (typeof ret !== "string" || ret.length === 0) {
      return { ok: false, message: "`return` must be a non-empty step id string" };
    }
    // The full set of valid binding keys is explicit ids PLUS the positional
    // fallback keys the loop above already collected -- every step that
    // reached this point either carries a valid non-empty string id or has
    // none at all, so `positionalSlots` is exactly the positional half.
    const allBindingKeys = new Set([...seenIds, ...positionalSlots]);
    if (!allBindingKeys.has(ret)) {
      return { ok: false, message: `\`return\` references unknown step id "${ret}"` };
    }
  }
  return { ok: true };
}

// Canonical binding key for a step: explicit id if provided, otherwise
// the step's positional index as a string ("0", "1", ...). Exposed so
// callers can build {stepId: output} maps consistently with what ref
// lookup expects.
export function stepBindingKey(step: ExecStepInput, index: number): string {
  return typeof step.id === "string" && step.id.length > 0 ? step.id : String(index);
}

// Walk one step's args exactly as resolveArgsAt does, checking every `$ref`
// against the keys bound by EARLIER steps. Returns the first problem as a
// message, or null when the subtree is clean. Throws ExecDepthError past the
// cap, mirroring the resolver so a too-deep tree is reported once, in the
// same words, whichever walker sees it first.
function checkRefsAt(node: unknown, bound: Set<string>, stepIndex: number, depth: number): string | null {
  if (depth > MAX_REF_DEPTH) throw new ExecDepthError(MAX_REF_DEPTH);
  if (isRefNode(node)) {
    const raw = node.$ref;
    const tokens = parseRefPath(raw);
    if (!tokens) return `step ${stepIndex}: $ref "${raw}" is malformed`;
    const head = tokens[0];
    if (typeof head !== "string") {
      // Same case resolveRef guards at runtime: a bracket-leading ref like
      // "[0]" parses to a NUMBER first token, which names no producer step.
      return `step ${stepIndex}: $ref "${raw}": missing step id (a bracket index cannot name a step)`;
    }
    if (!bound.has(head)) {
      return `step ${stepIndex}: $ref "${raw}" names step "${head}" which has not run by then`;
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const problem = checkRefsAt(v, bound, stepIndex, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      const problem = checkRefsAt(v, bound, stepIndex, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  return null;
}

// Preflight every `{"$ref": ...}` in the pipeline BEFORE step 0 runs.
//
// Every producer key is known statically from the steps array, so an
// unknown, forward (self or later), or malformed ref is decidable without
// executing anything -- yet resolveRef only sees it at step N, after steps
// 0..N-1 have already fired their real side effects. A one-character typo in
// step 2 of `create issue -> comment on it` therefore costs a filed issue,
// and the usual reaction (fix the ref, re-run the exec) files a second one.
//
// ORDERING CONTRACT: run this AFTER the meta-tool refusal pass over all
// steps, never before it. What makes a meta-tool step illegal is the tool it
// names, not its args, so a `{tool: "mcp_connect_exec", args: {x: {$ref:
// "nope"}}}` step must report the meta-tool refusal -- a ref error there
// sends the model off fixing arguments for a call exec will never make. That
// is also why this is a separate function rather than part of
// validateExecRequest, which server.ts runs first: exec-engine is
// dependency-free by design and cannot ask what a meta-tool is.
//
// Rejects exactly the set of requests that would have thrown at runtime,
// only earlier: `$ref`-shaped DATA (a JSON-Schema `{"$ref": "#/defs/X"}`
// travelling as an argument) already matches isRefNode and already fails
// during resolution, so no working pipeline loses.
export function validateExecRefs(steps: ExecStepInput[]): { ok: true } | { ok: false; message: string } {
  // Keys bound so far, built with stepBindingKey so a positional ref ("0",
  // "1") to an unnamed step is accepted rather than falsely rejected.
  const bound = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      const problem = checkRefsAt(step.args, bound, i, 0);
      if (problem) return { ok: false, message: problem };
    } catch (err) {
      if (err instanceof ExecDepthError) return { ok: false, message: `step ${i}: ${err.message}` };
      throw err;
    }
    // Added AFTER the check, so a step referencing itself is a forward ref.
    bound.add(stepBindingKey(step, i));
  }
  return { ok: true };
}
