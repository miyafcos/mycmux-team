#!/bin/zsh
# Derived from ~/Developer/macq-e2e/build.sh; isolated, unsigned, low priority.
set -u
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
cd ~/Developer/mycmux-lane-perf3 || exit 1
stamp=$(date +%Y%m%d-%H%M%S)
root=~/Developer/macq-e2e/perf3
mkdir -p "$root/results"
log="$root/results/build-$stamp.log"
echo "head $(git rev-parse HEAD)" > "$log"
start=$(date +%s)
VITE_E2E=1 nice -n 10 npm run tauri -- build --target aarch64-apple-darwin --bundles app --no-sign --features e2e \
  --config '{"identifier":"com.miyazaki.mycmux.e2e","bundle":{"createUpdaterArtifacts":false}}' >> "$log" 2>&1
code=$?
end=$(date +%s)
app=src-tauri/target/aarch64-apple-darwin/release/bundle/macos/mycmux.app
if [ $code -eq 0 ] && [ -d "$app" ]; then
  mkdir -p "$root/_old"
  [ -d "$root/mycmux-e2e.app" ] && mv "$root/mycmux-e2e.app" "$root/_old/mycmux-e2e-$stamp.app"
  cp -R "$app" "$root/mycmux-e2e.app"
fi
echo "{\"exit\": $code, \"seconds\": $((end-start)), \"head\": \"$(git rev-parse HEAD)\", \"log\": \"$log\"}" > "$root/build-result.json"
exit $code
