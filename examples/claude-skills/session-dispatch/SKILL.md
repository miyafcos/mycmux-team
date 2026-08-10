---
name: session-dispatch
description: |
  母艦で受けた依頼を「母艦継続 / 新タブの新鮮な Claude セッション / 並列N本」へ振り分け、
  spec 生成→mycmux spawn→台帳記録→完了回収→close-tab まで回す。mycmux 内
  (MYCMUX_TERM_PROGRAM=mycmux) 限定。
  トリガー: 「新タブでやって」「分散して」「並列で回して」「別セッションで」「セッション分けて」。
  状況判断で自動適用: 素材投入型の重い独立依頼 / 章・単位で割れる一括作業 / 母艦のコンテキストが
  重いときの新規重タスク。
---

# session-dispatch — セッション分散ディスパッチ

目的: コンテキスト限界に近づく前に、独立した重作業を新鮮なフルセッション (新タブ) へ流す。
便益 = 要約劣化ゼロの品質維持・並列スループット・母艦の軽さ。

前提: 環境変数 `MYCMUX_AGENT_CLI` に mycmux リポの `scripts/mycmux_agent_cli.py` の
フルパスが設定されていること (以下 `$CLI` と表記)。

## 判定表 (依頼受領時に3秒で)

| 依頼の型 | 振り先 |
|---|---|
| Q&A・相談・判断・軽微編集 (<10行/1-2ファイル)・skill/Git/MCP 操作 | 母艦のまま |
| 素材投入型 (パス束+検収/照合/修正反映) で現行作業と独立 | 新タブ claude 1本 |
| 一括・複数単位の重い依頼 (章・学年・科目・工程・検証観点) | **分割設計** (references/decompose-guide.md) → 新タブ並列 (同時上限3) |
| 母艦が重い (compact 接近・長大化) ときに来た新規の重依頼 | 新タブへ。母艦は司令塔に徹する |
| 「どこまでやったっけ」系で、この先に重作業が続く | 母艦で現状整理 → 作業本体を spec 化して新タブ |
| 読み調査・その場の検証・fan-out 検索 | Agent tool (サブエージェント・タブにしない) |

非 mycmux セッション (cron 等) では spawn 不可 → Agent tool / Workflow で代替する。

## 表示形態と寿命 (既定=裏タブ。横 pane はユーザー指定か確認承認後のみ)

| 型 | 形態 | 完了時 |
|---|---|---|
| 自律完遂型 (機械検収コマンドを spec に書ける: 照合・変換・量産・調査・整備) | **裏タブ** (--no-activate) | watcher が自動検収 PASS → **自動 close** |
| 対話往復が見込まれる (仕様が緩く判断待ち多発見込み) | **裏タブ** (--no-activate)。往復は ASK.md で回す | DONE/ASK 消化後、親検収して close |
| 機械検収が書けない (成果物が意味判断) | 裏タブ | DONE 通知→タブ温存、親検収後に close |

- **可視 `--split` 横 pane はオプトイン制**。発動は2条件のみ: ①ユーザーの明示指定
  (「横に出して」「見たい」「画面に出して」等) ②親が見せる価値ありと判断したら
  **AskUserQuestion で確認し承認を得てから**。親の独断で split しない。split 時も
  --no-activate は維持し、対話終了後に親が手動 close
- close は可逆: 子の全ログは `~/.claude/projects/` に常在し、resume パレットから復帰できる
- 自動 close の条件は「**親が spec に書いた機械検収が PASS**」のみ (子の DONE 自己申告では閉じない)

## 手順 (詳細・台帳スキーマ: references/dispatch-guide.md)

1. **spec 作成**: `~/.claude/dispatch/<YYMMDD>-<slug>/spec.md` を references/spec-template.md の型で書く。
   必須4点 (境界/完了条件/接続先/判断者) + DONE 契約 + ASK 契約。
   effort・モデル指定は spec 本文に日本語で明記 (CLI フラグでは渡らない)
2. **spawn**:
   `python $CLI spawn --target claude --prompt-file <spec> --label <slug> --cwd <作業フォルダ> --no-activate`
   — 既定は裏タブ。`--split` はユーザー指定 or AskUserQuestion 承認後のみ足す。`--activate` 禁止
   (フォーカスを奪うと戻す API が無い)。応答 JSON を台帳に記録
3. **台帳記録**: `~/.claude/dispatch/ledger.jsonl` に 1 行 append (dispatch-guide.md の型)
3b. **watcher 起動 (自律完遂型は必須)**: spawn 直後に
   `python ~/.claude/skills/session-dispatch/scripts/dispatch_watch.py --slug <slug>` を
   **バックグラウンド実行**。DONE 検知→spec の機械検収→PASS なら close-tab+台帳更新まで
   watcher が自動でやる。FAIL/STALL/TIMEOUT は exit 非0 で通知が返る
4. **回収**: watcher の verdict (`DONE-VERIFIED-CLOSED` なら完了) を確認。needs_review /
   watcher 無し運用は `dispatch_status.py` で突合し、**成果物を親が実体検証**
   (Test-Path / 行数 / diff / 実行出力)。DONE.md の自己申告は成果と見なさない
4b. **ASK の回収**: `dispatch_status.py` が `ASK(判断待ち)` を出したら `<dispatch-dir>/ASK.md` を読み、
   ユーザーの判断が要る内容ならユーザーへ確認、親が判断できる内容なら親が裁定して
   `python $CLI send --session <id> --text "<回答>"` → 数秒後に素の Enter を後追い送信
5. **片付け**: 自動 close 済み (`DONE-VERIFIED-CLOSED`) なら不要。needs_review を親検収で
   通したら `close-tab --session <tabSessionId>` → 台帳 status=closed。横 pane は対話が
   終わった時点で親が close

## 鉄則

- spawn は可逆 (close-tab で戻せる) → 確認なしで自動実行し事後報告。同時 dispatch は 3 本まで
- 子への追加指示は `send --session <id> --text ...` → 数秒後に素の Enter を後追い (ペースト扱い対策)
- pane.read は裏起動タブでは常に空 — 完了検知はファイル実体のみ (DONE.md / セッション JSONL 増分 / 成果物 mtime)
- 状態は常に外部化 (spec / DONE / ASK / 成果物ファイル)。「子の画面を見ないと分からない」状態を作らない
- **子は人間に生ログを読ませない**。走行中の判断は ASK.md、それ以外は DONE の「要判断」。
  **黙って止まるのは契約違反** — idle なのに DONE も ASK も無い子を見つけたら、
  子へ「ASK を書くか自分で判断して続行せよ」を send する
- 委譲契約の正本は mycmux リポの `docs/agent-integration.md`。矛盾したらそちらが勝つ
