from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import tomllib

SOURCE = 'ef72c0672d5a3a78685e7eab9511f07ddcca8892'
TREE = 'e3ecd9d24c153471345dcdeef60d1945171510fc'

LOGGER = '''
struct CiWindowLogger;

impl log::Log for CiWindowLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Warn
            && ["tauri_runtime_wry", "wry", "tao"].iter().any(|prefix| metadata.target().starts_with(prefix))
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            crate::diag::log(&format!("[ci-window-runtime] {} {}: {}", record.level(), record.target(), record.args()));
        }
    }

    fn flush(&self) {}
}

static CI_WINDOW_LOGGER: CiWindowLogger = CiWindowLogger;

fn ci_window_diagnostic() -> bool {
    test_profile::name().is_some_and(|name| name.starts_with("ci0886_"))
        && std::env::var("CI_WINDOW_RUNTIME_DIAGNOSTIC").as_deref() == Ok("1")
}

'''


def patch_sources(payloads: dict[str, bytes]) -> dict[str, bytes]:
    contents = {name: payload.decode('utf-8') for name, payload in payloads.items()}
    manifest = contents['src-tauri/Cargo.toml']
    assert manifest.count('[dependencies]\n') == 1 and '\nlog = ' not in manifest
    contents['src-tauri/Cargo.toml'] = manifest.replace('[dependencies]\n', '[dependencies]\nlog = "=0.4.29"\n', 1)
    lock = contents['src-tauri/Cargo.lock']
    package = '\nname = "mycmux"\nversion = "0.88.6"\ndependencies = [\n'
    assert lock.count(package) == 1
    start = lock.index(package)
    end = lock.index('\n]\n', start)
    block = lock[start:end]
    assert block.count(' "libc",\n') == 1 and ' "log",' not in block
    contents['src-tauri/Cargo.lock'] = lock[:start] + block.replace(' "libc",\n', ' "libc",\n "log",\n', 1) + lock[end:]
    source = contents['src-tauri/src/lib.rs']
    marker = '#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {'
    assert source.count(marker) == 1
    source = source.replace(marker, LOGGER + marker, 1)
    marker = '    std::panic::set_hook(Box::new(|info| {'
    assert source.count(marker) == 1
    source = source.replace(marker, '''    if ci_window_diagnostic() {
        let installed = log::set_logger(&CI_WINDOW_LOGGER).is_ok();
        log::set_max_level(log::LevelFilter::Warn);
        crate::diag::log(&format!("[ci-window-runtime] logger_installed={installed}"));
    }
''' + marker, 1)
    marker = '    let application = tauri::Builder::default()'
    assert source.count(marker) == 1
    source = source.replace(marker, '''    let startup_context = tauri::generate_context!();
    if ci_window_diagnostic() {
        let configured = &startup_context.config().app.windows;
        crate::diag::log(&format!("[ci-window-runtime] configured_windows={}", configured.len()));
        for window in configured {
            crate::diag::log(&format!("[ci-window-runtime] configured label={} create={} visible={}", window.label, window.create, window.visible));
        }
    }
''' + marker, 1)
    marker = '            watchdog::main_webview_created();'
    assert source.count(marker) == 1
    source = source.replace(marker, marker + '''
            if ci_window_diagnostic() {
                crate::diag::log(&format!("[ci-window-runtime] setup windows={} webviews={} main_present={}", app.windows().len(), app.webviews().len(), app.get_webview_window("main").is_some()));
            }''', 1)
    marker = '.build(tauri::generate_context!())'
    assert source.count(marker) == 1
    contents['src-tauri/src/lib.rs'] = source.replace(marker, '.build(startup_context)', 1)
    before = tomllib.loads(lock)
    after = tomllib.loads(contents['src-tauri/Cargo.lock'])
    original_packages = [package for package in before['package'] if package['name'] != 'mycmux']
    changed_packages = [package for package in after['package'] if package['name'] != 'mycmux']
    assert original_packages == changed_packages
    old_app = next(package for package in before['package'] if package['name'] == 'mycmux')
    new_app = next(package for package in after['package'] if package['name'] == 'mycmux')
    assert set(new_app['dependencies']) - set(old_app['dependencies']) == {'log'}
    assert set(old_app['dependencies']) <= set(new_app['dependencies'])
    return {name: content.encode('utf-8') for name, content in contents.items()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    root = args.source.resolve()
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip() == SOURCE
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=root).decode().strip() == TREE
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=root).strip()
    assert not args.receipt.exists()
    names = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lib.rs']
    payloads = {name: (root / name).read_bytes() for name in names}
    patched = patch_sources(payloads)
    backup = root.parent / ('runtime-probe-originals-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(exist_ok=False)
    rows = []
    for name in names:
        retained = backup / name
        retained.parent.mkdir(parents=True, exist_ok=True)
        with retained.open('xb') as stream:
            stream.write(payloads[name])
        assert retained.read_bytes() == payloads[name]
        (root / name).write_bytes(patched[name])
        rows.append({'path': name, 'original_sha256': hashlib.sha256(payloads[name]).hexdigest(),
                     'diagnostic_sha256': hashlib.sha256(patched[name]).hexdigest()})
    changes = subprocess.check_output(['git', 'diff', 'HEAD', '--name-only'], cwd=root).decode().splitlines()
    assert set(changes) == set(names)
    record = {'at': datetime.now(timezone.utc).isoformat(), 'public_source': SOURCE, 'public_tree': TREE,
              'diagnostic_only': True, 'production_update': False, 'new_packages': [], 'files': rows}
    args.receipt.parent.mkdir(exist_ok=True)
    with args.receipt.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(json.dumps(record, indent=2) + '\n')
    print('DIAGNOSTIC_PATCH_VERIFIED', len(rows), 'NEW_PACKAGES', 0)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
