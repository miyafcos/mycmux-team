# SOL Gate 1 — tab grouping engine report

作業日: 2026-08-25
対象: `C:\Users\miyaz\cmux-for-linux-dev-master`
開始基準: `b699fc0ca50ac79e047a4ea2258dc887c74da7a8`
実装 commit: `f5fb751` (`feat: reimplement tab grouping gate one engine`)

## 実装サマリ

- UI から独立した `src/components/layout/tabGroupingEngine.ts` を新設した。
- `prepareGroupingCommit` → `commitPreparedGrouping` の2段 API とし、plan/input/output の canonical SHA-256、preview identity、発行 engine 所有権、ticket 単回使用を fail-closed で検証する。
- ticket 確定後は対象外タブ追加を含む入力差分を `preview_stale` とし、`replaceWorkspaces` を呼ばない。
- `allocationSeed + planId + entity kind + groupId + column/pane index` から `tg-` prefix の決定 ID を導出する。同一 ticket は完全一致し、別 seed は別 ID になる。
- identity validator は workspace/pane の共通 ID namespace、tab/session、空 ID、splitColumns 一対一、active tab、空 pane identity、4列・1列4 pane 上限を検査する。衝突時の suffix/retry はしない。
- `PersistentLayoutProjection` は Workspace/Pane/PaneTab の in-memory 全置換対象フィールドを明示射影し、commit/rollback を canonical deep-equal で照合する。
- commit は `replaceWorkspaces` 1回、selection adapter 1回。破損時は注入された単一 `restoreGroupingState` action で rollback し、layout と selection の両方を照合する。
- `rollback_failed` は engine と stable `boundaryToken` の両方に latch し、同じ store を指す別 adapter/別 engine からの再 commit も拒否する。
- undo は selection-neutral 構造署名を使う。resize/rename/terminal metadata 変更では失効し、tab click では失効しない。全 pane の active tab、active workspace/session、`lastActivePaneByWorkspace` を有効な session に限って再適用する。browser/online の一時 state は live 値を保持する。
- moved/kept/unassigned/empty/new、tab location、splitColumns、activeTabs、focus を compiler の `expected` とは独立に再計算して照合する。

## Oracle round-3 からの逸脱・補足

1. `GroupingCompileContext` に `createdAt`（必須）と `newWorkspaceDefaults`（任意）を追加した。Oracle §B の「clock/pet/color/status を compiler 内で読まず preview 入力化する」を、3引数の prepare API のまま表現するため。
2. 公開 `compileGroupingPlan(plan, current, context)` は呼び出し互換を保つが、内部では最初に `CanonicalCompileInput` / `PersistentLayoutProjection` へ変換し、core compiler は raw store object を読まない。
3. projection は Gate 1 の in-memory transaction 証拠であり、`data.json` round-trip や非同期永続化成功の証拠ではない。schema gate と保存層確認は Gate 2 以降。
4. 現行 `tabGrouping.ts` の旧 `commitGroupingPlan(..., precompiled?)` は frozen Panel の型互換のため残っている。`TAB_GROUPING_ENTRY_ENABLED=false` で不可達。Gate 3 で Panel を新 API へ接続し、旧経路を廃止すること。

## 破壊試験: RED → GREEN

### RED

- `5f8631c` — `test: add tab grouping engine destructive cases`
- 実行: `npx vitest run tests/unit/tabGroupingEngine.test.ts`
- 結果: exit 1。`Cannot find module '../../src/components/layout/tabGroupingEngine'`、1 failed suite、0 tests。エンジン実装前に test commit を作成した。
- 独立レビューで fixture の複合破損・selection 不整合が見つかったため、engine commit より前に `e76af94` と `6f07199` で test を強化した。

### GREEN

- `f5fb751` — engine 実装
- `npx vitest run tests/unit/tabGroupingEngine.test.ts`
- 結果: 1 file / 29 tests PASS。

### 29ケースの対象

- NEW-01: target close、non-target add、target move、session change、destination delete。すべて `preview_stale` / replace 0。
- ticket integrity: plan change、ticket body/previewId/構造改変、cross-engine replay、成功後/失敗後再利用。
- NEW-02: 同 seed 完全一致、別 seed 非衝突、連続2回適用、allocation collision、全 entity ID 一意。
- identity: duplicate workspace/pane/tab/session、cross-kind collision、空 ID、split/active/empty-pane、4x4上限。
- verified commit: partial replace、identity-valid split reorder、metrics、metadata、focus no-op。
- rollback: canonical layout/selection 完全復元、corruption/throw → `rollback_failed`、stable boundary latch。
- undo: resize/rename/metadata 失効、tab click 非失効、全 pane selection、active workspace/session、`lastActivePaneByWorkspace` 復元。

## 完了条件の検証出力

### 1. `npx tsc --noEmit`

```text
exit 0
```

### 2. `npx vitest run`

```text
Test Files  205 passed (205)
Tests       2837 passed (2837)
Duration    35.12s
```

既知の jsdom `HTMLCanvasElement.getContext()` warning のみ。

### 3. `python -m pytest tests/`

```text
collected 355 items
355 passed in 44.74s
```

### 4. `python scripts/run_windows_tests.py`

```text
RAM gate: 空き 6.0GB < 8.0GB — cargo -j 2 で実行
test result: ok. 931 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out
all 2 test binaries passed
exit 0
```

## セルフレビュー 1周目 — 完了条件

- Oracle §A/B/C、§D-1、§E の Gate 1追加条件を正本と突合した。
- OCC、deterministic ID、identity、projection、rollback、undo、ticket single-use、rollback_failed latch を新規29 testsで確認した。
- 読み取り専用の独立レビューを OCC / ID / projection / test-boundary の4観点で2巡実施し、初回指摘を修正した。最終 Blocker/Critical/High は各観点0。
- 必須4検証はすべて PASS。Windows wrapper は安全 RAM gate を通過後、`cargo -j 2` で完走した。

## セルフレビュー 2周目 — 境界

- Gate 1差分は `src/components/layout/tabGroupingEngine.ts`、`tests/unit/tabGroupingEngine.test.ts`、本報告だけ。
- `src/components/layout/TabGroupingPanel.tsx` blob: `800b51f32800074de855e391171ddede6e5ebecd`（開始基準と一致）。
- `src/components/layout/TabGroupingButton.tsx` blob: `d31cb7d6f28ca7a611672d8902f2cda8167887a7`（開始基準と一致）。
- `TAB_GROUPING_ENTRY_ENABLED = false` を確認した。
- stores / Rust / CSS / 文言 / 既存別lane dirty は変更・stageしていない。
- `pytest-cache-files-ueu0ljs1\` は既知の Permission denied のため、その内部だけ `git status` 全量保証外。
- push / tag / deploy / runtime restart は未実施。

## Gate 2 への引き継ぎ

1. shared pure workspace factory/normalizer を通常作成経路と新 engine で単一正典化する。
2. `GroupingEngineDependencies.restoreGroupingState` を layout + selection の単一 Zustand `set()` action として実装する。
3. `boundaryToken` を store lifetime に対して安定な object として adapter へ渡す。
4. commit mutex、layout revision購読、schema/version gate、`_replaceWorkspaces` 後の永続化確認を実装する。
5. Gate 3 で Panel を `prepareGroupingCommit` / `commitPreparedGrouping` へ接続し、旧 `precompiled` 経路を削除する。
6. Gate 4/5 の UI実操作、Tauri adapter、実WebView/xterm、実PTY継続、focus/fit、100+ tab性能は未実施。
