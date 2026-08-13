"""Wiring contract for the background-AI provider/model setting.

The setting lives in data.json because every consumer of it is in Rust
(commands/tab_sweep.rs, ailog/summarize.rs, ailog/digest.rs). That round trip
has three links a refactor can silently break without failing a type check:
the snapshot builder, the two hydrate paths, and the markDirty subscription.
A missing subscription in particular fails invisibly -- the UI accepts the
change and the value is gone after a restart.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_snippets(relative_path: str, snippets: list[str]) -> None:
    text = read_repo_text(relative_path)
    for snippet in snippets:
        assert snippet in text, f"Missing snippet in {relative_path}: {snippet}"


def test_settings_dialog_exposes_the_ai_tab() -> None:
    assert_snippets(
        "src/components/settings/SettingsDialog.tsx",
        [
            '| "ai"',
            '{ id: "ai", label: aiSettingsStrings.tabLabel }',
            'activeTab === "ai" && <AiTab />',
        ],
    )


def test_ai_tab_uses_a_free_entry_combobox() -> None:
    # Preset list plus free entry: a plain <select> would make any model the
    # catalog has not heard of unreachable.
    assert_snippets(
        "src/components/settings/tabs/AiTab.tsx",
        ['list={MODEL_LIST_ID}', "<datalist id={MODEL_LIST_ID}>"],
    )


def test_storage_defaults_delegate_instead_of_repeating_a_model_name() -> None:
    # Keeping the literal in ai/mod.rs alone is what lets
    # test_no_hardcoded_ai_models.py keep a tight allowlist.
    storage = read_repo_text("src-tauri/src/db/storage.rs")
    for fn in ("default_ai_provider", "default_ai_model"):
        body = re.search(rf"fn {fn}\(\)[^{{]*\{{(.*?)\}}", storage, re.S)
        assert body, f"src-tauri/src/db/storage.rs: {fn}() not found"
        assert "crate::ai" in body.group(1), (
            f"{fn}() should take its value from crate::ai, not a literal"
        )


def test_defaults_agree_across_the_rust_typescript_boundary() -> None:
    # The catalog is TypeScript-only on purpose; the default pair is the one
    # value that exists on both sides, so pin the two together.
    runner = read_repo_text("src-tauri/src/ai/mod.rs")
    catalog = read_repo_text("src/lib/aiModels.ts")

    rust_model = re.search(r'Self::Codex\s*=>\s*"(gpt-[^"]+)"', runner)
    assert rust_model, "src-tauri/src/ai/mod.rs: Codex default model not found"

    ts_provider = re.search(
        r'DEFAULT_AI_PROVIDER:\s*AiProviderId\s*=\s*"([^"]+)"', catalog,
    )
    ts_model = re.search(r'DEFAULT_AI_MODEL\s*=\s*"([^"]+)"', catalog)
    assert ts_provider, "src/lib/aiModels.ts: DEFAULT_AI_PROVIDER not found"
    assert ts_model, "src/lib/aiModels.ts: DEFAULT_AI_MODEL not found"

    assert ts_provider.group(1) == "codex", "the default provider must stay codex on both sides"
    assert rust_model.group(1) == ts_model.group(1), (
        "default model differs between ai/mod.rs and aiModels.ts"
    )


def test_ai_settings_round_trip_through_data_json() -> None:
    text = read_repo_text("src/components/layout/SocketListener.tsx")
    for snippet in ("ai_provider: aiSettings.aiProvider", "ai_model: aiSettings.aiModel", "ai_enabled: aiSettings.aiEnabled"):
        assert snippet in text, f"buildSnapshot does not persist {snippet}"

    # Leader boot and child-window boot are separate hydrate paths.
    assert text.count("hydrateAiSettings({") == 2, (
        "expected hydrateAiSettings on both the leader and the child-window path"
    )

    # Without this subscription the dialog accepts edits that are never saved.
    assert "useAiSettingsStore.subscribe(" in text, "missing markDirty subscription"
    assert "unsubAi()" in text, "markDirty subscription is never cleaned up"


def test_backend_owned_settings_survive_a_snapshot_save() -> None:
    # buildSnapshot cannot carry settings that have no frontend store, and
    # save_persistent_data replaces the whole struct, so they must be kept
    # explicitly or they revert to serde defaults on every save.
    workspace = read_repo_text("src-tauri/src/commands/workspace.rs")
    snapshot = read_repo_text("src/components/layout/SocketListener.tsx")
    for field in ("remote_bind_all", "dirty_save_mode", "osc7_tracking_enabled"):
        assert field not in snapshot, (
            f"{field} is now in buildSnapshot; drop it from the preserve list in workspace.rs"
        )
        assert field in workspace, f"save_persistent_data does not preserve {field}"


def test_ailog_panel_does_not_auto_spend_tokens_when_ai_is_off() -> None:
    text = read_repo_text("src/components/ailog/AiLogPanel.tsx")
    assert "if (!aiEnabled) return;" in text, "digest auto-generation is not gated"
    assert "aiEnabled && !autoStartedRef.current" in text, "auto summarize is not gated"
