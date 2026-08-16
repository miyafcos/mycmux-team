"""M2 contracts for delegation-watch wording, settings, and notification gates."""

from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def test_delegation_watch_screen_copy_is_centralized() -> None:
    strings = read_repo_text("src/components/settings/settingsStrings.ts")
    automation = read_repo_text("src/components/settings/tabs/AutomationTab.tsx")
    watchdog = read_repo_text("src/stores/dispatchWatchdogStore.ts")
    watch_row = read_repo_text("src/components/dashboard/WatchStatusRow.tsx")

    for snippet in (
        "export const delegationWatchStrings",
        'heading: "委譲の見守り"',
        "kindLabels:",
        "queueContinuing",
        "dormancyTitle",
    ):
        assert snippet in strings
    assert "delegationWatchStrings" in automation
    assert "delegationWatchStrings" in watchdog
    assert "dashboardStrings.watchDueIn" in watch_row
    for visual_literal in ("委譲の見守り", "見守りを有効にする", "通知の敏感さ", "たった今"):
        assert visual_literal not in automation
        assert visual_literal not in watch_row


def test_output_silence_and_delegation_stall_use_distinct_words() -> None:
    dashboard_strings = read_repo_text("src/components/dashboard/dashboardStrings.ts")
    settings_strings = read_repo_text("src/components/settings/settingsStrings.ts")

    assert 'stateNoUpdate: "出力なし"' in dashboard_strings
    assert 'stallNoOutput: "5分 出力なし"' in dashboard_strings
    assert "見守りの停滞が${stallMinutes}分続くと通知" in settings_strings


def test_delegation_notifications_use_the_global_master_and_the_local_setting() -> None:
    watchdog = read_repo_text("src/stores/dispatchWatchdogStore.ts")
    notifications = read_repo_text("src/components/settings/tabs/NotificationsLayoutTab.tsx")

    assert "settings.notificationsEnabled && settings.dispatchWatchdogNotify" in watchdog
    assert "dispatchWatchdogNotify" in notifications
    assert "notificationSettingsStrings.delegationWatchHint" in notifications


def test_dormancy_setting_reuses_storage_and_notifies_the_live_sweep() -> None:
    dormancy = read_repo_text("src/lib/agentDormancy.ts")
    hook = read_repo_text("src/hooks/useAgentDormancy.ts")
    automation = read_repo_text("src/components/settings/tabs/AutomationTab.tsx")

    assert "AGENT_DORMANT_MINUTES_STORAGE_KEY" in dormancy
    assert "writeDormantMinutes" in dormancy
    assert "AGENT_DORMANCY_SETTINGS_EVENT" in dormancy
    assert "AGENT_DORMANCY_SETTINGS_EVENT" in hook
    assert "writeDormantMinutes" in automation
