# AISET DONE

## 実装サマリ

- 「AI」と「自動化」を独立タブに分離し、AI タブから非 AI 自動化を外しました。
- AI タブを、マスタースイッチ、プロバイダ select、プロバイダ連動のモデル select、カスタム入力、7機能の一覧へ再構成しました。
- 既存の自動命名・返信案だけはトグルを維持し、他の機能はデータ開示付きの表示行にしました。タブ再配置は操作不可の薄色表示です。
- 見守り通知の重複操作子を「通知とレイアウト」から削除し、「自動化」を正としました。
- 日次ダイジェストの設定 UI・コメント・旧契約を削除しました。バックエンドの digest 実装は変更していません。
- RULING の option 2 に従い、data.json 統一は今回扱っていません。`src-tauri/src/db/storage.rs`、`src/components/layout/SocketListener.tsx`、`src/lib/ipc.ts` は未変更です。
- `AISET_BLOCKER.md` は実装前に削除しました。

## 変更ファイル

- `src/components/settings/SettingsDialog.tsx`
- `src/components/settings/settingsStrings.ts`
- `src/components/settings/tabs/AiTab.tsx`
- `src/components/settings/tabs/AutomationTab.tsx`
- `src/components/settings/tabs/NotificationsLayoutTab.tsx`
- `src/stores/aiSettingsStore.ts`
- `src/lib/aiModels.ts`
- `tests/test_ai_settings_contract.py`
- `tests/test_delegation_watch_ui_contract.py`
- `tests/test_tab_sweep_command_contract.py`
- `tests/unit/aiAutomationTab.test.tsx`
- `AISET_DONE.md`

## テスト出力

```text
npx tsc --noEmit
PASS (exit 0, diagnostics なし)

npx vitest run --reporter=dot
Test Files  205 passed (205)
Tests  2842 passed (2842)
Duration  27.26s

python -m pytest tests/ -q
356 passed in 23.81s

python scripts/run_windows_tests.py
RULING option 2 により未実行。storage.rs を変更していないため Rust suite は不要。
```

補助確認: `tests/test_ai_settings_contract.py`、`tests/test_delegation_watch_ui_contract.py`、`tests/test_tab_sweep_command_contract.py` は 21 passed。AI 設定関連の Vitest 4 ファイルは 24 passed。

## セルフレビュー 1周目

- 作業指示の AI/自動化タブ名、マスター文言、モデルカスタム文言、7行の機能名・バッジ・送信内容を UTF-8 で完全一致確認。
- 設定 UI、aiSettingsStore、aiModels、AI 設定契約から日次ダイジェスト参照がないことを確認。
- タスク差分に U+FFFD がないことを確認。

## セルフレビュー 2周目

- タスク差分は上記変更ファイルに限定し、既存 dirty 17件を保持。
- `tabGrouping*`、復元レーン、`SocketListener.tsx`、`ipc.ts`、`storage.rs` の変更ゼロを確認。
- `git diff --check` を通過。
