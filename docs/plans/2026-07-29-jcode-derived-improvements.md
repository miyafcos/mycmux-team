# jcode 精読 → mycmux 改善計画 v2 (2026-07-29・Oracle ゲート反映)

**v1 からの重要変更 (実装中セッションは必読)**:
- **P4 の文字ドリップ (cps 制御) は却下** — jcode の stream_buffer は AI 応答テキスト専用のセマンティックバッファであり、汎用 PTY に適用すると (1) 表示が実プロセスから最大数十秒遅延 (2) approvalScan が画面を読むため**入力待ち検知が遅れる = 主目的の破壊** (3) 入力と表示の順序ずれ (4) 制御シーケンスまで遅延、の4点で不成立
- **P2 は仕様改訂** — 単一 state での5信号合流は「最後に届いた信号が勝つだけ」になる。状態 reducer (直交軸) を transport より先に作る。snapshot/epoch/seq/bounded queue を必須化
- **P3 は seen の時刻比較をやめ attention_id 単位に**。タブ一覧の動的ソートは二段構成に変更 (場所の記憶を壊さない)
- 根拠: Oracle (GPT-5.6 Sol Pro) 設計レビュー 2026-07-29。transcript = `C:\Users\miyaz\.oracle\sessions\mycmux-improvemen-gate-0729\artifacts\transcript.md`
- jcode 一次コードの精読結果 (v1 の出典) = `C:\Users\miyaz\reports\_quick\2026-07\jcode一次コード精読_mycmux最善手_v2_0729-2025.html`

## 実行順 (最初の2週間)

1. **P4 の文字ドリップ実装を中止**・P2 の wire schema を下記仕様で freeze (それまで merge しない)
2. **P1 + doctor-lite** — PTY リプレイ基盤で実測 (挙動は変えない)
3. **状態 reducer + replay テスト** — canonical store を transport より先に
4. **修正版 P2** — 専用 feed 接続 + snapshot/seq
5. **P3 + J** — attention_id 単位の未読 + next attention + 質問文1行
6. **B 最小実装** — Codex detector を adapter として reducer へ
7. **P1 で勝った描画対策を1つだけ** 採用 (基準: 同一リプレイで GPU CPU 相対30%減・入力 echo p95≤50ms・waiting 通知 p95≤1s)

A/C/E/G はこの2週間の後 (A が先頭)。F 増量・H・I は切る (理由は末尾)。

---

## P1. 計測基盤 (描画理由カウンタ → 3層計測 + PTY リプレイ) — doctor を統合

v1 の「呼び出し元カウンタ」だけでは不足。**xterm の実描画と一致しない** (write() は非同期パース)。3層で採る:

| 層 | 必須計測 |
|---|---|
| 入力・パース | PTY 受信 byte 数 / batch サイズ / `write()` 回数 / write callback 遅延 / pending byte 最大値 / `onWriteParsed` 回数 |
| 実描画 | `onRender` 回数と描画行数 / 全画面描画回数 / renderer 種別 / WebGL context loss 回数 |
| 周辺 | approvalScan 回数・所要 / resync byte・所要 / React commit 回数 / mount 中 xterm 数 / cursor blink / focus 状態 |

- **PTY リプレイ**: 実セッションの byte 列+到着時刻を保存し、同一ストリームを再生して before/after 比較 (生出力の比較は速度も内容も違い無意味)
- 実験マトリクス: WebGL 有/無 × mount 上限 1/2/4/8/12 × flush 16/33/100ms × blink 有/無 × focused/blurred × 各3回
- **renderer 在住予算**: LRU 12 は計測根拠のない固定値。上記マトリクスで切替時間と CPU の折衷点を決める (タブ位置は不変・renderer だけ冷却)
- `mycmux doctor` = この計測値+タブ毎 working set+状態の証拠台帳を人間向けに出す CLI (P1 の露出面。別プロジェクトにしない)

**境界**: 挙動変更なし (計上・リプレイ・レポートのみ)。**完了条件**: 3状態×60秒の対応表 + リプレイの再現性確認。

## P1.5. 状態 reducer + 証拠台帳 (新設・P2 の前提)

5信号 (processStatus / lastOutputAt / 画面スキャン / hook / work_done) は**同じ事実を観測していない**。単一 state に直接書くと最後に届いた信号が勝つだけ。直交軸に分ける:

```text
lifecycle: alive | exited | orphaned | unknown
activity:  streaming | running_silent | idle | unknown
attention: none | input | approval | error | done
health:    fresh | stale | degraded
```

- 構造: `raw evidence → 決定的 reducer (Rust) → canonical SessionView → frontend / socket / WS`。
  **screen scan・hook・monitor が直接 feed へ送る構造は禁止** (全部 evidence として reducer へ)
- attention は `attention_id / kind / detail / state_since / observed_at / sources[] / confidence / stale_after` を持つ (source 単数は誤り — 合流後の状態には複数証拠がある)
- UI 向けの単純な state はこの正本から導出
- **replay テスト必須**。ケース: ANSI 分割 / approval 直前の大量出力 / prompt 後も spinner / 非マウント中 waiting / hook と scan の順序逆転 / done 直後の追加出力 / PID 再利用 / 再起動後の古いイベント / resync 中の scan。
  各状態に「なぜ今 waiting か」の直近証拠数件を保持し doctor から読めるように — **これが無いと Claude/Codex の表示変更のたびに管制塔が静かに嘘をつく**
- 過去の実バグ2件 (7/27 再起動タイムスタンプ一斉更新で待ち通知全消し / 7/29 lastOutputAt 閉ループ) は reducer の replay ケースとして固定する

## P2. status feed push (修正版)

v1 からの変更点:

1. **「reply_to 無し=push」をやめる** — 既存クライアントが未知フレームを無視する保証がない。初期版は:
   - 既存 RPC 接続は**現在の形式を一切変更しない**
   - `status.subscribe` は**専用の長寿命接続** (subscribe 後は通常 RPC を受け付けない)
   - v2 フレームは明示的に `kind: "response" | "event"` を持つ
   - 契約試験は**現在使っている旧 CLI バイナリそのもの**で行う (ソース互換でなく実物)
2. **snapshot + server_epoch + seq を必須化**:
   - subscribe 直後に必ず full snapshot (`status.snapshot { server_epoch, seq, sessions[] }`)、以後 delta (`status.changed { seq, session_id, session_revision, status }`)
   - epoch 変化 or seq に穴 → 再 snapshot。33 セッション規模ならイベント再送ログより毎回 snapshot が正しい
   - **10秒の鮮度ポーリングは廃止するが、60〜120秒に1回の整合確認 snapshot は残す** (push に絶対の信頼を置かない — 1回の欠落が永久の嘘になる)
3. **unbounded mpsc をやめる** — 遅いスマホクライアントの負債を RAM で無制限に肩代わりする仕組みになる。status はログでなく最新状態: 接続ごと bounded queue で満杯時は同一 session の古い update を上書き (または capacity 1 の「更新あり」通知+writer が正本から取得)。overflow 時は `resync_required` → snapshot
4. **セッション単位 HashMap は不要** — 全セッション購読しか無い段階ではグローバル subscriber map 1つ。scope 追加時に writer 側 filter で対応
5. **client_instance_id takeover は初期版から外す** — feed は read-only で複数購読可。クライアント側の接続世代フラグで旧タスク無視すれば足りる
6. approvalScan の**状態遷移のみ** Tauri event で Rust へ (PTY byte stream は流さない)

**完了条件 (変更)**: 「push を受け取った」ではなく、**切断・mycmux 再起動・イベント欠落後にも正しい状態へ復元されること**。

## P3. 注意ルーティング (修正版) + J

1. **未読は時刻比較でなく attention_id / session_revision 単位** — 同一 waiting 中に detail だけ更新された場合の再点灯有無を明示できる。時計比較ではできない (7/27 の再起動一斉更新バグと同型の脆さ)
2. 3状態を区別: `unresolved` (サーバー正本・まだ入力/承認が必要) / `seen` (クライアントごとの表示状態) / `resolved` (入力・承認・遷移でサーバーが確定)。**スマホで一覧を開いただけでデスクトップの未読を消さない。見ただけでは unresolved は消えない**
3. **タブ一覧は動的ソートでなく二段構成**: 上段「要対応」(waiting/error/done-unseen) + 下段「全タブ (固定順)」。全体を並び替えると位置記憶を少しずつ破壊する
4. ジャンプキーは **`next attention`** (waiting → error → done-unseen の順・無ければ何もしない)。「無ければ done へ」のような名前と挙動の不一致を作らない
5. **J (何をしてほしいか1行) を統合** — hook/画面スキャンから抽出した**実文**を短く表示 (LLM 要約はしない)。waiting 以外では空欄

## P4. 描画対策 (修正版・P1 の実測で1つだけ採用)

**文字ドリップは却下** (冒頭参照)。安全に残る候補 (P1 マトリクスで勝者を1つだけ採用):

1. renderer 在住数削減 (LRU 12 → 実測最適値)
2. cursor blink / mycmux 自前アニメの停止・CSS 化 (blur 時)
3. active streaming の flush 16ms→33ms 比較
4. `write()` callback による pending parser backlog の bounded 化
5. blur 時の安全な whole-chunk バッチング (**chunk を割らない・遅延はさせない**)

- 例外則: user input 直後 / focus 復帰 / attention 検出時は即 flush
- 「差分なし処理中1s」は**任意 PTY には適用不可** (差分の有無を事前に判定できない)。mycmux 自前のスピナーにのみ適用可
- 採用基準: 同一リプレイで gpu-process CPU 相対30%以上減 かつ 入力 echo p95≤50ms かつ waiting 通知 p95≤1s

## 2週間後の待機列 (裁定済み・順に)

- **A. pane.activate_tab + フォーカス往復** — activation_token { previous_session_id, target_session_id, focus_revision } を発行し、restore は「target がまだ active / 人間の手動タブ移動なし / session epoch 不変」の全成立時のみ。1つでも違えば **no-op** (人間が動いた後に昔の位置へ引き戻さない)
- **B. Codex 状態検知** (2週間内に最小実装・上記6) — 難所はログ parse でなく **どの rollout ログがどの mycmux セッションかの対応付け**。cwd やタブ名で紐付けず、spawn 時の PID + process creation time + session epoch で結ぶ。format 不明時は `detector_health=degraded` + status=unknown (**誤った idle より unknown**)
- **E. クラッシュ検出** — last_pid 単独は PID 再利用で誤る。process creation time + session epoch も保存
- **C. 完了タブの棚卸し** — **自動 archive は切る** (位置記憶の破壊)。done 候補の提案+手動一括処理。将来形は「その場で軽量化」: タブ位置と名前は残し、renderer と重いバッファだけ解放して dim 表示
- **G. WebGL 再試行** — 無限 retry 禁止。focus 時に1回だけ再試行、再失敗で sticky fallback

## 切るもの (理由つき・再提案不要)

- **F. スクロールバック増量** — RAM を増やすほど resync と memory が悪化。必要なら disk 上の回転 transcript を別系統で
- **H. monitor 5秒ポーリング間引き** — 33タブ×5秒が gpu-process 96% の主因とは考えにくい。doctor で 1% 以上と実測されてから
- **I. 会話プレビュー** — stale になり scan と描画を増やす。J が必要情報だけを供給する
- (v1 から継続) 動的タブ名 / tokio::broadcast / multiplex 完全実装の初手 / wgpu 化 / 文字ドリップ

## stale action 防止 (管制塔側・auto-poke の前提)

feed を見たスマホが返信するまでに session は進行・再起動しうる。`send_text` / approval / auto-poke には
`session_id + expected_session_epoch + expected_attention_id + expected_session_revision` を持たせ、
不一致なら**送信を拒否して最新 snapshot を返す**。古い「続けてよいですか?」への yes が新しい破壊的コマンドの確認に届く事故を防ぐ。
(管制塔側文書 `mulmoclaude-dev/docs/miyazaki/2026-07-29-jcode-derived-notes.md` にも反映)

## 判断が誤りだと分かる観測 (Oracle 指定の反証条件)

| 判断 | 誤りと分かる観測 |
|---|---|
| reducer/attention_id/snapshot を P2 より先に | replay と実セッションで5信号が99%以上常に一致し、missed waiting の原因が transport 遅延だけだった場合 |
| P3+J+B で要対応を直接ルーティング | 導入後も waiting 発見までのタブ切替回数・応答時間が半減せず、detail 1行の誤誘導が 20件に1件以上 |
| P1 実測に基づく renderer 絞り | 同一リプレイで在住数・onRender 頻度と gpu-process CPU に相関がなく、各対策の削減率 20% 未満 → mycmux 側でなく WebView2/driver 調査へ移る |
