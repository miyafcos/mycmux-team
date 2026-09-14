"""ask --plugin: the chip must be attached before the brief and the brief appended."""
from __future__ import annotations

from pathlib import Path

import pytest

from oracmux_lib import pane, pane_driver

SITE = {
    "label": "ChatGPT",
    "pane_preset": "chatgpt",
    "composer": ["#prompt-textarea"],
    "send": ["[data-testid='send-button']"],
    "plugin_open": ["[data-testid='composer-plus-btn']"],
}


class FakePane:
    """Scripted DOM: the row appears after the opener is clicked and letters typed,
    the chip lands after the row is clicked, the send control after a type."""

    def __init__(self, *, list_row: bool = True, chip_lands: bool = True) -> None:
        self.list_row = list_row
        self.chip_lands = chip_lands
        self.clicks: list[str] = []
        self.keys: list[str] = []
        self.xy: list[tuple[float, float]] = []
        self.typed: list[dict] = []
        self.pushed = 0
        self.composer = ""

    def web_click(self, tab: str, selector: str) -> None:
        self.clicks.append(selector)

    def web_key(self, tab: str, key: str, *, trusted: bool = False) -> None:
        self.keys.append(key)

    def web_click_xy(self, tab: str, x: float, y: float, *, trusted: bool = True) -> None:
        self.xy.append((x, y))
        if self.chip_lands:
            self.composer = "oracmux-sandbox\n "

    def web_type(self, tab: str, text_file: Path, *, selector: str, submit: bool = False, trusted: bool = False, append: bool = False) -> None:
        self.typed.append({"append": append, "trusted": trusted})
        text = text_file.read_text(encoding="utf-8")
        self.composer = (self.composer + text) if append else text

    def web_push(self, **kwargs) -> None:
        self.pushed += 1
        self.composer = kwargs["text_file"].read_text(encoding="utf-8")

    def web_eval(self, tab: str, script: str) -> dict:
        if "startsWith(name)" in script:  # PLUGIN_ROW_JS
            menu_open = any("composer-plus-btn" in c for c in self.clicks) and len(self.keys) >= 4
            if self.list_row and menu_open:
                return {"found": True, "x": 610.0, "y": 444.0, "text": "oracmux-sandbox\nLocal sandbox files"}
            return {"found": False}
        if "attached:" in script:  # PLUGIN_ATTACHED_JS
            return {"found": True, "attached": "oracmux-sandbox" in self.composer, "text": self.composer[:120]}
        if "present:" in script:  # SEND_PRESENT_JS
            return {"present": bool(self.composer.strip()), "selector": SITE["send"][0]}
        return {"found": True, "text": self.composer}


@pytest.fixture
def fake(monkeypatch):
    f = FakePane()
    for name in ("web_click", "web_key", "web_click_xy", "web_type", "web_push", "web_eval"):
        monkeypatch.setattr(pane, name, getattr(f, name))
    monkeypatch.setattr(pane_driver, "PLUGIN_MENU_SEC", 0.0)
    monkeypatch.setattr(pane_driver, "PLUGIN_POLL_SEC", 0.0)
    monkeypatch.setattr(pane_driver, "PLUGIN_ROW_WAIT_SEC", 0.2)
    monkeypatch.setattr(pane_driver, "PLUGIN_ATTACH_SEC", 0.2)
    monkeypatch.setattr(pane_driver, "FILL_VERIFY_SEC", 0.2)
    monkeypatch.setattr(pane_driver, "FILL_POLL_SEC", 0.0)
    return f


def test_attach_plugin_opens_menu_types_and_clicks_row(fake) -> None:
    out = pane_driver.attach_plugin(SITE, "tab", "oracmux-sandbox", lambda m: None)
    assert fake.clicks[:2] == ["#prompt-textarea", "[data-testid='composer-plus-btn']"]
    assert fake.keys == ["o", "r", "a", "c"]
    assert fake.xy == [(610.0, 444.0)]
    assert out["plugin"] == "oracmux-sandbox" and out["composer"].startswith("oracmux-sandbox")


def test_attach_plugin_stops_when_row_never_lists(fake) -> None:
    fake.list_row = False
    with pytest.raises(pane_driver.PaneNotReady, match="never listed"):
        pane_driver.attach_plugin(SITE, "tab", "oracmux-sandbox", lambda m: None)
    assert fake.xy == []


def test_attach_plugin_stops_when_chip_does_not_land(fake) -> None:
    fake.chip_lands = False
    with pytest.raises(pane_driver.PaneNotReady, match="no chip appeared"):
        pane_driver.attach_plugin(SITE, "tab", "oracmux-sandbox", lambda m: None)


def test_attach_plugin_refuses_site_without_opener(fake) -> None:
    site = {k: v for k, v in SITE.items() if k != "plugin_open"}
    with pytest.raises(pane_driver.PaneNotReady, match="not supported"):
        pane_driver.attach_plugin(site, "tab", "oracmux-sandbox", lambda m: None)


def test_fill_append_keeps_chip_and_never_pushes(fake, tmp_path: Path) -> None:
    pane_driver.attach_plugin(SITE, "tab", "oracmux-sandbox", lambda m: None)
    brief = tmp_path / "brief.md"
    brief.write_text("hello brief\n", encoding="utf-8")
    out = pane_driver.fill_composer(SITE, "tab", brief, lambda m: None, append=True)
    assert out == {"method": "type-append", "send_present": True}
    assert fake.pushed == 0
    assert fake.typed == [{"append": True, "trusted": True}]
    assert fake.composer.startswith("oracmux-sandbox") and fake.composer.endswith("hello brief\n")


def test_fill_without_append_still_pushes(fake, tmp_path: Path) -> None:
    brief = tmp_path / "brief.md"
    brief.write_text("hello brief\n", encoding="utf-8")
    out = pane_driver.fill_composer(SITE, "tab", brief, lambda m: None)
    assert out["method"] == "push" and fake.pushed == 1 and fake.typed == []
