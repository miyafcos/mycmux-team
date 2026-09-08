---
name: session-dispatch
description: "母艦で受けた依頼を「母艦継続 / 新タブの新鮮な Claude セッション / 並列N本」へ振り分け、\nspec 生成→mycmux spawn→台帳記録→完了回収→close-tab まで回す。mycmux 内\n(MYCMUX_TERM_PROGRAM=mycmux) 限定。"
metadata:
  triggers:
    - "新タブでやって"
    - "分散して"
    - "並列で回して"
    - "別セッションで"
    - "セッション分けて"
    - "手が空いてるやつにやらせて"
  exclusions:
    - "git worktree の並列開発=bunshin"
  auto_apply: "素材投入型の重い独立依頼 / 章・科目単位で割れる一括作業 / 母艦のコンテキストが\n重いときの新規重タスク。"
---

# session-dispatch — セッション分散ディスパッチ (L1)

目的: コンテキスト限界に近づく前に、独立した重作業を新鮮なフルセッション (可視タブ) へ流す。
便益 = 要約劣化ゼロの品質維持・並列スループット・母艦の軽さ (2026-07-30 実測 816 本の分析が根拠)。

## 判定表 (依頼受領時に3秒で)

| 依頼の型 | 振り先 |
|---|---|
| Q&A・相談・判断・軽微編集 (<10行/1-2ファイル)・skill/Git/MCP 操作 | 母艦のまま |
| Codex ALWAYS 条件 (実装3+ファイル・新規100行超ほか delegation.md 参照) | codex 委譲 (従来どおり) |
| 素材投入型 (パス束+検収/照合/修正反映) で現行作業と独立 | 新タブ claude 1本 |
| 一括・複数単位の重い依頼 (章・学年・科目・工程・検証観点) | **分割設計** (references/decompose-guide.md) → 新タブ並列 (同時上限3)。納品物・作問・量産は分割案3〜5行を提示して GO / 内部作業は全自動+事後報告 |
| 母艦が重い (compact 接近・長大化) ときに来た新規の重依頼 | 新タブへ。母艦は司令塔に徹する |
| 「どこまでやったっけ」系で、この先に重作業が続く | 母艦で現状整理 → 作業本体を spec 化して新タブ |
| 軽い読み調査・その場の検証 | 母艦直 (サブエージェント・タブにしない) |
| 素材大量の走査・分類・抽出 (MCP 不要) | codex タブ (luna は明示起動 `spawn-tab -- powershell -NoLogo -NoExit -Command "codex --model gpt-5.6-luna -c model_reasoning_effort=max -c features.fast_mode=false"`。素の `spawn --target codex` は config 既定 = astra max で立つ・2026-09-05 実測) |
| MCP 必須素材・日本語プロースの fan-out | Agent tool `model:'opus'` 明示 (無指定は agent-model-guard hook が遮断) |

非 mycmux セッション (cron 等) では spawn 不可 → Agent tool / Workflow で代替する。

## 表示形態と寿命 (既定=裏タブ。横 pane は宮崎さん指定か確認承認後のみ — 2026-08-11 裁定)

| 型 | 形態 | 完了時 |
|---|---|---|
| 自律完遂型 (機械検収コマンドを spec に書ける: 照合・変換・量産・調査・整備) | **裏タブ** (--no-activate) | watcher が自動検収 PASS → **自動 close** |
| 対話往復が見込まれる (owner_judgment / 仕様が緩く ask 多発見込み) | **裏タブ** (--no-activate)。往復は ask カードで回す | DONE/ask 消化後、親検収して close |
| 機械検収が書けない (成果物が意味判断) | 裏タブ | DONE 通知→タブ温存、親検収後に close |

- **可視 `--split` 横 pane はオプトイン制**。発動は2条件のみ: ①宮崎さんの明示指定 (「横に出して」「見たい」「画面に出して」等) ②親が見せる価値ありと判断したら **AskUserQuestion で確認し承認を得てから**。親の独断で split しない。split 時も --no-activate は維持し、対話終了後に親が手動 close
- **`spawn-tab --detach` も `--split` と同格のオプトイン (既定禁止)** — 新ペインに出る。長時間ジョブ保護はペイン閉じ前の確認ダイアログに任せる (2026-08-21 裁定・`--detach` 推奨は撤回)。CLI は暗黙 split を廃止済み: `--workspace/--anchor-pane/--direction` 単独・env 欠落はエラーで止まる (隣ペインへは落ちない)。応答 JSON の `placement` が `tab` であることを台帳に残す
- close は可逆: 子の全ログは `~/.claude/projects/` に常在し、resume パレットから復帰できる
- 自動 close の条件は「**親が spec に書いた機械検収が PASS**」のみ (子の DONE 自己申告では閉じない)

## 手順 (詳細・台帳スキーマ: references/dispatch-guide.md)

0. **WIP gate (spawn 前に必ず)**: `python ~/.claude/ops/ops_common.py list --asks` で pending の
   判断カードを確認。**pending ask が3件以上、または最古が実働10分超なら、人間判断を要し得る新規 dispatch を保留**
   (先にカードを宮崎さんと消化する)。自律完遂型 (判断カードが出ない見込みの機械作業) は続行可
1. **spec 作成**: `~/.claude/dispatch/<YYMMDD>-<slug>/spec.md` を references/spec-template.md の型で書く。
   必須4点 (境界/完了条件/接続先/判断者) + DONE 契約 + **ask カード契約 (references/ask-card-contract.md)**。
   effort・モデル指定は spec 本文に日本語で明記 (CLI フラグでは渡らない)
2. **spawn**:
   `python <resolved-mycmux-agent-cli> spawn --target claude --prompt-file <spec> --label <slug> --cwd <作業フォルダ> --no-activate`
   — 既定は裏タブ。`--split` は宮崎さん指定 or AskUserQuestion 承認後のみ足す。`--activate` 禁止 (フォーカスを奪うと戻せない)。
   応答 JSON を台帳に記録
3. **台帳記録**: `scripts/dispatch_ledger.py append --slug <YYMMDD-名前> --status open --json '<spawn応答+dir/cwd>'`
   (手書き `>>` 追記は禁止 — パス中の `\` で行が壊れる。slug は日付必須・キーは snake)
3b. **watcher 起動 (自律完遂型は必須)**: spawn 直後に
   `python ~/.claude/skills/session-dispatch/scripts/dispatch_watch.py --slug <slug>` を
   **バックグラウンド実行** (Bash run_in_background)。DONE 検知→spec の機械検収→PASS なら
   close-tab+台帳更新まで watcher が勝手にやる。FAIL/STALL/TIMEOUT は exit 非0 で通知が返る
4. **回収**: watcher の verdict (`DONE-VERIFIED-CLOSED` なら完了) を確認。needs_review /
   watcher 無し運用は `dispatch_status.py` で突合し、**成果物を親が実体検証**
   (Test-Path / 行数 / diff / 実行出力)。DONE.md の自己申告は成果と見なさない
4b. **判断カードの回収**: カードは母艦ターン開始時に自動注入される (ask-inject.py)。回答は
   `python ~/.claude/ops/ops_common.py answer-ask <id> --text "<回答>"` の**1コマンドのみ**
   (送信→子の再開観測→resolved まで自動)。手動 send+done に分けない。**カード単体で答えられない
   低品質カードは宮崎さんに出さず子へ契約違反を差し戻す**。却下は `dismiss <id> --reason <分類>`
5. **片付け**: 自動 close 済み (`DONE-VERIFIED-CLOSED`) なら不要。needs_review を親検収で
   通したら `close-tab --session <当該dispatch行の tab_session_id>` → `dispatch_ledger.py update
   --slug <slug> --spawn-ts <ts> --status closed`。横 pane は対話終了時点で親が close

## 鉄則

- spawn は可逆 (close-tab で戻せる) → 確認なしで自動実行し事後報告。同時 dispatch は 3 本まで
- 子への追加指示は **`scripts/dispatch_send.py --slug <slug> --text ...`** (状態検査・本文投入・安定確認後の Enter 1回まで一括)。別コマンドで Enter を後追いしない。Enter 要求済み (`enter_sent: true`) は再送防止のため exit 0。配送未確認なら JSON の `warning` を確認し、本文も自動再送しない。配送の観測は `result: observed_delivered` で判断する
- **close-tab / send は「その dispatch の行が持つ tab_session_id」だけに撃つ**。同じ slug が
  別日に2本あるとき、台帳の後勝ちマージで旧タブへ撃つのが過去の事故経路 (2026-08-13 修正)
- pane.read は表示中タブの renderer buffer、背景タブでは PTY scrollback を headless xterm で再生した画面を返す (transcript ではない)。完了検知は DONE.md / セッション JSONL 増分 / 成果物 mtime で行い、canonical state は `mycmux_agent_cli.py status --session <id>` で読む
- 状態は常に外部化 (spec / DONE / 成果物ファイル)。「子の画面を見ないと分からない」状態を作らない
- **子は人間に生ログを読ませない**。走行中の判断は ask カード (契約=references/ask-card-contract.md)、
  それ以外は DONE の「要判断」。**黙って止まるのは契約違反** — idle なのに DONE も ask も無い子 (silent blocker)
  を見つけたら、人間向けカードを親が代作せず、子へ「ask を発行するか自分で判断して続行せよ」を send する
- 委譲契約の正本は `~/cmux-for-linux-dev-master/docs/agent-integration.md`。矛盾したらそちらが勝つ

## 見張り (dispatch_guard.py)

- spawn 前に `python -X utf8 ~/.claude/skills/session-dispatch/scripts/dispatch_preflight.py run --cwd <cwd> --spec <spec.md> --json` を実行する。exit 3 は必要な認証経路の不通で spawn を止める。settings.json は変更しない。
- `python -X utf8 ~/.claude/skills/session-dispatch/scripts/dispatch_guard.py ensure` が常駐を起動する。doctor は生存、最終周期、対象、分類、通報数を JSON で返す。stop は協調停止を要求する。
- 全 agent タブを観測する。催促と AskUserQuestion の推奨選択は台帳 active の子だけ。承認は拒否して代替手段を指示する。手動タブの質問・承認は通報だけ。ログインは操作せず blocked とする。
- 人が書いた本文は送らない。`pending_sends.jsonl` の本文と入力改訂番号を確認し、別の入力があれば Enter を打たない。
- dispatch_send の追加フィールド `delivered_confirmed` は、空の入力欄と状態遷移または子ログ増分の観測結果。`guard_pending: true` は見張りへの引き渡し。enter_sent と既存の返却値は従来どおり。配送不明時に本文を再送しない。
- watcher の STALL は見張りへ 1 回引き渡し、DONE / TIMEOUT / lost まで監視する。既存節の STALL 即終了の記述は `--legacy-stall-exit` 指定時に適用する。TIMEOUT は exit 2。
- lost は非 active だが CLOSED_STATUSES には含めない。blocked は人待ちとして active に残す。初回照合でタブが無い古い行は無音で lost にする。開始後に生存を観測したタブの消失は 2 周期で確定し、通報する。close-tab は送らない。
- 通報カードは 1 周期最大 1 枚。複数件はまとめ、同じタブ・分類は 30 分間重複させない。記録は `~/.claude/dispatch/guard/` の state.json / guard.log / pending_sends.jsonl / escalations.jsonl と台帳 event。
- guard.lock は PID と起動時刻を持つ通常ファイル。state.json の更新が 30 秒以上止まれば次の ensure が起動し直す。古いプロセスは所有権変更を検出して停止する。
- 開発・検証中の起動は `ensure --dry-run`。分類と記録だけを行い、操作・通報・台帳変更はしない。実操作はカナリア子への `once --session <id>` だけ。既存プロセスの設定を ensure は変更しない。モード変更時は stop 後に停止を確認する。
- 実機試験は mycmux の委譲元タブ内で `python -X utf8 ~/.claude/skills/session-dispatch/scripts/dispatch_canary.py --scenario startup,askuser,draft` を実行する。結果は JSON と一時 cwd の result.json。--keep 以外は子タブを閉じる。試験は最初の失敗で停止する。
- RELAY_1 対応後の本番 run は母艦が最終検証で初めて起動する。
