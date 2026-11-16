// Text made safe for a terminal. A leaf module with no imports, so any file
// could take these without an import cycle. git-source.ts imports `printable`
// and `asciiLines` and re-exports both for the callers that take them from
// there; search-cmd.ts and catalog.ts import `withoutControls`.

/** Repo-supplied text made safe for a terminal: anything outside printable
 *  ASCII (an ESC starting an OSC 52 clipboard write, a CSI screen clear)
 *  becomes "?". */
export function printable(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?");
}

/** `printable` for text of more than one line: newlines kept (CRLF folded to
 *  LF), everything else outside printable ASCII becomes "?". */
export function asciiLines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[^\x20-\x7e\n]/g, "?");
}

const FORMAT_CHAR = /\p{Cf}/u;

/** One line of fetched prose made safe for a terminal WITHOUT flattening it to
 *  ASCII, for text where an accented letter or a dash is content (a catalog
 *  description). Newline, carriage return and tab become a space (they are
 *  ordinary whitespace in prose, and the output is one line). Every other C0
 *  control (ESC included), DEL, each C1 control (0x9b is a one-byte CSI) and
 *  each Unicode format character (the bidi overrides that reorder what a line
 *  appears to say) becomes "?"; everything else is kept. */
export function withoutControls(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c === 0x0a || c === 0x0d || c === 0x09) {
      out += " ";
      continue;
    }
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) || FORMAT_CHAR.test(ch) ? "?" : ch;
  }
  return out;
}
