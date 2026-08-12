# mycmux AI ログ分析基盤 F3 — セッション要約 + ゴールのグルーピング (LLM)

前提: F1 (`src-tauri/src/ailog/`, `~/.mycmux/ailog.db`) が完了していること。
実行経路は **Claude Code のみ** (Codex は使わない。2026-08-10 宮崎さん指示)。

---

## 0. これは何か

F1 が出す定量値 (トークン・コスト・手戻りスコア) に、
「そのセッションで**何をやろうとして・何が分かって・なぜ手戻ったか**」という定性情報を紐づける。

出力先は F1 で定義済みの `summary` テーブル。UI (F2) はこれを定量値の隣に並べる。

---

## 1. 境界

- 新規: `src-tauri/src/ailog/summarize.rs`, `src-tauri/src/ailog/prompt.rs`
- 編集: `src-tauri/src/commands/ailog.rs` (コマンド追加), `src-tauri/src/ailog/mod.rs`
- 参照実装: `src-tauri/src/commands/tab_sweep.rs`
  (`claude -p` の spawn、プロンプトを argv に載せず stdin で渡す作法、
   タイムアウト、Windows での taskkill、`prepare_spawn_command`)
  **この作法を踏襲する。argv にプロンプト本文を載せない。**
- 触らない: F1 のスキーマ (summary テーブルの列追加を除く)、フロントエンド、pty/, usage/

---

## 2. 要約の入力 (トークン制御が肝)

セッションの生ログ全部を投げない。**1 セッションあたり入力 12,000 文字を上限**とし、
超える場合は下記の優先順で削る。削った事実は `truncated: true` として記録する。

投入する材料 (この順で優先):

1. `ai_title` / `first_prompt`
2. ユーザー発話 全件 (各 500 文字まで)。**ユーザーの発話が最も情報密度が高いので最優先で残す**
3. 手戻りシグナルの実データ:
   - エラーになった tool_result の先頭 300 文字 × 最大 10 件
   - 3 回以上編集されたファイルのパスと編集回数
   - 失敗直後に再実行された Bash コマンドの先頭語
4. アシスタントの最終メッセージ (最大 1,500 文字) — 結論・完了報告が入っている
5. tool 使用の統計 (名前別回数・エラー率)
6. 定量値 (モデル別トークン・コスト・所要時間・ターン数・compact 回数)

**思考ブロック・reasoning は投入しない** (量が多く要約価値が低い)。

---

## 3. 出力スキーマ (JSON 固定)

プロンプトで以下の JSON のみを返させる。前後に地の文を書かせない。
パース失敗時は 1 回だけリトライし、それでも失敗したら `summary.parse_error` に生出力の
先頭 500 文字を残してスキップする (握りつぶさない)。

```json
{
  "goal": "このセッションで達成しようとしたこと (60 文字以内)",
  "goal_cluster": "下記の固定カテゴリから 1 つ",
  "outcome": "done | partial | abandoned | unclear",
  "findings": [
    { "text": "このセッションで判明した事実 (80 文字以内)", "kind": "cause | constraint | gotcha | decision | verified" }
  ],
  "rework": {
    "happened": true,
    "cause": "手戻りの原因 (80 文字以内・起きていなければ空文字)",
    "category": "spec-ambiguity | wrong-assumption | env-issue | tool-failure | scope-creep | none"
  },
  "cost_note": "コストが大きい/小さい理由として観測できること (80 文字以内)",
  "confidence": "high | medium | low"
}
```

`goal_cluster` の固定カテゴリ (これ以外を返させない。該当しなければ `other`):

`feature` `bugfix` `refactor` `investigation` `review` `test` `build-release`
`ops-config` `docs` `data-analysis` `content-production` `planning` `other`

**カテゴリを自由記述にしない。** 自由記述だと表記ゆれで集計できなくなる。

---

## 4. 品質規律 (これを守らないと定性情報が信用できなくなる)

- **findings は「ログから読み取れる事実」に限定する。** 一般論・教訓めいた文
  (「テストは大事」等) を書かせない。プロンプトで明示的に禁止する
- **confidence: low の要約は UI で区別できるようにする。** 握りつぶさない
- `outcome` は最終メッセージとツール実行の終端から判定させる。
  **判定材料が無ければ `unclear` を選ばせる。** 埋めるために推測させない
- 要約モデル・プロンプトバージョンを `summary.model_used` と `summary.prompt_version` に記録する。
  プロンプトを変えたら version を上げ、**古い version の要約は再生成対象として識別できるようにする**

---

## 5. コマンド

| コマンド | 引数 | 返り値 |
|---|---|---|
| `ailog_summarize_start` | `{ range, filters, model, limit, order, force }` | `{ started, target_count, estimated_input_chars }` |
| `ailog_summarize_cancel` | — | `{ cancelled }` |
| `ailog_summarize_status` | — | `{ running, done, total, failed, current_session, elapsed_ms, last_error }` |

- `order`: `"cost_desc"` (既定) / `"rework_desc"` / `"recent"`
- `force=false` (既定) なら**既に要約済みのセッションはスキップ**。
  `force=true` で再生成 (プロンプト version が上がったとき用)
- `limit` 既定 50、上限 500。**無制限は許さない**
- `model` 既定は `claude-haiku-4-5-20251001` (tab_sweep と同じ)。
  `claude-opus-5` も選べるようにするが、UI 側で「コストが上がる」と表示する前提
- 並列度は 3 まで。それ以上同時に `claude -p` を立てない
- 1 セッションあたりのタイムアウト 120 秒。超えたら kill して failed に計上し、次へ進む

## 6. 自己言及の除外 (重要)

要約バッチ自身が `claude -p` を呼ぶため、その実行ログが `~/.claude/projects/` に残り、
次回インデックス時に「セッション」として集計されてしまう。放置すると
**分析ツールのコストが分析対象を汚染する**。

対策:

- `claude -p` を起動する際、`--append-system-prompt` などは使わず、
  **プロンプト本文の先頭に固定マーカー行 `[mycmux-ailog-summarizer]` を入れる**
- インデクサ側 (`parse_claude.rs`) で、セッションの最初のユーザー発話がこのマーカーで
  始まる場合 `session.origin = 'ailog-internal'` を立てる
- 既定フィルタで `origin = 'ailog-internal'` を除外する。
  ただし**除外した件数とコストは `Overview.excluded_internal` として返し、
  UI で「分析ツール自身の消費」として別枠表示できるようにする** (隠さない)
- この分岐は F1 側の変更になるため、**F3 の実装時に `parse_claude.rs` と
  `query.rs` へ最小の追記を行う**。F1 の他の部分は触らない

## 7. コスト事前提示

`ailog_summarize_start` を呼ぶ前に UI が見積もりを出せるよう、
`estimated_input_chars` と対象件数を返す。実際にかかったコストは
バッチ完了後に `summary` テーブルの `input_tokens` / `output_tokens` 合計から算出できる。

**要約バッチの累計消費を `ailog_summarize_status` の完了時レスポンスに含める。**
「分析のために何トークン使ったか」が分からないまま走らせない。

## 8. 完了条件

```
cd C:/Users/miyaz/cmux-for-linux-dev-master
npx tsc --noEmit
npx vitest run
python scripts/run_windows_tests.py
python -m pytest tests/
```

加えて Rust ユニットテストで以下を固定する:

- 入力ビルダが 12,000 文字上限を守り、優先順位どおりに削ること (固定データで検証)
- ユーザー発話が最優先で残ること
- JSON パーサが、前後に地の文が付いた出力・コードフェンスで囲まれた出力から
  JSON を取り出せること。取り出せない場合に `parse_error` が残ること
- `goal_cluster` が固定カテゴリ以外を返してきたら `other` に丸めること
- `force=false` で既存要約をスキップすること
- マーカー付きセッションが `origin='ailog-internal'` になり、既定集計から除外され、
  かつ `excluded_internal` に計上されること
- プロンプト本文が argv に載らないこと (tab_sweep のテストと同じ形の assert)

実データスモーク: 実際に 3 セッションだけ要約を走らせ、
生成された JSON と DB の行を報告に貼る。

## 9. 判断者・報告

採否は親 (Claude)。`REPORT_F3.md` に検証出力を貼る。疑問があれば `BLOCKER.md` で停止。
コミットはローカル 1 本、push しない。`git add -A` 禁止 (並行作業がある)。
セルフレビュー 2 周の結果を REPORT に書く。
