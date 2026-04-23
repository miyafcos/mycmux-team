#!/bin/bash
# Terminal launcher - arrow keys, j/k, or number keys
# Called from .bashrc

__write_session_mapping() {
  local pane_id="$1"
  local session_id="$2"
  [ -z "$pane_id" ] || [ -z "$session_id" ] && return
  local map_dir="$HOME/.mycmux-lite/pane-sessions"
  mkdir -p "$map_dir" 2>/dev/null
  echo "$session_id" > "$map_dir/$pane_id.txt"
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
  [ -z "$pane_id" ] && return
  [ ! -d "$project_dir" ] && return

  sleep 4
  local latest
  latest=$(ls -t "$project_dir"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$latest" ]; then
    __write_session_mapping "$pane_id" "$(basename "$latest" .jsonl)"
  fi
}

__track_claude_session() {
  __track_latest_jsonl_in_dir "$1" "$(__get_claude_project_dir)"
}

__track_claude_codex_session() {
  __track_latest_jsonl_in_dir "$1" "$(__get_claude_codex_project_dir)"
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
      __write_session_mapping "$pane_id" "$uuid"
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

cmd=""

if [ -n "$MYCMUX_RESUME" ]; then
  case "$MYCMUX_RESUME" in
    claude-codex*)
      __track_claude_codex_session "$MYCMUX_PANE_SESSION_ID" &
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        eval "claude-codex --resume $MYCMUX_SESSION_ID"
      else
        eval "claude-codex --continue"
      fi
      ;;
    claude*)
      __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        # Validate session file still exists before resume
        local __project_dir
        __project_dir=$(__get_claude_project_dir)
        if [ -f "$__project_dir/$MYCMUX_SESSION_ID.jsonl" ]; then
          eval "claude --allow-dangerously-skip-permissions --permission-mode auto --resume $MYCMUX_SESSION_ID"
        else
          eval "claude --allow-dangerously-skip-permissions --permission-mode auto --continue"
        fi
      else
        eval "claude --allow-dangerously-skip-permissions --permission-mode auto --continue"
      fi
      ;;
    codex*)
      __track_codex_session "$MYCMUX_PANE_SESSION_ID" &
      if [ -n "$MYCMUX_SESSION_ID" ]; then
        eval "codex resume $MYCMUX_SESSION_ID"
      else
        eval "codex resume --last"
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
    claude-auto-mode)
      cmd="claude --allow-dangerously-skip-permissions --permission-mode auto --enable-auto-mode"
      ;;
    codex)
      cmd="codex"
      ;;
    codex-resume)
      cmd="codex resume"
      ;;
    claude-codex)
      cmd="claude-codex"
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
                print('codex resume --last')
            sys.exit(0)
except FileNotFoundError:
    pass
except Exception as e:
    print(f'restore error: {e}', file=sys.stderr)
" 2>/dev/null)

  if [ -n "$__RESTORE_CMD" ]; then
    eval "$__RESTORE_CMD"
    return 0 2>/dev/null || exit 0
  fi
fi

if [ -z "$cmd" ]; then
  __open_menu_fd
  options=(
    "Claude Code"
    "Claude Code (resume)"
    "Claude Code (auto-mode)"
    "Codex"
    "Codex (resume)"
    "claude-codex"
    "Custom..."
  )

  commands=(
    "claude --allow-dangerously-skip-permissions --permission-mode auto"
    "claude --allow-dangerously-skip-permissions --permission-mode auto --resume"
    "claude --allow-dangerously-skip-permissions --permission-mode auto --enable-auto-mode"
    "codex"
    "codex resume"
    "claude-codex"
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
      7|/) selected=6; break ;;
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
  __track_command_session "$cmd" "$MYCMUX_PANE_SESSION_ID"
  if [ -n "${__CMUX_MENU_FD:-}" ]; then
    echo "Starting..." >&$__CMUX_MENU_FD
    echo "" >&$__CMUX_MENU_FD
  fi
  eval "$cmd"
fi
