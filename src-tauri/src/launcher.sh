#!/bin/bash
# Terminal launcher - arrow keys, j/k, or number keys
# Called from .bashrc

__MYCMUX_UNAME="$(uname -s 2>/dev/null || echo "")"
case "${MSYSTEM:-}:$__MYCMUX_UNAME" in
  *MINGW*|*MSYS*|*CYGWIN*) __MYCMUX_PLATFORM=windows ;;
  *:Darwin) __MYCMUX_PLATFORM=macos ;;
  *:Linux) __MYCMUX_PLATFORM=linux ;;
  *) __MYCMUX_PLATFORM=other ;;
esac

__mycmux_is_windows_shell() {
  [ "$__MYCMUX_PLATFORM" = "windows" ]
}

__mycmux_python() {
  local candidate
  if __mycmux_is_windows_shell; then
    for candidate in python python3; do
      command -v "$candidate" >/dev/null 2>&1 && { command -v "$candidate"; return 0; }
    done
  else
    for candidate in python3 python; do
      command -v "$candidate" >/dev/null 2>&1 && { command -v "$candidate"; return 0; }
    done
  fi
  return 1
}

__mycmux_lower_ascii_into() {
  local value="$1"
  value="${value//A/a}"
  value="${value//B/b}"
  value="${value//C/c}"
  value="${value//D/d}"
  value="${value//E/e}"
  value="${value//F/f}"
  value="${value//G/g}"
  value="${value//H/h}"
  value="${value//I/i}"
  value="${value//J/j}"
  value="${value//K/k}"
  value="${value//L/l}"
  value="${value//M/m}"
  value="${value//N/n}"
  value="${value//O/o}"
  value="${value//P/p}"
  value="${value//Q/q}"
  value="${value//R/r}"
  value="${value//S/s}"
  value="${value//T/t}"
  value="${value//U/u}"
  value="${value//V/v}"
  value="${value//W/w}"
  value="${value//X/x}"
  value="${value//Y/y}"
  value="${value//Z/z}"
  __MYCMUX_LOWER_RESULT="$value"
}

__mycmux_read_key_with_timeout() {
  local __mycmux_out_var="$1"
  local __mycmux_timeout="$2"
  local __mycmux_key
  local __mycmux_status
  if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
    IFS= read -rsn1 -t "$__mycmux_timeout" -u "$__CMUX_MENU_FD" __mycmux_key
  else
    IFS= read -rsn1 -t 1 -u "$__CMUX_MENU_FD" __mycmux_key
  fi
  __mycmux_status=$?
  printf -v "$__mycmux_out_var" '%s' "$__mycmux_key"
  return "$__mycmux_status"
}

# MSYS bash severs the Windows process ancestry when it runs a shebang-script
# wrapper as an external command (the fork copy that execs the interpreter
# dies), so agents launched via ~/bin/claude etc. are orphaned from the pane
# shell and invisible to the Rust monitor's descendant scan (agent badge,
# savepoint button, mapping retention). Direct .cmd/.exe children keep an
# intact chain, so route the agent commands to their .cmd shims and export
# the functions for the interactive shell that replaces the launcher.
__mycmux_issue_hook_cap() {
  local provider="$1"
  local python
  [ -n "${MYCMUX_PANE_SESSION_ID:-}" ] || return 1
  python="$(__mycmux_python)" || return 1
  MYCMUX_HOOK_PROVIDER="$provider" "$python" - <<'PY' 2>/dev/null
import json
import os
import socket
from pathlib import Path

runtime = Path(os.environ.get("MYCMUX_RUNTIME_DIR") or (Path.home() / ".mycmux"))
try:
    port = int((runtime / "mycmux.port").read_text(encoding="utf-8").strip())
    token = (runtime / "mycmux.token").read_text(encoding="utf-8").strip()
    request = {
        "token": token,
        "cmd": "launch.issue_hook_cap",
        "args": {
            "terminal_session_id": os.environ["MYCMUX_PANE_SESSION_ID"],
            "provider": os.environ["MYCMUX_HOOK_PROVIDER"],
        },
    }
    with socket.create_connection(("127.0.0.1", port), timeout=0.4) as client:
        client.sendall(json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n")
        client.settimeout(0.4)
        raw = b""
        while b"\n" not in raw and len(raw) <= 1048576:
            chunk = client.recv(4096)
            if not chunk:
                break
            raw += chunk
    response = json.loads(raw.split(b"\n", 1)[0])
    capability = response.get("result", {}).get("hook_cap")
    if not isinstance(capability, str) or not capability:
        raise ValueError("capability was not issued")
    print(capability, end="")
except (OSError, ValueError, KeyError, json.JSONDecodeError):
    raise SystemExit(1)
PY
}

__mycmux_with_hook_cap() {
  local provider="$1"
  shift
  local capability=""
  capability="$(__mycmux_issue_hook_cap "$provider")" || capability=""
  if [ -n "$capability" ]; then
    MYCMUX_HOOK_CAP="$capability" "$@"
  else
    env -u MYCMUX_HOOK_CAP "$@"
  fi
}

# The .cmd shims keep the Windows process ancestry intact, but they do not
# exist on macOS or Linux, where the agents live on PATH instead.
if __mycmux_is_windows_shell; then
  claude() { __mycmux_with_hook_cap claude "$HOME/bin/claude.cmd" "$@"; }
  claude-codex() { __mycmux_with_hook_cap claude "$HOME/bin/claude-codex.cmd" "$@"; }
  codex() { __mycmux_with_hook_cap codex "$APPDATA/npm/codex.cmd" "$@"; }
else
  claude() {
    local executable
    executable="$(type -P claude 2>/dev/null)" || return 127
    __mycmux_with_hook_cap claude "$executable" "$@"
  }
  claude-codex() {
    local executable
    executable="$(type -P claude-codex 2>/dev/null)" || return 127
    __mycmux_with_hook_cap claude "$executable" "$@"
  }
  codex() {
    local executable
    executable="$(type -P codex 2>/dev/null)" || return 127
    __mycmux_with_hook_cap codex "$executable" "$@"
  }
fi
grok() {
  local executable
  executable="$(type -P grok 2>/dev/null)" || return 127
  __mycmux_with_hook_cap grok "$executable" "$@"
}
export -f __mycmux_issue_hook_cap __mycmux_with_hook_cap claude claude-codex codex grok

if [ "${MYCMUX_HOOK_WRAPPERS_ONLY:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

__write_session_mapping() {
  local pane_id="$1"
  local kind="$2"
  local session_id="$3"
  local mapping_id="$pane_id"
  if [[ "${MYCMUX_TAB_ID:-}" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    mapping_id="$MYCMUX_TAB_ID"
  fi
  [ -z "$mapping_id" ] || [ -z "$session_id" ] && return
  local runtime_dir="${MYCMUX_RUNTIME_DIR:-$HOME/.mycmux}"
  local map_dir="$runtime_dir/pane-sessions"
  mkdir -p "$map_dir" 2>/dev/null
  if [ -n "$kind" ]; then
    echo "$kind:$session_id" > "$map_dir/$mapping_id.txt"
  else
    echo "$session_id" > "$map_dir/$mapping_id.txt"
  fi
}

__claude_project_key() {
  local path="$1"
  local python
  python="$(__mycmux_python)" || return 1
  PYTHONIOENCODING=utf-8 MYCMUX_CLAUDE_PROJECT_PATH="$path" "$python" - <<'PY' 2>/dev/null
import os
import re

path = os.environ.get("MYCMUX_CLAUDE_PROJECT_PATH", "").rstrip("/\\")
if re.match(r"^/[a-zA-Z]/", path):
    path = f"{path[1].upper()}:{path[2:]}"
print(re.sub(r"[^A-Za-z0-9-]", "-", path), end="")
PY
}

__get_claude_project_dir() {
  local mangled
  mangled="$(__claude_project_key "$(pwd)")"
  echo "$HOME/.claude/projects/$mangled"
}

__find_claude_session_file() {
  local session_id="$1"
  local python
  [[ "$session_id" =~ ^[0-9a-fA-F-]{36}$ ]] || return 1
  local root="$HOME/.claude/projects"
  [ -d "$root" ] || return 1
  python="$(__mycmux_python)" || return 1
  PYTHONIOENCODING=utf-8 MYCMUX_CLAUDE_PROJECTS_ROOT="$root" MYCMUX_CLAUDE_SESSION_ID="$session_id" "$python" - <<'PY' 2>/dev/null
import os
from pathlib import Path

root = Path(os.environ.get("MYCMUX_CLAUDE_PROJECTS_ROOT", ""))
session_id = os.environ.get("MYCMUX_CLAUDE_SESSION_ID", "")
candidates = []
try:
    for project_dir in root.iterdir():
        candidate = project_dir / f"{session_id}.jsonl"
        if not project_dir.is_dir() or not candidate.is_file():
            continue
        stat = candidate.stat()
        candidates.append((stat.st_mtime_ns, stat.st_size, str(candidate)))
except OSError:
    pass
if candidates:
    print(max(candidates)[2])
else:
    raise SystemExit(1)
PY
}

__claude_session_cwd() {
  local session_file="$1"
  local python
  python="$(__mycmux_python)" || return 1
  PYTHONIOENCODING=utf-8 MYCMUX_CLAUDE_SESSION_FILE="$session_file" "$python" - <<'PY' 2>/dev/null
import json
import os
import re
from pathlib import Path

path = os.environ.get("MYCMUX_CLAUDE_SESSION_FILE", "")
project_key = Path(path).parent.name

def claude_project_key(cwd):
    cwd = cwd.rstrip("/\\")
    if re.match(r"^/[a-zA-Z]/", cwd):
        cwd = f"{cwd[1].upper()}:{cwd[2:]}"
    return re.sub(r"[^A-Za-z0-9-]", "-", cwd)

try:
    with open(path, "r", encoding="utf-8-sig") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except (TypeError, ValueError):
                continue
            cwd = value.get("cwd")
            if isinstance(cwd, str) and cwd.strip() and claude_project_key(cwd) == project_key:
                print(cwd)
                break
except OSError:
    pass
PY
}

__prepare_claude_resume() {
  local session_id="$1"
  local session_file
  session_file="$(__find_claude_session_file "$session_id")" || return 1
  local session_cwd
  session_cwd="$(__claude_session_cwd "$session_file")"
  if __mycmux_is_windows_shell && [[ "$session_cwd" =~ ^([a-zA-Z]):[\\/](.*)$ ]]; then
    local drive
    __mycmux_lower_ascii_into "${BASH_REMATCH[1]}"
    drive="$__MYCMUX_LOWER_RESULT"
    local rest="${BASH_REMATCH[2]//\\//}"
    session_cwd="/$drive/$rest"
  fi
  [ -d "$session_cwd" ] || return 1
  cd "$session_cwd" 2>/dev/null || return 1
  local current_project_dir
  current_project_dir="$(__get_claude_project_dir)"
  [ -f "$current_project_dir/$session_id.jsonl" ]
}

__get_claude_codex_project_dir() {
  local mangled
  mangled="$(__claude_project_key "$(pwd)")"
  echo "$HOME/.claude-codex/config/projects/$mangled"
}

# Print one unclaimed candidate under $1 matching name pattern $2 only when it
# was written at or after epoch $3, its recorded CWD matches $6, and no other
# pane already maps that session id. $4 caps the search depth (empty = recursive).
# Session trackers guess which log belongs to the pane they just launched; a
# file that predates the launch cannot be that log, and attributing it would
# bind the pane to somebody else's session. No mapping is safer than a wrong or
# ambiguous one, so zero or multiple candidates yield nothing.
__single_unclaimed_session_since() {
  local dir="$1"
  local pattern="$2"
  local since="$3"
  local depth="$4"
  local pane_id="$5"
  local kind="$6"
  local launch_cwd="$7"
  local runtime_dir="${MYCMUX_RUNTIME_DIR:-$HOME/.mycmux}"
  local python
  python="$(__mycmux_python)" || return 1
  PYTHONIOENCODING=utf-8 MYCMUX_TRACK_DIR="$dir" MYCMUX_TRACK_PATTERN="$pattern" MYCMUX_TRACK_SINCE="$since" MYCMUX_TRACK_DEPTH="$depth" MYCMUX_TRACK_PANE_ID="$pane_id" MYCMUX_TRACK_KIND="$kind" MYCMUX_TRACK_CWD="$launch_cwd" MYCMUX_TRACK_RUNTIME_DIR="$runtime_dir" "$python" - <<'PY' 2>/dev/null
import json
import os
import re
from pathlib import Path

def normalize_cwd(value):
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    if re.match(r"^/[A-Za-z]/", value):
        value = f"{value[1].upper()}:{value[2:]}"
    try:
        value = os.path.realpath(value)
    except OSError:
        pass
    value = value.replace("/", "\\").rstrip("\\/")
    return value.lower()

root = Path(os.environ["MYCMUX_TRACK_DIR"])
pattern = os.environ["MYCMUX_TRACK_PATTERN"]
depth = os.environ["MYCMUX_TRACK_DEPTH"]
try:
    since = float(os.environ["MYCMUX_TRACK_SINCE"])
except (TypeError, ValueError):
    raise SystemExit
pane_id = os.environ["MYCMUX_TRACK_PANE_ID"]
kind = os.environ["MYCMUX_TRACK_KIND"]
expected_cwd = normalize_cwd(os.environ["MYCMUX_TRACK_CWD"])
if not expected_cwd:
    raise SystemExit

try:
    paths = root.rglob(pattern) if not depth else root.glob(pattern)
    files = [path for path in paths if path.is_file() and path.stat().st_mtime >= since]
except OSError:
    raise SystemExit

claimed = set()
map_dir = Path(os.environ["MYCMUX_TRACK_RUNTIME_DIR"]) / "pane-sessions"
try:
    for mapping_file in map_dir.glob("*.txt"):
        if mapping_file.stem == pane_id:
            continue
        match = re.match(r"^(?:claude|codex|claude-codex):(.+?)\s*$", mapping_file.read_text(encoding="utf-8-sig"))
        if match:
            claimed.add(match.group(1))
except OSError:
    pass

candidates = []
for path in files:
    cwd = None
    try:
        with path.open(encoding="utf-8-sig") as handle:
            if kind == "codex":
                try:
                    cwd = (json.loads(next(handle)).get("payload") or {}).get("cwd")
                except (StopIteration, TypeError, ValueError):
                    continue
            else:
                for index, line in enumerate(handle):
                    if index >= 32:
                        break
                    try:
                        value = json.loads(line)
                    except (TypeError, ValueError):
                        continue
                    cwd = value.get("cwd")
                    if cwd:
                        break
    except OSError:
        continue
    if normalize_cwd(cwd) != expected_cwd:
        continue
    if kind == "codex":
        match = re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", path.stem)
        session_id = match.group(0) if match else None
    else:
        session_id = path.stem
    if session_id and session_id not in claimed:
        candidates.append(session_id)

if len(candidates) == 1:
    print(candidates[0])
PY
}

# Wait for the log of the pane that was just launched, bounded.
#
# A single fixed 4s wait was wrong in both directions: it expired while the user
# was still choosing in the `--resume` picker (the session file did not exist
# yet, so no mapping was ever written and the pane's chat column stayed empty),
# and it waited the full 4s even when the log had already appeared. Poll
# instead: stop at the first tick where exactly one unclaimed candidate exists,
# and give up at the timeout so a backgrounded tracker can never linger. The
# "exactly one" rule is not relaxed — a wrong mapping is worse than none — and
# `$since` still rejects every log that predates the launch.
#
# Overridable through the environment so the contract test can drive the loop
# without waiting minutes; the launcher itself never sets them.
__poll_single_unclaimed_session() {
  local dir="$1" pattern="$2" since="$3" depth="$4" pane_id="$5" kind="$6" launch_cwd="$7"
  local interval="${__MYCMUX_TRACK_INTERVAL:-2}"
  local timeout="${__MYCMUX_TRACK_TIMEOUT:-120}"
  # The launcher inherits the pane's environment, so both values are validated
  # here: a non-numeric override would make the bound test below error out and
  # turn this into the unbounded wait it exists to prevent.
  case "$interval" in ''|*[!0-9]*) interval=2 ;; esac
  [ "$interval" -lt 1 ] && interval=1
  case "$timeout" in ''|*[!0-9]*) timeout=120 ;; esac
  local waited=0 session_id=""
  while :; do
    sleep "$interval"
    waited=$((waited + interval))
    session_id=$(__single_unclaimed_session_since "$dir" "$pattern" "$since" "$depth" "$pane_id" "$kind" "$launch_cwd")
    if [ -n "$session_id" ]; then
      printf '%s\n' "$session_id"
      return 0
    fi
    if [ "$waited" -ge "$timeout" ]; then
      return 1
    fi
  done
}

__track_latest_jsonl_in_dir() {
  local pane_id="$1"
  local project_dir="$2"
  local kind="$3"
  [ -z "$pane_id" ] && return
  [ ! -d "$project_dir" ] && return

  local started_at
  started_at=$(date +%s)
  local launch_cwd
  launch_cwd="$(pwd)"
  local session_id
  session_id=$(__poll_single_unclaimed_session "$project_dir" '*.jsonl' "$started_at" 1 "$pane_id" "$kind" "$launch_cwd")
  if [ -n "$session_id" ]; then
    __write_session_mapping "$pane_id" "$kind" "$session_id"
  fi
}

__track_claude_session() {
  __track_latest_jsonl_in_dir "$1" "$(__get_claude_project_dir)" "claude"
}

__track_claude_codex_session() {
  __track_latest_jsonl_in_dir "$1" "$(__get_claude_codex_project_dir)" "claude-codex"
}

__track_codex_session() {
  local pane_id="$1"
  [ -z "$pane_id" ] && return

  local sessions_dir="$HOME/.codex/sessions"
  [ ! -d "$sessions_dir" ] && return

  local started_at
  started_at=$(date +%s)
  local launch_cwd
  launch_cwd="$(pwd)"
  local session_id
  session_id=$(__poll_single_unclaimed_session "$sessions_dir" 'rollout-*.jsonl' "$started_at" "" "$pane_id" "codex" "$launch_cwd")
  if [ -n "$session_id" ]; then
    __write_session_mapping "$pane_id" "codex" "$session_id"
  fi
}

__track_command_session() {
  local cmd="$1"
  local pane_id="$2"
  [ -z "$pane_id" ] && return

  if [[ "$cmd" == *"claude-codex"* ]]; then
    __track_claude_codex_session "$pane_id" &
  elif [[ "$cmd" == *"claude"* ]]; then
    # A command that already carries --session-id owns its mapping; a follow-up
    # tracker would overwrite it with whatever jsonl happened to be newest.
    # Mirrors the guard in launcher.ps1 Start-MycmuxCommandSessionTracking.
    case " $cmd " in
      *" --session-id "*|*" --session-id="*) return ;;
    esac
    __track_claude_session "$pane_id" &
  elif [[ "$cmd" == grok || "$cmd" == grok\ * ]]; then
    # Grok receives an explicit id before launch; its log format is not tracked here.
    return
  elif [[ "$cmd" == *"codex"* ]]; then
    __track_codex_session "$pane_id" &
  fi
}

__make_uuid() {
  local python
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    python="$(__mycmux_python)" || return 1
    "$python" - <<'PY' 2>/dev/null
import uuid
print(uuid.uuid4())
PY
  fi
}

__stable_new_session_id() {
  local project_dir="${1:-}"
  local candidate
  if [ -n "$MYCMUX_TAB_ID" ]; then
    candidate="$MYCMUX_TAB_ID"
    if [ -z "$project_dir" ] || [ ! -e "$project_dir/$candidate.jsonl" ]; then
      echo "$candidate"
      return
    fi
  fi

  while true; do
    candidate="$(__make_uuid)" || return
    [ -z "$candidate" ] && return
    [ -n "$project_dir" ] && [ -e "$project_dir/$candidate.jsonl" ] && continue
    echo "$candidate"
    return
  done
}

__claude_needs_new_session_id() {
  local cmd="$1"
  case "$cmd" in
    claude|claude\ *) ;;
    *) return 1 ;;
  esac

  case " $cmd " in
    *" --resume "*|*" --resume="*|*" --continue "*|*" --continue="*|*" --session-id "*|*" --session-id="*|*" -r "*|*" -r="*)
      return 1
      ;;
  esac

  return 0
}

# Grok stores one directory per conversation under a percent-encoded cwd bucket:
# ~/.grok/sessions/C%3A%5CUsers%5C.../<session-id>/. Reusing an id that already
# has a directory makes grok exit immediately with "Session ID is already in
# use", so an id has to be checked against every bucket before it is handed over.
__grok_session_id_taken() {
  local id="$1" bucket
  local root="$HOME/.grok/sessions"
  [ -n "$id" ] || return 0
  [ -d "$root" ] || return 1
  for bucket in "$root"/*; do
    [ -d "$bucket/$id" ] && return 0
  done
  return 1
}

# MYCMUX_TAB_ID is stable for the lifetime of a tab, so relaunching grok in the
# same tab would collide with the first launch. Fall back to fresh UUIDs then.
__grok_new_session_id() {
  local candidate
  if [ -n "${MYCMUX_TAB_ID:-}" ] && ! __grok_session_id_taken "$MYCMUX_TAB_ID"; then
    echo "$MYCMUX_TAB_ID"
    return
  fi
  while true; do
    candidate="$(__make_uuid)" || return
    [ -z "$candidate" ] && return
    __grok_session_id_taken "$candidate" && continue
    echo "$candidate"
    return
  done
}

__grok_needs_new_session_id() {
  local cmd="$1"
  case "$cmd" in
    grok|grok\ *) ;;
    *) return 1 ;;
  esac

  case " $cmd " in
    *" --resume "*|*" --resume="*|*" --continue "*|*" --continue="*|*" --session-id "*|*" --session-id="*|*" -r "*|*" -r="*|*" -c "*|*" -c="*|*" -s "*|*" -s="*)
      return 1
      ;;
  esac

  return 0
}

__trust_claude_cwd() {
  [ "$MYCMUX_DISABLE_CLAUDE_AUTO_TRUST" = "1" ] && return
  local cwd python
  cwd="$(pwd -W 2>/dev/null || pwd)"
  cwd="${cwd//\\//}"
  cwd="${cwd%/}"
  [ -z "$cwd" ] && return
  python="$(__mycmux_python)" || return 1
  MYCMUX_CLAUDE_TRUST_CWD="$cwd" "$python" - <<'PY' 2>/dev/null
import json
import os
from pathlib import Path

cwd = os.environ.get("MYCMUX_CLAUDE_TRUST_CWD", "").replace("\\", "/").rstrip("/")
home = Path.home()
path = home / ".claude.json"
if not cwd or not path.exists():
    raise SystemExit(0)

with path.open("r", encoding="utf-8") as f:
    data = json.load(f)

projects = data.setdefault("projects", {})
project = projects.setdefault(cwd, {
    "allowedTools": [],
    "mcpContextUris": [],
    "mcpServers": {},
    "enabledMcpjsonServers": [],
    "disabledMcpjsonServers": [],
    "hasTrustDialogAccepted": True,
    "projectOnboardingSeenCount": 0,
    "hasClaudeMdExternalIncludesApproved": False,
    "hasClaudeMdExternalIncludesWarningShown": False,
    "exampleFiles": [],
})
if project.get("hasTrustDialogAccepted") is True:
    raise SystemExit(0)

project["hasTrustDialogAccepted"] = True
tmp_path = path.with_suffix(".json.mycmux.tmp")
with tmp_path.open("w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp_path, path)
PY
}

__open_menu_fd() {
  if [ -n "${__CMUX_MENU_FD:-}" ]; then
    return
  fi
  # Opening /dev/tty as a second descriptor breaks Grok Build's TUI: after the
  # menu has done it, grok starts and runs normally (MCP up, session created,
  # slash commands advertised) but never paints a single frame, and the pane
  # sits on "Starting..." forever. Closing the descriptor again before launching
  # does not undo it — under MSYS the damage is done by the open itself, and it
  # outlives the menu, so even typing `grok` at the shell afterwards stays blank.
  # Claude and Codex are unaffected, which is why this went unnoticed until Grok
  # was added. stdin is the pane's console in every mycmux pane, so read it
  # directly and keep /dev/tty out of the picture.
  __CMUX_MENU_FD=0
}

# メニュー用の1入力イベント読み取り (キーボード専用)。
# 結果: __MENU_EVENT = eof/up/down/enter/quit/esc/slash/dirkey/ankenkey/digit/none
#       __MENU_DIGIT (digit時)
__read_menu_event() {
  __MENU_EVENT=none; __MENU_DIGIT=""
  local key k2 k3
  if ! IFS= read -rsn1 -u "$__CMUX_MENU_FD" key; then
    __MENU_EVENT=eof; return
  fi
  case "$key" in
    $'\x1b')
      # 続きが 0.1s 来なければ Esc 単押し (矢印キーは ESC [ ... が即続く)
      if ! __mycmux_read_key_with_timeout k2 0.1; then
        __MENU_EVENT=esc; return
      fi
      __mycmux_read_key_with_timeout k3 0.1 || return
      case "${k2}${k3}" in
        '[A'|'OA') __MENU_EVENT=up ;;
        '[B'|'OB') __MENU_EVENT=down ;;
        '[C'|'OC') __MENU_EVENT=right ;;
      esac
      ;;
    k|K) __MENU_EVENT=up ;;
    j|J) __MENU_EVENT=down ;;
    '') __MENU_EVENT=enter ;;
    q|Q) __MENU_EVENT=quit ;;
    /) __MENU_EVENT=slash ;;
    d|D) __MENU_EVENT=dirkey ;;
    a|A) __MENU_EVENT=ankenkey ;;
    m|M) __MENU_EVENT=right ;;
    [0-9]) __MENU_EVENT=digit; __MENU_DIGIT="$key" ;;
  esac
}

__prompt_custom_command() {
  __open_menu_fd
  printf "\033[H\033[2J" >&$__CMUX_MENU_FD
  echo "  Command: (e.g. claude --resume sid:xxx, codex resume --last)" >&$__CMUX_MENU_FD
  echo "" >&$__CMUX_MENU_FD
  printf "  > " >&$__CMUX_MENU_FD
  IFS= read -ru "$__CMUX_MENU_FD" cmd
}

__ensure_fugu_env() {
  [ -n "${FUGU_API_KEY:-}" ] && return
  if command -v powershell.exe >/dev/null 2>&1; then
    local value
    value=$(powershell.exe -NoLogo -NoProfile -Command "[Environment]::GetEnvironmentVariable('FUGU_API_KEY', 'User')" 2>/dev/null | tr -d '\r')
    if [ -n "$value" ]; then
      export FUGU_API_KEY="$value"
    fi
  fi
}

cmd=""

if [ -n "$MYCMUX_HANDOFF" ]; then
  __handoff_file="$MYCMUX_HANDOFF_PROMPT_FILE"
  __bootstrap="Handoff from previous session. Read \"${__handoff_file}\" and continue from where it left off."
  # A handoff pane starts a brand new agent session; it must get its own id the
  # same way the normal launch path does. Writing the *source* pane id here (the
  # old "<kind>-handoff:<pane>" mapping) left the pane with no real session id,
  # so restore fell back to `--continue` and adopted another tab's conversation
  # in the same cwd.
  case "$MYCMUX_HANDOFF" in
    claude)
      __handoff_project_dir="$(__get_claude_project_dir)"
      __handoff_sid="$(__stable_new_session_id "$__handoff_project_dir")"
      if [ -n "$__handoff_sid" ]; then
        __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude" "$__handoff_sid"
        claude --session-id "$__handoff_sid" --allow-dangerously-skip-permissions --permission-mode auto "$__bootstrap"
      else
        __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
        claude --allow-dangerously-skip-permissions --permission-mode auto "$__bootstrap"
      fi
      ;;
    codex)
      # codex has no --session-id flag, so the real id can only be learned after
      # the fact from the rollout log it writes.
      __track_codex_session "$MYCMUX_PANE_SESSION_ID" &
      codex --no-alt-screen "$__bootstrap"
      ;;
    grok)
      __handoff_sid="$(__grok_new_session_id)"
      if [ -n "$__handoff_sid" ]; then
        __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "grok" "$__handoff_sid"
        grok --no-alt-screen --session-id "$__handoff_sid" --permission-mode bypassPermissions "$__bootstrap"
      else
        grok --no-alt-screen --permission-mode bypassPermissions "$__bootstrap"
      fi
      ;;
    claude-codex)
      __track_claude_codex_session "$MYCMUX_PANE_SESSION_ID" &
      claude-codex "$__bootstrap"
      ;;
  esac
  return 0 2>/dev/null || exit 0
fi

if [ -n "$MYCMUX_RESUME" ]; then
  case "$MYCMUX_RESUME" in
    claude-codex*)
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        if [ "${MYCMUX_RESUME_FORK:-}" = "1" ]; then
          __track_claude_codex_session "$MYCMUX_PANE_SESSION_ID" &
          eval "claude-codex --resume $MYCMUX_SESSION_ID --fork-session"
        else
          __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude-codex" "$MYCMUX_SESSION_ID"
          eval "claude-codex --resume $MYCMUX_SESSION_ID"
        fi
      else
        __track_claude_codex_session "$MYCMUX_PANE_SESSION_ID" &
        eval "claude-codex --continue"
      fi
      ;;
    claude*)
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        if __prepare_claude_resume "$MYCMUX_SESSION_ID"; then
          __trust_claude_cwd
          if [ "${MYCMUX_RESUME_FORK:-}" = "1" ]; then
            __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
            eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --resume $MYCMUX_SESSION_ID --fork-session"
          else
            __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude" "$MYCMUX_SESSION_ID"
            eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --resume $MYCMUX_SESSION_ID"
          fi
        else
          __trust_claude_cwd
          __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
          eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --continue"
        fi
      else
        __trust_claude_cwd
        __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
        eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --continue"
      fi
      ;;
    codex*)
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "codex" "$MYCMUX_SESSION_ID"
        eval "codex resume --no-alt-screen $MYCMUX_SESSION_ID"
      else
        __track_codex_session "$MYCMUX_PANE_SESSION_ID" &
        eval "codex resume --no-alt-screen --last"
      fi
      ;;
    grok*)
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        if [ "${MYCMUX_RESUME_FORK:-}" = "1" ]; then
          grok --no-alt-screen --resume "$MYCMUX_SESSION_ID" --fork-session
        else
          __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "grok" "$MYCMUX_SESSION_ID"
          grok --no-alt-screen --resume "$MYCMUX_SESSION_ID"
        fi
      else
        grok --no-alt-screen --continue
      fi
      ;;
  esac
  return 0 2>/dev/null || exit 0
fi

# Web タブはターミナルで動くコマンドではないので eval できない。ソケット経由で
# mycmux 本体に「Web タブを開いて」と頼む。--replace-anchor を使うのは、他の項目が
# シェルをそのプログラムに置き換えるのと同じで、このタブ自体がそのサービスのタブに
# なるため (spawn は --split なしだと pane.spawn_tab に落ち、web を扱えない)。
# メニューからも MYCMUX_LAUNCH_TARGET からも同じ経路を通す。
__open_web_tab() {
  local preset="$1"
  local cli="$HOME/cmux-for-linux-dev-master/scripts/mycmux_agent_cli.py"
  local web_out="" web_rc=0 python
  if [ ! -f "$cli" ]; then
    printf '  mycmux_agent_cli.py が見つかりません:
    %s

' "$cli"
    return 1
  fi
  python="$(__mycmux_python)" || return 1
  web_out=$(PYTHONIOENCODING=utf-8 "$python" "$cli" web-open --preset "$preset" --replace-anchor 2>&1)
  web_rc=$?
  # 失敗を握りつぶすと「押しても何も起きない」に見える。理由は必ず出す。
  if [ "$web_rc" -ne 0 ]; then
    printf '  Web タブを開けませんでした (exit %s):
' "$web_rc"
    printf '    %s
' "$web_out"
    printf '
'
  fi
  return $web_rc
}

# 疑似コマンド __web_<preset>__ から preset id を取り出して開く。
__open_web_tab_from_pseudo_command() {
  local preset="$1"
  preset="${preset#__web_}"
  preset="${preset%__}"
  __open_web_tab "$preset"
}

# --- 起動スペック (model / effort) -------------------------------------------
# GUI の New Workspace とランチャーのモデル選択が、同じ変換をここに集まる。
# resume / handoff には掛けない (再開先には既にモデルがあり、launcher.ps1 と
# 挙動を揃えるため)。
__MYCMUX_LAUNCH_MODEL=""
__MYCMUX_LAUNCH_EFFORT=""

# コマンドラインにそのまま載る値なので、フラグと誤認されない形だけ通す。
# src/lib/agentCatalog.ts の sanitizeLaunchSpecValue と同じ規則。
__launch_spec_value() {
  local value="$1"
  # 前後の空白を落としてから見る (launcher.ps1 の .Trim() と揃える)
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [ -z "$value" ] && { printf ''; return 0; }
  [ "${#value}" -gt 64 ] && { printf ''; return 0; }
  case "$value" in
    [A-Za-z0-9]*) ;;
    *) printf ''; return 0 ;;
  esac
  case "$value" in
    *[!A-Za-z0-9._-]*) printf ''; return 0 ;;
  esac
  printf '%s' "$value"
  return 0
}

# 読んだら env から消す。以降の子プロセスへ漏らさないため。
__read_launch_spec_from_env() {
  __MYCMUX_LAUNCH_MODEL="$(__launch_spec_value "${MYCMUX_LAUNCH_MODEL:-}")"
  __MYCMUX_LAUNCH_EFFORT="$(__launch_spec_value "${MYCMUX_LAUNCH_EFFORT:-}")"
  unset MYCMUX_LAUNCH_MODEL MYCMUX_LAUNCH_EFFORT
  return 0
}

# フラグは実行ファイルの直後に挟む。末尾に足すと `codex resume <id>` の位置引数を
# 飲み込んでしまう。
__add_launch_spec_to_cmd() {
  local cmd="$1"
  if [ -z "$cmd" ] || { [ -z "$__MYCMUX_LAUNCH_MODEL" ] && [ -z "$__MYCMUX_LAUNCH_EFFORT" ]; }; then
    printf '%s' "$cmd"
    return 0
  fi
  local head="${cmd%% *}"
  local rest="${cmd#"$head"}"
  local leaf="${head##*/}"
  local extra=""
  case "$leaf" in
    claude|claude-codex)
      [ -n "$__MYCMUX_LAUNCH_MODEL" ] && extra="$extra --model $__MYCMUX_LAUNCH_MODEL"
      [ -n "$__MYCMUX_LAUNCH_EFFORT" ] && extra="$extra --effort $__MYCMUX_LAUNCH_EFFORT"
      ;;
    codex)
      [ -n "$__MYCMUX_LAUNCH_MODEL" ] && extra="$extra --model $__MYCMUX_LAUNCH_MODEL"
      # codex に native な effort フラグは無い (config 上書きで渡す)
      [ -n "$__MYCMUX_LAUNCH_EFFORT" ] && extra="$extra -c model_reasoning_effort=$__MYCMUX_LAUNCH_EFFORT"
      ;;
    grok)
      [ -n "$__MYCMUX_LAUNCH_MODEL" ] && extra="$extra --model $__MYCMUX_LAUNCH_MODEL"
      [ -n "$__MYCMUX_LAUNCH_EFFORT" ] && extra="$extra --reasoning-effort $__MYCMUX_LAUNCH_EFFORT"
      ;;
    agy)
      [ -n "$__MYCMUX_LAUNCH_MODEL" ] && extra="$extra --model $__MYCMUX_LAUNCH_MODEL"
      [ -n "$__MYCMUX_LAUNCH_EFFORT" ] && extra="$extra --effort $__MYCMUX_LAUNCH_EFFORT"
      ;;
    *)
      printf '%s' "$cmd"
      return 0
      ;;
  esac
  printf '%s%s%s' "$head" "$extra" "$rest"
  return 0
}

__read_launch_spec_from_env

# --- 起動スペックの選択肢 -----------------------------------------------------
# src/lib/agentCatalog.ts の AGENT_CATALOG と同じ内容。ズレは
# tests/test_launcher_catalog_contract.py が機械検出する (GUI 側を台帳化したのは
# そもそもこの2重管理がズレていたため)。1行 = "表示名|値"。
__spec_models_for() {
  case "$1" in
    claude)
      printf '%s\n' "Fable (flagship)|fable" "Opus|opus" "Sonnet|sonnet" "Haiku|haiku" ;;
    codex|claude-codex)
      printf '%s\n' "Astra (flagship)|gpt-6-astra" "Sol (5.6 fallback)|gpt-5.6-sol" "Terra (standard)|gpt-5.6-terra" "Luna (light)|gpt-5.6-luna" ;;
    agy)
      printf '%s\n' \
        "Gemini 3.1 Pro (High)|gemini-3.1-pro-high" \
        "Gemini 3.1 Pro (Low)|gemini-3.1-pro-low" \
        "Gemini 3.8 Flash (High)|gemini-3.8-flash-high" \
        "Gemini 3.8 Flash (Medium)|gemini-3.8-flash-medium" \
        "Gemini 3.8 Flash (Low)|gemini-3.8-flash-low" \
        "Claude Opus 4.6 (Thinking)|claude-opus-4-6-thinking" \
        "Claude Sonnet 4.6 (Thinking)|claude-sonnet-4-6" ;;
    # grok はモデル ID 一覧を公開しておらず、fcc backend はアカウント次第。
    # 一覧を持たず「入力する」で受ける。
    grok|claude-codex-open) : ;;
  esac
  return 0
}

__spec_efforts_for() {
  case "$1" in
    claude|claude-codex|claude-codex-open) printf '%s\n' low medium high xhigh max ;;
    codex) printf '%s\n' none low medium high xhigh max ultra ;;
    grok|agy) printf '%s\n' low medium high ;;
  esac
  return 0
}

__spec_has_target() {
  case "$1" in
    claude|codex|claude-codex|claude-codex-open|grok|agy) return 0 ;;
  esac
  return 1
}

# 1画面の選択メニュー。先頭は必ず「(default)」= フラグを付けない。
# 呼び出し前に __SPEC_LABELS / __SPEC_VALUES を組んでおく。
# 結果は __SPEC_RESULT、Esc / ← / q なら 1 を返す。
__spec_menu() {
  local title="$1" note="${2:-}"
  local total=${#__SPEC_LABELS[@]}
  local sel=0 i num marker line
  __open_menu_fd
  while true; do
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  $title" >&$__CMUX_MENU_FD
    [ -n "$note" ] && echo "  $note" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    for i in "${!__SPEC_LABELS[@]}"; do
      num=$((i + 1))
      if [ "$i" -eq "$sel" ]; then marker=">"; else marker=" "; fi
      line="${marker} ${num}. ${__SPEC_LABELS[$i]}"
      if [ -n "${__SPEC_VALUES[$i]}" ] && [ "${__SPEC_VALUES[$i]}" != "__type__" ] \
        && [ "${__SPEC_LABELS[$i]}" != "${__SPEC_VALUES[$i]}" ]; then
        line="${line}  (${__SPEC_VALUES[$i]})"
      fi
      echo "$line" >&$__CMUX_MENU_FD
    done
    echo "" >&$__CMUX_MENU_FD
    echo "  ^v: move   Enter/number: select   Esc: back" >&$__CMUX_MENU_FD

    __read_menu_event
    case "$__MENU_EVENT" in
      eof|quit|esc) return 1 ;;
      up) ((sel--)); [ $sel -lt 0 ] && sel=$((total - 1)); continue ;;
      down) ((sel++)); [ $sel -ge $total ] && sel=0; continue ;;
      digit)
        i=$((__MENU_DIGIT - 1))
        [ "$i" -lt 0 ] || [ "$i" -ge "$total" ] && continue
        sel=$i
        ;;
      enter|right) ;;
      *) continue ;;
    esac

    if [ "${__SPEC_VALUES[$sel]}" = "__type__" ]; then
      printf "\033[H\033[2J" >&$__CMUX_MENU_FD
      echo "" >&$__CMUX_MENU_FD
      echo "  $title" >&$__CMUX_MENU_FD
      echo "" >&$__CMUX_MENU_FD
      printf "  > " >&$__CMUX_MENU_FD
      local typed="" trimmed=""
      IFS= read -ru "$__CMUX_MENU_FD" typed
      # 何も打たずに Enter は「既定でよい」と読む (launcher.ps1 と同じ扱い)
      trimmed="$(printf '%s' "$typed" | tr -d '[:space:]')"
      if [ -z "$trimmed" ]; then
        __SPEC_RESULT=""
        return 0
      fi
      __SPEC_RESULT="$(__launch_spec_value "$typed")"
      if [ -z "$__SPEC_RESULT" ]; then
        echo "" >&$__CMUX_MENU_FD
        echo "  使えない値です (英数字で始まり、英数字と . _ - のみ)" >&$__CMUX_MENU_FD
        sleep 1.2
        continue
      fi
      return 0
    fi
    __SPEC_RESULT="${__SPEC_VALUES[$sel]}"
    return 0
  done
}

# 1項目ぶんの model → effort を順に選ぶ。0 = 起動へ / 1 = メニューへ戻る。
__launch_spec_menu() {
  local target="$1" label="$2"
  __spec_has_target "$target" || return 1

  local entry
  __SPEC_LABELS=("(default)"); __SPEC_VALUES=("")
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    __SPEC_LABELS+=("${entry%%|*}")
    __SPEC_VALUES+=("${entry#*|}")
  done < <(__spec_models_for "$target")
  __SPEC_LABELS+=("入力する..."); __SPEC_VALUES+=("__type__")
  __spec_menu "$label - model" || return 1
  local model="$__SPEC_RESULT"

  local note="model: (default)"
  [ -n "$model" ] && note="model: $model"
  __SPEC_LABELS=("(default)"); __SPEC_VALUES=("")
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    __SPEC_LABELS+=("$entry")
    __SPEC_VALUES+=("$entry")
  done < <(__spec_efforts_for "$target")
  __SPEC_LABELS+=("入力する..."); __SPEC_VALUES+=("__type__")
  __spec_menu "$label - effort" "$note" || return 1

  __MYCMUX_LAUNCH_MODEL="$model"
  __MYCMUX_LAUNCH_EFFORT="$__SPEC_RESULT"
  return 0
}

if [ -n "$MYCMUX_LAUNCH_TARGET" ]; then
  case "$MYCMUX_LAUNCH_TARGET" in
    claude)
      cmd="claude --allow-dangerously-skip-permissions --permission-mode auto"
      ;;
    claude-resume)
      cmd="claude --allow-dangerously-skip-permissions --permission-mode auto --resume"
      ;;
    codex)
      cmd="codex --no-alt-screen"
      ;;
    codex-resume)
      cmd="codex resume --no-alt-screen"
      ;;
    grok)
      cmd="grok --no-alt-screen --permission-mode auto"
      ;;
    grok-resume)
      cmd="grok --no-alt-screen --resume"
      ;;
    claude-codex)
      cmd="claude-codex --backend gpt"
      ;;
    claude-codex-resume)
      cmd="claude-codex --resume"
      ;;
    claude-codex-open|fcc|fcc-claude)
      cmd="claude-codex --backend fcc"
      ;;
    custom)
      cmd="__custom__"
      ;;
    chatgpt|web-chatgpt)
      cmd="__web_chatgpt__"
      ;;
    web-gemini|gemini-web)
      cmd="__web_gemini__"
      ;;
    web-grok|grok-web)
      cmd="__web_grok__"
      ;;
    web-claude|claude-web|claude-ai)
      cmd="__web_claude__"
      ;;
    web-notebooklm|notebooklm)
      cmd="__web_notebooklm__"
      ;;
    gemini|agy|antigravity)
      # Gemini CLI was sunset for individual accounts on 2026-06-18; agy (Antigravity CLI) replaces it
      cmd="agy"
      ;;
    aider)
      cmd="aider"
      ;;
    shell)
      return 0 2>/dev/null || exit 0
      ;;
  esac
fi

# ディレクトリ選択。候補は ~/.mycmux/launch-roots.txt (name|path 形式)。
# 表示名が「案件」始まりの行は案件セクション、それ以外は開発セクションに出る。
# 選択で cd してメインメニューに戻る。以降の起動はそのディレクトリで行われるため、
# Claude Code はそのリポジトリの CLAUDE.md / プロジェクト履歴を持つセッションになる。
#
# 操作は上下キー + Enter で完結させる。→ でも決定、← でも復帰。ホイールは当てにしない
# (mycmux の wheel→PTY 合成は alternate screen のときだけ通るので、通常バッファに描く
#  このメニューには届かない。届くのはスクロールバック操作だけ)。
__LAUNCH_RUNTIME_DIR="${MYCMUX_RUNTIME_DIR:-$HOME/.mycmux}"
__ROOTS_FILE="$__LAUNCH_RUNTIME_DIR/launch-roots.txt"
__DIR_MRU_FILE="$__LAUNCH_RUNTIME_DIR/launch-dirs-mru.txt"

# 選んだ行き先を最近使った順で8件保持する (トップ画面の「最近使った」に出す)。
__record_dir_mru() {
  local target="$1"
  [ -z "$target" ] && return
  local tmp="${__DIR_MRU_FILE}.tmp"
  mkdir -p "$(dirname "$__DIR_MRU_FILE")" 2>/dev/null
  # 初回や全行除外で grep が 1 を返してもブロック全体を失敗にしないこと (mv が飛ぶ)
  {
    echo "$target"
    if [ -f "$__DIR_MRU_FILE" ]; then
      grep -vxF -- "$target" "$__DIR_MRU_FILE" 2>/dev/null | head -7
    fi
    true
  } > "$tmp" 2>/dev/null
  [ -s "$tmp" ] && mv -f "$tmp" "$__DIR_MRU_FILE" 2>/dev/null
  return 0
}

# 比較用の正規化 (/c/Users/... と C:/Users/... を同一視する)。
# 候補件数ぶん呼ぶので、結果は変数で返す版を本体にする ($() のサブシェルを避ける)。
__norm_path_into() {
  local p="${1//\\//}"
  p="${p%/}"
  if [[ "$p" =~ ^/([a-zA-Z])/(.*)$ ]]; then
    p="${BASH_REMATCH[1]}:/${BASH_REMATCH[2]}"
  fi
  __mycmux_lower_ascii_into "$p"
  __NORM_RESULT="$__MYCMUX_LOWER_RESULT"
}

__norm_path() {
  __norm_path_into "$1"
  echo "$__NORM_RESULT"
}

# Load configured display roots once, including for subshell-based callers.
__SHORT_ROOTS=()
__SHORT_ROOTS_LOADED=0
__load_short_roots() {
  [ "${__SHORT_ROOTS_LOADED:-0}" = 1 ] && return 0
  __SHORT_ROOTS_LOADED=1
  __SHORT_ROOTS=()
  [ -f "$__ROOTS_FILE" ] || return 0
  local line root
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '# short-root:'*)
        root="${line#\# short-root:}"
        root="${root#"${root%%[![:space:]]*}"}"
        root="${root%"${root##*[![:space:]]}"}"
        root="${root//\\//}"
        [ -n "$root" ] && __SHORT_ROOTS+=("$root")
        ;;
    esac
  done < "$__ROOTS_FILE"
  return 0
}
__load_short_roots

# Configured roots shorten first; the existing home fallback stays available.
__short_path_into() {
  local p="${1//\\//}" root
  __load_short_roots
  for root in "${__SHORT_ROOTS[@]}"; do
    root="${root%/}"
    case "$p" in
      "$root"/*) __SHORT_RESULT=$'\342\200\246'"/${p#"$root"/}"; return ;;
    esac
  done
  case "$p" in
    "$HOME") __SHORT_RESULT="~"; return ;;
    "$HOME"/*) __SHORT_RESULT="~${p#$HOME}"; return ;;
  esac
  __SHORT_RESULT="$p"
}

__short_path() {
  __short_path_into "$1"
  echo "$__SHORT_RESULT"
}

# ピッカー用の1入力イベント。メインメニューの __read_menu_event と違い、印字可能文字を
# そのまま返す (絞り込み検索に使う)。
# 結果: __PICK_EVENT = eof/up/down/pgup/pgdn/home/end/enter/esc/bs/char
#       __PICK_CHAR (char時)
__read_pick_event() {
  __PICK_EVENT=none; __PICK_CHAR=""
  local key k2 k3 k4
  if ! IFS= read -rsn1 -u "$__CMUX_MENU_FD" key; then
    __PICK_EVENT=eof; return
  fi
  case "$key" in
    $'\x1b')
      if ! __mycmux_read_key_with_timeout k2 0.1; then
        __PICK_EVENT=esc; return
      fi
      case "$k2" in
        '['|'O') ;;
        *) __PICK_EVENT=esc; return ;;
      esac
      __mycmux_read_key_with_timeout k3 0.1 || { __PICK_EVENT=esc; return; }
      case "$k3" in
        A) __PICK_EVENT=up ;;
        B) __PICK_EVENT=down ;;
        C) __PICK_EVENT=enter ;;
        D) __PICK_EVENT=esc ;;
        H) __PICK_EVENT=home ;;
        F) __PICK_EVENT=end ;;
        5) __mycmux_read_key_with_timeout k4 0.1; __PICK_EVENT=pgup ;;
        6) __mycmux_read_key_with_timeout k4 0.1; __PICK_EVENT=pgdn ;;
      esac
      ;;
    '') __PICK_EVENT=enter ;;
    $'\x7f'|$'\b') __PICK_EVENT=bs ;;
    *) __PICK_EVENT=char; __PICK_CHAR="$key" ;;
  esac
}

# 共通ピッカー。__PICK_LABELS[] / __PICK_PATHS[] を並べて上下キー + Enter で1件選ばせる。
# 画面高さに合わせてページ送りするので、候補が何件あっても1画面は溢れない。
# / を押すと絞り込みモードに入り、以降の文字入力でリアルタイムに絞られる (Esc で解除)。
# 絞り込み中でなければ 1〜9 の数字でも即選択できる。
# 引数: $1=タイトル $2=フッタの補足 (省略可)
# 出力: __PICK_INDEX (__PICK_LABELS 上の 0-based 位置)。戻り値 1 = キャンセル
__pick_list() {
  local p_title="$1" p_note="${2:-}"
  local p_total=${#__PICK_LABELS[@]}
  [ "$p_total" -eq 0 ] && return 1
  __open_menu_fd
  local p_sel=0 p_top=0 p_query="" p_searching=0
  local p_view=() p_cur
  p_cur="$(__norm_path "$(pwd)")"

  # 描画は 1 キー入力ごとに走るので、ループ内でサブシェルを起動しないこと。
  # 正規化・短縮・端末高さは起動時に一度だけ求めて配列と変数に持つ
  # (毎フレーム __norm_path/__short_path/tput を呼ぶと、候補行数ぶんプロセスが
  #  生成されて上下キーの追従が体感できるほど遅くなる)。
  local p_norms=() p_shorts=() p_rows p_lines
  local __p_i
  for __p_i in "${!__PICK_PATHS[@]}"; do
    if [ -n "${__PICK_PATHS[$__p_i]}" ]; then
      __norm_path_into "${__PICK_PATHS[$__p_i]}"
      __short_path_into "${__PICK_PATHS[$__p_i]}"
      p_norms+=("$__NORM_RESULT")
      p_shorts+=("$__SHORT_RESULT")
    else
      p_norms+=("")
      p_shorts+=("")
    fi
  done
  p_lines=$(tput lines 2>/dev/null || echo 24)
  p_rows=$((p_lines - 8)); [ $p_rows -lt 3 ] && p_rows=3

  __pick_rebuild() {
    local prev_idx=-1
    [ ${#p_view[@]} -gt 0 ] && [ $p_sel -lt ${#p_view[@]} ] && prev_idx=${p_view[$p_sel]}
    p_view=()
    local idx hay hay_lower query_lower=""
    if [ -n "$p_query" ]; then
      __mycmux_lower_ascii_into "$p_query"
      query_lower="$__MYCMUX_LOWER_RESULT"
    fi
    for idx in "${!__PICK_LABELS[@]}"; do
      if [ -z "$p_query" ]; then
        p_view+=("$idx")
        continue
      fi
      hay="${__PICK_LABELS[$idx]} ${__PICK_PATHS[$idx]}"
      __mycmux_lower_ascii_into "$hay"
      hay_lower="$__MYCMUX_LOWER_RESULT"
      if [[ "$hay_lower" == *"$query_lower"* ]]; then
        p_view+=("$idx")
      fi
    done
    # 絞り込み後もできるだけ同じ行を選んだままにする
    local n
    p_sel=0
    if [ $prev_idx -ge 0 ]; then
      for n in "${!p_view[@]}"; do
        [ "${p_view[$n]}" = "$prev_idx" ] && { p_sel=$n; break; }
      done
    fi
    p_top=0
  }

  # 1 キー入力ごとに走る。ここでサブシェル (コマンド置換) を使わないこと。
  __pick_draw() {
    local vcount=${#p_view[@]}
    local rows=$p_rows
    if [ $p_sel -lt $p_top ]; then p_top=$p_sel; fi
    if [ $p_sel -ge $((p_top + rows)) ]; then p_top=$((p_sel - rows + 1)); fi
    [ $p_top -lt 0 ] && p_top=0
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  ${p_title}" >&$__CMUX_MENU_FD
    if [ $p_searching -eq 1 ]; then
      echo "  絞り込み: ${p_query}_" >&$__CMUX_MENU_FD
    else
      echo "" >&$__CMUX_MENU_FD
    fi
    if [ $vcount -eq 0 ]; then
      echo "  (該当なし)" >&$__CMUX_MENU_FD
    fi
    local n idx mark here
    for (( n=p_top; n<p_top+rows && n<vcount; n++ )); do
      idx=${p_view[$n]}
      mark="   "
      [ $n -eq $p_sel ] && mark=" > "
      here=""
      if [ -n "${p_norms[$idx]}" ] && [ "${p_norms[$idx]}" = "$p_cur" ]; then
        here="  ← 今ここ"
      fi
      echo "${mark}${__PICK_LABELS[$idx]}${here}" >&$__CMUX_MENU_FD
    done
    echo "" >&$__CMUX_MENU_FD
    local pos="-"
    [ $vcount -gt 0 ] && pos="$((p_sel + 1))/${vcount}"
    if [ $p_searching -eq 1 ]; then
      echo "  ${pos}   ^v 移動   Enter 決定   BS 一文字消す   Esc 絞り込み解除" >&$__CMUX_MENU_FD
    else
      echo "  ${pos}   ^v 移動   Enter/→ 決定   / 絞り込み   Esc/← 戻る${p_note:+   $p_note}" >&$__CMUX_MENU_FD
    fi
    if [ $vcount -gt 0 ] && [ -n "${p_shorts[${p_view[$p_sel]}]}" ]; then
      echo "  → ${p_shorts[${p_view[$p_sel]}]}" >&$__CMUX_MENU_FD
    fi
  }

  __pick_rebuild
  __pick_draw
  while true; do
    __read_pick_event
    case "$__PICK_EVENT" in
      eof) return 1 ;;
      esc)
        if [ $p_searching -eq 1 ]; then
          p_searching=0; p_query=""; __pick_rebuild
        else
          return 1
        fi
        ;;
      up)
        [ ${#p_view[@]} -eq 0 ] && { __pick_draw; continue; }
        ((p_sel--)); [ $p_sel -lt 0 ] && p_sel=$(( ${#p_view[@]} - 1 ))
        ;;
      down)
        [ ${#p_view[@]} -eq 0 ] && { __pick_draw; continue; }
        ((p_sel++)); [ $p_sel -ge ${#p_view[@]} ] && p_sel=0
        ;;
      pgup) p_sel=$((p_sel - 10)); [ $p_sel -lt 0 ] && p_sel=0 ;;
      pgdn)
        p_sel=$((p_sel + 10))
        [ $p_sel -ge ${#p_view[@]} ] && p_sel=$(( ${#p_view[@]} - 1 ))
        [ $p_sel -lt 0 ] && p_sel=0
        ;;
      home) p_sel=0 ;;
      end) p_sel=$(( ${#p_view[@]} - 1 )); [ $p_sel -lt 0 ] && p_sel=0 ;;
      bs)
        if [ $p_searching -eq 1 ] && [ -n "$p_query" ]; then
          p_query="${p_query%?}"; __pick_rebuild
        fi
        ;;
      enter)
        [ ${#p_view[@]} -eq 0 ] && { __pick_draw; continue; }
        __PICK_INDEX=${p_view[$p_sel]}
        return 0
        ;;
      char)
        if [ $p_searching -eq 1 ]; then
          p_query="${p_query}${__PICK_CHAR}"; __pick_rebuild
        else
          case "$__PICK_CHAR" in
            /) p_searching=1 ;;
            q|Q) return 1 ;;
            k|K)
              [ ${#p_view[@]} -eq 0 ] && { __pick_draw; continue; }
              ((p_sel--)); [ $p_sel -lt 0 ] && p_sel=$(( ${#p_view[@]} - 1 ))
              ;;
            j|J)
              [ ${#p_view[@]} -eq 0 ] && { __pick_draw; continue; }
              ((p_sel++)); [ $p_sel -ge ${#p_view[@]} ] && p_sel=0
              ;;
            [1-9])
              local n=$((__PICK_CHAR - 1))
              if [ $n -lt ${#p_view[@]} ]; then
                __PICK_INDEX=${p_view[$n]}
                return 0
              fi
              ;;
          esac
        fi
        ;;
    esac
    __pick_draw
  done
}

# launch-roots.txt から1セクション分を __PICK_LABELS/__PICK_PATHS へ読み出す。
__load_roots_section() {
  local mode="$1" name path
  __PICK_LABELS=(); __PICK_PATHS=()
  [ -f "$__ROOTS_FILE" ] || return
  while IFS='|' read -r name path; do
    case "$name" in ''|'#'*) continue ;; esac
    [ -z "$path" ] && continue
    case "$name" in
      案件*)
        [ "$mode" = "anken" ] || continue
        name="${name#案件: }"; name="${name#案件:}"
        ;;
      *)
        [ "$mode" = "dev" ] || continue
        ;;
    esac
    __PICK_LABELS+=("$name"); __PICK_PATHS+=("$path")
  done < "$__ROOTS_FILE"
}

# 登録済み候補からの選択 (開発 / 案件 / 最近使った)。成功時 0 を返して cd 済み。
__select_launch_root() {
  local r_mode="${1:-dev}"
  local r_title
  case "$r_mode" in
    anken)
      __load_roots_section anken
      r_title="案件  (設定 → ランチャーで編集)"
      ;;
    mru)
      __PICK_LABELS=(); __PICK_PATHS=()
      if [ -f "$__DIR_MRU_FILE" ]; then
        local line
        while IFS= read -r line; do
          [ -z "$line" ] && continue
          [ -d "$line" ] || continue
          __PICK_LABELS+=("$(__short_path "$line")"); __PICK_PATHS+=("$line")
        done < "$__DIR_MRU_FILE"
      fi
      r_title="最近使った"
      ;;
    *)
      __load_roots_section dev
      r_title="開発  (設定 → ランチャーで編集)"
      ;;
  esac
  if [ ${#__PICK_LABELS[@]} -eq 0 ]; then
    __PICK_LABELS=("(候補なし)"); __PICK_PATHS=("")
  fi
  __pick_list "Change directory — ${r_title}" || return 1
  local target="${__PICK_PATHS[$__PICK_INDEX]}"
  [ -z "$target" ] && return 1
  cd "$target" 2>/dev/null || return 1
  __record_dir_mru "$target"
  return 0
}

# 実フォルダを1階層ずつ辿る。候補ファイルに載っていない場所へも上下キーだけで行ける。
__browse_launch_dirs() {
  local cur
  cur="$(pwd)"
  while true; do
    local entry
    __PICK_LABELS=("✓ ここに決定") ; __PICK_PATHS=("$cur")
    if [ "$(dirname "$cur")" != "$cur" ]; then
      __PICK_LABELS+=("↑ 上のフォルダへ"); __PICK_PATHS+=("$(dirname "$cur")")
    fi
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      __PICK_LABELS+=("${entry}/"); __PICK_PATHS+=("${cur%/}/$entry")
    done < <(cd "$cur" 2>/dev/null && ls -1 2>/dev/null | while IFS= read -r e; do [ -d "$e" ] && echo "$e"; done)
    __pick_list "フォルダを辿る — $(__short_path "$cur")" "Enter で1階層もぐる" || return 1
    local target="${__PICK_PATHS[$__PICK_INDEX]}"
    if [ "$__PICK_INDEX" -eq 0 ]; then
      cd "$cur" 2>/dev/null || return 1
      __record_dir_mru "$cur"
      return 0
    fi
    [ -d "$target" ] && cur="$target"
  done
}

# ディレクトリ選択のトップ画面。1画面を短く保ち、上下キー + Enter だけで
# 「最近使った / 開発 / 案件 / 実フォルダを辿る / Home」のどこへでも入れるようにする。
__launch_dir_menu() {
  local direct="${1:-}"
  if [ -n "$direct" ]; then
    __select_launch_root "$direct"
    return
  fi
  __open_menu_fd
  while true; do
    local mru_count=0
    if [ -f "$__DIR_MRU_FILE" ]; then
      mru_count=$(grep -c . "$__DIR_MRU_FILE" 2>/dev/null || echo 0)
    fi
    local dev_count anken_count
    __load_roots_section dev;   dev_count=${#__PICK_LABELS[@]}
    __load_roots_section anken; anken_count=${#__PICK_LABELS[@]}

    local t_labels=() t_kinds=()
    if [ "$mru_count" -gt 0 ]; then
      t_labels+=("最近使った  (${mru_count})"); t_kinds+=("mru")
    fi
    t_labels+=("開発  (${dev_count})");   t_kinds+=("dev")
    t_labels+=("案件  (${anken_count})"); t_kinds+=("anken")
    t_labels+=("フォルダを辿る  (ここから下へ)"); t_kinds+=("browse")
    t_labels+=("Home"); t_kinds+=("home")

    __PICK_LABELS=("${t_labels[@]}")
    __PICK_PATHS=()
    local k
    for k in "${t_kinds[@]}"; do
      case "$k" in
        home) __PICK_PATHS+=("$HOME") ;;
        *) __PICK_PATHS+=("") ;;
      esac
    done

    __pick_list "Change directory        now: $(__short_path "$(pwd)")" || return
    case "${t_kinds[$__PICK_INDEX]}" in
      mru)    __select_launch_root mru && return ;;
      dev)    __select_launch_root dev && return ;;
      anken)  __select_launch_root anken && return ;;
      browse) __browse_launch_dirs && return ;;
      home)   cd "$HOME" 2>/dev/null && __record_dir_mru "$HOME"; return ;;
    esac
  done
}

if [ -z "$cmd" ]; then
  __open_menu_fd
  options=(
    "Claude Code"
    "Codex"
    "claude-codex (Codex Models)"
    "Grok Build"
    "claude-codex (Open Models)"
    "Antigravity (agy)"
    "ChatGPT (Web)"
    "Gemini (Web)"
    "Grok (Web)"
    "Claude.ai (Web)"
    "NotebookLM (Web)"
    "Claude Code (resume)"
    "Codex (resume)"
    "claude-codex (resume)"
    "Grok Build (resume)"
    "Custom..."
    "Change directory (開発)..."
    "Change directory (案件)..."
    "Change directory (最近・フォルダを辿る)..."
  )

  # options / commands と同じ並び。model / effort を取れる行だけ target を持つ
  # (→ か m で起動スペックのメニューに入れる行)。長さの一致は
  # tests/test_launcher_catalog_contract.py が検査する。
  spec_targets=(
    "claude"
    "codex"
    "claude-codex"
    "grok"
    "claude-codex-open"
    "agy"
    "" "" "" "" ""
    "" "" "" ""
    ""
    "" "" ""
  )

  commands=(
    "claude --allow-dangerously-skip-permissions --permission-mode auto"
    "codex --no-alt-screen"
    "claude-codex --backend gpt"
    "grok --no-alt-screen --permission-mode auto"
    "claude-codex --backend fcc"
    "agy"
    "__web_chatgpt__"
    "__web_gemini__"
    "__web_grok__"
    "__web_claude__"
    "__web_notebooklm__"
    "claude --allow-dangerously-skip-permissions --permission-mode auto --resume"
    "codex resume --no-alt-screen"
    "claude-codex --resume"
    "grok --no-alt-screen --resume"
    "__custom__"
    "__dir_dev__"
    "__dir_anken__"
    "__dir__"
  )

  selected=0
  count=${#options[@]}
  tput civis >&$__CMUX_MENU_FD 2>/dev/null
  trap 'tput cnorm >&$__CMUX_MENU_FD 2>/dev/null' EXIT

  draw_menu() {
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  Launch:  [dir: $(pwd -W 2>/dev/null || pwd)]" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    for i in "${!options[@]}"; do
      local num=$((i + 1))
      if [ $i -eq $selected ]; then
        echo "> ${num}. ${options[$i]}" >&$__CMUX_MENU_FD
      else
        echo "  ${num}. ${options[$i]}" >&$__CMUX_MENU_FD
      fi
    done
    echo "" >&$__CMUX_MENU_FD
    echo "  ^v: move   Enter/number: select   ->/m: model   d: 開発dir   a: 案件dir   /: custom   Esc/q: shell" >&$__CMUX_MENU_FD
  }

  # 選択中の項目がメニュー内で完結するものなら処理して 0 (メニュー継続) か 2 (起動済み) を返す。
  # 1 を返したときだけ呼び出し側が break して cmd を eval する。
  __try_selected_menu_command() {
    case "${commands[$selected]}" in
      __web_chatgpt__|__web_gemini__|__web_grok__|__web_claude__|__web_notebooklm__)
        # 実処理は __open_web_tab (MYCMUX_LAUNCH_TARGET と共有)。
        # ここはメニューを畳んで結果を返すだけ。
        tput cnorm >&$__CMUX_MENU_FD 2>/dev/null
        __close_menu_fd 2>/dev/null || true
        __open_web_tab_from_pseudo_command "${commands[$selected]}"
        return 2
        ;;
      __dir_dev__|__dir_anken__|__dir__)
        # ディレクトリを変えたら選択を先頭 (Claude Code) に戻す
        case "${commands[$selected]}" in
          __dir_dev__)   __launch_dir_menu dev ;;
          __dir_anken__) __launch_dir_menu anken ;;
          *)             __launch_dir_menu ;;
        esac
        selected=0
        draw_menu
        return 0
        ;;
    esac
    return 1
  }

  draw_menu

  while true; do
    __read_menu_event
    case "$__MENU_EVENT" in
      eof|quit|esc)
        tput cnorm >&$__CMUX_MENU_FD 2>/dev/null
        return 0 2>/dev/null || exit 0
        ;;
      up) ((selected--)); [ $selected -lt 0 ] && selected=$((count - 1)) ;;
      down) ((selected++)); [ $selected -ge $count ] && selected=0 ;;
      enter)
        __try_selected_menu_command
        __try_status=$?
        if [ $__try_status -eq 0 ]; then
          continue
        elif [ $__try_status -eq 2 ]; then
          return 0 2>/dev/null || exit 0
        fi
        break
        ;;
      slash) selected=11; break ;;
      # → / m はこの行の model と effort を選んでから起動する。Enter と数字キーは
      # 触っていない — 従来どおり CLI の既定で即起動する。
      right)
        if __launch_spec_menu "${spec_targets[$selected]}" "${options[$selected]}"; then
          break
        fi
        draw_menu
        ;;
      dirkey) __launch_dir_menu dev ;;
      ankenkey) __launch_dir_menu anken ;;
      digit)
        case "$__MENU_DIGIT" in
          1)
            if __mycmux_read_key_with_timeout k2 0.15; then
              case "$k2" in
                0) selected=9 ;;
                1) selected=10 ;;
                2) selected=11 ;;
                3) selected=12 ;;
                4) selected=13 ;;
                5) selected=14 ;;
                *) selected=0 ;;
              esac
            else
              selected=0
            fi
            __try_selected_menu_command
            __try_status=$?
            if [ $__try_status -eq 0 ]; then
              continue
            elif [ $__try_status -eq 2 ]; then
              return 0 2>/dev/null || exit 0
            fi
            break
            ;;
          0)
            selected=9
            __try_selected_menu_command
            __try_status=$?
            if [ $__try_status -eq 0 ]; then
              continue
            elif [ $__try_status -eq 2 ]; then
              return 0 2>/dev/null || exit 0
            fi
            break
            ;;
          *)
            selected=$((__MENU_DIGIT - 1))
            __try_selected_menu_command
            __try_status=$?
            if [ $__try_status -eq 0 ]; then
              continue
            elif [ $__try_status -eq 2 ]; then
              return 0 2>/dev/null || exit 0
            fi
            break
            ;;
        esac
        ;;
    esac
    draw_menu
  done

  tput cnorm >&$__CMUX_MENU_FD 2>/dev/null
  printf "\033[H\033[2J" >&$__CMUX_MENU_FD
  cmd="${commands[$selected]}"
  # "__dir__" 系はメニュー内で処理済みのはずだが、万一漏れても eval しない
  case "$cmd" in __dir__|__dir_dev__|__dir_anken__) cmd="" ;; esac
fi

if [ "$cmd" = "__custom__" ]; then
  __prompt_custom_command
  if [ -z "$cmd" ]; then
    return 0 2>/dev/null || exit 0
  fi
fi

# MYCMUX_LAUNCH_TARGET=web-* で来た場合。Web タブはプロセスではないので eval せず、
# ここで開いてシェルに戻る (メニュー経由の場合は既に処理済みでここには来ない)。
case "$cmd" in
  __web_chatgpt__|__web_gemini__|__web_grok__|__web_claude__|__web_notebooklm__)
    __open_web_tab_from_pseudo_command "$cmd"
    cmd=""
    ;;
esac

if [ -n "$cmd" ]; then
  if [[ "$cmd" == *"fugu"* ]]; then
    __ensure_fugu_env
  fi
  if [[ "$cmd" == claude || "$cmd" == claude\ * ]]; then
    __trust_claude_cwd
  fi
  if __claude_needs_new_session_id "$cmd"; then
    __project_dir="$(__get_claude_project_dir)"
    __sid="$(__stable_new_session_id "$__project_dir")"
    if [ -n "$__sid" ]; then
      __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude" "$__sid"
      cmd="claude --session-id $__sid${cmd#claude}"
    fi
  fi
  if __grok_needs_new_session_id "$cmd"; then
    __sid="$(__grok_new_session_id)"
    if [ -n "$__sid" ]; then
      __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "grok" "$__sid"
      cmd="grok --session-id $__sid${cmd#grok}"
    fi
  fi
  cmd="$(__add_launch_spec_to_cmd "$cmd")"
  __track_command_session "$cmd" "$MYCMUX_PANE_SESSION_ID"
  if [ -n "${__CMUX_MENU_FD:-}" ]; then
    echo "Starting..." >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
  fi
  eval "$cmd"
fi

[ -f "$__LAUNCH_RUNTIME_DIR/bin/launcher.local.sh" ] && . "$__LAUNCH_RUNTIME_DIR/bin/launcher.local.sh" || true
