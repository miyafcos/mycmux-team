# Dispatch Spec テンプレート

spawn される新しい Claude セッションへの初回プロンプト。子は母艦の会話を一切知らない前提で、
このファイルだけで作業が完結するように書く。`<...>` を埋めて `~/.claude/dispatch/<YYMMDD>-<slug>/spec.md` に保存。

---

# 作業依頼: <slug — 一言で>

## 依頼内容
<やること 1〜3 行。動詞で終える>

## 境界 (調査・変更してよい範囲)
- 対象: <フォルダ / ファイルのフルパス>
- 変更禁止: <触ってはいけないもの。例: 正本 docx・.env・他案件フォルダ>

## 接続先 (一次資料 — 母艦の要約でなく実物を読むこと)
- <実ファイル・実 PDF・実フォルダのフルパス列挙>
- 関連 memory: <あれば project_*.md / feedback_*.md の名前>

## 完了条件 (受け入れテスト)
- <実行コマンド or 照合手順。「〜が PASS」「差分ゼロ」など機械判定できる形で>

## 判断者
- 採否・仕様の最終判断は母艦セッション側
- **走行中にブロッキング判断が出たら**: `references/ask-card-contract.md` の型で判断カードを投げて待機する
  (対象 = external_commit / requirement_conflict / scope_change / irreversible / owner_judgment / permission_safety のみ)。
  投入コマンドの雛形は同契約に記載。**1セッション1 pending・生ログ参照禁止**
- **可逆な判断は聞かず推奨案で続行**し、DONE.md の「要判断」に「仮定: <選んだ案> (理由)」として残す

## 実行指定
- effort: <max / xhigh / high>  (このセッション内で /effort 相当の深さで作業する)
- 適用 feedback: <該当する feedback_*.md 名。例: feedback_md_pipeline_line_drop_traps>

## 自動検収 (machine gate)

<自律完遂型なら必須。書けない (意味判断が要る) なら本節ごと削除 — その場合タブは自動 close されない>

auto_close: true

```verify
# 1行=1コマンド (PowerShell)。全行 exit 0 で PASS → watcher がタブを自動 close する
if (-not (Test-Path -LiteralPath "<成果物のフルパス>")) { exit 1 }
<照合スクリプト実行など。行数チェック例: if ((Get-Content <path> | Measure-Object -Line).Lines -ge 100) { exit 0 } else { exit 1 }>
```

## DONE 契約 (完了時に必ず・この順で)
1. 成果物を保存する (保存先は「境界」内)
2. `<dispatch-dir>/DONE.md` を書く — 次の4節を必ず含める:
   - **結果サマリ** (3行以内)
   - **成果物** (フルパス一覧・各1行説明)
   - **検証手順** (母艦が独立検証するためのコマンド / 照合手順)
   - **未解決・要判断** (なければ「なし」)
3. DONE.md を書いたら追加作業をせず待機する (質問があっても続行せず「要判断」に書く)
