"""Sequential full-suite validation under the mandatory shared S5 heavy-work lease."""
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from evidence_io import DEFAULT_DATA, dump

ROOT = Path(__file__).resolve().parents[3]
LOCK = Path.home() / ".claude/dispatch/261005-shared/heavy_lock.py"

def main():
    directory = DEFAULT_DATA / ("validation-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    directory.mkdir(parents=True, exist_ok=False)
    acquire = [sys.executable, "-X", "utf8", str(LOCK), "acquire", "--seat", "s5", "--what", "S5 tsc vitest pytest", "--minutes", "30", "--wait-minutes", "180"]
    result = subprocess.run(acquire)
    if result.returncode:
        dump(directory/"summary.json", {"status":"lease_unavailable", "returncode":result.returncode})
        return result.returncode
    results = []
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
    try:
        commands = [
            ("tsc", ["node", str(ROOT/"node_modules/typescript/bin/tsc"), "--noEmit"]),
            ("vitest", ["node", str(ROOT/"node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1"]),
            ("pytest", [sys.executable, "-X", "utf8", "-m", "pytest", "tests/", "-q", "-p", "no:cacheprovider"]),
        ]
        for name, command in commands:
            started = time.time()
            print("RUN " + name, flush=True)
            with (directory/(name+".log")).open("w",encoding="utf-8",newline="\n") as log:
                proc = subprocess.Popen(command,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding="utf-8",errors="replace")
                for line in proc.stdout:
                    log.write(line); log.flush()
                code = proc.wait()
            entry = {"name":name,"command":command,"exit_code":code,"elapsed_seconds":round(time.time()-started,3),"log":str(directory/(name+".log"))}
            results.append(entry); print(json.dumps(entry,ensure_ascii=True),flush=True)
            lines=(directory/(name+".log")).read_text(encoding="utf-8").splitlines()
            print("\n".join(lines[-12:]),flush=True)
        dump(directory/"summary.json",{"status":"passed" if all(r["exit_code"]==0 for r in results) else "failed","results":results})
        return 0 if all(r["exit_code"]==0 for r in results) else 1
    finally:
        subprocess.run([sys.executable,"-X","utf8",str(LOCK),"release","--seat","s5"],check=True)

if __name__ == "__main__": raise SystemExit(main())
