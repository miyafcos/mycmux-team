#!/bin/bash
# Terminal launcher - arrow keys, j/k, or number keys
# Called from .bashrc

__write_session_mapping() {
  local pane_id="$1"
  local kind="$2"
  local session_id="$3"
  [ -z "$pane_id" ] || [ -z "$session_id" ] && return
  local map_dir="$HOME/.mycmux-lite/pane-sessions"
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
  if [ -n "$MYCMUX_TAB_ID" ]; then
    echo "$MYCMUX_TAB_ID"
  else
    __make_uuid
  fi
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
tmp_path = path.with_suffix(".json.mycmux-lite.tmp")
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
  echo "  Command: (e.g. claude --resume sid:xxx, codex resume --no-alt-screen --last)" >&$__CMUX_MENU_FD
  echo "" >&$__CMUX_MENU_FD
  printf "  > " >&$__CMUX_MENU_FD
  IFS= read -ru "$__CMUX_MENU_FD" cmd
}

cmd=""

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
          eval "claude --allow-dangerously-skip-permissions --permission-mode auto --resume $MYCMUX_SESSION_ID"
        else
          __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
          eval "claude --allow-dangerously-skip-permissions --permission-mode auto --continue"
        fi
      else
        __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
        eval "claude --allow-dangerously-skip-permissions --permission-mode auto --continue"
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

__RESTORE_FILE="$HOME/.mycmux-lite/restore.json"
if [ -z "$cmd" ] && [ -f "$__RESTORE_FILE" ]; then
  __CWD="$(pwd)"
  __RESTORE_CMD=$(python -c "
import json, sys
try:
    with open(r'${__RESTORE_FILE}') as f:
        data = json.load(f)
    cwd = '${__CWD}'.replace('\\\\', '/').rstrip('/').lower()
    if cwd.startswith('/') and len(cwd) > 2 and cwd[2] == '/':
        cwd = cwd[1] + ':' + cwd[2:]
    for key in data:
        k = key.replace('\\\\', '/').rstrip('/').lower()
        if k == cwd:
            proc = (data[key] or '').lower()
            if 'claude-codex' in proc:
                print('claude-codex --continue')
            elif 'claude' in proc:
                print('claude --allow-dangerously-skip-permissions --permission-mode auto --continue')
            elif 'codex' in proc:
                print('codex resume --no-alt-screen --last')
            sys.exit(0)
except FileNotFoundError:
    pass
except Exception as e:
    print(f'restore error: {e}', file=sys.stderr)
" 2>/dev/null)

  if [ -n "$__RESTORE_CMD" ]; then
    if [[ "$__RESTORE_CMD" == claude\ * ]]; then
      __trust_claude_cwd
    fi
    eval "$__RESTORE_CMD"
    return 0 2>/dev/null || exit 0
  fi
fi

if [ -z "$cmd" ]; then
  __open_menu_fd
  options=(
    "Claude Code"
    "Claude Code (resume)"
    "Claude Code (dangerous)"
    "Codex"
    "Codex (resume)"
    "Codex (dangerous)"
    "claude-codex"
    "claude-codex (resume)"
    "Custom..."
  )

  commands=(
    "claude --allow-dangerously-skip-permissions --permission-mode auto"
    "claude --allow-dangerously-skip-permissions --permission-mode auto --resume"
    "claude --dangerously-skip-permissions --permission-mode bypassPermissions"
    "codex --no-alt-screen"
    "codex resume --no-alt-screen"
    "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox"
    "claude-codex"
    "claude-codex --resume"
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
      1) selected=0; break ;;
      2) selected=1; break ;;
      3) selected=2; break ;;
      4) selected=3; break ;;
      5) selected=4; break ;;
      6) selected=5; break ;;
      7) selected=6; break ;;
      8) selected=7; break ;;
      9|/) selected=8; break ;;
      '') break ;;
      q|Q) tput cnorm >&$__CMUX_MENU_FD 2>/dev/null; return 0 2>/dev/null || exit 0 ;;
    esac
    draw_menu
  done

  tput cnorm >&$__CMUX_MENU_FD 2>/dev/null
  printf "\033[H\033[2J" >&$__CMUX_MENU_FD
  cmd="${commands[$selected]}"
fi

if [ "$cmd" = "__custom__" ]; then
  __prompt_custom_command
  if [ -z "$cmd" ]; then
    return 0 2>/dev/null || exit 0
  fi
fi

if [ -n "$cmd" ]; then
  if [[ "$cmd" == claude\ * ]]; then
    __trust_claude_cwd
  fi
  if [[ "$cmd" == claude\ --dangerously-skip-permissions* || "$cmd" == claude\ --allow-dangerously-skip-permissions* ]] && [[ "$cmd" != *"--resume"* ]] && [[ "$cmd" != *"--continue"* ]] && [[ "$cmd" != *"--session-id"* ]]; then
    __sid="$(__stable_new_session_id)"
    if [ -n "$__sid" ]; then
      __write_session_mapping "$MYCMUX_PANE_SESSION_ID" "claude" "$__sid"
      cmd="$cmd --session-id $__sid"
    fi
  fi
  __track_command_session "$cmd" "$MYCMUX_PANE_SESSION_ID"
  if [ -n "${__CMUX_MENU_FD:-}" ]; then
    echo "Starting..." >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
  fi
  eval "$cmd"
fi
