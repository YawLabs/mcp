# Continue fixtures

Every file here is one exact state of
`<continue global dir>/mcpServers/yaw-mcp.json`, the file `install continue`
CREATES and owns. `src/tests/target-continue.test.ts` reads them and compares
whole files, not substrings: this target is the one row whose file has no
foreign content to preserve, so "the bytes are right" is a claim the tests can
make in full.

## Why `.txt` and not `.json`

`truncated.txt` is deliberately not valid JSON at all, and every file here is
byte-exact. `biome.json` includes `src/**` and excludes only
`src/tests/fixtures/*.json` -- a single level, so a `.json` file in THIS
subdirectory would be parsed and reformatted by `npm run lint:fix`, which would
rewrite the bytes the tests exist to pin and fail outright on the truncated
one. `.txt` is an extension biome has no language for, so it is left alone.

## Why there is no CRLF or tab fixture here

The repo's `.gitattributes` sets `* text=auto eol=lf`, so git normalises a
committed CRLF file to LF in the index AND in the working tree. A CRLF fixture
on disk could not survive a checkout, and one that silently became LF would
turn the round-trip test green while testing nothing.

The CRLF + tab + comment case therefore lives in the test file, built from
`String.fromCharCode(13)` and `String.fromCharCode(9)` -- never a typed escape,
which is one backslash level away from becoming a real control byte when a file
is written through a shell. The test asserts on the constructed bytes directly.

`src/tests/source-hygiene.test.ts` scans every tracked file for raw control
bytes other than tab, LF and CR, so these files are covered by that gate too.

## The files

| file | bytes | what it is |
|---|---|---|
| `fresh.txt` | 137 | what install writes into a file that did not exist. Also what `--repair` and a legacy trim converge on. |
| `drift-cmd.txt` | 166 | a `cmd /c npx` entry, the shape another client's config carries and a user hand-copies in. Drift on every OS: Continue's row writes a bare `npx`. |
| `legacy-key.txt` | 141 | the pre-rename `yaw-mcp` entry key. Nothing has ever written this file, so it can only be a hand edit -- install trims it in the same pass. |
| `uninstalled.txt` | 26 | `fresh.txt` after `uninstall`. The file and the folder stay; Continue loads an empty `mcpServers` as zero servers with no error. |
| `truncated.txt` | 57 | cut off mid-entry. Install refuses and leaves the bytes alone. |
| `container-array.txt` | 91 | `mcpServers` as a LIST -- the `config.yaml` shape pasted into a JSON file. Non-reparable: it could hold real servers. |
| `container-null.txt` | 21 | `mcpServers: null`. Reparable -- replacing it with an empty object throws nothing away. |
