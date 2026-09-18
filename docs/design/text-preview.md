# Text Preview

How a `.txt`, `.text` or `.log` becomes the page the preview pane shows. Source
of truth: `src-tauri/src/commands/artifact/text_preview.rs` (decoder, scrubber
and linker), `src-tauri/src/commands/artifact/text_preview.css` (the document's
own styles), `src/lib/artifactSourceKind.ts` (which files come here at all),
`src/components/workspace/BrowserPane.tsx` (the pane itself).

Tests: the `#[cfg(test)]` module in `text_preview.rs`,
`tests/unit/artifactSourceKind.test.ts`, `tests/test_artifact_extension_contract.py`.

This is the Markdown preview's sibling and borrows most of its shape. Where the
two differ, `docs/design/markdown-preview.md` explains the side that came first.

## Pipeline

```
bytes --decode--> String --scrub--> String --cut--> String --escape--> HTML --link--> <pre>
       BOM, UTF-8,         controls,      limits,     once,             http(s) and
       Shift_JIS           ANSI, CRLF     with a      never twice       absolute paths
                                          notice
```

`text_to_static_html(raw, source_path)` runs the whole chain and returns one
standalone document. It is handed the file's **bytes**, not a `String`:
`read_to_string` refuses anything that is not UTF-8, and a Japanese `.txt`
written on Windows regularly is not.

### Decoding, in the order an editor would guess

| Step | Result |
|---|---|
| A byte order mark (UTF-8, UTF-16 LE, UTF-16 BE) | believed. Bytes that then fail to decode are a damaged file, not a Shift_JIS one |
| Valid UTF-8 | used |
| Shift_JIS (cp932), **without replacement** | used. A reading that needs U+FFFD is not a Shift_JIS file, and mojibake shown as if it were the text is worse than saying so |
| anything else | refused, with the reason |

A file read as anything other than UTF-8 carries a line above the text saying
so (`Shift_JIS として表示しています`). UTF-8 says nothing: a notice on every file
would train the reader to skip the line on the files that need it.

UTF-16 goes through `std::char::decode_utf16` rather than `encoding_rs`, because
pairing surrogates is the whole of that format and the standard library fails on
an unpaired one instead of quietly replacing it.

### Scrubbing

- CRLF and lone CR become LF
- ANSI escape sequences (CSI and OSC) are removed — a `.log` is full of them
- C0 control characters other than tab and newline are removed, as are U+2028
  and U+2029
- a byte order mark is not shown as a character

### Refusing what is not text

A NUL in the first `BINARY_SNIFF_BYTES` (8 KB) refuses the file: a `.txt` is
sometimes an executable someone renamed. Looking at the whole file instead would
refuse a long log over one stray byte near its end, so a NUL past the window is
treated as one more control character and removed. The check sits **below** the
byte order marks, because UTF-16 is full of NULs and is not a binary.

### Limits

`MAX_TEXT_BYTES` (5 MB) and `MAX_LINES` (50,000). Past either, the text is cut
and the page says what it left out. The frame lays the whole `<pre>` out at
once, so the size of the document decides how long the pane stays frozen after a
click; a log bigger than that is a job for the terminal.

## Safety

The frame is `sandbox="allow-popups allow-same-origin"` — no `allow-scripts` —
and the document's own policy is one notch tighter than the Markdown preview's,
which has to let pictures in:

```
default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'
```

Nothing loads and nothing runs. There is no allowlist here because **no markup
is generated**: the text is escaped once, and the only elements in the body are
the `<pre>`, the notices, and the links the renderer adds afterwards. A test
pins that a document cannot hand itself `data-mycmux-local-path`, the attribute
the pane trusts.

## Links

Plain text has no link syntax, so the renderer finds the two things a reader
would otherwise copy out by hand.

| Target | Result |
|---|---|
| `http:` / `https:` | linked, without the punctuation that follows it |
| `C:\…`, `C:/…`, and `/…` off Windows | linked, and carries `data-mycmux-local-path` with the absolute path |
| a line and column after a path (`report.rs:12:34`) | shown in the link text; **not** part of the path the pane opens |
| `\\server\share`, `//host/x` | not linked — they reach another machine |
| a segment with a colon (alternate data stream), a Windows device name (`CON`, `NUL`, `COM1`…) | not linked |
| a relative path | **not linked** |

Relative paths stay text on purpose: in prose, `see the notes/` and `v1.2/final`
look exactly like paths, and a link that opens the wrong thing is worse than no
link. The same lexical normalisation as the Markdown preview applies — `.` and
`..` are resolved without touching the disk and never above their own root.

A link is answered by the pane, not by the frame: `classifyPreviewLink` sends a
local path to `onOpenLocalPath` (which previews it, or opens its location) and a
web address to the shell. Opening a local file with its default application is
deliberately not offered from inside a document.

## Colours and layout

The stylesheet uses **the Markdown preview's `--md-*` custom properties**, not a
set of its own. The pane already writes the theme over those on `<html>` and
sets `data-scheme` (`markdownPreviewTheme.ts`), so every theme's contrast is
already measured by `tests/unit/markdownPreviewTheme.test.ts`; a private set of
variables would sit outside that check. The stylesheet's own values are the
light paper a file opened outside the app falls back to.

- one monospaced column, `var(--md-font-mono)`, which follows the terminal font
- `max-width: 80ch` with `box-sizing: content-box`, so the 80 columns are a
  promise about the text and the padding sits outside it. A log written to 80
  columns arrives unwrapped; prose stops before the line grows too long to track
  back to; anything longer wraps rather than scrolling sideways
- `font-size: 14px` (15px from 560px wide), `line-height: 1.7`
- `white-space: pre-wrap`, `overflow-wrap: anywhere`, `tab-size: 4`
- the notices are ruled off and faded (`--md-faint`), so neither can be read as
  the first or the last line of the file

Body text sits directly on `--md-bg`, which is the pair every theme holds to
7:1. The code and pre surfaces next door are only held to 4.5:1.

## Read-only, and why

There is no editor and no save button. A file read as Shift_JIS would be written
back as UTF-8, and its encoding would change without anyone being told. The
backend refuses the save as well (`save_editable_artifact` rejects the `text`
kind), so the toolbar hiding the buttons is not the only thing standing between
a reader and a silently rewritten file.

## The preview file on disk

`report.txt` writes `report.text.preview.html`, not `report.preview.html`: a
`report.md` in the same folder already claims the second name, and the two would
overwrite each other. Outside a session the preview is written under
`…/sessions/<id>/artifacts/previews/` with the source path hashed into the name,
which has no such clash.

As with Markdown, the file on disk is the fallback: what the pane actually shows
is the document returned by `read_editable_artifact`, so the theme is already in
it before the frame loads.

## Known duplication

`normalize_local_path` and `is_safe_path_segment` are written out again here
rather than shared with `markdown_preview.rs`. They are the rules that keep a
path from climbing out of its own root and from naming a Windows device or an
alternate data stream, so the two copies drifting apart is a real hazard: a fix
made in one would not reach the other. They were copied because sharing them
means changing `markdown_preview.rs`, which had just shipped. **Merging them
into one module is worth doing**; both copies carry their own tests until then.

## Not covered

- **Syntax highlighting** and language detection: a `.log` is not a language
- **Line numbers**: they end up in the clipboard
- **A wrap on/off toggle**: `pre-wrap` at 80 columns is the one behaviour
- **Following the file as it grows** (`tail -f`): the reload button re-reads it
- **Search inside the document**: the frame has no scripts, so this would have
  to be the pane reaching into `contentDocument`
- **Relative paths as links** (see above)

## Looking at the output

An ignored test writes the HTML for a file so it can be opened and read:

```
set MYCMUX_TXT_DUMP_IN=C:\path\to\notes.txt
set MYCMUX_TXT_DUMP_OUT=%TEMP%\preview.html
<test binary> dump_text_preview_for_visual_check --ignored --nocapture
```

The binary is the one `scripts/run_windows_tests.py` builds (never plain
`cargo test` on Windows — see CLAUDE.md). With either variable unset the test
does nothing and passes.
