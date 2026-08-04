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

## 第2弾: 最高品質化 (2026-08-04 夜 追加裁定 — A→B 段階実行)

Phase 1〜4 (v0.21.7〜v0.21.10) 完了後の実査で確定した残差分。

- **Phase A: 質感の統一** — ①面の高さの階段 (bg < surface < raised < overlay をテーマ色からの派生計算で導入・持ち上がり面の上端1px内側ハイライト) ②境界線の2階層化 (ヘアライン=区切り / 既存 border=操作輪郭) ③タイポトークン (--cmux-font-size-xs/sm/md) + メタ情報モノスペースを実在フォントへ統一 (SF Mono/Geist Mono は Windows 非実在 — ターミナルと同じ UDEV Gothic 系に) ④クロームの絵文字グリフ (✏☐📄等) を単色 SVG へ
- **Phase B: 署名の確立** — エージェント種の色言語 (Claude橙/Codex青/Hybrid緑 = CrsmPalette の KIND_COLORS) をペインタブ下線・作業中ドット・ペイン枠へ一貫展開。「どのペインでどのエージェントか」が色で分かる mycmux 固有の見た目
- 額縁 (xterm padding+角丸) は保留 — レイアウト契約検証が必要になった時点で単独フェーズ化
- 制約は第1弾と同じ (コントラスト4.5:1テスト維持 / 色プリセット値は不変・派生計算のみ / 日本語11px床)
