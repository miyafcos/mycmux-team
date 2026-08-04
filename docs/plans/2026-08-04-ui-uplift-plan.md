# UI/UX 底上げ計画 (案B: 全体) — 2026-08-04

宮崎さん裁定: 「表示を Mac ぐらいキレイに」方向の全体底上げ (案B)。
Windows (WebView2/DirectWrite) で不可能なのはフォントアンチエイリアスのみ。
体感品質の主因は blur / モーション / hover / 階調・タイポ設計であり、これらは全て実装可能。

## 現状評価 (2026-08-04 実査)

- global.css に spacing / radius / 用途別シャドウ / focus-visible / reduced-motion は整備済み
- 欠落: motion トークン (duration/easing)、オーバーレイの backdrop blur、ダイアログ・パレットの入場アニメーション、インライン style 主体コンポーネントの hover/transition
- CrsmPalette (resume パレット) は約500行のインライン style で :hover が構造的に書けない
- 極小フォント多用 (9〜10px)。Windows の日本語は 11px 未満で品質が急落する
- 機能面の実害: 検索中は deep ロード導線が消え最初の1000件しか検索できない / Fuse インデックスを1キーごと再構築

## トークン追加 (Phase 1 で global.css へ)

- motion: `--cmux-motion-fast: 120ms` / `--cmux-motion-base: 160ms` / `--cmux-motion-slow: 240ms`、easing `--cmux-ease: cubic-bezier(0.2, 0, 0, 1)`
- blur: `--cmux-blur-overlay: blur(10px) saturate(1.2)` (オーバーレイ背面幕専用)
- shadow: パレット/ダイアログを近距離+遠距離の2層に (`--cmux-shadow-palette` / `--cmux-shadow-dialog` を多層化)
- 共有クラス: `.cmux-overlay-backdrop` (blur 幕) / `.cmux-overlay-panel` (fade+scale 入場 140ms) / `.cmux-list-item` 系 hover

## フェーズ分割

- **Phase 1 (今回)**: 基盤トークン + オーバーレイ層 (CrsmPalette / SettingsDialog / KeybindingsModal / UsageAccountsDialog / PathJumper) + CrsmPalette の機能修正一式
- **Phase 2**: クローム層 (タブバー・ペインヘッダー・フッター・サイドバー) の hover/遷移・タイポ床上げ
- **Phase 3**: コンテンツ層 (設定ダイアログ内部・OnlinePanel) + ライトテーマの階調再点検

## 制約 (壊してはいけないもの)

- テーマコントラスト 4.5:1 はテストで固定 (2026-07-12 UI監査)。トークンの「色」は変えない — 影・blur・motion のみ追加
- blur はオーバーレイ背面幕のみ。ターミナル面・ペイン面には適用しない (GPU コスト / perf 診断の実績を汚さない)
- reduced-motion は既存のグローバル規則が全アニメを止める設計 — 個別対処不要だが壊さない
- 日本語を含むテキストの最小フォントサイズは 11px (ラテン/数字のみのタグ類は 10px 可)
- layout 契約テスト (`.xterm-helper-textarea` コメント内言及禁止 ほか) / sync command allowlist は対象外領域 — 触らない

## 検証

`npx tsc --noEmit` / `npx vitest run` / `python -m pytest tests/` / `cd src-tauri && cargo test --release` 全通過 + GUI 目視 (パレット開閉・検索・hover・blur)。
