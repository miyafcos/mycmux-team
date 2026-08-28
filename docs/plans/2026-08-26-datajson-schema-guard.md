# data.json 未知 schema 破壊ガード — 親レーン CRITICAL (2026-08-26 起票)

起票元: タブ再配置 Gate2-6 子母艦 (Oracle round5 裁定済み)。詳細な発見経緯は
dispatch/260825-tab-grouping-gates/ASK.md。

## 欠陥

`data.json` の `schema_version` が未対応 (将来版の 999 等) でも frontend は schema 判定前に
hydrate し、debounce/終了時/retry 保存が `schema_version: 1` として書き戻して未知フィールドを
脱落させる。封印フラグと無関係に到達する既存バグ (Gate 2 差分起因でないことを
`git show ee66c11~1` で機械照合済み)。実害シナリオ = 将来版と旧版の併用・ダウングレード時の
データ破壊。

## 裁定 (Fable 親)

- タブ再配置 Gate 2 のブロッカーにしない (責任と回帰範囲を混ぜない)
- **親レーンの CRITICAL** として独立修正。期限 = タブ再配置 Gate 5 (実アプリ試験) 開始 or
  封印解除の早い方まで
- **実施タイミング**: 子レーンの Gate 2 修正 (SocketListener を触っている) の受理後に着手
  (同一ファイル並行編集の回避)。**AISET 後続便 (autoPaneNaming / replyDraftSuggestions の
  data.json 統一・Option型/一回限り移行) と同一レーンに束ねる** — 同じ永続化軌道・監査1回で済む
- 体制 = 実装 sol / チェック sol+Claude(Opus5) / 判断 Oracle (2026-08-26 の標準編成)

## 最小修正仕様 (子レーン+Oracle の案を採用)

1. Rust load を tagged envelope 化 (`{ schemaVersion, data, supported }`)。schema を捨てない
2. frontend は hydrate 前に schema 判定。未対応なら workspace/session を一切 hydrate しない
3. 未対応検出後はプロセス単位で永続化を quarantine (debounce/immediate/retry/終了時/leader 経由
   の全保存停止)。元ファイル不変・診断表示のみ。自動 downgrade・部分保存は作らない
4. **受入条件**: `schema_version: 999`+canary 未知フィールドの一時ファイルで
   起動→待機→終了→retry を通し、ファイルの byte hash が不変

## 同レーンに束ねる第2件 (AISET 後続便)

- `autoPaneNamingEnabled` / `replyDraftSuggestionsEnabled` を data.json (AppSettings) へ移設。
  serde は Option 型で「未設定」と「既定値保存済み」を区別し、localStorage 旧キーからの移行は
  一回限り (マーカー or Option 判定)。契約テスト追加

## 対応プラットフォーム

このガードのプロセス間排他は Windows named mutex を正規の binding とし、Windows を本仕様の
対応プラットフォームとする。cross-platform lock は本レーンでは実装しない。非 Windows build
では同等の排他が入るまで `data.json` の更新を fail-closed で拒否し、診断のための読み込みは
維持する。既存 bytes は変更しない。

この保存停止・byte 不変保証の対象は `data.json` のみ。browser `localStorage`
（Zustand 互換値・移行済み marker を含む）は対象外で、更新を妨げない。ただし unsupported
schema 起動中に `localStorage` 値を `data.json` へ移行・保存しない。
