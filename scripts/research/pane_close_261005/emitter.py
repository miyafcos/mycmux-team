"""Small PTY fixture with an independently recorded monotonic counter."""
import argparse
import os
from pathlib import Path
import time

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--counter", type=Path, required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    args.counter.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    while True:
        n += 1
        args.counter.write_text(str(n), encoding="ascii")
        print(f"\x1b[2J\x1b[H{args.label} PID={os.getpid()} SEQ={n}\nS4 isolated test fixture\n", end="", flush=True)
        time.sleep(.25)
