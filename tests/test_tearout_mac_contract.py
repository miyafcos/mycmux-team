"""Mac opt-in, native-thread and live-transfer boundaries without a local build."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(relative):
    return (ROOT / relative).read_text(encoding='utf-8')


def test_mac_backend_is_separate_and_windows_module_stays_gated():
    module = read('src-tauri/src/tearout/mod.rs')
    assert '#[cfg(target_os = "windows")]\nmod native;' in module
    assert '#[cfg(target_os = "macos")]\n#[path = "macos.rs"]\nmod native;' in module
    assert 'native::defer(move ||' in module
    mac = read('src-tauri/src/tearout/macos.rs')
    assert 'windowNumberAtPoint' in mac and 'belowWindowWithWindowNumber: 0isize' in mac
    assert 'setAlphaValue' in mac and 'setFrameOrigin' in mac
    assert 'scheduledTimerWithTimeInterval' in mac and 'NSRunLoopCommonModes' in mac
    assert 'CGEventSourceKeyState(0, 53)' in mac and 'removeMonitor' in mac
    assert 'geometry::sample_recipients' in mac
    assert 'CGEventPost' not in mac and 'makeKeyAndOrderFront' not in mac


def test_mac_consent_is_not_inherited_from_the_existing_windows_default():
    settings = read('src/stores/settingsStore.ts')
    assert 'nativePaneTearoutEnabled: true' in settings
    # On by default on the Mac since 0.83.0 (owner's decision 2026-10-04); the
    # 0.82.0 default off saved on every Mac is switched on once at version 7.
    assert 'macNativePaneTearoutEnabled: true' in settings
    migration = read('src/stores/settingsMigration.ts')
    assert 'export const SETTINGS_STORE_VERSION = 7;' in migration
    assert 'if (persistedVersion < 7 && /^Mac/i.test(platform)) {' in migration
    assert 'merged.nativePaneTearoutEnabled = merged.macNativePaneTearoutEnabled === true' in settings
    feature = read('src/lib/tearout/feature.ts')
    assert 'macEnabled === true' in feature
    assert 'afterTearoutFrame' in read('src/lib/tearout/runtime.ts')


def test_test_only_handles_remain_guarded_and_do_not_inject_physical_input():
    hooks = read('src/lib/e2eHooks.ts')
    assert 'if (import.meta.env.VITE_E2E !== "1") return' in hooks
    assert 'nativeTearout:' in hooks and 'settings: useSettingsStore' in hooks
    module = read('src-tauri/src/tearout/mod.rs')
    assert 'tearout_synthetic_requires_test_profile' in module
    assert 'tearout_synthetic_live_move' in read('src-tauri/src/tearout/macos.rs')
