# HTML Preview in a Child Webview

Why a read-only `.html` preview is drawn by its own WebView2 rather than by a
frame inside the app, and what that changes. Source of truth:
`src/components/workspace/WebPaneController.tsx` (which tabs get a webview and
where it is placed), `src/components/workspace/BrowserPane.tsx` (the host
rectangle), `src-tauri/src/commands/webpane.rs` (the `preview` preset and its
URL policy).

Tests: `tests/unit/documentPreviewWebview.test.tsx`,
`tests/unit/webPaneControllerLifecycle.test.tsx`,
`tests/test_web_pane_contract.py`, and the `preview` tests in `webpane.rs`.

## What was wrong with the frame

The preview lived in an `<iframe sandbox="allow-popups allow-same-origin">`
inside the app's own WebView. Three things followed from that, and all three
were things people reported:

- **No scripts.** The sandbox has no `allow-scripts`, so a report that draws a
  chart, switches a tab or animates anything showed a blank space. There was no
  way to grant scripts safely: the frame is served from the asset protocol,
  which reaches every file on the machine, so a document that could run code
  could read the disk and send it anywhere.
- **The terminal froze with it.** The frame shares a renderer, and therefore a
  main thread, with xterm.js and the whole interface. Laying out a 13 MB report
  is seconds during which nothing else paints.
- **Relative pictures never resolved.** `convertFileSrc` percent-encodes a whole
  path into one URL segment, so `img/a.png` next to `report.html` resolved
  against the site root and 404'd. Reports had to inline every picture as
  base64, which is most of why they reach 13 MB in the first place.

A child webview answers all three at once: its own process, its own thread, its
own origin, and a real URL with real path segments.

## Which previews move

Only HTML, and only when it is not being edited.

| Kind | Shown by | Why |
|---|---|---|
| `html`, read-only | child webview | the three reasons above |
| `html`, editing | frame | the editor works by reaching into the document from the pane; a child webview is another process |
| `markdown`, `text` | frame | the app renders these itself and paints them in the current theme, and the pane answers their links |
| `office` | frame | same: a document the app rendered |
| `pdf` | `<embed>` | already handed to the platform's own viewer |

`isChildWebviewPreview` is the one place that decides. The dashboard's preview
column keeps the frame as well: it is not a tab, so there is no tab id to place
a webview against.

## Placement

The pane draws an empty host `<div data-web-pane-host-tab-id="…">` and nothing
else. `WebPaneController` — the same one that places the Web panes — measures
that rectangle every frame and moves the webview onto it.

Everything that follows comes free, because it was already solved for Web panes:
pane splits and drags, window resizes, workspace switches, pane zoom, and the
whole occluder list (a modal, a popover, a menu, a drag in progress) hiding the
native rectangle so the interface can draw over where it was.

**Switching to another tab in the same pane hides the webview; it does not
destroy it.** The host div leaves the DOM, the measured rectangle becomes null,
and the controller hides the view. Coming back shows it again with its scroll
position and its page state intact — which the frame could never do, because
React unmounted it.

## When the webview is rebuilt

`webPaneIdentity` decides. For a preview it is the preset, the file and the
reload counter together, so the view is torn down and built again when the file
it shows changes. The counter only moves when the file was actually written
again (`browserTabNeedsReload`), so clicking the same path twice keeps the page
and the reader's place in it.

Rebuilding rather than calling reload is deliberate: `webpane_navigate` is
refused to anything but the main window, and a preview in a detached window
would have no way to refresh itself.

## The `preview` preset and its policy

A preview runs under its own preset, which is **not** in the launcher: nobody
opens an empty preview.

- **Its own profile directory.** A report opened from a client must not be able
  to read the cookies of anything signed in elsewhere in the app.
- **`http://asset.localhost` and nothing else.** Not `file:`, not `https:`, not
  another host. A link in a report cannot take the pane somewhere else.
- **No authentication hosts.** Every other preset also allows the identity
  providers, so a sign-in popup works. A preview has no reason to show a login,
  and allowing one would let a document put up a convincing imitation of it.
- **Every new window goes to the OS browser.** `window.open`, `target="_blank"`
  and a link to the web all leave the app rather than opening inside it.

Scripts run. That is the point. What they can reach is bounded by the four rules
above plus the browser's own rules: the document is on `asset.localhost`, so it
cannot read the app's origin, and it has no Tauri IPC.

## Not covered

- **The dashboard's preview column** still uses the frame, so a heavy report is
  still heavy there
- **Zoom.** There is no API to set a child webview's scale; `Ctrl` `+`/`-` are
  left to the webview's own handling
- **One webview per open preview.** A frame cost a DOM subtree; this costs a
  process. Opening many previews at once costs more memory than it used to
- **Reload from a detached window** rebuilds the view rather than refreshing it
