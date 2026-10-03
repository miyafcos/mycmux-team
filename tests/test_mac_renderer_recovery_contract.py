"""Protect Windows parity, shipping isolation and Mac notification boundaries."""
import re
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
BASE='8071722ea0546544d56ec177ef323c33f6331e8f'

def original(relative):
    return subprocess.check_output(['git','show',f'{BASE}:{relative}'],cwd=ROOT).decode('utf-8')

def body(source,name):
    start=source.index('{',source.index('fn '+name+'('))
    depth=0
    for i in range(start,len(source)):
        depth+=(source[i]=='{')-(source[i]=='}')
        if depth==0:return source[start:i+1]
    raise AssertionError('unbalanced function '+name)

def test_windows_callback_budget_recovery_and_heartbeat_are_unchanged():
    before=original('src-tauri/src/watchdog.rs')
    after=(ROOT/'src-tauri/src/watchdog.rs').read_text(encoding='utf-8')
    for name in ['queue_renderer_failure','recover_renderers','creation_line','report_renderer_heartbeat']:
        assert body(before,name)==body(after,name),name
    assert before.split('#[cfg(windows)]\npub(crate) fn register_process_failed',1)[1].split('#[cfg(not(windows))]',1)[0] == \
        after.split('#[cfg(windows)]\npub(crate) fn register_process_failed',1)[1].split('#[cfg(not(any(windows, target_os = "macos")))]',1)[0]
    assert before.split('impl ReloadBudget {',1)[1].split('\nfn recover_renderers(',1)[0].rstrip() == \
        after.split('impl ReloadBudget {',1)[1].split('\n#[cfg(not(target_os = "macos"))]',1)[0].rstrip()

def test_mac_creation_registrations_add_only_macos_code():
    for relative in ['src-tauri/src/lib.rs','src-tauri/src/commands/window.rs','src-tauri/src/commands/webpane.rs']:
        after=(ROOT/relative).read_text(encoding='utf-8')
        stripped,count=re.subn(r'^[ \t]*#\[cfg\(target_os = "macos"\)\]\n[ \t]*(?:crate::)?watchdog::register_mac_process_failed[^\n]*\n','',after,flags=re.M)
        assert count==1,relative
        assert stripped==original(relative).replace('\r\n','\n'),relative

def test_test_only_fault_injection_stays_out_of_shipped_builds():
    lib=(ROOT/'src-tauri/src/lib.rs').read_text(encoding='utf-8')
    assert '#[cfg(feature = "e2e")]\nmod e2e;' in lib
    e2e=(ROOT/'src-tauri/src/e2e.rs').read_text(encoding='utf-8')
    assert body(e2e,'dispatch').index('!crate::test_profile::is_active()')<body(e2e,'dispatch').index('"e2e.renderer"')
    injection=body(e2e,'renderer_action')
    assert '_webProcessIdentifier' in injection
    assert 'pid <= 1 || pid == std::process::id() as i32' in injection
    assert 'libc::kill(pid, libc::SIGKILL)' in injection
    assert original('src-tauri/Cargo.toml')==(ROOT/'src-tauri/Cargo.toml').read_text(encoding='utf-8').replace('\r\n','\n')

def test_termination_callback_forwards_wry_and_only_enqueues():
    source=(ROOT/'src-tauri/src/watchdog.rs').read_text(encoding='utf-8')
    callback=body(source,'terminated')
    assert 'original(delegate, selector, view)' in callback
    assert 'objc_getAssociatedObject' in callback
    assert 'queue_renderer_failure' in callback
    for forbidden in ['.reload(','.navigate(','.recv(','.lock(', 'std::fs', 'session_manager','diag::log(']:
        assert forbidden not in callback,forbidden

def test_native_label_lifetime_is_owned_by_each_webview():
    source=(ROOT/'src-tauri/src/watchdog.rs').read_text(encoding='utf-8')
    assert 'objc_setAssociatedObject' in source
    assert 'OBJC_ASSOCIATION_RETAIN_NONATOMIC = 1' in source
    assert 'static LABEL_KEY: u8 = 0;' in source
    assert 'HashMap<usize' not in source

def test_every_mac_gui_case_is_serialized_by_the_shared_lock():
    driver=(ROOT/'scripts/e2e/run_mac_robust.py').read_text(encoding='utf-8')
    assert "['/usr/bin/lockf','-k','-t','7200','/Users/edu/.mycmux-gui-e2e.lock'" in driver
    assert "'scripts/e2e/mac_robust.py'" in driver
    assert 'subprocess.run(command,cwd=root)' in driver
    harness=(ROOT/'scripts/e2e/mac_robust.py').read_text(encoding='utf-8')
    assert "profile=f'm2-" in harness
    assert "['open', '-n', '-g'" in harness
    assert 'CGEventPost' not in harness and 'cliclick' not in harness
