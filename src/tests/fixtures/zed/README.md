# Zed byte fixtures

Every file here is read by `src/tests/target-zed.test.ts` and compared BYTE FOR
BYTE. Two spellings in this directory are deliberate and both are load-bearing.

## Why `.txt` and not `.json` / `.jsonc`

Zed's settings.json is JSONC: `//` comments and trailing commas are legal, and
Zed's own default template ships both -- `zed: open settings file`
(`OpenSettingsFile` in crates/zed/src/zed.rs) creates settings.json from
`initial_user_settings_content()`, the `assets/settings/initial_user_settings
.json` asset committed here verbatim. Biome is this repo's formatter and its
`files.includes` is `["src/**", ...]` with one narrow exclusion,
`!src/tests/fixtures/*.json` -- a single-level glob that does not reach this
subdirectory. Measured on this branch with biome 2.4.16:

- named `.json`, the template is a hard PARSE error (`Expected an array, an
  object, or a literal but instead found '// Zed settings'`);
- named `.jsonc`, it parses, and `biome check` reports the formatter would
  delete both trailing commas -- so `npm run lint:fix`, which the pre-commit
  checklist runs before EVERY commit, would silently rewrite the fixture into
  one that no longer carries the bytes it exists to carry;
- named `.txt`, biome reports the path as ignored and `biome check --write`
  leaves the bytes identical (md5 unchanged).

So the extension is what keeps the fixture honest, not a filing preference.

## Why `.gitattributes` here

The repo root sets `* text=auto eol=lf`, and this repo is developed on Windows
with `core.autocrlf=true`. `initial-user-settings.crlf.txt` exists to carry
CRLF line endings; normalising them is exactly the corruption it is meant to
detect. The local `* -text` turns end-of-line conversion off for this
directory only.

## The files

| file | what it is | bytes verified |
|---|---|---|
| `initial-user-settings.txt` | Zed's own default template, byte-for-byte from `assets/settings/initial_user_settings.json` on zed-industries/zed `main` | 447 bytes, LF, 8 `//` header lines, trailing commas after `"One Dark",` and after the theme object's `},` |
| `initial-user-settings.installed.txt` | the same file after `yaw-mcp install zed` | 586 bytes, LF; header and both original trailing commas unchanged, `"context_servers"` appended in the file's own trailing-comma style |
| `initial-user-settings.uninstalled.txt` | ...and after `yaw-mcp uninstall zed` | 475 bytes, LF; every original byte back, plus the emptied `"context_servers": {` / `},` container the splicer leaves behind |
| `initial-user-settings.crlf.txt` | the template with CRLF endings, as a Windows editor would have saved it | 464 bytes, 17 CRLF, 0 lone LF |
| `initial-user-settings.crlf.installed.txt` | the CRLF file after install | 612 bytes, 26 CRLF, 0 lone LF |
| `neighbours.txt` | a `context_servers` container holding a foreign server with a trailing `//` comment, a comment line above it, and a legacy `yaw-mcp` key | 210 bytes, LF |
| `neighbours.installed.txt` | after install: the neighbour and BOTH comments byte-identical, the legacy key trimmed in the same pass | 253 bytes, LF |
| `neighbours.uninstalled.txt` | after uninstall: the neighbour and its comment still byte-identical | 141 bytes, LF |
| `tab-indent.txt` | a tab-indented settings.json | 92 bytes, LF, U+0009 indents |
| `tab-indent.installed.txt` | after install: the new entry indented with tabs too | 183 bytes, LF, U+0009 indents |

The tab and CRLF fixtures were generated with `String.fromCharCode(9)` and
`String.fromCharCode(13)` rather than typed escape sequences, and every one of
them was read back with `cat -A` before being committed.
