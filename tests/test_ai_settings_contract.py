"""Contracts for the background-AI provider/model settings and UI."""

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


def test_settings_dialog_separates_ai_and_automation_tabs() -> None:
    assert_snippets(
        "src/components/settings/SettingsDialog.tsx",
        [
            '| "ai"',
            '| "automation"',
            '{ id: "ai", label: aiSettingsStrings.tabLabel }',
            '{ id: "automation", label: aiSettingsStrings.automationTabLabel }',
            'activeTab === "ai" && <AiTab />',
            'activeTab === "automation" && <AutomationTab />',
        ],
    )


def test_ai_tab_lists_the_seven_declared_features() -> None:
    text = read_repo_text("src/components/settings/tabs/AiTab.tsx")
    strings = read_repo_text("src/components/settings/settingsStrings.ts")
    expected_copy = (
        "AI機能を有効にする",
        "オフにすると下の機能がすべて止まります",
        "使用する AI",
        "モデル",
        "カスタム…",
        "この設定で動く機能",
        "自動",
        "ボタンで実行",
        "タブの自動命名",
        "画面末尾14行・作業フォルダ・ペイン構成を送ります",
        "返信案の準備",
        "ダッシュボードの会話末尾を送ります",
        "報告インボックスの要約",
        "報告本文を送ります",
        "タブ整理のAI判定",
        "各タブの画面末尾8行と作業フォルダを送ります",
        "ailog セッション要約",
        "セッションログ全文を送ります（トークン消費が大きい機能です）",
        "ailog 一括要約",
        "選択したセッションのログを順に送ります",
        "タブ再配置（準備中）",
        "監査完了まで利用できません",
    )
    for snippet in expected_copy:
        assert snippet in strings, f"Missing approved copy: {snippet}"
    assert "AutomationTab" not in text
    assert 'checked={replyDraftSuggestionsEnabled}' in text
    assert 'checked={autoPaneNamingEnabled}' in text
    assert "unavailable" in text


def test_watchdog_settings_keep_the_existing_store_keys_and_setters() -> None:
    text = read_repo_text("src/components/settings/tabs/AutomationTab.tsx")
    for snippet in (
        "dispatchWatchdogEnabled",
        "dispatchWatchdogIntervalMinutes",
        "dispatchStallMinutes",
        "setDispatchWatchdogEnabled",
        "setDispatchWatchdogIntervalMinutes",
        "setDispatchStallMinutes",
        "setDispatchWatchdogNotify",
    ):
        assert snippet in text, f"Watchdog store contract changed: {snippet}"


def test_ai_feature_flags_use_option_semantics_with_approved_defaults() -> None:
    storage = read_repo_text("src-tauri/src/db/storage.rs")
    ipc = read_repo_text("src/lib/ipc.ts")
    ai_store = read_repo_text("src/stores/aiSettingsStore.ts")

    for field in ("auto_pane_naming_enabled", "reply_draft_suggestions_enabled"):
        assert f"pub {field}: Option<bool>" in storage
        assert f"{field}?: boolean | null" in ipc
    assert "auto_pane_naming_enabled: None" in storage
    assert "reply_draft_suggestions_enabled: None" in storage
    assert "DEFAULT_AUTO_PANE_NAMING_ENABLED = true" in ai_store
    assert "DEFAULT_REPLY_DRAFT_SUGGESTIONS_ENABLED = false" in ai_store


def test_ai_tab_uses_provider_bound_selects_with_a_custom_escape() -> None:
    assert_snippets(
        "src/components/settings/tabs/AiTab.tsx",
        [
            "<select",
            "AI_PROVIDERS.map",
            "def.presets.map",
            "CUSTOM_MODEL_VALUE",
            "customModelMode",
            'aria-label={aiSettingsStrings.customModelLabel}',
        ],
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
    for snippet in (
        "ai_provider: aiSettings.aiProvider",
        "ai_model: aiSettings.aiModel",
        "ai_enabled: aiSettings.aiEnabled",
        "auto_pane_naming_enabled: aiSettings.persistedAutoPaneNamingEnabled",
        "reply_draft_suggestions_enabled: aiSettings.persistedReplyDraftSuggestionsEnabled",
    ):
        assert snippet in text, f"buildSnapshot does not persist {snippet}"

    # Leader and child-window boot both pass through the shared migration-aware helper.
    assert text.count("hydrateAiSettingsFromDataJson(") == 3, (
        "expected one helper definition plus leader and child-window hydrate calls"
    )

    # Without this subscription the dialog accepts edits that are never saved.
    assert "useAiSettingsStore.subscribe(" in text, "missing markDirty subscription"
    assert "unsubAi()" in text, "markDirty subscription is never cleaned up"


def test_watchdog_notification_control_lives_only_in_automation() -> None:
    automation = read_repo_text("src/components/settings/tabs/AutomationTab.tsx")
    notifications = read_repo_text("src/components/settings/tabs/NotificationsLayoutTab.tsx")

    assert "dispatchWatchdogNotify" in automation
    assert "setDispatchWatchdogNotify" in automation
    assert "dispatchWatchdogNotify" not in notifications
    assert "setDispatchWatchdogNotify" not in notifications


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
