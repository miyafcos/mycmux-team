#!/bin/bash
# Terminal launcher — arrow keys, j/k, or number keys
# Called from .bashrc (CMux/WezTerm detection)
# Do NOT source .bashrc here — already sourced by caller

# --- Session tracking helpers ---
# Write pane-session-id → tool-session-id mapping to ~/.mycmux/pane-sessions/
__write_session_mapping() {
  local pane_id="$1"
  local session_id="$2"
  [ -z "$pane_id" ] || [ -z "$session_id" ] && return
  local map_dir="$HOME/.mycmux/pane-sessions"
  mkdir -p "$map_dir" 2>/dev/null
  echo "$session_id" > "$map_dir/$pane_id.txt"
}

# Track Claude session: find most recently modified JSONL in project dir
__track_claude_session() {
  local pane_id="$1"
  [ -z "$pane_id" ] && return

  local project_dir
  project_dir=$(__get_claude_project_dir)
  [ ! -d "$project_dir" ] && return

  sleep 4
  local latest
  latest=$(ls -t "$project_dir"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$latest" ]; then
    __write_session_mapping "$pane_id" "$(basename "$latest" .jsonl)"
  fi
}

# Track Codex session: find most recently modified rollout JSONL
__track_codex_session() {
  local pane_id="$1"
  [ -z "$pane_id" ] && return

  local sessions_dir="$HOME/.codex/sessions"
  [ ! -d "$sessions_dir" ] && return

  sleep 4
  # Codex stores sessions as: sessions/YYYY/MM/DD/rollout-{timestamp}-{UUID}.jsonl
  # Find the most recently modified one across all date dirs
  local latest
  latest=$(find "$sessions_dir" -name "rollout-*.jsonl" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
  if [ -z "$latest" ]; then
    # Git Bash fallback (no -printf)
    latest=$(find "$sessions_dir" -name "rollout-*.jsonl" -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
  fi
  if [ -n "$latest" ]; then
    # Extract UUID from filename: rollout-YYYY-MM-DDTHH-MM-SS-{UUID}.jsonl
    local fname
    fname=$(basename "$latest" .jsonl)
    # UUID is the last 36 characters before .jsonl (standard UUID length)
    local uuid
    uuid=$(echo "$fname" | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    if [ -n "$uuid" ]; then
      __write_session_mapping "$pane_id" "$uuid"
    fi
  fi
}

# Compute Claude project dir from CWD
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

# --- Auto-resume from env var (set by mycmux for restored sessions) ---
if [ -n "$MYCMUX_RESUME" ]; then
  case "$MYCMUX_RESUME" in
    claude*)
      __track_claude_session "$MYCMUX_PANE_SESSION_ID" &

      if [ -n "$MYCMUX_SESSION_ID" ]; then
        eval "claude --allow-dangerously-skip-permissions --permission-mode auto --resume $MYCMUX_SESSION_ID"
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

# --- Auto-restore: check if mycmux saved a restore manifest for this CWD ---
__RESTORE_FILE="$HOME/.mycmux/restore.json"
if [ -f "$__RESTORE_FILE" ]; then
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
            if 'claude' in proc:
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
    echo -e "\033[90mAuto-resuming: $__RESTORE_CMD\033[0m"
    eval "$__RESTORE_CMD"
    return 0 2>/dev/null || exit 0
  fi
fi

# --- Interactive launcher menu ---
options=(
  "Claude Code"
  "Claude Code (resume)"
  "Claude Code (auto-mode)"
  "Codex"
  "Codex (resume)"
  "Custom..."
)

commands=(
  "claude --allow-dangerously-skip-permissions --permission-mode auto"
  "claude --allow-dangerously-skip-permissions --permission-mode auto --resume"
  "claude --allow-dangerously-skip-permissions --permission-mode auto --enable-auto-mode"
  "codex"
  "codex resume"
  "__custom__"
)

selected=0
count=${#options[@]}

tput civis 2>/dev/null
trap 'tput cnorm 2>/dev/null' EXIT

draw_menu() {
  printf "\033[H\033[2J"
  echo ""
  echo -e "  \033[1;36m Launch:\033[0m"
  echo ""
  for i in "${!options[@]}"; do
    local num=$((i + 1))
    if [ $i -eq $selected ]; then
      echo -e "  \033[1;32m▸ ${num}. ${options[$i]}\033[0m"
    else
      echo -e "    ${num}. ${options[$i]}"
    fi
  done
  echo ""
  echo -e "  \033[90m↑↓/j/k move  Enter/number select  / custom  q shell\033[0m"
}

draw_menu

while true; do
  IFS= read -rsn1 key
  case "$key" in
    $'\x1b')
      read -rsn1 -t 0.1 k2
      read -rsn1 -t 0.1 k3
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
    6|/) selected=5; break ;;
    '') break ;;
    q|Q) tput cnorm 2>/dev/null; return 0 2>/dev/null || exit 0 ;;
  esac
  draw_menu
done

tput cnorm 2>/dev/null
printf "\033[H\033[2J"

cmd="${commands[$selected]}"

if [ "$cmd" = "__custom__" ]; then
  echo -e "  \033[1;36mCommand:\033[0m (e.g. claude --resume sid:xxx, codex resume --last)"
  echo ""
  read -rep "  > " cmd
  if [ -z "$cmd" ]; then
    return 0 2>/dev/null || exit 0
  fi
fi

if [ -n "$cmd" ]; then
  # Track session for launches from menu too
  if [ -n "$MYCMUX_PANE_SESSION_ID" ]; then
    if [[ "$cmd" == *"claude"* ]]; then
      __track_claude_session "$MYCMUX_PANE_SESSION_ID" &
    elif [[ "$cmd" == *"codex"* ]]; then
      __track_codex_session "$MYCMUX_PANE_SESSION_ID" &
    fi
  fi
  echo -e "\033[90mStarting...\033[0m"
  echo ""
  eval "$cmd"
fi
