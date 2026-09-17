# Markdown Preview

How a `.md` file becomes the page the preview pane shows. Source of truth:
`src-tauri/src/commands/artifact/markdown_preview.rs` (renderer and sanitiser),
`src-tauri/src/commands/artifact/markdown_preview.css` (the document's own
styles), `src/lib/markdownPreviewTheme.ts` (theme colours),
`src/lib/markdownPreviewDocument.ts` (what the frame receives and what a click
means), `src/components/workspace/BrowserPane.tsx` (the pane itself).

Tests: the `#[cfg(test)]` module in `markdown_preview.rs`,
`tests/unit/markdownPreviewTheme.test.ts`,
`tests/unit/markdownPreviewDocument.test.ts`.

## Pipeline

```
markdown --comrak--> HTML --kuchikiki--> DOM --allowlist--> DOM --serialise--> <body>
                                                 + URL policy
                                                 + tables, alerts, autolinks
```

`markdown_to_static_html(markdown, source_path)` runs the whole chain and
returns one standalone document. `source_path` is the file the Markdown was
read from: relative links and images resolve against its directory, and without
it they are dropped rather than guessed at.

### comrak options, and why

comrak 0.55 is pinned (`=0.55.0`) because the AST pass and the sanitiser are
written against this node set. Default features (CLI, syntect, bon) are off.

| Option | Reason |
|---|---|
| `strikethrough`, `table`, `autolink`, `tasklist`, `footnotes`, `alerts` | GFM, which is what these documents are written in |
| `tagfilter` | turns `<script>`, `<style>`, `<iframe>`… into text one layer before the sanitiser. Deprecated upstream in 0.55; kept while it exists |
| `math_dollars`, `math_code` | `$x^2$` is marked up instead of read as emphasis |
| `subscript` | **only** so that a single `~` stops being strikethrough. The AST pass below turns every subscript node back into literal `~` characters, so `9/15~9/17` and `1~2 件` survive as typed |
| `cjk_friendly_emphasis` | `これは**「重要」**です` is bold, which plain CommonMark refuses |
| `header_id_prefix = ""` | every heading gets an `id`, which `#anchor` links in the same document need |
| `front_matter_delimiter = "---"` | a leading `---` block is front matter, not a rule |
| `hardbreaks` | a newline inside a paragraph is a line break, as in Typora and every editor these files are written in |
| `unsafe` + `escape = false` | raw HTML is rendered and then filtered. Escaping it instead is what the old renderer did, and it showed `<br>` as text |
| `tasklist_classes` | the checkbox and its list item carry classes the stylesheet can reach |

### AST pass

1. **Front matter** is taken out of the tree and kept aside. The HTML formatter
   drops it entirely, and a document that opens with `---` should not silently
   lose its header; it is put back at the top as
   `<pre class="front-matter"><code>…</code></pre>`.
2. **Subscript nodes become `~` + children + `~`.** See the table above.

## Safety

The frame is `sandbox="allow-popups allow-same-origin"` — no `allow-scripts` —
and everything below is on top of that.

### The allowlist

The rendered HTML is parsed with kuchikiki and the body is rebuilt one element
at a time:

- **dropped with their contents**: `script, style, template, noscript, iframe,
  frame, frameset, object, embed, applet, noembed, noframes, xmp, plaintext,
  title, textarea, select, button, svg, math, canvas, audio, video, link, meta,
  base, head`, plus every element outside the HTML namespace and every comment,
  processing instruction and stray doctype
- **kept**: the document elements (`p, div, span, br, hr, h1-h6, blockquote,
  pre, code, kbd, samp, var`, lists, tables, `a, img`, the inline marks,
  `details, summary, figure, figcaption, section, center`)
- **`input`**: kept only when it is a checkbox, and then only its `class` and
  `checked`; `type="checkbox"` and `disabled` are re-added by the renderer, so a
  document cannot smuggle another control in by spelling it `TYPE=" CheckBox "`
- **anything else** (`font`, `article`, `header`, `form`, `label`…) loses the
  element and keeps its children

Attributes are an allowlist too: `id` (≤ 256 characters), `class` (only tokens
matching `[A-Za-z0-9_-]{1,64}`), `title`, `lang`, `dir`, `align`, `aria-label`,
`aria-hidden`, the `data-footnote-*` / `data-math-style` attributes comrak
writes, and a short per-element list (`href`/`name`, `src`/`alt`/`width`/
`height`, `colspan`/`rowspan`/`scope`, `start`/`reversed`/`type`, `value`,
`span`, `open`, `datetime`, `cite`). Numeric attributes must be digits and at
most six characters. Everything else goes, `on*`, `style`, `target`, `srcset`
and the internal `data-mycmux-*` / `data-label*` attributes included.

**The order matters**: the internal attributes the pane trusts are added *after*
the sanitiser runs, so a document cannot forge them.

Elements nested deeper than 256 levels are unwrapped: the HTML serialiser
recurses once per level, and a document can nest block quotes without limit.

### URL policy

Applies to `a[href]`, `img[src]` and `cite`. Tabs and newlines are removed and
C0 controls trimmed first, so `java<TAB>script:` is one target and not two.

| Target | Result |
|---|---|
| `#fragment` | kept (on a link only) |
| `http:` / `https:` | kept |
| `mailto:` | kept on a link |
| `data:image/(png\|gif\|jpeg\|jpg\|webp\|avif\|bmp\|svg+xml)` | kept on an image |
| `file:` (empty host or `localhost`), `C:\…`, `/c/…` (Git-Bash), `/…` off Windows, a relative path | resolved to an absolute path (below) |
| `\\server\share`, `//host/x`, `/\…`, `file://host/…` | **dropped** |
| Windows `\…` or `/…` that is not a Git-Bash drive path, `~/…` | dropped |
| anything else (`javascript:`, `vbscript:`, `data:text/html`, `ftp:`…) | dropped |

A UNC or protocol-relative target is dropped because it reaches another
machine: loading one as an image is enough to send the reader's credentials
there, with no click involved. The decoded spelling is checked as well, so
`java%09script:` cannot arrive as a relative path.

A resolved path is normalised lexically (`.` and `..` resolved without touching
the disk, never above its own root) and refused if a segment carries a colon
(alternate data stream) or names a Windows device (`CON`, `NUL`, `COM1`…).

A link that resolves keeps its `href` as written and gains
`data-mycmux-local-path="<absolute path>"`; an image loses its `src` and gains
`data-mycmux-local-src` plus `loading="lazy"`, and the pane turns that into an
asset URL. A dropped link loses its `href` and keeps its text; a dropped image
is replaced by its alt text.

### Content-Security-Policy

```
default-src 'none'; img-src * data: blob: asset: http://asset.localhost https://asset.localhost;
style-src 'unsafe-inline'; font-src * data:; base-uri 'none'; form-action 'none'
```

Scripts have no source at all. Pictures are allowed from anywhere because a
document may point at one on the web, and a local one arrives as an asset URL.

### Clicks

The frame cannot navigate anywhere useful (a new window request from a
sandboxed frame has no receiver in the main window, which is why links used to
do nothing at all), so the pane answers every click itself: `click` and
`auxclick` are captured on the frame's document, `preventDefault()` runs for
every link, and `classifyPreviewLink` decides.

- `fragment` → scroll to the element with that id (or that name), or to the top
- `local` → `onOpenLocalPath` if the pane has one: `TerminalPane` previews a
  file mycmux can show and opens the location of anything else. Without the
  callback (the dashboard, a detached window) the location opens.
- `external` → `open()` from the shell plugin
- `none` → nothing

**Opening a local file with its default application is deliberately not offered
from inside a document**: that is how a link would start a program.

## Colours

A theme declares terminal and chrome colours, nothing about documents, so every
preview colour is derived (`markdownPreviewPalette`). A palette written by hand
would drift the moment a theme is added.

- `--md-bg` = `terminal.background`, or `chrome.surface`, or white
- `scheme` = `isLightColor(bg)`, which also picks the "ink" colour (black on a
  light page, white on a dark one) that every other role is pushed toward
- `--md-text` = the terminal foreground lifted until it clears **7:1** against
  the page (AAA; the preview is nothing but small body text)
- `--md-muted` / `--md-faint` = the text colour faded as far toward the page as
  **4.8:1** / **3.2:1** still allow
- `--md-link` and the five alert colours = the theme's accent and ANSI colours
  lifted to the **4.5:1** body floor
- the surfaces (`--md-code-bg`, `--md-pre-bg`, `--md-table-head`,
  `--md-table-stripe`, borders) are small mixes between the page and the text,
  in OKLab so the hue does not swing

`tests/unit/markdownPreviewTheme.test.ts` measures all of that for **every**
theme in `THEMES`, including that body text still clears 4.5:1 against the code,
code-block and table-heading surfaces it is read on.

The stylesheet ships a light paper palette of its own, so the same file opened
outside the app still reads. The pane writes the theme over it as custom
properties on `<html>` plus `data-scheme`, and re-applies them **in place** when
the theme changes: rebuilding the document would reload the frame and throw
away where the reader had scrolled to.

## Tables in a narrow pane

mycmux panes are often 300-350px wide, which no four-column table survives. The
renderer tags each table so the stylesheet can turn its rows into cards:

- the wrapper is `<div class="table-wrap cols-N">` with `cols-2` (≤ 2 columns),
  `cols-3`, `cols-4` or `cols-many` (≥ 5)
- a body cell carries `data-label="<column name>"`, so the card can print the
  column name in front of the value. The first cell titles the card, so it gets
  `data-label-first` only when it is four characters or fewer (a number, an id)
- a column whose widest cell fits in 16 character widths (counting East Asian
  wide characters as two) gets `md-nowrap`, so short columns stop wrapping mid
  value

The container queries in the stylesheet decide when the switch happens: 22em for
two columns, 32em for three, 38em for four, 44em for five or more.

## Not covered

- **Syntax highlighting**: code blocks keep comrak's `language-…` class but are
  not coloured (syntect would pull a large dependency in for one pane)
- **Mermaid and other diagram fences**: shown as code
- **Maths**: `$x^2$` is marked up as `data-math-style` and styled as code, not
  typeset - a formula renderer needs scripts, and the frame has none
- **Table of contents / outline**: headings carry ids, but nothing lists them
- **Reloading when the file changes on disk**: the reload button re-reads it

## Looking at the output

An ignored test writes the HTML for a document so it can be opened and read:

```
set MYCMUX_MD_DUMP_IN=C:\path\to\report.md
set MYCMUX_MD_DUMP_OUT=%TEMP%\preview.html
<test binary> dump_markdown_preview_for_visual_check --ignored --nocapture
```

The binary is the one `scripts/run_windows_tests.py` builds (never plain
`cargo test` on Windows - see CLAUDE.md). With either variable unset the test
does nothing and passes.

`src-tauri/src/commands/artifact/testdata/markdown_kitchen_sink.md` is a sample
document that exercises every block kind at once, and is what
`the_sample_document_renders_every_block_kind` runs over.
