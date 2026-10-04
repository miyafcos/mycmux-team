"""M1-only remote commands; no shell interpolation of source or test text."""
from __future__ import annotations

import base64
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
match = re.fullmatch(r"mycmux-wt-(?:mac-)?([a-z0-9]+)-261003", ROOT.name)
assert match, ROOT
SEAT = match.group(1)
REMOTE = f"/Users/edu/Developer/mycmux-wt-mac-{SEAT}-261003"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "edumac-mini"]


def run(source: str) -> int:
    payload = base64.b64encode(source.encode("utf-8")).decode("ascii")
    command = 'python3 -c "import base64;exec(base64.b64decode(\'' + payload + '\'))"'
    return subprocess.run([*SSH, command]).returncode


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        sys.exit(run(f"""
from pathlib import Path
import subprocess
base = Path('/Users/edu/Developer/mycmux')
wt = Path({REMOTE!r})
rev = {subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()!r}
subprocess.run(['git', 'cat-file', '-e', rev], cwd=base, check=True)
if not wt.exists():
    subprocess.run(['git', 'worktree', 'add', '--detach', str(wt), rev], cwd=base, check=True)
subprocess.run(['git', 'status', '--short', '--branch'], cwd=wt, check=True)
print(subprocess.check_output(['ps', '-axo', 'pid,comm'], text=True).split('mycmux')[:1][0][-100:])
print(Path('/Users/edu/Developer/macq-e2e/build.sh').read_text())
"""))
    if sys.argv[1] == "spike":
        source = Path(__file__).with_name("mac_tearout_spike.swift").read_text(encoding="utf-8")
        sys.exit(run(f"""
from pathlib import Path
import subprocess
wt = Path({REMOTE!r})
out = wt / 'tmp' / 'tearout-{SEAT}'
out.mkdir(parents=True, exist_ok=True)
source = out / 'spike.swift'
source.write_text({source!r}, encoding='utf-8')
subprocess.run(['swiftc', str(source), '-o', str(out / 'spike')], cwd=wt, check=True)
p = subprocess.run(['/usr/bin/lockf', '-k', '-t', '7200', '/Users/edu/.mycmux-gui-e2e.lock', str(out / 'spike')], cwd=wt, capture_output=True, text=True, timeout=25)
(out / 'spike.log').write_text(p.stdout + p.stderr, encoding='utf-8')
print(p.stdout)
print(p.stderr[-3000:])
raise SystemExit(p.returncode)
"""))
    if sys.argv[1] == "script":
        sys.exit(run(Path(sys.argv[2]).read_text(encoding="utf-8")))
    raise SystemExit("expected prepare, spike or script <python-file>")
