// Text made safe for a terminal. A leaf module with no imports, so any file
// could take these without an import cycle. Today git-source.ts is the only
// importer; it re-exports both for the callers that take them from there.

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
