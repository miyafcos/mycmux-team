"""Fake Playwright page/locator and a scripted chat site for driver tests.

The fake models what the driver actually relies on: `locator(selector)` with
`count()`, `nth(i)`, `first`, `is_visible()`, `click()`, `fill()`, `press()`,
`inner_text()`, `evaluate()`, `evaluate_all()`, plus `page.url`, `goto`,
`evaluate`, `keyboard.press`, `screenshot`, `close`. A `Scenario` decides what
each selector returns at a given moment, so tests can script "answer appears
after N polls", "generating indicator flickers", "login wall mid-wait" and so
on without a browser.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class Node:
    text: str = ""
    visible: bool = True
    href: str | None = None
    aria: str | None = None
    tag: str = "div"
    on_click: Callable[[], None] | None = None


class FakeLocator:
    def __init__(self, page: "FakePage", selector: str, nodes: list[Node]) -> None:
        self.page = page
        self.selector = selector
        self.nodes = nodes

    def count(self) -> int:
        return len(self.nodes)

    @property
    def first(self) -> "FakeLocator":
        return FakeLocator(self.page, self.selector, self.nodes[:1])

    def nth(self, index: int) -> "FakeLocator":
        return FakeLocator(self.page, self.selector, [self.nodes[index]])

    def _node(self) -> Node:
        if not self.nodes:
            raise RuntimeError(f"no node for {self.selector}")
        return self.nodes[0]

    def is_visible(self) -> bool:
        return bool(self.nodes) and self._node().visible

    def click(self, timeout: int | None = None) -> None:
        node = self._node()
        self.page.clicks.append(self.selector)
        if node.on_click:
            node.on_click()

    def fill(self, text: str, timeout: int | None = None) -> None:
        self.page.composer_value = text

    def press(self, key: str) -> None:
        self.page.presses.append(key)
        if key == "Enter":
            self.page.scenario.on_send(self.page)

    def inner_text(self, timeout: int | None = None) -> str:
        return self._node().text

    def get_attribute(self, name: str) -> str | None:
        node = self._node()
        return {"href": node.href, "aria-label": node.aria}.get(name)

    def evaluate(self, script: str, arg: Any = None) -> Any:
        if "tagName" in script and "value" in script:
            return self.page.composer_value
        if "tagName.toLowerCase" in script:
            return self._node().tag
        return None

    def evaluate_all(self, script: str, arg: Any = None) -> Any:
        if "getAttribute('href')" in script and "aria" in script:
            return [{"href": node.href or "", "aria": node.aria or "", "text": node.text} for node in self.nodes]
        if "getAttribute('href')" in script:
            return [node.href or "" for node in self.nodes]
        if "aria-label" in script:
            return [{"index": index, "text": node.text, "aria": node.aria or ""} for index, node in enumerate(self.nodes)]
        return []

    def locator(self, selector: str) -> "FakeLocator":
        return self.page.locator(selector, scope=self.selector)


class FakeKeyboard:
    def __init__(self) -> None:
        self.pressed: list[str] = []

    def press(self, key: str) -> None:
        self.pressed.append(key)


@dataclass
class Scenario:
    """Scripted site. `resolve(page, selector, scope)` returns nodes for a selector."""

    resolve: Callable[["FakePage", str, str | None], list[Node]]
    on_send: Callable[["FakePage"], None] = lambda page: None
    url_after_send: str = ""


class FakePage:
    def __init__(self, scenario: Scenario, url: str = "https://example.test/") -> None:
        self.scenario = scenario
        self.url = url
        self.composer_value = ""
        self.clicks: list[str] = []
        self.presses: list[str] = []
        self.keyboard = FakeKeyboard()
        self.closed = False
        self.screenshots: list[str] = []
        self.polls = 0
        self.body = ""
        self.turns: list[dict[str, str]] = []
        self.sent = False
        self.default_timeout = 0

    def set_default_timeout(self, value: int) -> None:
        self.default_timeout = value

    def goto(self, url: str, wait_until: str | None = None, timeout: int | None = None) -> None:
        self.url = url

    def locator(self, selector: str, scope: str | None = None) -> FakeLocator:
        return FakeLocator(self, selector, self.scenario.resolve(self, selector, scope))

    def evaluate(self, script: str, arg: Any = None) -> Any:
        if "document.body" in script:
            return self.body
        if "querySelectorAll(combined)" in script:
            return list(self.turns)
        if "insertText" in script:
            self.composer_value = arg
            return None
        if "innerText || '').trim() === 'Chat'" in script:
            return True
        return None

    def screenshot(self, path: str) -> None:
        self.screenshots.append(path)

    def close(self) -> None:
        self.closed = True


class FakePlaywright:
    """Stand-in for `sync_playwright()` that hands the driver a prepared page."""

    def __init__(self, page: FakePage, fail_connect: bool = False) -> None:
        self.page = page
        self.fail_connect = fail_connect

    def __enter__(self) -> "FakePlaywright":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None


def install(monkeypatch, cdp_module, page: FakePage, *, fail_connect: bool = False) -> None:
    """Route cdp._connect and sync_playwright to the fake, and make chrome quiet."""
    import types

    def fake_connect(_playwright: Any, _endpoint: str) -> FakePage:
        if fail_connect:
            raise RuntimeError("CDP endpoint down: simulated")
        return page

    fake_module = types.SimpleNamespace(sync_playwright=lambda: FakePlaywright(page))
    monkeypatch.setitem(__import__("sys").modules, "playwright.sync_api", fake_module)
    monkeypatch.setattr(cdp_module, "_connect", fake_connect)
    monkeypatch.setattr(cdp_module.chrome, "show", lambda: "shown")
    monkeypatch.setattr(cdp_module.time, "sleep", lambda _seconds: None)
