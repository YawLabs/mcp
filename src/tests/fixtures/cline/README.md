# Cline settings-file fixtures

Input documents for `src/tests/target-cline.test.ts`. Each one is a
`cline_mcp_settings.json` as some real writer leaves it, so the test asserts
against bytes a user can actually have rather than bytes we invented.

## Why the `.json.txt` suffix

Biome's fixture exclusion in `biome.json` is `!src/tests/fixtures/*.json` --
ONE level, not recursive. A `.json` file in this directory would therefore be
parsed and formatted by `npm run lint:fix`, which destroys exactly what four
of these fixtures exist to carry: a trailing comma, a comment, a truncated
document, and a missing final newline. Biome dispatches on the LAST extension,
so `.json.txt` is skipped entirely (measured: `biome check` on this directory
reports "Checked 1 file" for a `.json` sibling and says nothing about a `.txt`
one). The suffix is the reason the bytes survive the gate; renaming these to
`.json` re-breaks them.

## Line endings and the BOM are NOT in this directory

`.gitattributes` sets `* text=auto eol=lf`, so a committed CRLF file is
normalised to LF in the index AND checked out as LF. A CRLF fixture stored
here would therefore be a lie about its own bytes. The test builds the CRLF
and the UTF-8-BOM variants in memory instead -- from `String.fromCharCode(13)`
and the core's `UTF8_BOM` constant -- and asserts the constructed bytes before
using them.

Every file here is pure ASCII with LF line endings and no control byte but LF
(asserted by the test, and by `source-hygiene.test.ts` over the whole tree).

## The files

| file | bytes | what wrote it, and why it is here |
|---|---|---|
| `bootstrap.json.txt` | 22, **no final newline** | Cline's own bootstrap. The legacy runtime writes `JSON.stringify({ mcpServers: {} }, null, 2)` the first time its hub initialises in an editor (`apps/vscode/src/core/storage/disk.ts` `getMcpSettingsFilePath` on branch `legacy-extension`), so this is what install finds in a detected editor that has never had a server. |
| `sibling-servers.json.txt` | 273, **no final newline** | One foreign server as Cline's own writer leaves it -- `autoApprove` / `disabled` / `timeout` / `type` all stamped by its schema. The neighbour a splice must not touch. |
| `restamped-win.json.txt` | 457, **no final newline** | The whole file after a UI toggle: the legacy runtime's `toggleServerDisabledRPC` re-serialises the ZOD-PARSED settings (`McpHub.ts:1133-1144`, `fs.writeFile(settingsPath, JSON.stringify(config, null, 2))`), so every entry -- ours included -- comes back with the schema's defaults stamped on it. Our entry gains `timeout` and `type`. Key ORDER here is this fixture's own choice: the test compares values, and no claim is made about which order zod emits. |
| `stale-win.json.txt` | 334 | A Windows entry pinned to an old version, carrying an `env` and the Cline-owned `disabled` / `autoApprove` / `timeout`. The drift case `--repair` and `--force` differ on. |
| `nested-transport-win.json.txt` | 280 | The nested `{ transport: { type, command, args } }` shape the Cline CLI writes (`apps/vscode/src/services/mcp/schemas.ts`, `nestedTransportConfigSchema`: "Nested transport format as produced by the Cline CLI (`cline mcp add`)"). |
| `legacy-key-posix.json.txt` | 141 | A hand-added `yaw-mcp` key -- one of `LEGACY_ENTRY_NAMES` -- for the legacy trim. |
| `trailing-comma.json.txt` | 131 | Strict-JSON refusal. `JSON.parse` rejects it, so Cline loads NO server from this file. |
| `line-comment.json.txt` | 85 | Strict-JSON refusal, the `//` form. |
| `block-comment.json.txt` | 194 | Strict-JSON refusal, the `/* */` form -- the one a reader expecting only `//` would miss. |
| `truncated.json.txt` | 14, no final newline | Fails BOTH parsers, so it is `malformed` rather than merely unloadable, and takes the pre-existing refusal instead of the strict one. |

Cline reads all of these with `JSON.parse`
(`apps/vscode/src/services/mcp/McpHub.ts:213`, and the same call on the
`legacy-extension` branch at `McpHub.ts:183`), which is what makes the last
four unloadable for the client rather than merely untidy.
