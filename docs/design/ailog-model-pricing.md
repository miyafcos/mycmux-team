# AIログ分析: モデル・単価更新 (2026-09-30)

対象: `C:\Users\miyaz\cmux-for-linux-dev-master` / mycmux 0.80.5.
各社の公式資料を当日確認し、ローカル実装のモデル識別・参考単価・配色を更新。

## 公式出典

- [OpenAI models](https://developers.openai.com/api/docs/models) / [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Claude models](https://platform.claude.com/docs/en/models/overview) / [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Grok 4.7](https://docs.x.ai/developers/models/grok-4.7)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)

## 参考単価

USD / 100万トークン。通常のテキスト計算であり、請求額ではない。下表は実装の `DEFAULT_PRICES` から転記。

| Model | Input | Output | Cache read | Cache write (5m column) | Cache write (1h column) |
|---|---:|---:|---:|---:|---:|
| fable-5.1 | 10 | 50 | 0.25 | 12.5 | 20 |
| mythos-5.1 | 10 | 50 | 0.25 | 12.5 | 20 |
| opus-5.5 | 4 | 20 | 0.2 | 5 | 8 |
| sonnet-5.5 | 2 | 10 | 0.2 | 2.5 | 4 |
| fable-5 | 10 | 50 | 1 | 12.5 | 20 |
| mythos-5 | 10 | 50 | 1 | 12.5 | 20 |
| opus-5 | 5 | 25 | 0.5 | 6.25 | 10 |
| opus-4.8 | 5 | 25 | 0.5 | 6.25 | 10 |
| opus-4.7 | 5 | 25 | 0.5 | 6.25 | 10 |
| opus-4.6 | 5 | 25 | 0.5 | 6.25 | 10 |
| sonnet-5 | 2 | 10 | 0.2 | 2.5 | 4 |
| sonnet-4.6 | 3 | 15 | 0.3 | 3.75 | 6 |
| haiku-4.5 | 1 | 5 | 0.1 | 1.25 | 2 |
| gpt-6-astra | 10 | 50 | 1 | 12.5 | 12.5 |
| gpt-6.1-sol | 2 | 10 | 0.1 | 2.5 | 2.5 |
| gpt-6-sol | 2 | 10 | 0.2 | 2.5 | 2.5 |
| gpt-6-luna | 0.1 | 0.5 | 0.01 | 0.125 | 0.125 |
| gpt-5.6-sol | 4 | 20 | 0.4 | 5 | 5 |
| gpt-5.6-terra | 2 | 12 | 0.2 | 2.5 | 2.5 |
| gpt-5.6-luna | 0.2 | 1.2 | 0.02 | 0.25 | 0.25 |
| gpt-5.5 | 5 | 30 | 0.5 | 5 | 5 |
| gpt-5.4 | 2.5 | 15 | 0.25 | 2.5 | 2.5 |
| gemini-3.8-flash | 0.75 | 3.75 | 0.075 | 0.75 | 0.75 |
| gemini-3.7-flash | 0.75 | 3.75 | 0.075 | 0.75 | 0.75 |
| gemini-3.6-flash | 0.75 | 3.75 | 0.075 | 0.75 | 0.75 |
| gemini-3.5-flash | 1.5 | 9 | 0.15 | 1.5 | 1.5 |
| gemini-3.5-flash-lite | 0.3 | 2.5 | 0.03 | 0.3 | 0.3 |
| gemini-3.1-flash-lite | 0.25 | 1.5 | 0.025 | 0.25 | 0.25 |

GPT の対応モデルは全入力 (キャッシュ読み書きを含む) が272,000トークンを超えるターンで、
入力とキャッシュ単価は2倍、出力単価は1.5倍になる。手入力した単価には自動倍率を適用しない。
GPT-5.6 Sol は現行のキャンペーン料率を反映 (公式資料では少なくとも2026-11-21まで)。
Gemini 3.6/3.7/3.8 Flash は2026-12-31までの料率を反映。期間後は再確認が必要。
音声・保存時間・ツール料金・地域加算・特別サービスティアはこの参考計算に含めない。
Grok Build はログの報告コストを使い、単価表で上書きしない。

## 実装と移行

- 最新の Claude / GPT / Gemini の個別モデル名を識別し、Grok 4.7 の日付・Build ログも系列にまとめる。
- 未登録の新世代・別ティアに旧単価を流用しない。日付付きスナップショットと `[1m]` は同モデルの単価を参照する。
- Codex のキャッシュ書き込みを通常入力から差し引き、二重計上を解消する。
- 価格カタログ v2 から v3 への移行で、既存ターンの分類・単価・日次集計を同一トランザクションで更新する。
- 手入力単価、保存済み要約、ログの元モデル名を保全し、移行の二重適用を防ぐ。
- 設定画面のモデル候補を追加。既存の選択値と既定値は保全する。
- 4社の10系列の配色を検証。コントラスト 3:1 以上、色覚特性を含む識別性の床を維持する。

Gemini は既存の対応ログ形式に記録されたモデルの分析対応。Gemini CLI / Antigravity 固有ログの直接取り込みは未実装。
実アプリの起動画面と配布パッケージでの確認は未実施。

## 検証記録

- Rust / ailog: **216 passed, 0 failed, 8 ignored**.
- Frontend: **159 passed** / 13 files.
- Python contracts: **23 passed**.
- `npm run build`: TypeScript + Vite 成功。
- `git diff --check`: 成功。変更した15ファイルの UTF-8 再読込みで U+FFFD = 0。

Rust の検証コマンド:

```powershell
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER='python -X utf8 C:\Users\miyaz\_work\ailog_models_260930\rust-test-runner.py'
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib ailog:: -- --test-threads=2 --skip smoke_real_database_efficiency_and_rule_check_are_read_only
```

テスト用 exe にマニフェストが無く、初回は `0xc0000139` で起動失敗。Windows SDK の `mt.exe` で
検証用コピーにだけ Common Controls v6 のマニフェストを付けて実行した。アプリのビルド設定は保全。
読み取り専用の実 DB スモークは前の実行で成功済みのため、テストデータ修正後の最終実行では除外した。
ignored 8件は既存の明示実行用検査 (実 CLI / 実 DB / 性能計測)。

詳細ログと修正前の復元用コピー:

- `C:\Users\miyaz\_work\ailog_models_260930\rust-tests-uot8k3q5\tests.log`
- `C:\Users\miyaz\_work\ailog_models_260930\frontend-tests-final.log`
- `C:\Users\miyaz\_work\ailog_models_260930\contract-tests.log`
- `C:\Users\miyaz\_work\ailog_models_260930\frontend-build-final.log`
- `C:\Users\miyaz\_work\ailog_models_260930\before`
