from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify Codex cursor rendering is fixed and non-blinking.")
    parser.add_argument(
        "--artifact-dir",
        type=Path,
        default=Path.home() / "codex-tmp" / "mycmux-cursor-test",
        help="Directory for screenshot artifacts.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repo = Path(__file__).resolve().parents[1]
    xterm_js = repo / "node_modules" / "@xterm" / "xterm" / "lib" / "xterm.js"
    xterm_css = repo / "node_modules" / "@xterm" / "xterm" / "css" / "xterm.css"
    app_css = repo / "src" / "global.css"
    wrapper_source = repo / "src" / "components" / "terminal" / "XTermWrapper.tsx"
    terminal_pane_source = repo / "src" / "components" / "workspace" / "TerminalPane.tsx"
    artifact_dir = args.artifact_dir
    artifact_dir.mkdir(parents=True, exist_ok=True)
    screenshot = artifact_dir / f"{repo.name}-codex-cursor.png"

    if not xterm_js.exists() or not xterm_css.exists():
        raise FileNotFoundError("xterm assets are missing; run npm install first.")
    wrapper_text = wrapper_source.read_text(encoding="utf-8")
    if "codexCursorFollowInputUntil" in wrapper_text:
        raise AssertionError("Codex cursor still follows moving output after input.")
    for required in (
        "codexCursorStyleActiveRef",
        "ensureCodexCursorStyleActive",
        "getCodexPromptCursorPosition",
        "positionCodexCursorOnInputLine",
        "cursorInactiveStyle = \"none\"",
        "cursorAccent: \"rgba(0, 0, 0, 0)\"",
        "agentKind === \"claude-codex\"",
        "Codex session starting",
    ):
        if required not in wrapper_text:
            raise AssertionError(f"XTermWrapper is missing required late-activation guard: {required}")
    css_text = app_css.read_text(encoding="utf-8")
    for required_css in ("caret-color: transparent", ".xterm-cursor-layer *"):
        if required_css not in css_text:
            raise AssertionError(f"global.css is missing cursor suppression rule: {required_css}")
    if "activeTabMetadataAgentKind" not in terminal_pane_source.read_text(encoding="utf-8"):
        raise AssertionError("TerminalPane does not pass metadata agentKind to XTermWrapper.")

    html = """
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body {
            margin: 0;
            background: #0a0a0a;
          }
          #host {
            --cmux-bg: #0a0a0a;
            --cmux-text: #ededed;
            position: relative;
            width: 900px;
            height: 460px;
            overflow: hidden;
            background: var(--cmux-bg);
          }
          #terminal {
            width: 100%;
            height: 100%;
          }
        </style>
      </head>
      <body>
        <div id="host">
          <div id="terminal"></div>
          <div id="codex-fixed-cursor" class="codex-fixed-cursor" aria-hidden="true"></div>
        </div>
      </body>
    </html>
    """

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 920, "height": 480}, device_scale_factor=1)
        page.set_content(html)
        page.add_style_tag(path=str(xterm_css))
        page.add_style_tag(path=str(app_css))
        page.add_script_tag(path=str(xterm_js))
        page.evaluate(
            """
            async () => {
              const term = new Terminal({
                cols: 80,
                rows: 20,
                cursorBlink: true,
                cursorStyle: 'block',
                fontSize: 16,
                fontFamily: 'Consolas, monospace',
                theme: { background: '#0a0a0a', foreground: '#ededed', cursor: '#ededed' }
              });
              const terminal = document.getElementById('terminal');
              const host = document.getElementById('host');
              const fixed = document.getElementById('codex-fixed-cursor');
              term.open(terminal);
              term.focus();

              window.__term = term;
              let lastPromptPosition = null;
              window.__findPromptCursor = () => {
                const buffer = term.buffer.active;
                const viewportTop = buffer.viewportY;
                const viewportBottom = Math.min(buffer.length - 1, viewportTop + term.rows - 1);
                for (let lineIndex = viewportBottom; lineIndex >= viewportTop; lineIndex -= 1) {
                  const line = buffer.getLine(lineIndex);
                  if (!line) continue;
                  const rawText = line.translateToString(false);
                  const text = rawText.trim();
                  if (!/gpt-5(?:\\.\\d+)?\\b.*\\u00b7\\s*(?:~|[A-Za-z]:\\\\|\\/)/i.test(text)) continue;
                  return {
                    x: Math.max(0, Math.min(rawText.trimEnd().length, term.cols - 1)),
                    y: lineIndex - viewportTop
                  };
                }
                return null;
              };
              window.__placeFixedCursor = (updatePosition, targetPosition) => {
                host.classList.add('xterm-codex-cursor', 'codex-fixed-cursor-visible');
                if (!updatePosition && fixed.dataset.positioned === '1') return;
                const anchor = term.element.querySelector('.xterm-screen') || term.element;
                const anchorRect = anchor.getBoundingClientRect();
                const hostRect = host.getBoundingClientRect();
                const cellWidth = anchorRect.width / Math.max(term.cols, 1);
                const cellHeight = anchorRect.height / Math.max(term.rows, 1);
                const cursorX = Math.max(0, Math.min(targetPosition?.x ?? term.buffer.active.cursorX, term.cols - 1));
                const cursorY = Math.max(0, Math.min(targetPosition?.y ?? term.buffer.active.cursorY, term.rows - 1));
                fixed.style.transform = `translate(${Math.round(anchorRect.left - hostRect.left + cursorX * cellWidth)}px, ${Math.round(anchorRect.top - hostRect.top + cursorY * cellHeight)}px)`;
                fixed.style.height = `${Math.max(1, Math.round(cellHeight))}px`;
                fixed.dataset.positioned = '1';
              };
              window.__activateCodexCursor = (updatePosition) => {
                term.options.cursorBlink = false;
                term.options.cursorStyle = 'bar';
                term.options.cursorInactiveStyle = 'none';
                term.options.cursorWidth = 1;
                term.options.theme = { ...term.options.theme, cursor: 'rgba(0, 0, 0, 0)', cursorAccent: 'rgba(0, 0, 0, 0)' };
                const promptPosition = window.__findPromptCursor();
                if (promptPosition) lastPromptPosition = promptPosition;
                window.__placeFixedCursor(updatePosition, promptPosition || lastPromptPosition);
              };

              await new Promise((resolve) => term.write('status line\\r\\ngpt-5.5 xhigh \\u00b7 ~', resolve));
              window.__activateCodexCursor(true);
            }
            """
        )
        page.wait_for_selector(".codex-fixed-cursor", state="attached")

        native_state = page.evaluate(
            """
            () => Array.from(document.querySelectorAll('.xterm-cursor-layer, .xterm-cursor, .xterm-cursor-block, .xterm-cursor-bar, .xterm-cursor-underline'))
              .map((el) => {
                const style = getComputedStyle(el);
                return {
                  className: el.className,
                  opacity: style.opacity,
                  visibility: style.visibility,
                  animationName: style.animationName
                };
              })
            """
        )
        if not native_state:
            raise AssertionError("No xterm cursor elements were rendered, so the test cannot prove hiding.")
        for entry in native_state:
            if entry["opacity"] != "0" and entry["visibility"] != "hidden":
                raise AssertionError(f"xterm native cursor is still visible: {entry}")
            if entry["animationName"] != "none":
                raise AssertionError(f"xterm native cursor is still animated: {entry}")

        before = page.locator("#codex-fixed-cursor").bounding_box()
        if not before:
            raise AssertionError("Fixed cursor was not visible before Codex output burst.")

        page.evaluate(
            """
            async () => {
              await new Promise((resolve) => window.__term.write('\\x1b[1AWorking before input-line check', resolve));
              window.__activateCodexCursor(true);
            }
            """
        )
        after_forced_prompt = page.locator("#codex-fixed-cursor").bounding_box()
        if not after_forced_prompt:
            raise AssertionError("Fixed cursor disappeared after forced working-line cursor move.")
        if abs(before["x"] - after_forced_prompt["x"]) > 0.5 or abs(before["y"] - after_forced_prompt["y"]) > 0.5:
            raise AssertionError(
                f"Fixed cursor left the input prompt line: before={before}, after={after_forced_prompt}"
            )

        page.evaluate(
            """
            async () => {
              window.__activateCodexCursor(true);
              for (let i = 0; i < 24; i += 1) {
                window.__term.write('\\x1b[?25h\\x1b[1 q\\x1b[?12h\\x1b[2AWorking... ' + i + '\\x1b[2B');
                window.__activateCodexCursor(false);
                await new Promise((resolve) => setTimeout(resolve, 12));
              }
            }
            """
        )

        after = page.locator("#codex-fixed-cursor").bounding_box()
        if not after:
            raise AssertionError("Fixed cursor disappeared after Codex output burst.")

        if abs(before["x"] - after["x"]) > 0.5 or abs(before["y"] - after["y"]) > 0.5:
            raise AssertionError(f"Fixed cursor moved: before={before}, after={after}")

        fixed_style = page.evaluate(
            """
            () => {
              const style = getComputedStyle(document.getElementById('codex-fixed-cursor'));
              return { opacity: style.opacity, animationName: style.animationName };
            }
            """
        )
        if fixed_style["opacity"] != "1" or fixed_style["animationName"] != "none":
            raise AssertionError(f"Fixed cursor is not a visible non-blinking bar: {fixed_style}")

        page.screenshot(path=str(screenshot), full_page=True)
        browser.close()

    print(f"PASS codex cursor visual test")
    print(f"screenshot={screenshot}")


if __name__ == "__main__":
    main()
