// Vault recovery codes: generate, format and parse.
//
// A recovery code is 16 random bytes (128 bits). It is shown to the user ONCE,
// at the moment a vault's recovery slot is written, and is what
// `yaw-mcp secrets recover` takes in place of a forgotten passphrase. The slot
// itself (secrets-vault.ts) wraps the vault's data key under
// HKDF-SHA256(secret) -- this module only owns the human-facing encoding.
//
// Encoding: the 128 bits, left-padded with two zero bits to 130, as 26
// Crockford base32 symbols (alphabet 0-9 A-Z without I L O U), then 2 check
// symbols -- 28 symbols, displayed as "YAWR-" + 7 groups of 4:
//
//   YAWR-1A2B-3C4D-5E6F-7G8H-9JKM-NPQR-STVX
//
// Check symbols: two Damm checks over GF(32). Each uses the quasigroup
// x * y = a.x XOR y (multiplication in GF(32) under x^5 + x^2 + 1), with a
// different multiplier a per check. For a != 0 the operation is a quasigroup
// (every row and column is a permutation), and for a != 0, 1 it is weakly
// totally anti-symmetric: (c*x)*y = (c*y)*x forces x = y, because the two
// sides differ by (a + 1)(x XOR y). Those two properties are exactly Damm's
// guarantees: a single-symbol substitution and an adjacent transposition both
// change the folded result. Each check symbol is chosen so its sequence folds
// to 0:
//   - check 1 over the 26 data symbols (multiplier 2),
//   - check 2 over the 26 data symbols AND check 1 (multiplier 3),
// so check 2 alone covers every position of the 28 -- including a typo in
// either check symbol and a swap between them -- and check 1 adds an
// independent second test (a random multi-symbol error passes both with
// probability about 1/1024 instead of 1/32). recovery-code.test.ts verifies
// both guarantees exhaustively over many random codes.
//
// The secret never leaves memory except as the formatted code the CLI writes
// to the prompt stream. Buffers this module produces belong to the caller,
// who zeroes them. The module zeroes its own intermediate Buffers and the
// number[] symbol arrays (every one of which encodes the whole secret) before
// it returns or throws -- except the arrays recoverySymbols returns, which
// belong to the caller (the property tests). The strings it builds -- the
// formatted code, the typed input and its normalized forms, the groups --
// are immutable JS strings and cannot be wiped.

import { randomBytes } from "node:crypto";

/** Bytes of entropy in a recovery code. */
export const RECOVERY_SECRET_LEN = 16;

/** The prefix every displayed code carries, and parse accepts optionally. */
export const RECOVERY_CODE_PREFIX = "YAWR";

/** Crockford base32: digits and capitals without I, L, O, U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const DATA_SYMBOLS = 26;
const CHECK_SYMBOLS = 2;
const TOTAL_SYMBOLS = DATA_SYMBOLS + CHECK_SYMBOLS;
const GROUP_LEN = 4;
/** Zero bits padded in front of the 128-bit secret to reach 26 * 5 = 130. */
const PAD_BITS = DATA_SYMBOLS * 5 - RECOVERY_SECRET_LEN * 8;

/** The two Damm multipliers (GF(32) elements; neither may be 0 or 1). */
const CHECK1_MULTIPLIER = 2;
const CHECK2_MULTIPLIER = 3;

/** parseRecoveryCode: the input is not shaped like a recovery code at all. */
export const RECOVERY_CODE_FORMAT_ERROR = "not a recovery code (wrong length/characters)";

/** parseRecoveryCode: the right shape, but a check symbol disagrees -- almost
 *  certainly a mistyped or misread symbol. */
export const RECOVERY_CODE_TYPO_ERROR = "typo in the recovery code (check failed)";

/** A well-formed code whose key does not unwrap this vault's recovery slot
 *  (thrown by secrets-vault.ts's unlockWithRecoveryCode). */
export const RECOVERY_CODE_WRONG_VAULT_ERROR = "this recovery code does not open this vault";

/** Multiply in GF(32) modulo x^5 + x^2 + 1. */
function gfMul(a: number, b: number): number {
  let x = a;
  let y = b;
  let out = 0;
  while (y > 0) {
    if (y & 1) out ^= x;
    y >>= 1;
    x <<= 1;
    if (x & 0x20) x ^= 0x25;
  }
  return out;
}

/** Damm fold of `symbols[0..end)` under x * y = a.x XOR y, starting from 0.
 *  `end` instead of a slice, so no copy of the secret's symbols is made. */
function dammFold(symbols: readonly number[], multiplier: number, end = symbols.length): number {
  let interim = 0;
  for (let i = 0; i < end; i++) interim = gfMul(multiplier, interim) ^ symbols[i];
  return interim;
}

/** The check symbol that makes `symbols` + it fold to 0 under `multiplier`:
 *  a.r XOR c = 0, so c = a.r. */
function dammCheck(symbols: readonly number[], multiplier: number): number {
  return gfMul(multiplier, dammFold(symbols, multiplier));
}

/** Append both check symbols to the 26 data symbols, in a new array (one
 *  copy, so there is no second intermediate to wipe). */
function withChecks(data: readonly number[]): number[] {
  const out = [...data, dammCheck(data, CHECK1_MULTIPLIER)];
  out.push(dammCheck(out, CHECK2_MULTIPLIER));
  return out;
}

/** True iff a 28-symbol sequence passes both checks. Exported for the
 *  property tests, which mutate symbol arrays directly. */
export function checksPass(symbols: readonly number[]): boolean {
  if (symbols.length !== TOTAL_SYMBOLS) return false;
  return dammFold(symbols, CHECK1_MULTIPLIER, DATA_SYMBOLS + 1) === 0 && dammFold(symbols, CHECK2_MULTIPLIER) === 0;
}

/** 16 secret bytes -> 26 five-bit symbols, most significant first. */
function secretToSymbols(secret: Buffer): number[] {
  const symbols: number[] = [];
  for (let i = 0; i < DATA_SYMBOLS; i++) {
    let v = 0;
    for (let b = 0; b < 5; b++) {
      const padded = i * 5 + b;
      const bit = padded < PAD_BITS ? 0 : (secret[(padded - PAD_BITS) >> 3] >> (7 - ((padded - PAD_BITS) & 7))) & 1;
      v = (v << 1) | bit;
    }
    symbols.push(v);
  }
  return symbols;
}

/** 26 data symbols -> 16 secret bytes, or null when the pad bits are set. */
function symbolsToSecret(symbols: readonly number[]): Buffer | null {
  const out = Buffer.alloc(RECOVERY_SECRET_LEN);
  for (let i = 0; i < DATA_SYMBOLS; i++) {
    for (let b = 0; b < 5; b++) {
      const bit = (symbols[i] >> (4 - b)) & 1;
      const padded = i * 5 + b;
      if (padded < PAD_BITS) {
        if (bit !== 0) {
          out.fill(0);
          return null;
        }
        continue;
      }
      const k = padded - PAD_BITS;
      out[k >> 3] |= bit << (7 - (k & 7));
    }
  }
  return out;
}

/** The full 28-symbol array (data + checks) for `secret`. Exported for the
 *  property tests. */
export function recoverySymbols(secret: Buffer): number[] {
  if (secret.length !== RECOVERY_SECRET_LEN) throw new Error(`recovery secret must be ${RECOVERY_SECRET_LEN} bytes`);
  const data = secretToSymbols(secret);
  try {
    return withChecks(data);
  } finally {
    data.fill(0);
  }
}

/** Render a 28-symbol array as the display form. */
export function formatSymbols(symbols: readonly number[]): string {
  const chars = symbols.map((s) => ALPHABET[s]).join("");
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GROUP_LEN) groups.push(chars.slice(i, i + GROUP_LEN));
  return [RECOVERY_CODE_PREFIX, ...groups].join("-");
}

/** A fresh random recovery secret (the caller zeroes it). */
export function generateRecoverySecret(): Buffer {
  const raw = randomBytes(RECOVERY_SECRET_LEN);
  const out = Buffer.alloc(RECOVERY_SECRET_LEN);
  raw.copy(out);
  raw.fill(0);
  return out;
}

/** The display form of `secret`: "YAWR-" + 7 groups of 4. */
export function formatRecoveryCode(secret: Buffer): string {
  const symbols = recoverySymbols(secret);
  try {
    return formatSymbols(symbols);
  } finally {
    symbols.fill(0);
  }
}

/** The 7 four-symbol groups of a formatted code, in order (group 1 first) --
 *  what the creation prompt asks the user to type back. Accepts anything
 *  parseRecoveryCode accepts. */
export function recoveryCodeGroups(code: string): string[] {
  const symbols = parseSymbols(code);
  try {
    const chars = symbols.map((s) => ALPHABET[s]).join("");
    const groups: string[] = [];
    for (let i = 0; i < chars.length; i += GROUP_LEN) groups.push(chars.slice(i, i + GROUP_LEN));
    return groups;
  } finally {
    symbols.fill(0);
  }
}

/** Normalize one group as typed (case, Crockford aliases, separators) for a
 *  comparison against recoveryCodeGroups' output. */
export function normalizeRecoveryGroup(input: string): string {
  return normalizeChars(input);
}

/** The single normalization entry point for typed input: NFKC first, then
 *  case, separators, Crockford aliases. NFKC folds full-width digits/letters
 *  ("１", "Ｙ") a CJK IME hands back onto their ASCII forms -- without
 *  it the right code was rejected as wrong length/characters -- and is a
 *  no-op on ASCII, mirroring why the passphrase path normalizes at all
 *  (secrets-crypto.ts normalizePassphrase). */
function normalizeChars(input: string): string {
  return input
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** Parse to symbols and verify both checks. Throws the format or typo error. */
function parseSymbols(input: string): number[] {
  // Normalize once, up front (see normalizeChars): so the prefix check below
  // sees a full-width "ＹＡＷＲ" as "YAWR" and the alias map runs on ASCII.
  let s = normalizeChars(input);
  // A real code never starts with Y (its first symbol is < 8), so stripping
  // the prefix cannot eat a symbol.
  if (s.startsWith(RECOVERY_CODE_PREFIX)) s = s.slice(RECOVERY_CODE_PREFIX.length);
  if (s.length !== TOTAL_SYMBOLS) throw new Error(RECOVERY_CODE_FORMAT_ERROR);
  const symbols: number[] = [];
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) {
      symbols.fill(0);
      throw new Error(RECOVERY_CODE_FORMAT_ERROR);
    }
    symbols.push(v);
  }
  if (!checksPass(symbols)) {
    symbols.fill(0);
    throw new Error(RECOVERY_CODE_TYPO_ERROR);
  }
  return symbols;
}

/** Parse a code as the user typed it: case-insensitive, spaces and dashes
 *  ignored, the "YAWR" prefix optional, full-width forms NFKC-normalized to
 *  ASCII (CJK IME input), Crockford's O -> 0 and I/L -> 1 aliases applied
 *  (U is invalid). Returns the 16-byte secret in the
 *  caller's own allocation (zero it when done). Throws
 *  RECOVERY_CODE_FORMAT_ERROR for the wrong length or characters, and
 *  RECOVERY_CODE_TYPO_ERROR when a check symbol disagrees. */
export function parseRecoveryCode(input: string): Buffer {
  const symbols = parseSymbols(input);
  // symbolsToSecret reads only the first DATA_SYMBOLS entries, so no data-only
  // copy is made (it would be one more array to wipe).
  const secret = symbolsToSecret(symbols);
  symbols.fill(0);
  // Both checks passed but the pad bits are set: not something this module
  // ever produced (a multi-symbol error that happened to pass both checks,
  // or a code from somewhere else). Shape-level, so the format error.
  if (secret === null) throw new Error(RECOVERY_CODE_FORMAT_ERROR);
  return secret;
}
