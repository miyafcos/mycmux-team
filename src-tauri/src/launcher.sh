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
      cmd="claude-codex --backend gpt"
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
    claude-codex-open|fcc|fcc-claude)
      cmd="claude-codex --backend fcc"
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

# ディレクトリ選択。候補は ~/.mycmux/launch-roots.txt (name|path 形式)。
# 表示名が「案件」始まりの行は案件セクション、それ以外は開発セクションに出る。
# 選択で cd してメインメニューに戻る。以降の起動はそのディレクトリで行われるため、
# Claude Code はそのリポジトリの CLAUDE.md / プロジェクト履歴を持つセッションになる。
#
# 操作は上下キー + Enter で完結させる。→ でも決定、← でも復帰。ホイールは当てにしない
# (mycmux の wheel→PTY 合成は alternate screen のときだけ通るので、通常バッファに描く
#  このメニューには届かない。届くのはスクロールバック操作だけ)。
__ROOTS_FILE="$HOME/.mycmux/launch-roots.txt"
__DIR_MRU_FILE="$HOME/.mycmux/launch-dirs-mru.txt"

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
  __NORM_RESULT="${p,,}"
}

__norm_path() {
  __norm_path_into "$1"
  echo "$__NORM_RESULT"
}

# 表示用の短縮 (案件は 事務関係/ 以降、ホーム配下は ~ 起点)。
__short_path_into() {
  local p="${1//\\//}"
  case "$p" in
    *事務関係/*) __SHORT_RESULT="…/${p#*事務関係/}"; return ;;
  esac
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
      if ! read -rsn1 -t 0.1 -u "$__CMUX_MENU_FD" k2; then
        __PICK_EVENT=esc; return
      fi
      case "$k2" in
        '['|'O') ;;
        *) __PICK_EVENT=esc; return ;;
      esac
      read -rsn1 -t 0.1 -u "$__CMUX_MENU_FD" k3 || { __PICK_EVENT=esc; return; }
      case "$k3" in
        A) __PICK_EVENT=up ;;
        B) __PICK_EVENT=down ;;
        C) __PICK_EVENT=enter ;;
        D) __PICK_EVENT=esc ;;
        H) __PICK_EVENT=home ;;
        F) __PICK_EVENT=end ;;
        5) read -rsn1 -t 0.1 -u "$__CMUX_MENU_FD" k4; __PICK_EVENT=pgup ;;
        6) read -rsn1 -t 0.1 -u "$__CMUX_MENU_FD" k4; __PICK_EVENT=pgdn ;;
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
    local idx hay
    for idx in "${!__PICK_LABELS[@]}"; do
      if [ -z "$p_query" ]; then
        p_view+=("$idx")
        continue
      fi
      hay="${__PICK_LABELS[$idx]} ${__PICK_PATHS[$idx]}"
      if [[ "${hay,,}" == *"${p_query,,}"* ]]; then
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
      __refresh_anken_roots_bg
      __load_roots_section anken
      r_title="案件  (自動更新: update_launch_anken.py)"
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
      r_title="開発  (edit ~/.mycmux/launch-roots.txt)"
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
    "Codex (Fugu Ultra)"
    "claude-codex (Fugu)"
    "claude-codex (Open Models)"
    "Antigravity (agy)"
    "Claude Code (dangerous)"
    "Codex (dangerous)"
    "claude-codex (dangerous)"
    "Claude Code (resume)"
    "Codex (resume)"
    "claude-codex (resume)"
    "Custom..."
    "Change directory (開発)..."
    "Change directory (案件)..."
    "Change directory (最近・フォルダを辿る)..."
  )

  commands=(
    "claude --allow-dangerously-skip-permissions --permission-mode auto"
    "codex --no-alt-screen"
    "claude-codex --backend gpt"
    "codex --no-alt-screen --profile fugu-ultra"
    "claude-codex --backend fugu"
    "claude-codex --backend fcc"
    "agy"
    "claude --dangerously-skip-permissions --permission-mode bypassPermissions"
    "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox"
    "claude-codex --dangerously-skip-permissions --permission-mode bypassPermissions"
    "claude --allow-dangerously-skip-permissions --permission-mode auto --resume"
    "codex resume --no-alt-screen"
    "claude-codex --resume"
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
    echo "  ^v: move   Enter/number: select   d: 開発dir   a: 案件dir   /: custom   Esc/q: shell" >&$__CMUX_MENU_FD
  }

  # 選択中の項目がメニュー内で完結するものなら処理して 0 (メニュー継続) か 2 (起動済み) を返す。
  # 1 を返したときだけ呼び出し側が break して cmd を eval する。
  __try_selected_menu_command() {
    case "${commands[$selected]}" in
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
      slash) selected=13; break ;;
      dirkey) __launch_dir_menu dev ;;
      ankenkey) __launch_dir_menu anken ;;
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
                5) selected=14 ;;
                6) selected=15 ;;
                7) selected=16 ;;
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
  # agy (Antigravity CLI) hardcodes light-background ANSI/256-color escapes and
  # never queries the terminal background (OSC 11); mycmux's ANSI theme cannot
  # patch the truecolor/256-color output it emits directly, and agy has no
  # --theme/--no-color flag (confirmed on agy 1.1.11). NO_COLOR=1 is the only
  # known mitigation. Scope it to this one invocation only (VAR=val cmd, not
  # export) — this script is sourced from .bashrc and the shell that follows
  # `eval` is the same process (the caller execs bash -i into it), so an
  # exported NO_COLOR would keep suppressing colors for ls/git/etc. after agy
  # exits.
  __eval_cmd="$cmd"
  case "$cmd" in
    agy|agy\ *|gemini|gemini\ *|antigravity|antigravity\ *)
      __eval_cmd="NO_COLOR=1 $cmd"
      ;;
  esac
  eval "$__eval_cmd"
fi

[ -f "$HOME/.mycmux/bin/launcher.local.sh" ] && . "$HOME/.mycmux/bin/launcher.local.sh" || true
