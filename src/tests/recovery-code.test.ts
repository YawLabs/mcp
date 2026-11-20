import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  checksPass,
  formatRecoveryCode,
  formatSymbols,
  generateRecoverySecret,
  normalizeRecoveryGroup,
  parseRecoveryCode,
  RECOVERY_CODE_FORMAT_ERROR,
  RECOVERY_CODE_TYPO_ERROR,
  RECOVERY_SECRET_LEN,
  recoveryCodeGroups,
  recoverySymbols,
} from "../recovery-code.js";

const DISPLAY_RE = /^YAWR(-[0-9A-HJKMNP-TV-Z]{4}){7}$/;

/** A real code holding BOTH an ASCII 0 and an ASCII 1, so an alias-fold test
 *  built from it cannot quietly substitute nothing: a random 28-symbol code has
 *  neither with probability ~(1-2/32)^28 ~= 16%, which would leave such a test
 *  asserting on an empty input. */
function codeWithBothDigits(): { secret: Buffer; code: string } {
  for (let i = 0; i < 2000; i++) {
    const secret = randomBytes(RECOVERY_SECRET_LEN);
    const code = formatRecoveryCode(secret);
    if (code.includes("0") && code.includes("1")) return { secret, code };
  }
  throw new Error("no code with both 0 and 1 after 2000 draws -- alphabet broken?");
}

/** Many random secrets, plus the all-zero and all-one edge cases. */
function sampleSecrets(n: number): Buffer[] {
  const out = [Buffer.alloc(RECOVERY_SECRET_LEN, 0), Buffer.alloc(RECOVERY_SECRET_LEN, 0xff)];
  for (let i = 0; i < n; i++) out.push(randomBytes(RECOVERY_SECRET_LEN));
  return out;
}

describe("recovery code format", () => {
  it("round-trips: format then parse yields the same 16 bytes", () => {
    for (const secret of sampleSecrets(500)) {
      const code = formatRecoveryCode(secret);
      expect(code).toMatch(DISPLAY_RE);
      expect(parseRecoveryCode(code).equals(secret)).toBe(true);
    }
  });

  it("is 28 symbols: 26 data (top 2 bits zero, so the first is below 8) + 2 checks", () => {
    for (const secret of sampleSecrets(50)) {
      const symbols = recoverySymbols(secret);
      expect(symbols).toHaveLength(28);
      expect(symbols[0]).toBeLessThan(8);
      expect(checksPass(symbols)).toBe(true);
    }
    // Two distinct secrets differ in the code.
    expect(formatRecoveryCode(Buffer.alloc(16, 0))).not.toBe(formatRecoveryCode(Buffer.alloc(16, 1)));
  });

  it("generateRecoverySecret is 16 fresh bytes", () => {
    const a = generateRecoverySecret();
    const b = generateRecoverySecret();
    expect(a).toHaveLength(RECOVERY_SECRET_LEN);
    expect(a.equals(b)).toBe(false);
  });

  it("refuses a secret that is not 16 bytes", () => {
    expect(() => formatRecoveryCode(Buffer.alloc(15))).toThrow(/16 bytes/);
  });
});

describe("parseRecoveryCode leniency", () => {
  const secret = randomBytes(RECOVERY_SECRET_LEN);
  const code = formatRecoveryCode(secret);
  const bare = code.slice("YAWR-".length).replace(/-/g, "");

  it("accepts lowercase, no dashes, spaces, and no YAWR prefix", () => {
    for (const variant of [
      code.toLowerCase(),
      bare,
      bare.toLowerCase(),
      `YAWR${bare}`,
      `yawr ${bare.match(/.{4}/g)?.join(" ")}`,
      `  ${code}  `,
      code.replace(/-/g, " - "),
    ]) {
      expect(parseRecoveryCode(variant).equals(secret), variant).toBe(true);
    }
  });

  it("maps Crockford aliases O -> 0 and I/L -> 1", () => {
    // Force a code that contains 0 and 1 symbols, then type them as O / I / L.
    const zeros = formatRecoveryCode(Buffer.alloc(16, 0));
    expect(zeros).toContain("0");
    expect(parseRecoveryCode(zeros.replace(/0/g, "O")).equals(Buffer.alloc(16, 0))).toBe(true);
    expect(parseRecoveryCode(zeros.replace(/0/g, "o")).equals(Buffer.alloc(16, 0))).toBe(true);
    let withOne: Buffer | null = null;
    for (const s of sampleSecrets(200)) {
      if (formatRecoveryCode(s).slice(5).includes("1")) {
        withOne = s;
        break;
      }
    }
    expect(withOne).not.toBeNull();
    const c = formatRecoveryCode(withOne as Buffer);
    for (const alias of ["I", "i", "L", "l"]) {
      const typed = `YAWR-${c.slice(5).replace(/1/g, alias)}`;
      expect(parseRecoveryCode(typed).equals(withOne as Buffer), alias).toBe(true);
    }
  });

  it("accepts full-width digits/letters (CJK IME input) via NFKC", () => {
    // Built from code points, never typed: a full-width "１" is visually
    // identical to "1" in an editor, so a literal fixture could silently be
    // plain ASCII. NFKC folds every full-width form back onto the code we
    // generated; without it this exact input was rejected as wrong length.
    const fullWidth = [...code]
      .map((ch) => {
        const c = ch.charCodeAt(0);
        if (ch >= "0" && ch <= "9") return String.fromCharCode(0xff10 + (c - 0x30));
        if (ch >= "A" && ch <= "Z") return String.fromCharCode(0xff21 + (c - 0x41));
        return ch; // dash
      })
      .join("");
    expect(fullWidth).not.toBe(code);
    expect(parseRecoveryCode(fullWidth).equals(secret)).toBe(true);
    // Mixed full-width and ASCII parses too (what a real IME handback looks
    // like), as does a full-width alias folding to its Crockford target.
    expect(parseRecoveryCode(`${fullWidth.slice(0, 10)}${code.slice(10)}`).equals(secret)).toBe(true);
    expect(normalizeRecoveryGroup(fullWidth.slice(5, 9))).toBe(code.slice(5, 9));
  });

  it("accepts full-width O/L LETTERS in place of 0/1 (NFKC first, then the alias map)", () => {
    // The end-to-end full-width test above never puts a full-width LETTER in
    // an alias position: real codes spell 0/1, and its full-width mapping is
    // mechanical. This is the ordering the code actually claims -- NFKC folds
    // full-width "Ｏ" (U+FF2F) onto ASCII "O", THEN the alias map turns that
    // "O" into "0" (probed: "\uFF2F" -> "0", "\uFF4F" -> "0", "\uFF2C"/"\uFF4C"
    // -> "1", so both full-width cases land on the Crockford digit). Probed
    // with node, not assumed.
    // A code that really contains 0 AND 1 (see codeWithBothDigits): with a
    // random `code` the substitution below could replace nothing ~16% of runs
    // and pass on an input identical to the untouched form.
    const both = codeWithBothDigits();
    const bothBare = both.code.slice("YAWR-".length).replace(/-/g, "");
    const expected = normalizeRecoveryGroup(bothBare); // ASCII ground truth: 28 symbols
    expect(expected).toMatch(/^[0-9A-HJKMNP-TV-Z]{28}$/);
    expect(bothBare).toContain("0");
    expect(bothBare).toContain("1");
    // Built from code points: a full-width "Ｏ" is visually identical to "O".
    const upper = (ch: string) => String.fromCharCode(ch.charCodeAt(0) - 0x41 + 0xff21);
    const lower = (ch: string) => String.fromCharCode(ch.charCodeAt(0) - 0x61 + 0xff41);
    const fullWidthAlias = [...bothBare].map((ch) => (ch === "0" ? upper("o") : ch === "1" ? lower("l") : ch)).join("");
    expect(fullWidthAlias).not.toBe(bothBare);
    // Both must differ from the plain full-width form, or the assertion below
    // would pass on digits alone.
    const allFullWidth = [...bothBare].map((ch) => (ch >= "A" && ch <= "Z" ? upper(ch) : ch)).join("");
    expect(fullWidthAlias).not.toBe(allFullWidth);
    // The input the test claims: full-width o/l only where the code has 0/1.
    expect(normalizeRecoveryGroup(fullWidthAlias)).toBe(expected);

    // Through parse: the whole prefixed code with every 0/1 typed as a
    // full-width letter, then mixed in with the ASCII prefix (what a CJK IME
    // hands back mid-word).
    const coded = [...both.code]
      .map((ch) => (ch === "0" ? upper("o") : ch === "1" ? lower("l") : ch >= "A" && ch <= "Z" ? upper(ch) : ch))
      .join("");
    expect(parseRecoveryCode(coded).equals(both.secret)).toBe(true);
    expect(parseRecoveryCode(`YAWR${coded.slice(4)}`).equals(both.secret)).toBe(true);

    // The confirm prompt's normalization sees the same fold for each case.
    expect(normalizeRecoveryGroup("\uFF4F")).toBe("0"); // full-width o
    expect(normalizeRecoveryGroup("\uFF4C")).toBe("1"); // full-width l
    expect(normalizeRecoveryGroup("\uFF2F")).toBe("0"); // full-width O
    expect(normalizeRecoveryGroup("\uFF2C")).toBe("1"); // full-width L
    expect(normalizeRecoveryGroup("\uFF21\uFF11\uFF2F\uFF4C")).toBe("A101");
  });

  it("refuses U, other characters and the wrong length as not-a-code", () => {
    const syms = bare.split("");
    for (const bad of [
      `${bare.slice(0, 5)}U${bare.slice(6)}`,
      `${bare.slice(0, 5)}*${bare.slice(6)}`,
      bare.slice(1),
      `${bare}0`,
      "",
      "YAWR",
      "hello",
      syms.join("_"),
    ]) {
      expect(() => parseRecoveryCode(bad), bad).toThrow(RECOVERY_CODE_FORMAT_ERROR);
    }
  });

  it("refuses a code whose checks pass but whose pad bits are set, as not-a-code", () => {
    // Find a 28-symbol sequence with a first symbol >= 8 that passes both
    // checks: take a real code, set the first symbol, and recompute the checks
    // by searching the 32*32 check space.
    const symbols = recoverySymbols(randomBytes(16));
    symbols[0] = 8;
    let found = false;
    for (let c1 = 0; c1 < 32 && !found; c1++) {
      for (let c2 = 0; c2 < 32 && !found; c2++) {
        symbols[26] = c1;
        symbols[27] = c2;
        if (checksPass(symbols)) found = true;
      }
    }
    expect(found).toBe(true);
    expect(() => parseRecoveryCode(formatSymbols(symbols))).toThrow(RECOVERY_CODE_FORMAT_ERROR);
  });
});

describe("check symbols: exhaustive property tests", () => {
  // The guarantee the spec requires: EVERY single-symbol substitution and
  // EVERY adjacent transposition is detected, at every position including the
  // two check symbols. Checked exhaustively per code, over many random codes.
  const codes = sampleSecrets(400).map(recoverySymbols);

  it("detects every single-symbol substitution", () => {
    let tried = 0;
    for (const symbols of codes) {
      for (let pos = 0; pos < symbols.length; pos++) {
        for (let v = 0; v < 32; v++) {
          if (v === symbols[pos]) continue;
          const mutated = [...symbols];
          mutated[pos] = v;
          tried++;
          if (checksPass(mutated)) throw new Error(`undetected substitution at ${pos} -> ${v}`);
        }
      }
    }
    expect(tried).toBe(codes.length * 28 * 31);
  });

  it("detects every adjacent transposition of two different symbols", () => {
    let tried = 0;
    for (const symbols of codes) {
      for (let pos = 0; pos + 1 < symbols.length; pos++) {
        if (symbols[pos] === symbols[pos + 1]) continue;
        const mutated = [...symbols];
        [mutated[pos], mutated[pos + 1]] = [mutated[pos + 1], mutated[pos]];
        tried++;
        if (checksPass(mutated)) throw new Error(`undetected transposition at ${pos}`);
      }
    }
    expect(tried).toBeGreaterThan(codes.length * 20);
  });

  it("surfaces a typo through parseRecoveryCode as the typo error, not not-a-code", () => {
    const secret = randomBytes(16);
    const code = formatRecoveryCode(secret);
    const bare = code.slice(5).replace(/-/g, "");
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (let pos = 0; pos < 28; pos++) {
      const other = alphabet[(alphabet.indexOf(bare[pos]) + 7) % 32];
      const typo = `${bare.slice(0, pos)}${other}${bare.slice(pos + 1)}`;
      expect(() => parseRecoveryCode(typo), String(pos)).toThrow(RECOVERY_CODE_TYPO_ERROR);
    }
    const swapAt = [...bare].findIndex((ch, i) => i + 1 < bare.length && ch !== bare[i + 1]);
    const swapped = `${bare.slice(0, swapAt)}${bare[swapAt + 1]}${bare[swapAt]}${bare.slice(swapAt + 2)}`;
    expect(() => parseRecoveryCode(swapped)).toThrow(RECOVERY_CODE_TYPO_ERROR);
  });
});

describe("recoveryCodeGroups / normalizeRecoveryGroup", () => {
  it("returns the 7 display groups in order", () => {
    const code = formatRecoveryCode(randomBytes(16));
    const groups = recoveryCodeGroups(code);
    expect(groups).toHaveLength(7);
    expect(`YAWR-${groups.join("-")}`).toBe(code);
    // Accepts anything parse accepts.
    expect(recoveryCodeGroups(code.toLowerCase().replace(/-/g, ""))).toEqual(groups);
  });

  it("normalizes a typed group for comparison (case, spaces, aliases)", () => {
    expect(normalizeRecoveryGroup(" a1o-l ")).toBe("A101");
    expect(normalizeRecoveryGroup("xyzi")).toBe("XYZ1");
    // Full-width "１" (NFKC) before the alias map, so it reaches "1", not the
    // FORMAT_ERROR a raw toUpperCase().replace chain gave.
    expect(normalizeRecoveryGroup(String.fromCharCode(0xff11))).toBe("1");
  });

  it("normalizeChars is idempotent, so one pass in the confirm prompt cannot diverge", () => {
    // The creation prompt compares the typed group to recoveryCodeGroups'
    // output with a SINGLE normalizeRecoveryGroup call on each side
    // (secrets-cmd.ts). If a second pass over its own output produced
    // something different, ground truth and typed input could normalize by
    // different routes -- and one of the two would be the odd one out. Pin
    // f(f(x)) === f(x) over everything the alias/separator/NFKC chain can see.
    const fwDigit = (d: string) => String.fromCharCode(0xff10 + d.charCodeAt(0) - 0x30);
    const inputs = [
      "",
      " ",
      "0",
      "1",
      "\u3000",
      // full-width digits, full-width dash (U+FF0D), full-width space, and the
      // O/I/L aliases (upper- and lower-case) in one row each.
      "1234",
      [..."1234"].map(fwDigit).join(""),
      `${[..."01"].map(fwDigit).join("")}\uFF0D${[..."56"].map(fwDigit).join("")}`,
      "\u30001234\u3000",
      " o1i-l ",
      "O1I-L",
      `${fwDigit("9")}\uFF0Doil\uFF0D${fwDigit("0")}`,
      // ...the whole display form, both cases, and a mixed IME handback.
      "YAWR-1A2B-3C4D-5E6F-7G8H-9JKM-NPQR-STVX",
      "yawr-1a2b-3c4d-5e6f-7g8h-9jkm-npqr-stvx",
      `YAWR\uFF0D${[..."1A2B"].map(fwDigit).join("")}\uFF0D3C4D`,
      "  YAWR-1A2B 3C4D-5E6F-7G8H-9JKM-NPQR-STVX  ",
    ];
    for (const input of inputs) {
      const once = normalizeRecoveryGroup(input);
      expect(normalizeRecoveryGroup(once), JSON.stringify(input)).toBe(once);
    }
    // And the second pass is still the ground truth for a real group.
    const group = recoveryCodeGroups(formatRecoveryCode(randomBytes(RECOVERY_SECRET_LEN)))[0];
    const typed = normalizeRecoveryGroup(group.toLowerCase().replace(/0/g, "o"));
    expect(normalizeRecoveryGroup(typed)).toBe(group);
    expect(typed).toBe(group);
  });
});

describe("secret-bearing symbol arrays are wiped", () => {
  /** Run `fn`, returning every number[] the module zero-filled meanwhile, as
   *  `{ before, target }`: the array's contents snapshotted BEFORE the fill
   *  ran, plus the live array (post-wipe) for checking after `fn` returns.
   *  A snapshot taken after delegating to realFill is the zeros the fill just
   *  wrote, so a `every(v => v === 0)` assertion on it is a tautology that
   *  can never fail -- the proof of wiping lives in `before` holding the
   *  secret-bearing state the fill destroyed. */
  interface Filled {
    before: number[];
    target: number[];
  }
  function zeroFilledArrays(fn: () => void): Filled[] {
    const filled: Filled[] = [];
    const realFill = Array.prototype.fill;
    const spy = vi.spyOn(Array.prototype, "fill").mockImplementation(function (this: unknown[], ...args: unknown[]) {
      // Snapshot BEFORE the apply, never after (see the doc comment).
      if (args[0] === 0 && args.length === 1)
        filled.push({ before: [...(this as number[])], target: this as number[] });
      return (realFill as (...a: unknown[]) => unknown[]).apply(this, args);
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return filled;
  }

  const secret = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const code = formatRecoveryCode(secret);
  // The ground truth: the symbols these arrays must have held pre-wipe.
  const symbols = recoverySymbols(secret);

  it("formatRecoveryCode wipes the data and full symbol arrays", () => {
    const filled = zeroFilledArrays(() => formatRecoveryCode(secret));
    expect(filled.map((f) => f.before.length).sort()).toEqual([26, 28]);
    for (const f of filled) {
      // Pre-fill the array held THIS secret's symbols (non-zero), so the fill
      // we observed really targeted secret-bearing state -- not an array that
      // was already zero. Post-fill the same array is wiped.
      expect(f.before).toEqual(symbols.slice(0, f.before.length));
      expect(f.before.some((v) => v !== 0)).toBe(true);
      expect(f.target.every((v) => v === 0)).toBe(true);
    }
  });

  it("parseRecoveryCode and recoveryCodeGroups wipe the parsed symbols", () => {
    for (const fn of [() => parseRecoveryCode(code).fill(0), () => recoveryCodeGroups(code)]) {
      const filled = zeroFilledArrays(fn).filter((f) => f.before.length === 28);
      expect(filled).toHaveLength(1);
      // The parsed 28 symbols encode the secret exactly, then are zeroed.
      expect(filled[0].before).toEqual(symbols);
      expect(filled[0].target.every((v) => v === 0)).toBe(true);
    }
  });

  it("a typo'd or malformed code wipes what was parsed before throwing", () => {
    const last = code.slice(-1);
    const typo = `${code.slice(0, -1)}${last === "0" ? "1" : "0"}`;
    const typoFilled = zeroFilledArrays(() => expect(() => parseRecoveryCode(typo)).toThrow(RECOVERY_CODE_TYPO_ERROR));
    const typoSnapshots = typoFilled.filter((f) => f.before.length === 28);
    expect(typoSnapshots).toHaveLength(1);
    // The parsed array held this code's symbols with only the last one altered
    // by the typo (no alias mapping touches "0"/"1"), then was zeroed.
    const expectedTypo = [...symbols];
    expectedTypo[expectedTypo.length - 1] = last === "0" ? 1 : 0;
    expect(typoSnapshots[0].before).toEqual(expectedTypo);
    expect(typoSnapshots[0].target.every((v) => v === 0)).toBe(true);
    // U is not in the alphabet: the 27 symbols parsed before it are wiped too.
    const bad = `${code.slice(0, -1)}U`;
    const badFilled = zeroFilledArrays(() => expect(() => parseRecoveryCode(bad)).toThrow(RECOVERY_CODE_FORMAT_ERROR));
    const badSnapshots = badFilled.filter((f) => f.before.length === 27);
    expect(badSnapshots).toHaveLength(1);
    expect(badSnapshots[0].before).toEqual(symbols.slice(0, 27));
    expect(badSnapshots[0].target.every((v) => v === 0)).toBe(true);
  });
});
