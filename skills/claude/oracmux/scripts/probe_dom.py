#!/usr/bin/env python3
"""Read-only DOM probe for selector maintenance (sends nothing, clicks nothing).

    python probe_dom.py --engine gemini [--selector "a[href^='/app/']" ...] [--wide]

Opens the engine's landing page in OracleChrome, waits for the composer, then
reports for each selector: count and a sample (tag / href / text / aria /
data-testid). Playwright-only selectors (`:has-text(...)`) are counted through
the locator API instead of `querySelectorAll` (audit F-51). `--wide` dumps every
non-http link, every aria-label, custom tag names and data-testid /
data-test-id values — the net that found the history and mode controls on
2026-09-07. Output is UTF-8 JSON on stdout; any failure exits 1 (audit F-52).

Use it before touching engines.json; paste the measured selector and the date
into references/engine-notes.md.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from oracmux_lib import chrome, engines  # noqa: E402
from oracmux_lib.engines import PLAYWRIGHT_ONLY  # noqa: E402

SAMPLE_JS = """
(selectors) => {
  const out = {};
  for (const sel of selectors) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { out[sel] = {error: String(e)}; continue; }
    out[sel] = {
      count: nodes.length,
      sample: nodes.slice(0, 5).map(n => ({
        tag: n.tagName.toLowerCase(),
        href: n.getAttribute('href'),
        text: (n.innerText || n.textContent || '').trim().slice(0, 60),
        testid: n.getAttribute('data-testid') || n.getAttribute('data-test-id'),
        aria: n.getAttribute('aria-label'),
        role: n.getAttribute('role'),
      })),
    };
  }
  return out;
}
"""

WIDE_JS = """
() => {
  const uniq = (arr) => Array.from(new Set(arr));
  const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
    href: a.getAttribute('href'), text: (a.innerText || '').trim().slice(0, 40), aria: a.getAttribute('aria-label'), testid: a.getAttribute('data-testid')
  })).filter(x => x.href && !x.href.startsWith('http'));
  const arias = Array.from(document.querySelectorAll('[aria-label]')).map(e => ({
    tag: e.tagName.toLowerCase(), aria: e.getAttribute('aria-label'), text: (e.innerText || '').trim().slice(0, 30), testid: e.getAttribute('data-testid'), role: e.getAttribute('role')
  }));
  const customTags = uniq(Array.from(document.querySelectorAll('*')).map(e => e.tagName.toLowerCase()).filter(t => t.includes('-')));
  const testids = uniq(Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')));
  const testids2 = uniq(Array.from(document.querySelectorAll('[data-test-id]')).map(e => e.getAttribute('data-test-id')));
  return {links: links.slice(0, 80), arias: arias.slice(0, 150), customTags: customTags.slice(0, 150), testids: testids.slice(0, 150), testids2: testids2.slice(0, 150)};
}
"""


def playwright_only(selector: str) -> bool:
    return any(token in selector for token in PLAYWRIGHT_ONLY)


def sample_locator(page, selector: str) -> dict:
    """Count + sample through Playwright for selectors the page itself cannot parse."""
    try:
        locator = page.locator(selector)
        count = int(locator.count())
        sample = []
        for index in range(min(count, 5)):
            node = locator.nth(index)
            try:
                sample.append({
                    "tag": node.evaluate("(n) => n.tagName.toLowerCase()"),
                    "href": node.get_attribute("href"),
                    "text": (node.inner_text(timeout=1000) or "").strip()[:60],
                    "aria": node.get_attribute("aria-label"),
                    "visible": node.is_visible(),
                })
            except Exception as exc:  # noqa: BLE001
                sample.append({"error": str(exc)[:80]})
        return {"count": count, "sample": sample, "via": "playwright"}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)[:120], "via": "playwright"}


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", choices=engines.ENGINE_IDS, required=True)
    parser.add_argument("--selector", action="append", default=[], help="CSS selector to sample (repeatable)")
    parser.add_argument("--url", help="open this URL instead of the landing page (e.g. a conversation)")
    parser.add_argument("--wide", action="store_true")
    parser.add_argument("--wait-sec", type=float, default=25.0)
    ns = parser.parse_args(argv)

    data = engines.load()
    site = engines.engine(data, ns.engine)
    endpoint = engines.cdp_endpoint(data)
    print(chrome.ensure_up(endpoint), file=sys.stderr)
    selectors = list(ns.selector or [])
    for key in ("composer", "send", "generating", "assistant", "user_turns", "new_chat", "history", "login", "mode_label", "dismiss"):
        selectors.extend(site.get(key, []))
    selectors = list(dict.fromkeys(selectors))
    from playwright.sync_api import sync_playwright

    report: dict = {"engine": ns.engine, "url": ns.url or site["url"]}
    failed = False
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(endpoint, timeout=20000)
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()
        try:
            page.goto(ns.url or str(site["url"]), wait_until="domcontentloaded", timeout=45000)
            deadline = time.monotonic() + ns.wait_sec
            seen = False
            while time.monotonic() < deadline and not seen:
                for selector in site["composer"]:
                    try:
                        if page.locator(selector).count() and page.locator(selector).first.is_visible():
                            seen = True
                            break
                    except Exception:  # noqa: BLE001
                        continue
                if not seen:
                    page.wait_for_timeout(1000)
            page.wait_for_timeout(2000)
            report["composer_seen"] = seen
            report["url_after_load"] = page.url
            plain = [selector for selector in selectors if not playwright_only(selector)]
            report["selectors"] = page.evaluate(SAMPLE_JS, plain)
            for selector in selectors:
                if playwright_only(selector):
                    report["selectors"][selector] = sample_locator(page, selector)
            if ns.wide:
                report["wide"] = page.evaluate(WIDE_JS)
        except Exception as exc:  # noqa: BLE001
            report["error"] = f"{type(exc).__name__}: {str(exc)[:300]}"
            failed = True
        finally:
            page.close()
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
