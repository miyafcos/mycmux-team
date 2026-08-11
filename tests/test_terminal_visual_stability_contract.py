from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_chrome_and_active_pane_use_flat_focus_indicators() -> None:
    css = (ROOT / "src" / "global.css").read_text(encoding="utf-8")
    app_shell = (
        ROOT / "src" / "components" / "layout" / "AppShell.tsx"
    ).read_text(encoding="utf-8")

    assert "--cmux-chrome-icon-shadow: none;" in css
    assert "--cmux-chrome-text-shadow: none;" in css
    assert '"--cmux-chrome-icon-shadow": "none"' in app_shell
    assert '"--cmux-chrome-text-shadow": "none"' in app_shell
    assert '.terminal-pane-border[data-active-pane="true"]::after' not in css


def test_status_indicators_are_flat_and_localized() -> None:
    pane_tab_bar = (
        ROOT / "src" / "components" / "workspace" / "PaneTabBar.tsx"
    ).read_text(encoding="utf-8")

    assert "boxShadow: `0 0 0 3px" not in pane_tab_bar
    assert 'title: "作業中"' in pane_tab_bar
    assert 'title: "入力待ち"' in pane_tab_bar
    assert 'background: "transparent"' in pane_tab_bar
    assert "color-mix(in srgb, ${statusCfg.color} 10%, transparent)" not in pane_tab_bar


def test_all_terminal_kinds_share_the_saved_surface_background() -> None:
    terminal = (
        ROOT / "src" / "components" / "terminal" / "XTermWrapper.tsx"
    ).read_text(encoding="utf-8")

    assert "CODEX_TERMINAL_OPACITY_FLOOR" not in terminal
    assert "codexSurfaceBackground" not in terminal
    assert "setDetectedCodexSessionId" not in terminal
    assert (
        'background: "var(--cmux-terminal-bg, var(--cmux-bg, #0a0a0a))"'
        in terminal
    )
