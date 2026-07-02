from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def test_mycmux_ui_variant_accepts_product_name_and_legacy_alias() -> None:
    package_json = read_repo_text("package.json")
    app = read_repo_text("src/App.tsx")
    vite_config = read_repo_text("vite.config.ts")

    assert_contains(package_json, "VITE_UI_VARIANT=mycmux vite build", "package.json")
    assert_contains(package_json, "VITE_UI_VARIANT=mycmux npm run tauri dev", "package.json")
    assert_contains(app, "const uiVariantEnv = import.meta.env.VITE_UI_VARIANT;", "src/App.tsx")
    assert_contains(
        app,
        'const uiVariant = uiVariantEnv === "mycmux" || uiVariantEnv === "cmux" ? "cmux" : "default";',
        "src/App.tsx",
    )
    assert_contains(
        vite_config,
        'const isCmuxVariant = env.VITE_UI_VARIANT === "mycmux" || env.VITE_UI_VARIANT === "cmux";',
        "vite.config.ts",
    )
    assert_contains(vite_config, 'mode === "production" && isCmuxVariant ? "dist-cmux-ui" : "dist"', "vite.config.ts")


def test_hot_path_xterm_diagnostic_logs_are_dev_guarded() -> None:
    xterm_wrapper = read_repo_text("src/components/terminal/XTermWrapper.tsx")

    for marker in [
        "cache_evict",
        "cache_hit",
        "cache_miss",
        "initial_replay",
    ]:
        marker_pos = xterm_wrapper.index(marker)
        guard_window = xterm_wrapper[max(0, marker_pos - 180):marker_pos]
        assert 'if (import.meta.env.DEV)' in guard_window, marker
