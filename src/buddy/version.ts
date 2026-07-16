// Buddy 独立 version。mycmux 本体 (package.json / tauri.conf.json / Cargo.toml) とは別に
// 管理する。Buddy 関連だけの更新ではここを bump し、本体 version は据え置く。
//
// 運用ルール:
// - mycmux 本体機能の追加/修正 → master/lite 両方の本体 version を bump (同期)
// - Buddy 関連 (`src/buddy/**`、`src-tauri/src/buddy/**`、`~/.claude-buddy/` 周辺) のみ
//   の更新 → BUDDY_VERSION のみ bump (本体 version は変えない)
// - lite には Buddy 自体が無いので BUDDY_VERSION は反映されない
export const BUDDY_VERSION = "2.0.0";

// 現 BUDDY_VERSION で利用可能な機能フラグ (UI 表示・診断・/buddy-codex-bridge status 等で参照)
export const BUDDY_FEATURES = [
  "kurisu-v8-persona",   // スタンドアロン claude-buddy v8 と同一人格 (牧瀬紅莉栖)
  "four-mood-model",     // idle / thinking / tsukkomi / applaud の 4 mood
  "svg-avatar",          // SVG ベース 4 mood アバター
  "codex-pet-bridge",    // ~/.codex/pets/ の Pet を Buddy の skin として render
  "shared-runtime",      // ~/.claude-buddy/ をスタンドアロン版と共有
  "mycmux-perception",   // mycmux のペイン出力・打鍵イベントも観測
] as const;

export type BuddyFeature = (typeof BUDDY_FEATURES)[number];
