# AskUserQuestion は画面から読み、数字キーだけで答える

Status: accepted (2026-08-23)

ダッシュボードから Claude Code の選択肢プロンプトに答えられるようにするにあたり、テスト機 (`scripts/test-profile.ps1 -Name askq`) で実機計測した。結論は2つ。**質問は transcript には現れないので画面から読むしかない**。そして**応答は数字キー1バイトだけで完結し、Enter を送ってはいけない**。

## 計測でわかったこと

### transcript は回答が終わるまで質問を書かない

これが最大の発見で、設計の前提を決める。

| | 質問が画面に出ている間 | 回答を送った後 |
|---|---|---|
| `assistant` レコード | **0件** | 2件 |
| `tool_use` | **なし** | `{AskUserQuestion: 1}` |
| `toolUseResult.answers` | — | `{"Pick a fruit": "Banana"}` |

`AskUserQuestion` の `tool_use` は、回答が完了してから `tool_result` と一緒に書き出される。つまり `livebrief` が transcript を tail していても、**質問中は Question イベントを立てられない**。回答後に `tool_use` と `tool_result` が同時に流れるため `Question` → `QuestionResolved` が即座に相殺され、`pending` は一瞬も残らない。

ダッシュボードに質問が出たことが一度も無かった理由はこれで、`adapter.rs:812 parse_question` が `questions[]` を読めないバグはその奥にある第二の問題だった。片方だけ直しても何も表示されない。

### 単一質問と複数質問で UI が違う

**単一質問** — 縦並びのリスト。カーソルは常に先頭 (`❯ 1.`)。

```
 ☐ Probe A
Pick a fruit
❯ 1. Apple
     甘酸っぱい定番の果物        ← description が折り返して出る
  2. Banana
  4. Type something.
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
```

**複数質問** — タブ形式に変わる。ナビゲーションの案内も `↑/↓` から `Tab/Arrow keys` になる。

```
☐  ☐ Colour  ☐ Size  ✔ Submit  ▶
Pick a colour
❯ 1. Red
  2. Green
  3. Blue
  4. Type something.
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
```

1問ずつ順に聞かれるのではなく、**全問を選んでから Submit する**。選択済みのタブは `☑` になる。

全問選び終えると自動で Submit タブに進み、確認画面が出る。

```
☐  ☑ Colour  ☑ Size  ✔ Submit  ▶
Review your answers
▪ Pick a colour → ☑ Green
▪ Pick a size   → ☑ Large
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
```

### 数字キーは即決かつ自動前進する。Enter は不要

| 試行 | 打鍵 | 結果 |
|---|---|---|
| B | `"2"` + Enter | 単一質問で成立 (`Pick a fruit → Banana`) |
| D | `"2"` のみ (Enter なし) | **成立**。選択が即確定し、タブが自動で次へ進む |
| E | 複数質問で D を各問 → Submit で `"1"` | **成立** (`{"Pick a colour":"Green","Pick a size":"Large"}`) |
| H | 質問直後のカーソル位置 | 常に先頭 |

複数質問のフローは「各問で数字 → 自動前進 → Submit タブで `1`」だけで完結する。矢印も Enter も一度も要らない。

### multiSelect はトグルで、Submit だけ番号が無い

`multiSelect: true` の質問はチェックボックス表示になり、単一質問でもタブバーが出る。

```
☐  ☐ Toppings  ✔ Submit  ▶
Pick toppings
❯ 1. [ ] Cheese
     とろけるコクのある定番
  2. [ ] Bacon
  3. [ ] Onion
  4. [ ] Type something
     Submit                  ← 番号が振られていない
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
```

ここでは数字キーの意味が変わる。**即決ではなくトグル**で、押しても前進しない (`1. [✔] Cheese` になるだけ)。

`Submit` 行には番号が無いため数字では押せない。`↓` でカーソルを運んで `Enter` を送る必要がある。実測では選択肢4個 + Submit の並びで `↓` × 4 で到達した。その後は単一選択と同じ確認画面が出るので、`1` (Submit answers) で確定する。

つまり multiSelect だけは **数字キー (トグル) → ↓ × n → Enter → 確定画面で 1** という別のフローになる。`{"Pick toppings": "Cheese, Onion"}` が記録されることを実測で確認した。

### Enter を足すと複数質問で誤答する

数字キーが即決するため、`"2" + \r` を送ると **`\r` が次のタブに流れて、そのタブの1番目を確定させる**。単一質問では質問が終わった後に `\r` が入力欄へ落ちるだけなので実害が見えないが、複数質問では確実に誤答になる。

`intervene.rs:71-72` は payload に無条件で `b'\r'` を push している。この経路をそのまま使うと誤答を生む。

## 決めたこと

- **検出は画面スキャンで行う。** transcript 経路 (`livebrief` の `Question` / `pending`) は質問中に何も出さないので、質問の検出には使えない。画面から header・question・options・description・タブ状態・カーソル位置をパースする
- **応答は数字キー1バイトのみを送る。** Enter を付けない。複数質問は各問に1バイト、最後に Submit へ1バイト
- **multiSelect だけは例外。** 数字はトグルなので必要な数だけ押し、番号の無い `Submit` へ `↓` で移動して `Enter`、確認画面で `1`。`↓` の回数は画面から数えた選択肢数に依存するので、**画面を読めないときは撃たない**
- **`send_intervention` の既存経路は使わない。** brief の `pending` が埋まっていることを前提にした expectation 検証 (`prompt_event_id` / `prompt_hash`) が成立しないため。代わりに `pane.send_text` の `expected_attention_id` / `expected_session_revision` による楽観ロックを使う
- **transcript は事後確認にだけ使う。** `toolUseResult.answers` で「何が選ばれたか」を確定できるので、送信の到達確認はここで取る

## 検討した選択肢

- **transcript を待って質問を出す**: 実装が最も素直で、`livebrief` の配管がそのまま使えた。却下理由は、そもそも回答するまで書かれないため質問中に一度も表示できないから。この計測をするまでこれが本命だった
- **矢印キーで相対移動して Enter**: 現在位置に依存せず組めると考えていた。却下理由は、数字キーが絶対指定で動くうえ即決するので、より単純で誤りの余地が小さいから。`validate_reply_text` が ESC を拒否する制約も回避できる
- **ラベル文字列を打ち込む** (現行 `Choose` の実装): 却下。Claude の選択リストは文字入力を無視するため、届くのは末尾の `\r` だけになり、**常にカーソル位置の選択肢が確定する**。今は `parse_question` のバグで options が空になり `Err("option_id")` に落ちているため事故っていないが、パースだけ直すとこの誤答が実害化する

## 帰結

- 画面スキャンの範囲を広げる必要がある。`XTermWrapper.tsx runScan` は現在末尾16行しか見ていないが、質問ブロックは選択肢と description を含めて20行を超える
- `approvalScan.ts` の #5 パターン (`ask user question` のボックス見出し) は boolean の検出しかしていない。構造パースは別関数として起こす
- `QuestionCard` / `AskStrip` の UI はデータソースを差し替えれば流用できる。捨てる必要はない
- `parse_question` の `questions[]` 未対応バグは、事後の `answers` 突合と codex 経路のために直す価値が残る。ただし「質問を表示する」目的では効かない
