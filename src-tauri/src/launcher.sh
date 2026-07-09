#!/bin/bash
# Terminal launcher - arrow keys, j/k, or number keys
# Called from .bashrc

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

__get_claude_project_dir() {
  local cwd
  cwd="$(pwd)"
  if [[ "$cwd" =~ ^/([a-zA-Z])/ ]]; then
    cwd="${BASH_REMATCH[1]^^}:${cwd:2}"
  fi
  local mangled
  mangled=$(echo "$cwd" | sed 's|[:\\/]|-|g')
  echo "$HOME/.claude/projects/$mangled"
}

__get_claude_codex_project_dir() {
  local cwd
  cwd="$(pwd)"
  if [[ "$cwd" =~ ^/([a-zA-Z])/ ]]; then
    cwd="${BASH_REMATCH[1]^^}:${cwd:2}"
  fi
  local mangled
  mangled=$(echo "$cwd" | sed 's|[:\\/]|-|g')
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
  local __json
  if ! __json="$(crsm list --json --limit 20 2>/dev/null)"; then
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
  __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "$kind" "$sid"
  [ -d "$cwd" ] && cd "$cwd" 2>/dev/null || true

  case "$kind" in
    claude)
      __trust_claude_cwd
      local __project_dir
      __project_dir=$(__get_claude_project_dir)
      if [ -f "$__project_dir/$sid.jsonl" ]; then
        eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --resume $sid"
      else
        __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
        eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --continue"
      fi
      ;;
    codex)
      eval "codex resume --no-alt-screen $sid"
      ;;
    claude-codex)
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
      __trust_claude_cwd
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude" "$MYCMUX_SESSION_ID"
        # Validate session file still exists before resume
        __project_dir=
        __project_dir=$(__get_claude_project_dir)
        if [ -f "$__project_dir/$MYCMUX_SESSION_ID.jsonl" ]; then
          eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --resume $MYCMUX_SESSION_ID"
        else
          __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
          eval "claude --dangerously-skip-permissions --permission-mode bypassPermissions --continue"
        fi
      else
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
    gemini)
      cmd="gemini"
      ;;
    aider)
      cmd="aider"
      ;;
    shell)
      return 0 2>/dev/null || exit 0
      ;;
  esac
fi


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
    "Custom..."
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
    "__custom__"
  )

  selected=0
  count=${#options[@]}
  tput civis >&$__CMUX_MENU_FD 2>/dev/null
  trap 'tput cnorm >&$__CMUX_MENU_FD 2>/dev/null' EXIT

  draw_menu() {
    printf "\033[H\033[2J" >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
    echo "  Launch:" >&$__CMUX_MENU_FD
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
    echo "  Up/Down or j/k move  Enter/number select  / custom  q shell" >&$__CMUX_MENU_FD
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
    if ! IFS= read -rsn1 -u "$__CMUX_MENU_FD" key; then
      tput cnorm >&$__CMUX_MENU_FD 2>/dev/null
      return 0 2>/dev/null || exit 0
    fi
    case "$key" in
      $'\x1b')
        read -rsn1 -t 0.1 -u "$__CMUX_MENU_FD" k2
        read -rsn1 -t 0.1 -u "$__CMUX_MENU_FD" k3
        case "${k2}${k3}" in
          '[A'|'OA') ((selected--)); [ $selected -lt 0 ] && selected=$((count - 1)) ;;
          '[B'|'OB') ((selected++)); [ $selected -ge $count ] && selected=0 ;;
        esac
        ;;
      k|K) ((selected--)); [ $selected -lt 0 ] && selected=$((count - 1)) ;;
      j|J) ((selected++)); [ $selected -ge $count ] && selected=0 ;;
      1)
        if IFS= read -rsn1 -t 0.15 -u "$__CMUX_MENU_FD" k2; then
          case "$k2" in
            0) selected=9 ;;
            1) selected=10 ;;
            2) selected=11 ;;
            3) selected=12 ;;
            *) selected=0 ;;
          esac
        else
          selected=0
        fi
        __try_selected_menu_command
        __try_status=$?
        [ $__try_status -eq 0 ] && continue
        [ $__try_status -eq 2 ] && { return 0 2>/dev/null || exit 0; }
        break
        ;;
      2) selected=1; break ;;
      3) selected=2; break ;;
      4) selected=3; break ;;
      5) selected=4; break ;;
      6) selected=5; break ;;
      7) selected=6; break ;;
      8) selected=7; break ;;
      9) selected=8; break ;;
      0)
        selected=9
        __try_selected_menu_command
        __try_status=$?
        [ $__try_status -eq 0 ] && continue
        [ $__try_status -eq 2 ] && { return 0 2>/dev/null || exit 0; }
        break
        ;;
      /) selected=12; break ;;
      '')
        __try_selected_menu_command
        __try_status=$?
        [ $__try_status -eq 0 ] && continue
        [ $__try_status -eq 2 ] && { return 0 2>/dev/null || exit 0; }
        break
        ;;
      q|Q) tput cnorm >&$__CMUX_MENU_FD 2>/dev/null; return 0 2>/dev/null || exit 0 ;;
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
