# 便3a 完了報告 — 単価の訂正と model NULL の遡及

状態: 実装・検証完了。採否は親。本番 `ailog.db` は開いていない。

## 1. 変更したファイルと行数 (`git diff --numstat`)

```
93	0	src-tauri/src/ailog/index.rs
63	8	src-tauri/src/ailog/migrate.rs
21	4	src-tauri/src/ailog/price.rs
6	2	src-tauri/src/ailog/query.rs
2	2	src-tauri/src/ailog/tests/index_tests.rs
1	0	src-tauri/src/ailog/tests/mod.rs
2	2	src-tauri/src/ailog/tests/price_tests.rs
2	1	src/lib/ailog.ts
1	0	tests/unit/crossTable.test.tsx
1	1	tests/unit/sessionPresentation.test.tsx
1	1	tests/unit/summaryCards.test.tsx
```

未追跡の新規: `src-tauri/src/ailog/tests/ben3a_tests.rs` (346 行)

## 2. 検証コマンドの末尾

### `npx tsc --noEmit`

exit 0。出力なし。

### `npx vitest run`

```
 Test Files  169 passed (169)
      Tests  2085 passed (2085)
   Duration  11.88s
```

### `python scripts/run_windows_tests.py`

```
test result: ok. 783 passed; 0 failed; 8 ignored; 0 measured; 0 filtered out; finished in 8.21s
=== running mycmux-9c8c0ceae6c8d3cb.exe ===
all 2 test binaries passed
```

### `python -m pytest tests/`

この環境はコンソールが無く、素の `pytest tests/` は xonsh plugin で `NoConsoleScreenBufferError` になる。`-p no:xonsh` で再走:

```
FAILED tests/test_updater_feed_contract.py::test_normalize_updater_feed_fails_closed_without_nsis_entry
================== 1 failed, 291 passed, 1 warning in 5.22s ===================
```

失敗 1 件は updater feed 正規化 (PowerShell stderr が None)。便3a の差分とは無関係。前回便でも同じ環境ノイズ。

## 3. T1〜T12

| # | テスト名 | 結果 |
|---|---|---|
| T1 | `t1_terra_and_luna_default_rates` | ok |
| T2 | `t2_gpt55_and_gpt54_exist_spark_and_grok_do_not` | ok |
| T3 | `t3_migrate_updates_stale_default_rows` | ok |
| T4 | `t4_user_price_rows_are_untouched` | ok |
| T5 | `t5_migrate_increments_price_generation` | ok |
| T6 | `t6_migrate_is_idempotent` | ok |
| T7 | `t7_carry_uses_previous_non_null` | ok |
| T8 | `t8_carry_falls_back_to_next_non_null` | ok |
| T9 | `t9_carry_leaves_all_null_session_alone` | ok |
| T10 | `t10_carry_fills_family_and_variant` | ok |
| T11 | `t11_carry_is_idempotent` | ok |
| T12 | `t12_classify_grok_as_reported` | ok |

## 4. 実装しなかった項目

- `gpt-5.3-codex-spark` の単価行 — spec どおり追加しない
- grok の単価行 — spec どおり追加しない。`classify` は `Reported`
- `parse_codex.rs` — パーサは直さない
- 画面文言 — 便3b。`src/components/` は 0 行
- `reprice_all` / `reprice_all_in_transaction` の中身 — 呼ぶだけ
- `FAMILY_STEMS` への `gpt-5.4` 追加 — spec A の範囲外。exact key で lookup できる

循環参照は起きなかった (`index.rs` は `migrate` を import しない)。BLOCKER は出していない。

## 5. セルフレビュー 2 周

### 1 周目 — 完了条件の充足 (diff 突合。テスト緑は証拠にしない)

- **A やった**: `DEFAULT_PRICES` の terra 2.0/12.0/0.20、luna 0.20/1.20/0.02。`gpt-5.5` (5.0/30.0/0.50) と `gpt-5.4` (2.50/15.00/0.25) を `Price::openai` で追加。コメントに 2026-08-18 と出典を追記。spark / grok 行なし
- **B やった**: `index_state.price_catalog_version = "2"`。`source='default'` だけ UPDATE。`source='user'` は WHERE で除外。`price_generation` を既存 upsert と同じ式でインクリメント。同一 tx で `index::reprice_all_in_transaction`。スキーマ版数が既に 2 でもカタログ段は独立に走る
- **C やった**: `ModelClass::Reported`。`reported_markers: &["grok"]`。`PriceCoverage.reported` を unknown から分離。`src/lib/ailog.ts` に `reported` を追加。表示文言は未変更
- **D やった**: `MODEL_CARRY_VERSION = "1"`。`rederive` 直後に同型の版数ゲート。SQL は直前優先・直後フォールバック。Rust で `price::normalize` して family/variant を書く。触ったセッションだけ `recompute_session` + `mark_session_dirty`。呼び出しは `mark_all_dirty` の条件に入れていない

### 2 周目 — 指示外変更・退行・積み残し

- `src/components/` の差分: **0 行**
- `parse_codex.rs` / `rollup.rs` / `schema.rs`: **0 行**
- `cargo fmt` のワークスペース流し込みなし。触ったファイルは仕様の対象 + 既存テスト期待値 + TS 型追加に伴う fixture
- 許可リスト外だが tsc に必要だった変更: `tests/unit/{crossTable,sessionPresentation,summaryCards}.test.tsx` に `reported: { models: [], tokens: 0 }` を足した (画面コードではない)
- 既存テストの terra 期待値 (2.5/15.0 → 2.0/12.0) を `price_tests.rs` と `index_tests.rs` で更新した。直さないと退行扱いになる
- 未追跡の `DONE_remote_ben1a.md` は前便の残り。今回は触っていない
