#!/usr/bin/env bash
# mycmux パフォーマンス計測 (Mac 専用)
# Usage: ./scripts/measure-mac.sh [label]
# 出力: /tmp/mycmux-measure-<label>-<timestamp>.json
#
# 計測項目:
#  - launch_time_sec: open から最初の window が現れるまで
#  - rss_kb_initial: 起動直後の常駐メモリ
#  - rss_kb_after_30s_idle: アイドル 30 秒後の常駐メモリ
#  - cpu_pct_initial: 起動直後の瞬時 CPU%
#  - idle_30s_cpu_sec: アイドル 30 秒間の累積 CPU 時間
#
# Coverage boundary: this is the macOS substitute for basic launch/RSS/CPU
# sampling only. The Windows-only scripts/perf tools additionally inspect
# WebView2 paint and AILog/UI flows, which have no WKWebView-equivalent metric.

set -uo pipefail

LABEL="${1:-baseline}"
TS=$(date +%Y%m%d-%H%M%S)
OUTFILE="/tmp/mycmux-measure-${LABEL}-${TS}.json"
APP_PATH="/Applications/mycmux.app"
EXE_PATH="$APP_PATH/Contents/MacOS/mycmux"

if [ ! -d "$APP_PATH" ]; then
    echo "ERROR: $APP_PATH not found" >&2
    exit 1
fi

echo "=== mycmux measurement: ${LABEL} ===" >&2

pkill -f "$APP_PATH" 2>/dev/null
sleep 2

START=$(python3 -c 'import time; print(time.time())')
open "$APP_PATH"

WINDOW_READY_AT=""
DEADLINE=$((SECONDS + 30))
while [ $SECONDS -lt $DEADLINE ]; do
    if osascript -e 'tell application "System Events" to tell process "mycmux" to count windows' 2>/dev/null | grep -q "^1$"; then
        WINDOW_READY_AT=$(python3 -c 'import time; print(time.time())')
        break
    fi
    sleep 0.2
done

if [ -z "$WINDOW_READY_AT" ]; then
    echo "WARN: window did not appear within 30s" >&2
    LAUNCH_TIME="null"
else
    LAUNCH_TIME=$(python3 -c "print(round($WINDOW_READY_AT - $START, 3))")
    echo "launch_time_sec: $LAUNCH_TIME" >&2
fi

PID=$(pgrep -f "$EXE_PATH" | head -1)
if [ -z "$PID" ]; then
    echo "ERROR: mycmux PID not found" >&2
    exit 1
fi
echo "PID: $PID" >&2

RSS_KB=$(ps -o rss= -p $PID | tr -d ' ')
CPU_PCT_INIT=$(ps -o %cpu= -p $PID | tr -d ' ')
echo "initial RSS=${RSS_KB}KB CPU=${CPU_PCT_INIT}%" >&2

CPU_TIME_BEFORE=$(ps -o cputime= -p $PID | tr -d ' ')
sleep 30
CPU_TIME_AFTER=$(ps -o cputime= -p $PID | tr -d ' ')
RSS_KB_AFTER=$(ps -o rss= -p $PID | tr -d ' ')

to_seconds() {
    python3 -c "
import sys
parts = '$1'.replace(':', ' ').split()
n = len(parts)
if n == 2: print(float(parts[0])*60 + float(parts[1]))
elif n == 3: print(float(parts[0])*3600 + float(parts[1])*60 + float(parts[2]))
else: print(0)
"
}
CPU_BEF_SEC=$(to_seconds "$CPU_TIME_BEFORE")
CPU_AFT_SEC=$(to_seconds "$CPU_TIME_AFTER")
CPU_DELTA=$(python3 -c "print(round($CPU_AFT_SEC - $CPU_BEF_SEC, 3))")
echo "idle_30s_cpu_sec: $CPU_DELTA RSS_after=${RSS_KB_AFTER}KB" >&2

VERSION=$(defaults read "$APP_PATH/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)

cat > "$OUTFILE" <<EOF
{
  "label": "$LABEL",
  "timestamp": "$TS",
  "version": "$VERSION",
  "pid": $PID,
  "launch_time_sec": $LAUNCH_TIME,
  "rss_kb_initial": $RSS_KB,
  "rss_kb_after_30s_idle": $RSS_KB_AFTER,
  "cpu_pct_initial": $CPU_PCT_INIT,
  "idle_30s_cpu_sec": $CPU_DELTA
}
EOF

echo "wrote: $OUTFILE" >&2
cat "$OUTFILE"
echo

pkill -f "$APP_PATH" 2>/dev/null
