"""Protect Windows parity, shipping isolation and Mac notification boundaries.

Only the working tree is read (no fixed base commit), so the checks also hold in the
public mirror, whose history does not carry the private commits.
"""
import re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
WATCHDOG=ROOT/'src-tauri/src/watchdog.rs'

def gates(source,signature):
    """The cfg attribute above each occurrence of an item, skipping doc comments and derives."""
    found=[]
    start=source.find(signature)
    while start!=-1:
        above=source[:source.rfind('\n',0,start)].splitlines()
        gate=next((line.strip() for line in reversed(above)
            if not line.strip().startswith(('///','#[derive'))),'')
        found.append(gate)
        start=source.find(signature,start+1)
    return found

def body(source,name):
    start=source.index('{',source.index('fn '+name+'('))
    depth=0
    for i in range(start,len(source)):
        depth+=(source[i]=='{')-(source[i]=='}')
        if depth==0:return source[start:i+1]
    raise AssertionError('unbalanced function '+name)

def test_renderer_recovery_is_partitioned_by_platform():
    # The Mac path is separate code: none of it compiles into the Windows build,
    # and the Windows callback, queue and recovery keep their own definitions.
    source=WATCHDOG.read_text(encoding='utf-8')
    assert gates(source,'fn register_process_failed(')==['#[cfg(windows)]',
        '#[cfg(not(any(windows, target_os = "macos")))]','#[cfg(target_os = "macos")]']
    assert gates(source,'fn queue_renderer_failure(')==['#[cfg(windows)]','#[cfg(target_os = "macos")]']
    assert gates(source,'fn recover_renderers(')==['#[cfg(not(target_os = "macos"))]','#[cfg(target_os = "macos")]']
    for item in ['struct MacReloadBudget','impl MacReloadBudget','mod mac_process_failed',
                 'use register_process_failed as register_mac_process_failed']:
        assert gates(source,item)==['#[cfg(target_os = "macos")]'],item

def test_both_platforms_heartbeat_identity_comes_from_the_caller_and_prunes_closed_views():
    source=WATCHDOG.read_text(encoding='utf-8')
    assert source.count('pub async fn report_renderer_heartbeat(')==1
    assert 'struct MacRendererWatches' not in source
    assert 'Mutex<RendererWatch>' not in source
    for item in ['struct RendererWatches', 'impl RendererWatches', 'fn renderers()']:
        assert all(not gate.startswith('#[cfg(') for gate in gates(source,item)),item
    command=body(source,'report_renderer_heartbeat')
    assert 'caller: tauri::Webview' in source
    assert 'heartbeat(caller.label(), &heartbeat, clock_ms())' in command
    assert 'renderers().lock()' in command
    assert '.poll(now_ms, |label| app.get_webview(label).is_some())' in source
    assert 'self.views.retain(|label, _| exists(label))' in source
    assert '[renderer] heap_used_mib={heap}' in source
    assert 'webview={label}' in body(source,'heartbeat') or 'format!("{line} webview={label}")' in source
    for name in ['a_spare_heartbeat_cannot_conceal_a_silent_main_renderer',
                 'a_live_main_heartbeat_cannot_conceal_a_silent_child_renderer',
                 'destroyed_renderers_are_pruned_without_false_silence',
                 'shared_legacy_heartbeat_masks_silence_but_per_view_watches_do_not',
                 'per_view_renderer_metrics_keep_the_existing_prefix_and_rate_limits']:
        assert gates(source,'fn '+name+'(')==['#[test]'],name

def test_mac_creation_registrations_are_macos_only():
    for relative in ['src-tauri/src/lib.rs','src-tauri/src/commands/window.rs','src-tauri/src/commands/webpane.rs']:
        source=(ROOT/relative).read_text(encoding='utf-8')
        gated=re.findall(r'^[ \t]*#\[cfg\(target_os = "macos"\)\]\n[ \t]*(?:crate::)?watchdog::register_mac_process_failed\(',source,flags=re.M)
        assert len(gated)==1,relative
        assert source.count('register_mac_process_failed(')==1,relative

def test_wry_delegate_class_name_follows_the_locked_wry_version():
    # wry registers its delegate class under module_path + crate version. A wry update
    # renames the class, and the Mac hook would then only log a mismatch and never recover.
    lock=(ROOT/'src-tauri/Cargo.lock').read_text(encoding='utf-8')
    versions=re.findall(r'^name = "wry"\nversion = "([^"]+)"$',lock,flags=re.M)
    assert len(versions)==1,versions
    names=re.findall(r'WryNavigationDelegate([0-9][0-9A-Za-z.+-]*)"',WATCHDOG.read_text(encoding='utf-8'))
    assert names==versions,(names,versions)

def test_test_only_fault_injection_stays_out_of_shipped_builds():
    lib=(ROOT/'src-tauri/src/lib.rs').read_text(encoding='utf-8')
    assert '#[cfg(feature = "e2e")]\nmod e2e;' in lib
    e2e=(ROOT/'src-tauri/src/e2e.rs').read_text(encoding='utf-8')
    assert body(e2e,'dispatch').index('!crate::test_profile::is_active()')<body(e2e,'dispatch').index('"e2e.renderer"')
    injection=body(e2e,'renderer_action')
    assert '_webProcessIdentifier' in injection
    assert 'pid <= 1 || pid == std::process::id() as i32' in injection
    assert 'libc::kill(pid, libc::SIGKILL)' in injection
    features=(ROOT/'src-tauri/Cargo.toml').read_text(encoding='utf-8').split('\n[features]\n',1)[1].split('\n[',1)[0]
    assert re.search(r'^e2e = \[\]$',features,flags=re.M)
    default=re.search(r'^default\s*=\s*\[([^\]]*)\]',features,flags=re.M)
    assert default is None or 'e2e' not in default.group(1)

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
    assert "profile=f'{SEAT}-" in harness
    assert "['open', '-n', '-g'" in harness
    assert 'CGEventPost' not in harness and 'cliclick' not in harness
