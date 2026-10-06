"""Seat-local evidence; no production-log reads or delivery aggregation."""
import datetime as dt
import json
from pathlib import Path

DEFAULT_DATA = Path.home() / ".claude/dispatch/261005-mycmux-pane-ops/s5/evidence"

def dump(path, value):
    text = json.dumps(value, ensure_ascii=True, indent=2) + "\n"
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() != text.encode("utf-8"):
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup = path.with_name(path.name + ".before-" + stamp)
        backup.write_bytes(path.read_bytes())
    path.write_bytes(text.encode("utf-8"))
    assert path.read_text(encoding="utf-8") == text and "\ufffd" not in text
