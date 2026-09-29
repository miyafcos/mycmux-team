"""pytest import path + isolated homes for oracmux tests."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    """Redirect every filesystem side effect into tmp_path."""
    home = tmp_path / "oracmux-home"
    oracle_home = tmp_path / "oracle-home"
    (oracle_home / "sessions").mkdir(parents=True)
    monkeypatch.setenv("ORACMUX_HOME", str(home))
    monkeypatch.setenv("ORACLE_HOME_DIR", str(oracle_home))
    monkeypatch.delenv("MYCMUX_TERM_PROGRAM", raising=False)
    monkeypatch.setenv("MYCMUX_AGENT_CLI", str(tmp_path / "mycmux_agent_cli.py"))
    (tmp_path / "mycmux_agent_cli.py").touch()
    return home
