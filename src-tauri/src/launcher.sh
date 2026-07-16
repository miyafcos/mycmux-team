#!/bin/bash
# Terminal launcher - arrow keys, j/k, or number keys
# Called from .bashrc

# MSYS bash severs the Windows process ancestry when it runs a shebang-script
# wrapper as an external command (the fork copy that execs the interpreter
# dies), so agents launched via ~/bin/claude etc. are orphaned from the pane
# shell and invisible to the Rust monitor's descendant scan (agent badge,
# savepoint button, mapping retention). Direct .cmd/.exe children keep an
# intact chain, so route the agent commands to their .cmd shims and export
# the functions for the interactive shell that replaces the launcher.
claude() { "$HOME/bin/claude.cmd" "$@"; }
claude-codex() { "$HOME/bin/claude-codex.cmd" "$@"; }
codex() { "$APPDATA/npm/codex.cmd" "$@"; }
export -f claude claude-codex codex

__write_session_mapping() {
  local pane_id="$1"
  local kind="$2"
  local session_id="$3"
  [ -z "$pane_id" ] || [ -z "$session_id" ] && return
  local map_dir="$HOME/.mycmux/pane-sessions"
  mkdir -p "$map_dir" 2>/dev/null
  if [ -n "$kind" ]; then
    echo "$kind:$session_id" > "$map_dir/$pane_id.txt"
  else
    echo "$session_id" > "$map_dir/$pane_id.txt"
  fi
}

__claude_project_key() {
  local path="$1"
  PYTHONIOENCODING=utf-8 MYCMUX_CLAUDE_PROJECT_PATH="$path" python - <<'PY' 2>/dev/null
import os
import re

path = os.environ.get("MYCMUX_CLAUDE_PROJECT_PATH", "").rstrip("/\\")
if re.match(r"^/[a-zA-Z]/", path):
    path = f"{path[1].upper()}:{path[2:]}"
print(re.sub(r"[^A-Za-z0-9-]", "-", path).lstrip("-"), end="")
PY
}

__get_claude_project_dir() {
  local mangled
  mangled="$(__claude_project_key "$(pwd)")"
  echo "$HOME/.claude/projects/$mangled"
}

__find_claude_session_file() {
  local session_id="$1"
  [[ "$session_id" =~ ^[0-9a-fA-F-]{36}$ ]] || return 1
  local root="$HOME/.claude/projects"
  [ -d "$root" ] || return 1
  PYTHONIOENCODING=utf-8 MYCMUX_CLAUDE_PROJECTS_ROOT="$root" MYCMUX_CLAUDE_SESSION_ID="$session_id" python - <<'PY' 2>/dev/null
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
  PYTHONIOENCODING=utf-8 MYCMUX_CLAUDE_SESSION_FILE="$session_file" python - <<'PY' 2>/dev/null
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
    return re.sub(r"[^A-Za-z0-9-]", "-", cwd).lstrip("-")

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
  if [[ "$session_cwd" =~ ^([a-zA-Z]):[\\/](.*)$ ]]; then
    local drive="${BASH_REMATCH[1],,}"
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

__track_latest_jsonl_in_dir() {
  local pane_id="$1"
  local project_dir="$2"
  local kind="$3"
  [ -z "$pane_id" ] && return
  [ ! -d "$project_dir" ] && return

  sleep 4
  local latest
  latest=$(ls -t "$project_dir"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$latest" ]; then
    __write_session_mapping "$pane_id" "$kind" "$(basename "$latest" .jsonl)"
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

  sleep 4
  local latest
  latest=$(find "$sessions_dir" -name "rollout-*.jsonl" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  if [ -z "$latest" ]; then
    latest=$(find "$sessions_dir" -name "rollout-*.jsonl" -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
  fi
  if [ -n "$latest" ]; then
    local fname
    fname=$(basename "$latest" .jsonl)
    local uuid
    uuid=$(echo "$fname" | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    if [ -n "$uuid" ]; then
      __write_session_mapping "$pane_id" "codex" "$uuid"
    fi
  fi
}

__track_command_session() {
  local cmd="$1"
  local pane_id="$2"
  [ -z "$pane_id" ] && return

  if [[ "$cmd" == *"claude-codex"* ]]; then
    __track_claude_codex_session "$pane_id" &
  elif [[ "$cmd" == *"claude"* ]]; then
    __track_claude_session "$pane_id" &
  elif [[ "$cmd" == *"codex"* ]]; then
    __track_codex_session "$pane_id" &
  fi
}

__make_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    python - <<'PY' 2>/dev/null
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

__trust_claude_cwd() {
  [ "$MYCMUX_DISABLE_CLAUDE_AUTO_TRUST" = "1" ] && return
  local cwd
  cwd="$(pwd -W 2>/dev/null || pwd)"
  cwd="${cwd//\\//}"
  cwd="${cwd%/}"
  [ -z "$cwd" ] && return
  MYCMUX_CLAUDE_TRUST_CWD="$cwd" python - <<'PY' 2>/dev/null
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
  if exec {__CMUX_MENU_FD}<>/dev/tty 2>/dev/null; then
    :
  else
    __CMUX_MENU_FD=0
  fi
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
      if ! read -rsn1 -t 0.1 -u "$__CMUX_MENU_FD" k2; then
        __MENU_EVENT=esc; return
      fi
      read -rsn1 -t 0.1 -u "$__CMUX_MENU_FD" k3 || return
      case "${k2}${k3}" in
        '[A'|'OA') __MENU_EVENT=up ;;
        '[B'|'OB') __MENU_EVENT=down ;;
      esac
      ;;
    k|K) __MENU_EVENT=up ;;
    j|J) __MENU_EVENT=down ;;
    '') __MENU_EVENT=enter ;;
    q|Q) __MENU_EVENT=quit ;;
    /) __MENU_EVENT=slash ;;
    d|D) __MENU_EVENT=dirkey ;;
    a|A) __MENU_EVENT=ankenkey ;;
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

__pick_resume_session() {
  __open_menu_fd
  if ! command -v crsm >/dev/null 2>&1; then
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "  crsm command not found." >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  Press any key to return to menu." >&$__CMUX_MENU_FD
    IFS= read -rsn1 -u "$__CMUX_MENU_FD" _ || true
    return 1
  fi

  local __py
  if command -v python3 >/dev/null 2>&1; then
    __py=python3
  elif command -v python >/dev/null 2>&1; then
    __py=python
  else
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "  python not found." >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  Press any key to return to menu." >&$__CMUX_MENU_FD
    IFS= read -rsn1 -u "$__CMUX_MENU_FD" _ || true
    return 1
  fi

  printf "\033[H\033[2J" >&$__CMUX_MENU_FD
  echo "  Loading sessions..." >&$__CMUX_MENU_FD
  local __json __crsm_status=0
  __json="$(crsm list --json --limit 20 2>/dev/null)" || __crsm_status=$?
  if [ "$__crsm_status" -eq 0 ] && [[ "$__json" =~ ^[[:space:]]*\[[[:space:]]*\][[:space:]]*$ ]]; then
    __json="$(crsm list --all --json --limit 20 2>/dev/null)" || __crsm_status=$?
  fi
  if [ "$__crsm_status" -ne 0 ]; then
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "  crsm list failed." >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  Press any key to return to menu." >&$__CMUX_MENU_FD
    IFS= read -rsn1 -u "$__CMUX_MENU_FD" _ || true
    return 1
  fi

  local __pwd __tsv
  __pwd="$(pwd -W 2>/dev/null || pwd)"
  __tsv="$(MYCMUX_CRSM_JSON="$__json" MYCMUX_PICKER_CWD="$__pwd" "$__py" - <<'PY' 2>/dev/null
import json
import os
from datetime import datetime, timezone

def norm(path):
    path = (path or "").strip().replace("\\", "/")
    if len(path) >= 3 and path[0] == "/" and path[2] == "/":
        path = path[1].upper() + ":" + path[2:]
    while "//" in path:
        path = path.replace("//", "/")
    return path.rstrip("/").lower()

def rel_time(value):
    if not value:
        return "-"
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return "-"
    now = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    sec = max(0, int((now - dt.astimezone(timezone.utc)).total_seconds()))
    if sec < 60:
        return f"{sec}s ago"
    minutes = sec // 60
    if minutes < 60:
        return f"{minutes}m ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}h ago"
    return f"{hours // 24}d ago"

current = norm(os.environ.get("MYCMUX_PICKER_CWD", ""))
try:
    rows = json.loads(os.environ.get("MYCMUX_CRSM_JSON", "[]"))
except json.JSONDecodeError:
    rows = []
if not isinstance(rows, list):
    rows = []

prepared = []
for index, row in enumerate(rows):
    if not isinstance(row, dict):
        continue
    kind = str(row.get("kind") or "")
    sid = str(row.get("id") or "")
    cwd = str(row.get("cwd") or "")
    if kind not in {"claude", "codex", "claude-codex"} or not sid:
        continue
    label = str(row.get("label") or row.get("preview") or sid).replace("\t", " ").replace("\r", " ").replace("\n", " ")
    label = " ".join(label.split())
    prepared.append((0 if norm(cwd) == current else 1, index, kind, sid, cwd, rel_time(row.get("last_activity")), label[:90]))

for _, _, kind, sid, cwd, rel, label in sorted(prepared):
    print("\t".join([kind, sid, cwd, rel, label]))
PY
)"

  if [ -z "$__tsv" ]; then
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "  No resume sessions found." >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  Press any key to return to menu." >&$__CMUX_MENU_FD
    IFS= read -rsn1 -u "$__CMUX_MENU_FD" _ || true
    return 1
  fi

  local r_kinds=() r_ids=() r_cwds=() r_rels=() r_labels=()
  local r_kind r_id r_cwd r_rel r_label
  while IFS=$'\t' read -r r_kind r_id r_cwd r_rel r_label; do
    [ -z "$r_kind" ] && continue
    r_kinds+=("$r_kind")
    r_ids+=("$r_id")
    r_cwds+=("$r_cwd")
    r_rels+=("$r_rel")
    r_labels+=("$r_label")
  done <<< "$__tsv"

  local r_selected=0 r_count=${#r_ids[@]}
  if [ "$r_count" -eq 0 ]; then
    return 1
  fi

  __draw_resume_menu() {
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  Resume session:  [dir: $(pwd -W 2>/dev/null || pwd)]" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    local i num mark disp
    for i in "${!r_ids[@]}"; do
      num=$((i + 1))
      mark="  "
      [ $i -eq $r_selected ] && mark="> "
      disp="${r_cwds[$i]}"
      case "$disp" in "$HOME"*) disp="~${disp#$HOME}" ;; esac
      echo "${mark}${num}. ${r_kinds[$i]}  ${r_rels[$i]}  ${r_labels[$i]}" >&$__CMUX_MENU_FD
      echo "     ${disp}" >&$__CMUX_MENU_FD
    done
    echo "" >&$__CMUX_MENU_FD
    echo "  ^v: move   Enter/number: resume   Esc/q: back" >&$__CMUX_MENU_FD
  }

  __draw_resume_menu
  while true; do
    __read_menu_event
    case "$__MENU_EVENT" in
      eof|quit|esc) return 1 ;;
      up) ((r_selected--)); [ $r_selected -lt 0 ] && r_selected=$((r_count - 1)) ;;
      down) ((r_selected++)); [ $r_selected -ge $r_count ] && r_selected=0 ;;
      enter) break ;;
      digit)
        local n second
        n=$((__MENU_DIGIT - 1))
        if [ "$__MENU_DIGIT" = "1" ] || [ "$__MENU_DIGIT" = "2" ]; then
          if IFS= read -rsn1 -t 0.15 -u "$__CMUX_MENU_FD" second; then
            case "$second" in
              [0-9]) n=$((__MENU_DIGIT * 10 + second - 1)) ;;
            esac
          fi
        fi
        if [ $n -ge 0 ] && [ $n -lt $r_count ]; then
          r_selected=$n
          break
        fi
        ;;
    esac
    __draw_resume_menu
  done

  local kind="${r_kinds[$r_selected]}"
  local sid="${r_ids[$r_selected]}"
  local cwd="${r_cwds[$r_selected]}"
  [ -d "$cwd" ] && cd "$cwd" 2>/dev/null || true

  case "$kind" in
    claude)
      if __prepare_claude_resume "$sid"; then
        __trust_claude_cwd
        __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude" "$sid"
        eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --resume $sid"
      else
        __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
        eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --continue"
      fi
      ;;
    codex)
      __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "codex" "$sid"
      eval "codex resume --no-alt-screen $sid"
      ;;
    claude-codex)
      __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude-codex" "$sid"
      eval "claude-codex --resume $sid"
      ;;
  esac
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
  case "$MYCMUX_HANDOFF" in
    claude)
      __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude-handoff" "$MYCMUX_HANDOFF_FROM_SESSION"
      claude --allow-dangerously-skip-permissions --permission-mode auto "$__bootstrap"
      ;;
    codex)
      __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "codex-handoff" "$MYCMUX_HANDOFF_FROM_SESSION"
      codex --no-alt-screen "$__bootstrap"
      ;;
    claude-codex)
      __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude-codex-handoff" "$MYCMUX_HANDOFF_FROM_SESSION"
      claude-codex "$__bootstrap"
      ;;
  esac
  return 0 2>/dev/null || exit 0
fi

if [ -n "$MYCMUX_RESUME" ]; then
  case "$MYCMUX_RESUME" in
    claude-codex*)
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude-codex" "$MYCMUX_SESSION_ID"
        eval "claude-codex --resume $MYCMUX_SESSION_ID"
      else
        __track_claude_codex_session "$MYCMUX_PANE_SESSION_ID" &
        eval "claude-codex --continue"
      fi
      ;;
    claude*)
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        if __prepare_claude_resume "$MYCMUX_SESSION_ID"; then
          __trust_claude_cwd
          __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude" "$MYCMUX_SESSION_ID"
          eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --resume $MYCMUX_SESSION_ID"
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
  esac
  return 0 2>/dev/null || exit 0
fi

if [ -n "$MYCMUX_LAUNCH_TARGET" ]; then
  case "$MYCMUX_LAUNCH_TARGET" in
    claude)
      cmd="claude --allow-dangerously-skip-permissions --permission-mode auto"
      ;;
    claude-resume)
      cmd="claude --allow-dangerously-skip-permissions --permission-mode auto --resume"
      ;;
    claude-dangerous)
      cmd="claude --dangerously-skip-permissions --permission-mode bypassPermissions"
      ;;
    codex)
      cmd="codex --no-alt-screen"
      ;;
    codex-resume)
      cmd="codex resume --no-alt-screen"
      ;;
    codex-dangerous)
      cmd="codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox"
      ;;
    claude-codex)
      cmd="claude-codex"
      ;;
    claude-codex-resume)
      cmd="claude-codex --resume"
      ;;
    claude-codex-dangerous)
      cmd="claude-codex --dangerously-skip-permissions --permission-mode bypassPermissions"
      ;;
    codex-fugu-ultra)
      cmd="codex --no-alt-screen --profile fugu-ultra"
      ;;
    claude-codex-fugu)
      cmd="claude-codex --backend fugu"
      ;;
    custom)
      cmd="__custom__"
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

# d / a キーで出るディレクトリ選択。候補は ~/.mycmux/launch-roots.txt (name|path 形式)。
# 表示名が「案件」始まりの行は案件メニュー (a / 16)、それ以外は開発メニュー (d / 15) に出る。
# 選択で cd してメインメニューに戻る。以降の起動はそのディレクトリで行われるため、
# Claude Code はそのリポジトリの CLAUDE.md / プロジェクト履歴を持つセッションになる。
__ROOTS_FILE="$HOME/.mycmux/launch-roots.txt"

# 案件メニューを開いたとき、最終更新が3時間より古ければ裏で再生成を蹴る (走査2〜3分・
# 表示は現行リストのまま待たせない。次にメニューを開いた時に新しくなっている)。
__refresh_anken_roots_bg() {
  local log="$HOME/.mycmux/launch-roots-anken.log"
  local lock="$HOME/.mycmux/launch-roots-anken.lock"
  local script="$HOME/.claude/scripts/update_launch_anken.py"
  [ -f "$script" ] || return 0
  command -v python >/dev/null 2>&1 || return 0
  # 3時間以内に更新済みなら何もしない / 15分以内のロックがあれば実行中と見なす
  [ -n "$(find "$log" -mmin -180 2>/dev/null)" ] && return 0
  [ -n "$(find "$lock" -mmin -15 2>/dev/null)" ] && return 0
  touch "$lock"
  ( python "$script" >/dev/null 2>&1; rm -f "$lock" ) &
  disown 2>/dev/null || true
}

__select_launch_root() {
  local r_mode="${1:-dev}"
  [ "$r_mode" = "anken" ] && __refresh_anken_roots_bg
  __open_menu_fd
  local r_names=() r_paths=()
  if [ "$r_mode" = "dev" ]; then
    r_names+=("Home"); r_paths+=("$HOME")
  fi
  if [ -f "$__ROOTS_FILE" ]; then
    local name path
    while IFS='|' read -r name path; do
      case "$name" in ''|'#'*) continue ;; esac
      [ -z "$path" ] && continue
      case "$name" in
        案件*)
          [ "$r_mode" = "anken" ] || continue
          name="${name#案件: }"; name="${name#案件:}"
          ;;
        *)
          [ "$r_mode" = "dev" ] || continue
          ;;
      esac
      r_names+=("$name"); r_paths+=("$path")
    done < "$__ROOTS_FILE"
  fi
  if [ ${#r_names[@]} -eq 0 ]; then
    r_names=("(候補なし — python ~/.claude/scripts/update_launch_anken.py で生成)")
    r_paths=(".")
  fi
  local r_title="開発  (edit ~/.mycmux/launch-roots.txt)"
  [ "$r_mode" = "anken" ] && r_title="案件  (自動更新: update_launch_anken.py・週次月曜)"
  local r_selected=0 r_count=${#r_names[@]}
  __draw_root_menu() {
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  Launch directory — ${r_title}" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    local i disp
    for i in "${!r_names[@]}"; do
      local num=$((i + 1))
      local mark="  "
      [ $i -eq $r_selected ] && mark="> "
      disp="${r_paths[$i]}"
      case "$disp" in *事務関係/*) disp="…/${disp#*事務関係/}" ;; esac
      echo "${mark}${num}. ${r_names[$i]}  (${disp})" >&$__CMUX_MENU_FD
    done
    echo "" >&$__CMUX_MENU_FD
    echo "  ^v: move   Enter/number: select   Esc/q: back" >&$__CMUX_MENU_FD
  }
  __draw_root_menu
  while true; do
    __read_menu_event
    case "$__MENU_EVENT" in
      eof|quit|esc) return ;;
      up) ((r_selected--)); [ $r_selected -lt 0 ] && r_selected=$((r_count - 1)) ;;
      down) ((r_selected++)); [ $r_selected -ge $r_count ] && r_selected=0 ;;
      enter) break ;;
      digit)
        if [ "$__MENU_DIGIT" != "0" ]; then
          local n=$((__MENU_DIGIT - 1))
          [ $n -lt $r_count ] && { r_selected=$n; break; }
        fi
        ;;
    esac
    __draw_root_menu
  done
  cd "${r_paths[$r_selected]}" 2>/dev/null || true
}

if [ -z "$cmd" ]; then
  __open_menu_fd
  options=(
    "Claude Code"
    "Codex"
    "claude-codex"
    "Claude Code (dangerous)"
    "Codex (dangerous)"
    "claude-codex (dangerous)"
    "Claude Code (resume)"
    "Codex (resume)"
    "claude-codex (resume)"
    "Resume (pick session)"
    "Codex (Fugu Ultra)"
    "claude-codex (Fugu)"
    "Antigravity (agy)"
    "Custom..."
    "Change directory (開発)..."
    "Change directory (案件)..."
  )

  commands=(
    "claude --allow-dangerously-skip-permissions --permission-mode auto"
    "codex --no-alt-screen"
    "claude-codex"
    "claude --dangerously-skip-permissions --permission-mode bypassPermissions"
    "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox"
    "claude-codex --dangerously-skip-permissions --permission-mode bypassPermissions"
    "claude --allow-dangerously-skip-permissions --permission-mode auto --resume"
    "codex resume --no-alt-screen"
    "claude-codex --resume"
    "__resume_pick__"
    "codex --no-alt-screen --profile fugu-ultra"
    "claude-codex --backend fugu"
    "agy"
    "__custom__"
    "__dir__"
    "__dir_anken__"
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
    echo "  ^v: move   Enter/number: select   d: 開発dir   a: 案件dir   /: custom   Esc/q: shell" >&$__CMUX_MENU_FD
  }

  __try_selected_menu_command() {
    if [ "${commands[$selected]}" = "__resume_pick__" ]; then
      tput cnorm >&$__CMUX_MENU_FD 2>/dev/null
      if __pick_resume_session; then
        return 2
      fi
      tput civis >&$__CMUX_MENU_FD 2>/dev/null
      draw_menu
      return 0
    fi
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
        if [ $selected -eq $((count - 1)) ]; then
          # 最下段 "Change directory (案件)..." — a キーと同じ動作。戻ったら先頭 (Claude Code) に選択を戻す
          __select_launch_root anken
          selected=0
        elif [ $selected -eq $((count - 2)) ]; then
          # "Change directory (開発)..." — d キーと同じ動作
          __select_launch_root dev
          selected=0
        else
          __try_selected_menu_command
          __try_status=$?
          if [ $__try_status -eq 0 ]; then
            continue
          elif [ $__try_status -eq 2 ]; then
            return 0 2>/dev/null || exit 0
          fi
          break
        fi
        ;;
      slash) selected=13; break ;;
      dirkey) __select_launch_root dev ;;
      ankenkey) __select_launch_root anken ;;
      digit)
        case "$__MENU_DIGIT" in
          1)
            if IFS= read -rsn1 -t 0.15 -u "$__CMUX_MENU_FD" k2; then
              case "$k2" in
                0) selected=9 ;;
                1) selected=10 ;;
                2) selected=11 ;;
                3) selected=12 ;;
                4) selected=13 ;;
                5) __select_launch_root dev; selected=0; draw_menu; continue ;;
                6) __select_launch_root anken; selected=0; draw_menu; continue ;;
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
  case "$cmd" in __dir__|__dir_anken__|__resume_pick__) cmd="" ;; esac
fi

if [ "$cmd" = "__custom__" ]; then
  __prompt_custom_command
  if [ -z "$cmd" ]; then
    return 0 2>/dev/null || exit 0
  fi
fi

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
  __track_command_session "$cmd" "$MYCMUX_PANE_SESSION_ID"
  if [ -n "${__CMUX_MENU_FD:-}" ]; then
    echo "Starting..." >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
  fi
  eval "$cmd"
fi

[ -f "$HOME/.mycmux/bin/launcher.local.sh" ] && . "$HOME/.mycmux/bin/launcher.local.sh" || true
