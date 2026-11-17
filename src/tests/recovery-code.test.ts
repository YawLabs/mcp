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
  });
});

describe("secret-bearing symbol arrays are wiped", () => {
  /** Run `fn`, returning every number[] the module zero-filled meanwhile
   *  (a snapshot of each array right after the fill). */
  function zeroFilledArrays(fn: () => void): number[][] {
    const filled: number[][] = [];
    const realFill = Array.prototype.fill;
    const spy = vi.spyOn(Array.prototype, "fill").mockImplementation(function (this: unknown[], ...args: unknown[]) {
      const out = (realFill as (...a: unknown[]) => unknown[]).apply(this, args);
      if (args[0] === 0 && args.length === 1) filled.push([...(this as number[])]);
      return out;
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

  it("formatRecoveryCode wipes the data and full symbol arrays", () => {
    const filled = zeroFilledArrays(() => formatRecoveryCode(secret));
    expect(filled.map((a) => a.length).sort()).toEqual([26, 28]);
    for (const a of filled) expect(a.every((v) => v === 0)).toBe(true);
  });

  it("parseRecoveryCode and recoveryCodeGroups wipe the parsed symbols", () => {
    for (const fn of [() => parseRecoveryCode(code).fill(0), () => recoveryCodeGroups(code)]) {
      const filled = zeroFilledArrays(fn).filter((a) => a.length === 28);
      expect(filled).toHaveLength(1);
      expect(filled[0].every((v) => v === 0)).toBe(true);
    }
  });

  it("a typo'd or malformed code wipes what was parsed before throwing", () => {
    const last = code.slice(-1);
    const typo = `${code.slice(0, -1)}${last === "0" ? "1" : "0"}`;
    const typoFilled = zeroFilledArrays(() => expect(() => parseRecoveryCode(typo)).toThrow(RECOVERY_CODE_TYPO_ERROR));
    expect(typoFilled.filter((a) => a.length === 28)).toHaveLength(1);
    // U is not in the alphabet: the symbols before it are wiped too.
    const bad = `${code.slice(0, -1)}U`;
    const badFilled = zeroFilledArrays(() => expect(() => parseRecoveryCode(bad)).toThrow(RECOVERY_CODE_FORMAT_ERROR));
    expect(badFilled.filter((a) => a.length === 27)).toHaveLength(1);
  });
});
