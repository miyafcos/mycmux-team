# 気づきの序列は種別ではなく「誰を待たせているか × 重大度」で決まる

Status: accepted (2026-08-31 宮崎さん承認)

承認時点の判断材料として、`attention_cards` テーブルは **0 行**だった。この機能はまだ一度も実運用でカードを出していないため、「実機の並びが変わる」という本文の注意は現時点では実害を伴わない。カードが出始める前にここを直すのが最も安い。

`AttentionCard` の並び順を決めている `KIND_PRIORITY` を廃止し、**すべての観測源が必ず埋める 2 つの軸** — 誰を待たせているか (`waiting`) と重大度 (`severity`) — で序列を決める。`kind` は表示ラベルに降格し、順序を決めない。観測源ごとの写像表を増やさない。

前提の状態確定は [ADR 0010](0010-agent-state-canonical-reconciler.md)。あちらは「エージェントの状態を誰が確定するか」、この文書は「確定した気づきをどの順で人に見せるか」を扱う。作戦上の位置づけは `docs/plans/2026-08-31-observation-contract-roadmap.md` の段1。

## いま起きていること

`src/components/dashboard/attentionModel.ts` の `KIND_PRIORITY` は 11 種類の `kind` に 0〜10 の固定席を与えている。この 1 列に、性質の違う 3 つの軸が畳み込まれている。

- 人が答えないと進まない (`agentAsked`)
- 作業が止まった・事故が起きた (`workStopped` / `outOfScopeWrite` / `conflictDetected` / `workOrderStalled`)
- 誰も待っていない良い知らせ (`nextItemReady` / `reportsComplete` / `goalReached`)

そこへ 3 本目の観測源が入り、歪みが表に出た。`src-tauri/src/attention/session_board.rs:275` は

```rust
let _ = (&item.severity, &item.actor, &item.freshness);
```

と書いて、session-board が送ってくる **重大度 (blocking / warning / advisory)・誰が動くべきか (actor / requires_human_action)・鮮度 (freshness) を 3 つとも捨てている**。残るのは `sourceRank` だけで、全件が単一の `sessionBoardIncident` として席順 2 に固定される。producer が blocking と判定した件も advisory と判定した件も同じ高さに並び、どちらも `agentAsked` と `workStopped` より必ず下に来る。

注目すべきは、**session-board は既に正しい 2 次元で送ってきている**という点である。捨てているのは受け取る側だ。4 本目の入口 (メール) を足す前に、この 2 次元を共通の軸として引き上げる。

## 検討した選択肢

- **種別優先を残し、severity を第 2 キーにする** — 却下。`sessionBoardIncident` が席順 2 に固定されている限り、session-board の blocking は `workStopped` より下、`outOfScopeWrite` より上、という説明のつかない位置に留まる。歪みの原因は席順そのものなので、第 2 キーを足しても動かない。
- **session-board 専用の写像表を書く (blocking → workStopped と同格に上げる)** — 却下。効くのは速いが、入口ごとに写像表が 1 枚ずつ増える。メールで 2 枚目、hook の分類が細分化すれば 3 枚目になり、「同じ重大度なのに入口によって位置が違う」を人手で維持することになる。作戦が主軸に据えたのは、まさにこれを起こさないことだった。
- **単一の数値スコアに畳む (severity × 重み + rank + 経過時間)** — 却下。順序は決まるが、なぜこのカードが上なのかを人にも自分にも説明できない。重みを 1 つ動かすと全体が動き、回帰テストが書けない。
- **LLM に並べさせる** — 却下。同じ状況で同じ順序が出ない。序列は決定性のある場所に置く (skill-structure §2 と同じ理由)。
- **`freshness` も序列に入れる** — 今回は却下。鮮度は「その観測をどれだけ信じるか」であって「どれだけ急ぐか」ではない。ADR 0010 の provisional / grace が扱う領域なので、序列ではなくカードの表示 (観測未完了の但し書き) 側で使う。捨てるのはやめ、カードに保持だけする。

## 結果

**軸 1 — `waiting`: 誰を待たせているか**

| 値 | 意味 |
|---|---|
| `human` | 人が答えるまで進まない (エージェントの質問・承認待ち) |
| `work` | 作業が止まっている、または事故が起きていて放置すると悪化する |
| `none` | 誰も待っていない (完了報告・次の候補) |

**軸 2 — `severity`: 重大度**

`blocking` / `warning` / `advisory` の 3 値。session-board の語彙をそのまま採る (既にこの 3 値で送ってきており、変換を挟むと意味がずれる)。

**並び順** = `waiting` → `severity` → `firstSeenAt` → `sourceRank` → `id`。すべて決定的で、同じ入力から同じ順序が出る。

`sourceRank` を `firstSeenAt` の**後ろ**に置くのが要点で、これは並びを実際に計算してみて分かった。rank は producer が 1 つのスナップショットの中で付けた相対順であり、**源をまたいで比べる意味を持たない**。前に置くと、rank を持たない自前カード (rank 欠損を末尾扱いにするため) が rank 付きの外部カードより下に沈み、`agentAsked` が 4 位まで落ちた。逆に rank 欠損を先頭扱いにすれば自前カードが常に上に来る。どちらも「rank の有無」という無関係な事実で順序が決まってしまう。

`firstSeenAt` を先に置けば、古い気づきほど先に処理するという素直な規則になり、同一スナップショットで同時に届いた session-board の複数件は `firstSeenAt` が等しくなるので、そこで初めて rank が効く。producer の意図は保たれ、源をまたいだ比較には使われない。

**既存 kind の写像 (移行時に 1 回)**

| kind | waiting | severity |
|---|---|---|
| `agentAsked` | human | blocking |
| `workStopped` | work | blocking |
| `outOfScopeWrite` | work | blocking |
| `conflictDetected` | work | blocking |
| `workOrderStalled` | work | warning |
| `completionWithoutTests` | work | warning |
| `budgetReached` | work | warning |
| `nextItemReady` | none | advisory |
| `reportsComplete` | none | advisory |
| `goalReached` | none | advisory |
| `sessionBoardIncident` | **item から導出** | **item の severity** |

session-board の `waiting` は `requires_human_action` と `severity` から導出する。既存 fixture 10 本の全 items を数えると、実在する組み合わせは 4 通りだった。

| severity | actor | requires_human_action | 件数 | → waiting |
|---|---|---|---|---|
| warning | human | true | 4 | human |
| blocking | human | true | 3 | human |
| advisory | human | true | 2 | human |
| blocking | system | false | 1 | **work** |

導出規則は 3 行:

1. `requires_human_action: true` → `human`
2. `false` かつ `severity` が `blocking` または `warning` → `work`
3. `false` かつ `advisory` → `none`

**2 行目が要点。** 「人の action は要らないが blocking」は実在する (system が動く番だが、いま塞がっている)。これを `none` に落とすと、塞がっている案件が完了報告と同じ高さに沈む。`requires_human_action` だけで 3 値を決めようとすると必ずここを踏むので、severity と組で読む。

`actor` は上の 4 通りでは `requires_human_action` と一対一に対応しており、導出には使わない。ただし「誰が動く番か」の表示には要るので、捨てずにカードへ保持する。

**観測が不完全なときのカード (2026-08-31 追記)**

session-board のスナップショットが読めない・スキーマが合わない・被覆が足りないとき、mycmux は「観測未完了」カードを出す (`9ee419c2`)。このカードには**元 item が存在しない**ので、上の導出規則が使えない。実装中に指摘されて判明した穴で、次のとおり埋める。

- `waiting` = `work` / `severity` = `warning` の固定値
- `actor` と `freshness` は `null` (捨てるのではなく、無いことを持つ)

`human` ではない — 人がその場で答えて解決する種類ではなく、producer 側かファイルの側を直す話になる。`advisory` でもない — 放置すると調整事項を見落とし続ける。`blocking` にもしない — 観測が一時的に欠けただけのものが最上位に居座り、実際に塞がっている案件を押し下げる。

被覆の程度 (`complete_zero` と `partial` で severity を変える) は**今回採らない**。どこから `blocking` に上げるべきかを決める根拠が今はなく、閾値を先に決めると外したときに動かしにくい。実運用でこのカードが出るようになってから見直す。

**観測源に課す義務**

- どの入口も `waiting` と `severity` を必ず埋める。埋められない観測源はカードを作れない
- これは 4 本目 (メール) を足すときの関門になる。「このメールは誰を待たせているのか」を答えられない限り入口として成立しない、という形で要件が前倒しで決まる
- `kind` は残すが表示ラベル専用。序列に使ってはならない (`KIND_PRIORITY` を消すことでこれを機械的に保証する)
- `freshness` / `actor` / `severity` を `let _ =` で捨てるのをやめ、カードに保持する。序列に使わないものも、捨てずに持つ

**移行**

1. `AttentionCard` に `waiting` と `severity` を追加 (Rust / TS 双方)
2. 既存の永続カードは上の表で埋めるマイグレーションを 1 回
3. `KIND_PRIORITY` を削除し `sortAttentionCards` を新しい並びに差し替え
4. `session_board.rs:275` の `let _` を外し、3 フィールドを写像に使う
5. 並び順の回帰テストは、**現在の並びが新実装で再現されない**ことを先に確認してから書く (テストが逸脱を固定するのを防ぐ・memory `feedback-codex-tests-lock-in-deviation`)

**見え方が変わること**

`KIND_PRIORITY` の廃止で、実機のカードの並びは変わる。特に session-board の blocking 案件が上位に、完了報告系が下位に動く。これは意図した変更だが、宮崎さんの体感に直接出るため、実装後は実機で並びを見てもらってから確定する (memory `feedback-ui-overhaul-needs-touch-go`)。
