"""Build an S4-only test bundle on the Mac; never signs/publishes an updater."""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--user', action='store_true', help='Build without e2e hooks for a physical acceptance test')
args = parser.parse_args()
mode = 'touch' if args.user else 'e2e'
assert str(ROOT) == '/Users/edu/Developer/mycmux-wt-next-s4-261003', ROOT
assert sys.platform == 'darwin'
HEAD = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT, text=True).strip()
OUT = ROOT / 'tmp/tearout-s4'
OUT.mkdir(parents=True, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
config = {'identifier': 'com.miyazaki.mycmux.test.s4' if args.user else 'com.miyazaki.mycmux.e2e.s4', 'bundle': {'createUpdaterArtifacts': False},
          'build': {'beforeBuildCommand': 'node node_modules/vite/bin/vite.js build --configLoader runner --emptyOutDir false'}}
env = dict(os.environ)
env['PATH'] = '/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/rustup/bin:' + str(Path.home() / '.cargo/bin') + ':/opt/homebrew/bin:' + env.get('PATH', '')
if args.user:
    env.pop('VITE_E2E', None)
else:
    env['VITE_E2E'] = '1'
env['CARGO_BUILD_JOBS'] = '2'
env['CARGO_NET_OFFLINE'] = 'true'
env['NODE_PATH'] = '/Users/edu/Developer/mycmux/node_modules'
command = ['nice', '-n', '10', 'npm', 'run', 'tauri', '--', 'build', '--target', 'aarch64-apple-darwin',
           '--bundles', 'app', '--no-sign']
if not args.user:
    command += ['--features', 'e2e']
command += ['--config', json.dumps(config)]
log = OUT / f'build-{mode}-{stamp}.log'
print('MAC_' + mode.upper() + '_BUILD ' + HEAD + ' ' + str(log), flush=True)
with log.open('wb') as stream:
    process = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
result = {'head': HEAD, 'exit': process.returncode, 'command': command, 'log': str(log), 'mode': mode}
if process.returncode == 0:
    source = ROOT / 'src-tauri/target/aarch64-apple-darwin/release/bundle/macos/mycmux.app'
    bundle = OUT / f'mycmux-s4-{mode}-{HEAD[:8]}-{stamp}.app'
    assert not bundle.exists(), bundle
    shutil.copytree(source, bundle, symlinks=True)
    result['bundle'] = str(bundle)
    result['binary_sha256'] = hashlib.sha256((bundle / 'Contents/MacOS/mycmux').read_bytes()).hexdigest()
    result['identifier'] = config['identifier']
    result['code_signature'] = (bundle / 'Contents/_CodeSignature').is_dir()
result_path = OUT / f'build-{mode}-{stamp}.json'
result_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result), flush=True)
if process.returncode:
    print(log.read_text(errors='replace')[-9000:])
raise SystemExit(process.returncode)
