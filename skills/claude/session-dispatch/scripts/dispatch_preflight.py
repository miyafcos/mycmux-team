"""Prepare a new Claude cwd without modifying global settings or authenticating."""
from __future__ import annotations
import argparse
from copy import deepcopy
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

def normalized_cwd(cwd, projects):
    absolute = str(Path(cwd).resolve()).replace("\\", "/")
    if re.match(r"^[a-zA-Z]:", str(cwd)):
        absolute = ntpath.normpath(str(cwd)).replace("\\", "/")
    # Reuse an equivalent existing key rather than creating a duplicate.
    for key in projects:
        if key.replace("\\", "/").rstrip("/").casefold() == absolute.rstrip("/").casefold():
            return key
    if re.match(r"^[a-zA-Z]:", absolute):
        absolute = absolute[0].upper() + absolute[1:]
    return absolute.rstrip("/")

def prepare_project(config_path, cwd, *, before_reload=None):
    """Read, backup, re-read/merge, atomic replace, verify; preserve unrelated values."""
    config_path = Path(config_path)
    initial_raw = config_path.read_bytes() if config_path.exists() else b"{}"
    initial = json.loads(initial_raw.decode("utf-8-sig"))
    if not isinstance(initial, dict) or not isinstance(initial.get("projects", {}), dict):
        raise ValueError("Invalid Claude project configuration")
    backup = config_path.with_name(config_path.name + ".bak-guard")
    backup.write_bytes(initial_raw)
    if before_reload:
        before_reload()
    # Claude can write while preflight is running. Apply only the two desired fields to this latest read.
    latest_raw = config_path.read_bytes() if config_path.exists() else b"{}"
    latest = json.loads(latest_raw.decode("utf-8-sig"))
    desired = deepcopy(latest)
    projects = desired.setdefault("projects", {})
    key = normalized_cwd(cwd, projects)
    entry = projects.setdefault(key, {})
    if not isinstance(entry, dict) or not isinstance(entry.get("enabledMcpjsonServers", []), list):
        raise ValueError("Invalid project entry")
    previous = deepcopy(entry)
    entry["hasTrustDialogAccepted"] = True
    servers = entry.setdefault("enabledMcpjsonServers", [])
    for server in ("oracle", "deepwiki"):
        if server not in servers:
            servers.append(server)
    if desired != latest:
        fd, tmp = tempfile.mkstemp(prefix=".claude-guard-", suffix=".tmp", dir=config_path.parent)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(desired, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        assert "\ufffd" not in Path(tmp).read_text(encoding="utf-8")
        os.replace(tmp, config_path)
    verified = json.loads(config_path.read_text(encoding="utf-8-sig"))
    if verified != desired:
        raise RuntimeError("Configuration changed during post-write verification")
    # Report only the owned settings, never the root configuration or unrelated project content.
    return {"key": key, "backup": str(backup), "changed": previous != entry,
            "diff": {name: {"before": previous.get(name), "after": entry[name]}
                     for name in ("hasTrustDialogAccepted", "enabledMcpjsonServers")
                     if previous.get(name) != entry[name]},
            "unrelated_values_preserved": True,
            "before_sha256": hashlib.sha256(latest_raw).hexdigest(),
            "after_sha256": hashlib.sha256(config_path.read_bytes()).hexdigest()}

def doctor_routes(output):
    routes = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[1] in {"ok", "dead", "error", "failed", "warn", "unavailable"}:
            routes[fields[0]] = fields[1]
    return routes

def required_routes(spec):
    required = set()
    if re.search(r"Gmail|gws", spec, re.I):
        required.add("google_gws")
    if re.search(r"Slack", spec, re.I):
        required.add("slack")
    if re.search(r"mcp__claude_ai|OAuth", spec, re.I):
        required.add("local_mcp_tokens")
    return required

def preflight(cwd, *, spec=None, home=None, doctor_fn=None, ensure_fn=None):
    home = Path(home or Path.home())
    warnings = []
    project = None
    try:
        project = prepare_project(home / ".claude.json", cwd)
    except (OSError, ValueError, RuntimeError) as exc:
        warnings.append("Project pre-approval failed: " + type(exc).__name__)
    try:
        settings = json.loads((home / ".claude" / "settings.json").read_text(encoding="utf-8"))
        for key in ("enableAllProjectMcpServers", "skipAutoPermissionPrompt"):
            if settings.get(key) is not True:
                warnings.append(key + " is not true; settings were not changed")
    except (OSError, ValueError):
        warnings.append("settings.json could not be checked")
    if doctor_fn is None:
        def doctor_fn():
            proc = subprocess.run([sys.executable, "-X", "utf8",
                str(home / ".claude" / "scripts" / "svc.py"), "doctor"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
            return proc.returncode, proc.stdout
    try:
        code, output = doctor_fn()
        routes = doctor_routes(output)
    except (OSError, subprocess.TimeoutExpired):
        code, routes = 1, {}
    text = Path(spec).read_text(encoding="utf-8") if spec else ""
    required = required_routes(text)
    dead = sorted(name for name in required if routes.get(name) != "ok")
    if code and not dead:
        warnings.append("svc doctor reported unavailable services")
    if ensure_fn is None:
        from dispatch_guard import ensure
        ensure_fn = ensure
    guard = ensure_fn()
    if not guard.get("alive"):
        warnings.append("Guard startup is not yet confirmed")
    return {"ok": not dead, "exit_code": 3 if dead else 0,
            "project": project, "routes": routes, "required_routes": sorted(required),
            "blocked_routes": dead, "guard": guard, "warnings": warnings}

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run",))
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--spec")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result = preflight(args.cwd, spec=args.spec)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result["exit_code"]

if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
