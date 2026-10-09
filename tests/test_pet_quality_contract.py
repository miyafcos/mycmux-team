"""Pet defaults, rollback copy and the shared data.json boundary."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def source(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_pet_defaults_keep_display_opt_in_and_non_repeating_random() -> None:
    store = source("src/stores/petSettingsStore.ts")
    storage = source("src-tauri/src/db/storage.rs")
    assert 'petDisplayMode: "none"' in store
    assert 'settings.petDisplayMode ?? "none"' in store
    assert 'petNewWorkspaceMode: "random"' in store
    assert 'settings.petNewWorkspaceMode ?? "random"' in store
    assert re.search(r'fn default_pet_display_mode\(\).*?"none"', storage, re.S)
    assert re.search(r'fn default_pet_new_ws_mode\(\).*?"random"', storage, re.S)


def test_pet_rollback_is_a_visible_setting_with_workspace_copy() -> None:
    strings = source("src/components/settings/settingsStrings.ts").split("export const petSettingsStrings = {", 1)[1].split("} as const", 1)[0]
    ui = source("src/components/settings/tabs/PetTab.tsx")
    assert 'newWsRandom: "使用中のキャラを避けてランダム (既定)"' in strings
    assert "重なってもよい・以前の方式" in strings
    assert "そのワークスペースに固定" in strings
    assert '["random", "random-repeat", "fixed"]' in ui
    assert "petSettingsStrings.newWsRandomRepeat" in ui
    assert "新しいタブ" not in strings
    assert "新しいペイン" not in strings


def test_pet_bag_is_optional_and_survives_the_shared_settings_boundary() -> None:
    ipc = source("src/lib/ipc.ts")
    storage = source("src-tauri/src/db/storage.rs")
    listener = source("src/components/layout/SocketListener.tsx")
    assert '"random-repeat"' in ipc
    assert 'pet_random_bag?: import("./petAssignment").PetAssignmentBag | null' in ipc
    assert re.search(r'#\[serde\(default\)\]\s*pub pet_random_bag: Option<serde_json::Value>', storage)
    assert "pet_random_bag: None" in storage
    assert "petRandomBag: settings.pet_random_bag ?? undefined" in listener
    assert "petRandomBag: data.settings.pet_random_bag ?? undefined" in listener
    assert "pet_random_bag: petSettings.petRandomBag ?? null" in listener
    assert "state.petRandomBag !== previousState.petRandomBag" in listener


def test_pet_workspace_identity_is_preserved_on_restore_and_save() -> None:
    restore = source("src/lib/workspaceRestore.ts")
    listener = source("src/components/layout/SocketListener.tsx")
    assert "pet: cfg.pet ?? undefined" in restore
    assert "restorePet: true" in restore
    assert "pet: ws.pet ?? null" in listener


def test_pet_current_spec_is_linked_and_covers_all_state_rows() -> None:
    plan = source("docs/plans/2026-09-10-pet-state-design.md")
    current = source("docs/features/implemented/pet.md")
    assert "../features/implemented/pet.md" in plan
    assert all(f"R{row}" in current for row in range(11))
    assert "random-repeat" in current
    assert "prefers-reduced-motion" in current
    assert "ワークスペース > タブ > ペイン" in current
