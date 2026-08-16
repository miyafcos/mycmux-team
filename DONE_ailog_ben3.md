# AILog 便3 完了報告

状態: 実装・検証完了。採否判断は親が行う。

## 実装

- `rollup_turn_session_day`（`day, kind, session_id, model, model_family, effort, origin, is_sidechain`）と `rollup_dirty` を additive migration v2 として追加した。`schema.rs::USER_VERSION` は未変更。
- writer transaction 内で旧日・更新日を dirty 化し、DELETE→GROUP BY INSERT で再構築する。価格変更は価格upsert、再価格化、全日rollup再構築まで同一transactionにした。
- `series` と `breakdown` の model/project/branch/effort/origin は、完全JST日をrollup、端日をrawで合成する。models と usage_rhythm はrawのまま。
- 完全日を含まないrangeはrawと記録し、単一完全日もrollup対象にした。
- 日別・全体seriesはSQL側で日別に畳み、distinct session数と価格カバレッジを保持する高速経路を追加した。

## 受入テスト

- migration冪等性・既存session保持
- 端日raw＋中間rollupを含むseriesとbreakdown 5次元のJSON完全一致（timings除外）
- 増分index後のrollup/raw再照合
- min_cost/query/agent/title/tag/kind のraw fallback
- JST日境界定数の共有、価格変更の再構築、失敗した価格変更のrollback

## 検証結果

- `python scripts/run_windows_tests.py`: 723 passed, 0 failed, 8 ignored
- `python -m pytest tests/`: 291 passed
- `git diff --check`（対象9ファイル）: clean
- 一時DBを製品indexerで作成: 35,473 files, 19,362 sessions, 20,921 rollup rows
  - DB: `C:\Users\miyaz\AppData\Local\Temp\ailog-ben3-4927f777-ee0f-4fb5-888c-80fe9e4d0924.db`
  - 本番 `C:\Users\miyaz\.mycmux\ailog.db` は操作していない。
- query-only性能測定（同一接続で90dをread-only warmup後）: 全対象reportが150ms未満。

| Range | series | model | project | branch | effort | origin |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 30d SQL+build ms | 33 | 41 | 49 | 61 | 36 | 39 |
| 90d SQL+build ms | 48 | 64 | 101 | 107 | 68 | 65 |

Ben2 baselineの30d raw overview/breakdown/sessionsは1090/651/585ms、90dは1576/993/942msだった。今回の対象2reportはrollup経路で測定した。

## scratch吸収

- `scratch_series.txt`（114行）: 旧raw seriesとbreakdown型の参照断片。最終の `query.rs` に統合済み。
- `scratch_breakdown.txt`（181行）: 旧raw breakdownとmodels型の参照断片。最終の `query.rs` に統合済み。
- `scratch_models.txt`（188行）: 旧raw modelsとsessions型の参照断片。modelsをraw据置とする裁定確認に使用済み。

scratchファイルは監査参照用に残し、内容上の未処理事項はない。

## セルフレビュー

1. 正しさ: DDLが裁定の1表のみであること、partial/full-day分割、session/rework JOIN、raw fallback、価格更新の原子性、models/usage_rhythm非移行を確認した。
2. 境界: staged対象がailogの9ファイルのみであること、`schema.rs`無変更、frontend無変更、境界外ファイル未stageを確認した。

コードcommit: `4c5cc84 feat(ailog): add session-preserving daily rollups`
