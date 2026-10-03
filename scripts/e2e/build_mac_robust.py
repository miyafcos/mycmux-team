"""Build an isolated M2 test bundle; never signs or publishes."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tmp/robust-m2'
assert sys.platform == 'darwin'
assert str(ROOT) == '/Users/edu/Developer/mycmux-wt-mac-m2-261003'
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT)
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
OUT.mkdir(parents=True, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
config = {'identifier': 'com.miyazaki.mycmux.e2e.m2', 'bundle': {'createUpdaterArtifacts': False},
          'build': {'beforeBuildCommand': 'node node_modules/vite/bin/vite.js build --configLoader runner --emptyOutDir false'}}
env = {key: value for key, value in os.environ.items() if not key.startswith(('MYCMUX_', 'CLAUDE'))}
env['PATH'] = '/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/rustup/bin:' + str(Path.home() / '.cargo/bin') + ':/opt/homebrew/bin:' + env.get('PATH', '')
env.update(VITE_E2E='1', CARGO_BUILD_JOBS='2', CARGO_NET_OFFLINE='true',
           NODE_PATH='/Users/edu/Developer/mycmux/node_modules')
command = ['nice', '-n', '10', 'npm', 'run', 'tauri', '--', 'build', '--target', 'aarch64-apple-darwin',
           '--bundles', 'app', '--no-sign', '--features', 'e2e', '--config', json.dumps(config)]
log = OUT / f'build-{head[:8]}-{stamp}.log'
print('M2_BUILD', head, str(log), flush=True)
with log.open('wb') as stream:
    result = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
record = {'head': head, 'exit': result.returncode, 'command': command, 'log': str(log)}
if result.returncode == 0:
    source = ROOT / 'src-tauri/target/aarch64-apple-darwin/release/bundle/macos/mycmux.app'
    bundle = OUT / f'mycmux-m2-{head[:8]}-{stamp}.app'
    assert not bundle.exists()
    shutil.copytree(source, bundle, symlinks=True)
    record.update(bundle=str(bundle), binary_sha256=hashlib.sha256((bundle / 'Contents/MacOS/mycmux').read_bytes()).hexdigest(),
                  identifier=config['identifier'])
(OUT / f'build-{head[:8]}-{stamp}.json').write_text(json.dumps(record, indent=2)+'\n', encoding='utf-8')
print(json.dumps(record), flush=True)
if result.returncode:
    print(log.read_text(errors='replace')[-12000:])
raise SystemExit(result.returncode)
