# エージェント hook の契約 (Phase 0)

- 状態: 確定 (2026-08-30)。Phase 1 以降の実装はこの文書を正本とする
- 上位の裁定: [ADR 0009](../adr/0009-agent-hook-realm-and-per-launch-capability.md) (受け口と認証) / [ADR 0010](../adr/0010-agent-state-canonical-reconciler.md) (状態は reconciler が確定)
- 要件: [2026-08-29-orca-adoption-requirements.md](2026-08-29-orca-adoption-requirements.md)

この文書は Phase 1 の実装が参照する語彙と規則を確定する。実装中に迷ったらここへ戻る。ここに無い判断が出たら、実装を止めてここへ追記してから進む。

---

## 1. 正規化イベントの語彙

エージェントが何を言ってきても、mycmux の内部では次の8状態のいずれかへ正規化する。provider 固有の名前を内部へ持ち込まない。

| 状態 | 意味 | 典型的な発生源 |
|---|---|---|
| `TURN_ACTIVE` | エージェントが作業している | プロンプト投入・ツール実行の開始 |
| `ATTENTION_REQUIRED` | 人の入力を待って止まっている | 許可要求・選択肢つき質問 |
| `TURN_ENDED` | ひと続きの応答が終わった | provider の `Stop` 相当 |
| `PROCESS_EXITED` | プロセスが終了した | プロセス検査・PTY の終了 |
| `SESSION_TERMINATED` | セッションそのものが終わった | セッション終了イベント |
| `FAILED` | 異常終了・エラーで停止 | 失敗を示すイベント |
| `CANCELLED` | 人が中断した | 割り込み・Escape |
| `RATE_LIMITED` | 枠切れで進めない | 枠超過の通知 |

### 1.1 「完了」の定義 (最重要)

**画面上の「完了」= `TURN_ENDED`** とする。`PROCESS_EXITED` と `SESSION_TERMINATED` は完了ではなく、それぞれ別の表示にする。

理由: provider の `Stop` は「応答が終わった」であって「頼んだ仕事が終わった」ではない。ここを混ぜると、hook を入れた結果かえって「一回答しただけで完了通知」が増えて精度が下がる。

- `TURN_ENDED` → 「こちらの番が来た」の通知。turn チップの主対象
- `PROCESS_EXITED` → 「プロセスが終わった」。成功とは限らないので完了と呼ばない
- `SESSION_TERMINATED` → 「セッションが閉じた」。再開の対象外になったことを示す

**確定済み** (2026-08-30 宮崎さん裁定)。Phase 1 以降の実装はこの定義に従う。

## 2. 対話プロンプトの3分類

エージェントからの問いかけは、応答の仕方が3通りある。カードの挙動が変わるので実装前に分ける。

| 分類 | 性質 | mycmux の振る舞い |
|---|---|---|
| `OBSERVE` | 報告だけ。返事は要らない | 受け取って記録し、即座に受領を返す |
| `SYNC_DECISION` | エージェントが返事を待って止まっている | カードを出し、答えを構造化して返す。返すまでエージェントは待つ |
| `DEFER_RESUME` | いったん保留を返し、後から明示的に答える | 保留を返してエージェントを解放し、答えが決まってから別経路で送る |

`SYNC_DECISION` と `DEFER_RESUME` は、どちらも人の入力を待つが、**エージェントを待たせるかどうか**が違う。待たせる方は応答期限があるので、期限切れの扱いを provider ごとに定める。

## 3. 起動世代 (launch generation)

**同じペインでも、エージェントを起動し直したら別物として扱う。** これが無いと、古いプロセスから遅れて届いた報告が新しいエージェントを完了扱いにする。

起動世代は次で構成する。

```
app_instance_id   アプリの起動ごとに変わる乱数
pane_id           ペインの識別子
provider          claude / codex / grok のいずれか
launch_generation 同じペインでの起動回数 (単調増加)
```

**ペイン ID の再利用だけでは同じ起動とみなさない。** resume と新規起動も別世代として扱う。provider が出すセッション ID の再利用も信用しない。

## 4. 受け口の認証 (capability)

### 4.1 構造

```
capability_id -> {
  app_instance_id,
  pane_id,
  provider,
  launch_generation,
  managed_process_id?,
  created_at,
  state: ACTIVE | DRAINING | REVOKED
}
```

- 値は最低 256bit の乱数。対応関係は server 側だけが持つ
- **リクエストに書かれた `pane_id` や `provider` を認証の根拠にしない。** server が capability から導出し、リクエストの値は一致確認にだけ使う

### 4.2 状態遷移

| 状態 | 受理するもの | いつ入るか |
|---|---|---|
| `ACTIVE` | すべてのイベント | 起動時に発行 |
| `DRAINING` | その起動の終端イベントだけ | ペインを閉じた直後から10秒間 |
| `REVOKED` | 何も受理しない (状態を変えない) | DRAINING の経過後・アプリ終了時 |

**ペインを閉じた瞬間に無効化しない。** 終了 hook とプロセス終了とタブ閉じは競合するため、10秒の猶予を置く。ただしユーザーが明示的に閉じた場合は、終端イベントを記録しても OS 通知は出さない。

### 4.3 許可する操作 (これだけ)

1. lifecycle イベントの登録
2. 対話プロンプトの登録と応答待ち
3. hook / helper の health probe

`pane.spawn` / `pane.send_text` / `pane.read` / `pane.close_tab` へは**絶対に昇格できない**。既存のソケットトークンとは別の認証領域として実装し、既存コマンドの処理と mutex / executor を共有しない。

## 4.4 線の仕様 (wire protocol)

Phase 1b の実装が参照する具体値。ここが曖昧なままだと受け口を書けないため確定させる。

### 動詞

| 動詞 | 用途 | Phase |
|---|---|---|
| `hook.observe` | lifecycle 観測の登録 | 1b |
| `hook.health` | 生存確認と版数の取得 | 1b |
| `hook.prompt.*` | 対話プロンプトの登録と回答 | **2** (1b では実装しない) |

**Phase 1b で実装するのは `hook.observe` と `hook.health` の2つだけ。** プロンプト機構は CAS・保留・再開・期限を伴い、その仕様は要件書の Phase 2 にある。受け口だけ先に作っても中身を定義できないので、Phase 2 で受け口ごと足す。

### 資格情報の場所

リクエスト直下の `hook_cap` フィールド (文字列)。既存の広い権限のトークンは `token` フィールドで、**両者は排他**。

- `hook_cap` があれば hook 領域へ。`token` は見ない
- `token` があれば既存の領域へ。`hook_cap` は見ない
- **両方あるリクエストは拒否する** (どちらの領域にも入れない)
- どちらも無ければ既存の領域の未認証として扱う (現行動作のまま)

資格情報は分類の直後にペイロードから除去し、**ログにも診断にも出さない**。

### 封筒

要求:

```
{"hook_cap": "<capability>", "cmd": "hook.observe", "id": <u64>, "body": { ... }}
```

応答:

```
{"id": <u64>, "ok": true,  "result": { ... }}
{"id": <u64>, "ok": false, "reason": "<機械可読な理由>", "retryable": <bool>}
```

拒否の `reason` は §15 の計数名と同じ語彙を使う (`invalid_cap` / `stale_launch` / `wrong_provider` / `queue_dropped` / `too_large` / `malformed`)。**拒否は正常な結果であって異常ではない** (§13)。

### 版数

`hook.health` の応答に `protocol_major` と `protocol_minor` を含める。**Phase 1b の値は major=1 / minor=0。**

- major が一致しなければ helper は何もしない (no-op)
- minor の差は許容し、知らないフィールドは無視する

### 大きさの上限

| 対象 | 上限 |
|---|---|
| 1行 (フレーム) 全体 | 1MiB |
| `hook_cap` | 512 バイト |
| `cmd` | 64 バイト |
| `body` の文字列フィールド1つ | 64KiB |
| `body` の入れ子の深さ | 32 |

上限超過は `too_large` で拒否する。**行の読み取りは最初から上限つきで行う** (無制限に読んでから長さを見る実装にしない)。

### 流量の制限

| 対象 | 上限 | 溢れたとき |
|---|---|---|
| capability ごと | 20件/秒 (瞬間的な超過は 40件まで許容) | `queue_dropped` で拒否 |
| 全体 | 200件/秒 | 同上 |
| 受信待ち行列 | 2048件 | 最古を捨てて計数する |

いずれもエージェントは止めない。捨てたことは集約して1度だけ診断に出す (毎回出さない)。

### 身元 (identity) — 2026-08-30 改訂

**認証の主体は pane ではない。** 当初 `pane_id` をレイアウトの pane UUID と定めたが、Oracle の設計ゲートで却下された。理由は2つ。

1. **pane は配置の単位であって実行の主体ではない。** タブ移動・複数タブ・PTY の作り直しと寿命が一致しない
2. **Rust の起動経路に pane UUID が届いていない。** 実装が2回、この地点で正しく停止した

採用する構成:

```
app_instance_id      アプリ起動ごとの乱数
terminal_session_id  PTY の寿命を表す実行コンテナ ID (既存の session_id)
provider             claude / codex / grok
launch_id            エージェント1回の起動を表す非秘密 ID
launch_generation    同じ (terminal_session_id, provider) 内の起動順
```

- **capability は `launch_id` を証明する推測不能な bearer**。`launch_id` 自体は秘密ではない
- `pane_id` は**表示と配置のためのメタデータとして持ってよいが、認証・失効・current 判定には使わない**
- **`pane_id` というフィールド名に session_id を入れることを禁じる。** 意味を変えるならフィールド名ごと変える

### 受理の手順

body に書かれた値をルーティングの根拠にしない。capability からサーバ側のレコードを引く。

```
record = capability_lookup(token)
record が無い                                        → unauthorized
record.app_instance != current_app_instance          → unauthorized
current_launch[session_id, provider] != record.launch_id → stale_launch
body を検証 → record.launch_id のイベントとしてだけ記録
```

### 投影 (projection) の分離 — ここを間違えると事故が残る

古い launch の台帳に「完了」が記録されること自体は問題ではない。**それが現在の表示へ投影されることが問題**である。

```
イベント → launch_id の台帳を更新
        → その launch_id が current のときだけ現在の表示へ投影
```

認証だけ直して投影が pane 単位の上書きなら、元の事故 (古い報告が新しいエージェントを完了扱いにする) は残る。

### 未解決の前提 — Phase 1b の実装前に埋める

**`create_session` はエージェント起動の境界ではない。** これは実測で確認した。

- `create_session` は PTY を1つ作る API (`command` + `args` を受ける)
- `isShellLauncher()` が示すとおり、シェルタブ (`shell` / `bash`) が存在する
- **そのシェルの中で `claude` を手で起動し直す経路がある。この起動は Rust から見えない**

したがって PTY 作成時に capability を env へ置くだけでは、同じシェル内の新旧エージェントが**同じ capability を継承する**。台帳上で世代を進めても、新しいプロセスへ新しい capability が渡らなければ意味がない。

**採用: L2 — 起動ラッパー方式** (2026-08-30 宮崎さん裁定)。

ラッパーは provider を exec する直前に backend から capability を取得し、それを環境に置いてから本体を起動する。

```
ランチャー / spawn
  → ラッパー起動
      → backend へ「この session の provider を起動する」と申告
      → backend が起動世代を1つ進め、新しい capability を発行
      → 環境に置いて provider を exec
```

これで**同じシェルの中でエージェントを起動し直しても、起動ごとに別の capability になる**。PTY 作成時に1回だけ置く方式では覆えなかった穴が閉じる。

**差し込み口は既にある。** `src-tauri/src/launcher.sh` の冒頭で、エージェントは shell 関数として定義され `export -f` されている。

```sh
claude() { "$HOME/bin/claude.cmd" "$@"; }
claude-codex() { "$HOME/bin/claude-codex.cmd" "$@"; }
codex() { "$APPDATA/npm/codex.cmd" "$@"; }
export -f claude claude-codex codex
```

`export -f` されているため、**この関数は対話シェルにも引き継がれる**。つまり**手打ちの `claude` もこの関数を通る**。ここで capability を取得してから本体を呼べば、ランチャー経由と手打ちの両方を同じ経路で捕捉できる。

当初「手打ち起動は覆えない」と書いたが、実態はより良い。ただし次の条件つき:

| 経路 | 捕捉 | 条件 |
|---|---|---|
| ランチャー経由 (bash) | ○ | 関数を通る |
| 手打ち `claude` (bash) | ○ | `export -f` により関数を通る |
| **PowerShell 側** | **×** | `launcher.ps1` に同等の関数定義が無い |
| 絶対パス直叩き (`~/bin/claude.cmd`) | × | 関数を迂回する |

**PowerShell 側は必ず同時に対応する。** 「ランチャーは bash / ps1 の2本あり、片方だけ直すと押せない項目ができる」という既知の教訓がそのまま当てはまる。契約テストは両方を走査すること。

絶対パス直叩きは覆えないが、その場合も環境に残る古い capability のイベントとして記録されるだけで、§4.4「投影の分離」により**現在の表示は書き換えない**。事故は起きない。

却下した案:

| 案 | 却下理由 |
|---|---|
| L1 (起動を必ず backend API 経由にする) | 最も厳密だが起動経路の変更が広く及ぶ |
| L3 (per-PTY-session に弱める) | 「同じシェル内の再起動を分離する」という目的自体を捨てることになる |

### Phase 1b の受理ゲート

次の5件が閉じるまで Phase 1b を PASS にしない。

| ID | 内容 |
|---|---|
| P1B-01 | 認証主体を pane から launch/session に変更した本節が確定していること |
| P1B-02 | `session_id` の生成・寿命・再利用規則を、コードと実機試験で証明すること |
| P1B-03 | **ラッパー経由の起動すべてで capability が更新されることを証明すること**。同じシェル内で2回起動して別の capability になることを試験する。**bash と PowerShell の両方**で確認する |
| P1B-04 | 古い launch のイベントが現在状態の投影を変更できないことを試験すること |
| P1B-05 | body・拒否コード・壊れた JSON の応答を wire contract として固定すること |

## 4.5 capability の発行と失効の経路

受け口だけを作っても、発行する側が無ければ動かない。発行と失効はペインの起動・終了と同じ場所に置く。

| 出来事 | 場所 | すること |
|---|---|---|
| エージェントを起動 | **未決 (§4.4 の L1/L2/L3 を決めてから確定)** | 起動世代を1つ進め、capability を発行し、`MYCMUX_HOOK_CAP` としてその子プロセスにだけ渡す |
| ペインを閉じる | 同ファイルの終了経路 | `DRAINING` へ移し、10秒後に `REVOKED` |
| アプリ終了 | `lib.rs` の終了処理 | すべて `REVOKED` |

**env に入れるのは capability だけ。** session ID・provider・起動世代は入れない (server が capability から解決するため・§4.4「受理の手順」)。

> 注: `create_session` が起動境界にならないことが実測で判明したため、この表の「場所」は §4.4 の L1/L2/L3 の決着まで確定しない。PTY 作成時に1回置くだけでは、同じシェル内の再起動を分離できない。

`MYCMUX_HOOK_CAP` は §8 の観点では**継承させてよい** (helper は孫プロセスとして起動されるため)。ただし `sanitize_launch_env` の always-strip 一覧に加えて、**新しいペインを作るときに親から漏れ継がないようにする**。既存の3リストと同じく契約テストで固定する。

## 5. 情報源の優先順位と競合規則

### 5.1 権限表

| 情報源 | 役割 | 単独で OS 通知してよいか |
|---|---|---|
| 妥当な hook | 信頼度の高い意味情報 | reconciler が確定した後だけ |
| rollout ログ | 予備・先行する暫定情報 | 猶予の経過後だけ |
| プロセス検査 | 生存と終了の事実 | 「プロセスが終わった」だけ |
| タイトル・画面 | 信頼度の低い表示ヒント | 不可 |

**どの情報源からも、直接 toast / badge / カード / OS 通知を出してはならない。** 必ず reconciler を通す。

### 5.2 競合の裁定

- 妥当な `ATTENTION_REQUIRED` は、暫定の `TURN_ENDED` より優先する
- `PROCESS_EXITED` は「終わった」であって「成功した」ではない
- **古い起動世代のイベントを新しい世代へ適用しない**
- 同じ turn の同じ終端イベントは、何回来ても1回として扱う
- 終端から作業中へ戻すには、新しい turn ID か新しい世代が要る
- ユーザーが明示的に閉じた後の終端イベントは、台帳に残すが通知しない
- 猶予が切れて確定した後に hook が遅れて来た場合、状態は訂正してよいが**通知は再発火しない**

### 5.3 猶予 (grace)

hook が仕込まれている起動では、rollout の終端を**暫定**として記録し、**3秒だけ** hook を待つ。

- hook が来たら統合する
- 3秒経ったら暫定を確定に昇格させる
- hook が仕込まれていない起動では猶予なしで即確定

3秒は初期値。実測の p99 を見て 0.5〜5秒の範囲で調整する。**orca の30分窓は採らない** (同じエージェントが30分以内に複数回応答を終えると、正当な予備判定まで抑え込むため)。

**猶予の判定には受信時の単調時計を使う。** provider が付けた時刻は表示と記録の専用とし、判定に使わない。

## 6. 同一性と重複排除

### 6.1 照合キー

```
app_instance_id
pane_id
launch_generation
provider
provider_session_id
provider_turn_id      (provider が出さない場合は reconciler が発行する synthetic 世代)
event_kind
```

**時刻を丸めただけの重複排除キーは使わない。**

### 6.2 一度きりを保証する場所

配送の一度きりは追わない。**人に見える副作用の側で一度きりを保証する。**

永続台帳に最低限これを持つ。

```
canonical_event_id
source_event_ids[]
payload_hashes[]
current_state
state_version
card_created_at
unread_incremented_at
native_notification_emitted_at
acknowledged_at
```

イベントの受理と `native_notification_emitted_at` の確保を同一トランザクション (または耐久 outbox) で行う。**アプリを再起動して rollout を再走査しても、同じ通知を二度出さない。**

保持期間は最低7日、または rollout の読み取り位置が完全に通過するまで。

## 6.3 既存の attention モジュールとの関係

`src-tauri/src/attention/` は既に「カード・証拠・解決・永続化」を持っている。**新しい判定器はこれを置き換えない。層が違う。**

| | attention (既存) | reconciler (新規) |
|---|---|---|
| 入力 | スナップショット2枚の差分 (`previous` / `current`) | イベントの列 (hook / rollout / プロセス検査) |
| 出力 | 人に見せるカード (`AgentAsked` / `WorkStopped` 等) | canonical state (8状態) |
| 位置 | 確定した状態を受けて表示を作る | 状態そのものを確定する |

縦の関係にする。**reconciler が状態を確定 → attention がそれを見てカードを起こす。** 逆流させない。

したがって:

- 台帳 (§6.2) は reconciler 用に新設する。`attention_cards` とは別テーブルにする (役割が違うため)
- attention の判定規則は変更しない。入力となるスナップショットの精度が上がるだけ
- カードの表示・解決・永続化は既存の仕組みをそのまま使う

## 7. 副作用の所有権

**canonical state・未読の加算・OS 通知は Rust backend だけが発行する。** React 側は読み取り専用のモデルを表示するだけにする。

理由: React の Strict Mode は開発時に effect の設定と後片付けを追加実行する。描画側の effect で通知やカードを作ると、後片付けの漏れだけで二重発火する。複数ウィンドウにしたときも、各 WebView が同じイベントで副作用を起こしてはならない。

## 8. 設定ファイルへの書き込み規則

| 規則 | 内容 |
|---|---|
| 意味を保つ統合 | 既存の定義を順序ごと保持し、自分の分だけを差し替える |
| 所有の目印 | 自分が足した項目にだけ目印を付ける |
| 競合検出 | 書き込む直前に、読んだときから変わっていないことを確認する |
| 原子的な置換 | 一時ファイルへ書いてから入れ替える |
| 撤去 | 自分の項目だけを消す。他は触らない |
| 無変更なら書かない | 内容が同じなら書き直さない |
| Codex の信頼 | 信頼状態を検出し、未信頼なら予備の判定へ落とす |

**`~/.claude/settings.json` には既存の設定が多数ある。1つでも壊すと実害。** 検証は書き込み前後の差分を機械的に比較して行う。目視で通さない。

## 9. 版数の互換

- helper と app のプロトコル版数を major / minor で持つ
- 知らないフィールドは受け入れる (無視する)
- 対応外の major は何もしない (no-op)
- app の更新中に「古い helper × 新しい app」「新しい helper × 古い app」の組み合わせが起きる。両方を試験する
- **helper のパスを変えると Codex の再信頼が必要になる。** 運用手順に明記する

## 10. hook が無いときの動作

hook を仕込んでいない・信頼されていない・helper が届かない起動では、次のように劣化させる。

- rollout ログとプロセス検査だけで判定する (猶予なしで即確定)
- 診断画面に「予備の判定で動作中」と出す
- **止まらない。** 精度は落ちるが、現在の動作を下回らない

## 11. 撤去と巻き戻し

- 設定から自分の項目を消す
- capability を全て無効化する
- 台帳は消さない (履歴として残す)
- helper の実体ファイルは残しても安全な設計にする (残骸が動作を壊さない)

## 12. 脅威の範囲

### 守るもの

- 他のペイン・他の起動世代へのなりすまし
- 古いイベントによる誤った状態変更
- 既存の広い権限のコマンドへの昇格
- 設定ファイル経由のコマンド実行
- 通知やカードの増幅

### 守らないもの (非目標)

- 同じ起動世代の子孫プロセスによる自分の状態の詐称
- 同じユーザー権限で動くマルウェア
- OS の管理者権限
- エージェントの出力そのものの虚偽

完全防御は目指さない。同じユーザーのプロセスを敵とみなすと防ぎきれず、無効化の競合を増やすだけになる。**安価に取れる「他ペイン・古い世代からの隔離」だけを取る。**

## 13. 失敗の方向

**エージェントの実行については開いて倒す。mycmux の状態変更については閉じて倒す。**

- 認証失敗・古い世代・未知の provider・壊れたペイロード → helper は短時間で正常終了し、**エージェントを止めない**
- 同時に mycmux 側は、カード・未読・完了状態・通知を**一切変更しない**

## 14. 数値の初期値

| 項目 | 初期値 |
|---|---|
| 終端の猶予 | 3秒 (0.5〜5秒で調整) |
| DRAINING の保持 | 10秒 |
| helper の応答期限 (報告系) | 500ms |
| helper 起動から受領まで | p95 100ms / p99 250ms |
| mycmux 停止中の helper 終了 | 250ms 以内 |
| リクエスト本文の上限 | 1MiB |
| endpoint 記述子の上限 | 16KiB |
| 受信待ち行列の上限 | 2048件 |
| 台帳の保持 | 7日 |

## 15. 計測する項目

秘密を含めず、次を数える。

```
received / accepted / rejected_invalid_cap / rejected_stale_launch /
rejected_wrong_provider / deduplicated / provisional / promoted_by_timeout /
merged_with_hook / late_hook / queue_dropped /
notification_emitted / notification_suppressed / prompt_stale / answer_cas_failed
```

ペインごとに診断画面へ出す: hook が入っているか / 信頼されているか / helper の版数が合うか / capability が有効か / 最後のイベント / 予備判定で動いているか / rollout の読み取り位置の健全性。

## 16. Phase 1 の受け入れ条件

「受信できた」では認めない。次の出来事の列を流して、canonical state と副作用が**一意に収束する**ことを確認する。

- 同じ hook を100回送る
- rollout の終端の 0〜10秒後に hook が届く
- hook が届いた後に rollout を再走査する
- hook が逆順に届く
- ペインを閉じるのと終端 hook が同時に起きる
- 同じペインで即座に再起動する
- アプリを落として再起動する
- 古い endpoint 記述子が残っている
- 古い helper × 新しい app / 新しい helper × 古い app
- 設定ファイルを編集している最中に自動統合が走る
- Codex の hook が未信頼
- 20ペイン以上から同時に発火する

## 17. 未確定 (実装前に埋める)

- provider ごとの応答期限の実測値 (`SYNC_DECISION` の待たせ方)
- helper の配置場所とインストール手順 (Phase 1c で確定)
- 診断画面の置き場所
