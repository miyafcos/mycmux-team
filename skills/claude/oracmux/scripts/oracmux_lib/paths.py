"""Filesystem and executable locations used by oracmux.

Everything that touches the outside world is resolved here so tests can
redirect it with environment variables:

- ORACMUX_HOME      : handoff root (default ~/.mycmux/handoff/oracmux)
- ORACLE_HOME_DIR   : oracle's own home (default ~/.oracle) — shared with the CLI/MCP
- MYCMUX_AGENT_CLI  : path to mycmux_agent_cli.py
- ORACMUX_ENGINES   : alternative engines.json (tests)
- ORACMUX_GUARD     : alternative guard.json (tests)
"""

from __future__ import annotations

import os
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = SKILL_DIR / "scripts"


def resolve_agent_cli() -> Path:
    import os
    import sys
    explicit = os.environ.get("MYCMUX_AGENT_CLI")
    candidates = [Path(explicit).expanduser()] if explicit else []
    candidates.append(Path.home() / ".mycmux" / "bin" / "mycmux_agent_cli.py")
    candidates.extend(parent / "scripts" / "mycmux_agent_cli.py"
                      for parent in Path(__file__).resolve().parents)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    print("mycmux agent CLI not found. From the mycmux checkout run: "
          "python scripts/install_claude_skills.py install", file=sys.stderr)
    raise SystemExit(7)



def home() -> Path:
    value = os.environ.get("ORACMUX_HOME")
    return Path(value) if value else Path.home() / ".mycmux" / "handoff" / "oracmux"


def ledger_path() -> Path:
    return home() / "ledger.jsonl"


def engines_json() -> Path:
    value = os.environ.get("ORACMUX_ENGINES")
    return Path(value) if value else SCRIPTS_DIR / "engines.json"


def guard_json() -> Path:
    value = os.environ.get("ORACMUX_GUARD")
    if value:
        return Path(value).expanduser()
    local = SCRIPTS_DIR / "guard.json"
    return local if local.exists() else SCRIPTS_DIR / "guard.example.json"


def oracle_home() -> Path:
    value = os.environ.get("ORACLE_HOME_DIR")
    return Path(value) if value else Path.home() / ".oracle"


def oracle_sessions_dir() -> Path:
    return oracle_home() / "sessions"


def oracle_chrome_ps1() -> Path:
    return oracle_home() / "oracle-chrome.ps1"


def oracle_cli_js() -> Path:
    """The oracle CLI entry, called through node directly.

    `oracle.cmd` goes through cmd.exe, whose quoting rules mangle `%`, `&` and
    friends; node + the JS entry takes argv verbatim.
    """
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "npm" / "node_modules" / "@steipete" / "oracle" / "dist" / "bin" / "oracle-cli.js"


def mycmux_cli() -> Path:
    return resolve_agent_cli()


def quick_html() -> Path:
    return Path.home() / ".claude" / "scripts" / "quick_html.py"


def in_mycmux() -> bool:
    return os.environ.get("MYCMUX_TERM_PROGRAM") == "mycmux"
