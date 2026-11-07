"""pytest 用の import パス設定 (scripts/ 直下のモジュールを import 可能にする)."""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

# guard_classify calls load_bridge() at import time (test collection), before any fixture runs: bind the sibling
# bridge here so its parser is the one next to these scripts, not whatever BRIDGE_SCRIPT points at by default.
import dispatch_send as _dispatch_send  # noqa: E402
_dispatch_send.BRIDGE_SCRIPT = SCRIPTS_DIR.parents[1] / "mycmux-bridge/scripts/mycmux_bridge.py"
_dispatch_send.load_bridge.cache_clear()


import pytest
@pytest.fixture(autouse=True)
def copied_bridge_only(monkeypatch, tmp_path):
    import dispatch_send
    dispatch_send.load_bridge.cache_clear()
    monkeypatch.setattr(dispatch_send, "BRIDGE_SCRIPT",
                        SCRIPTS_DIR.parents[1] / "mycmux-bridge/scripts/mycmux_bridge.py")
    monkeypatch.setattr(dispatch_send, "transcript_mtime_for", lambda *_: None)
    monkeypatch.setenv("DISPATCH_GUARD_DIR", str(tmp_path / "guard"))
    yield
    dispatch_send.load_bridge.cache_clear()
