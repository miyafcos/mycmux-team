#!/bin/zsh -f
# Synthetic Claude-shaped records; no files under ~/.claude are read or written.
set -eu
root="$HOME/.mycmux-perf3/fake-projects/perf3"
id="${1:?expected synthetic UUID}"
[[ "$id" != *[^a-zA-Z0-9-]* ]] || exit 2
mkdir -p "$root"
i=0
trap 'exit 0' INT TERM HUP
while true; do
  i=$((i + 1))
  printf '\033[36mperf3 fake-agent %s line %d\033[0m\n' "$id" "$i"
  printf '{"type":"assistant","sessionId":"%s","uuid":"%s-%d","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":"dummy perf3 line %d"}]}}\n' "$id" "$id" "$i" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$i" >> "$root/$id.jsonl"
  sleep 2
done
