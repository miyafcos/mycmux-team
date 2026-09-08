# dispatch-guide — 運用詳細 (SKILL.md の下層)

## 台帳 `~/.claude/dispatch/ledger.jsonl`

1 dispatch = 1 行 (JSON)。母艦が spawn 直後に append し、状態変化時は「status を変えた行を追記」する
(上書きしない — append-only で競合を避ける)。

**書き込みは必ず `scripts/dispatch_ledger.py` を通す** (手書き `printf >>` は禁止 — 生バックスラッシュの
`"spec":"C:\Users\..."` で行が JSON として壊れ、2026-08-13 時点で 3 行が読めなくなっていた)。

```bash
# spawn 直後 (新規 dispatch)
python ~/.claude/skills/session-dispatch/scripts/dispatch_ledger.py append \
  --slug 260813-yabat-ch2 --status open \
  --json '{"label":"yabat-ch2","dir":"...","cwd":"...","tab_session_id":"...","tab_id":"...","target":"claude","workstream":"yabat","stage":"build"}'

# 状態変化 (差分行の追記・対象は slug + spawn_ts で特定)
python ~/.claude/skills/session-dispatch/scripts/dispatch_ledger.py update \
  --slug 260813-yabat-ch2 --spawn-ts 2026-08-13T12:34:56 --status closed --set verify=auto-pass
```

- **`slug` は `YYMMDD-<名前>` 必須** (ASCII)。日付なし slug は別日に再利用され、旧 dispatch の
  tab_session_id へ close-tab / send を撃つ事故になる。append は日付なし slug を拒否する
- `status` 語彙は `dispatch_ledger.py` の定数が正本:
  `open` / `running` (作業中) → `done` (DONE.md 自己申告・タブは生存) →
  `closed` / `done-verified-closed` (タブ片付け済) / `abandoned` / `fallback-inline` (異常終了)。
  close 失敗は `close_failed` (タブ未回収・再検収対象) として別記する。
  タブ片付け済・異常終了の4つが **クローズ集合** = 二度と操作してはいけない集合 (watcher も hook もこれで fail-closed 判定)
- `verify` (watcher が書く): `auto-pass` (機械検収 PASS) / `auto-fail` (FAIL → needs_review 扱い)
- **`workstream`** (ASCII キー・必須): 案件識別子。日本語表示名が要る場合は `workstream_label` を追記
- **`stage`** (必須): 固定バケット `prep / build / verify / done`
  (spawn 時=`build`、DONE.md 検出=`verify`、母艦の検収通過=`done`)。`closed` は stage でなく status
- キーは **snake_case のみ**書く。読みは camel (`tabSessionId` 等) も受けるが、書くと台帳が二枚舌になる
- **後勝ちシャローマージはしない**。dispatch の同一性は `(slug, tab_session_id)`。
  identity を名乗らない差分行だけが同 slug の直近 dispatch に付く。
  同じ slug が別日に2本あっても、片方の tab_session_id がもう片方に混ざることはない

## spawn 応答と tab_session_id

spawn の stdout は mycmux socket の応答 JSON。`sessionId` (タブの pty セッション ID) が返る —
`append --json` が `sessionId` / `session_id` → `tab_session_id`、`tabId` → `tab_id` を明示対応する。
別名同士の値が異なれば追記を拒否する。過去行は補完しない。close-tab / send / rename はこの PTY ID を使う。
`tabId` も必ず記録する: handoff spawn した claude 子では **tab id = 子の claude セッション UUID**
になり、`~/.claude/projects/<cwdスラッグ>/<tabId>.jsonl` が子のログそのものになる。

## 完了検知 3層 (agent-integration.md の規約準拠)

1. **DONE.md** — `<dispatch-dir>/DONE.md` の実在 = 子の完了自己申告
2. **子セッション JSONL 増分** — Claude の実行ログは `~/.claude/projects/<cwdをスラッグ化>/*.jsonl`。
   スラッグ化規則は `re.sub(r'[^A-Za-z0-9]', '-', cwd)`。**見るのは子1本だけ** —
   `claude_session_id` (無ければ `tab_id`、無ければ spawn 直後に初出した jsonl が1本だけのときに
   pin して台帳へ追記) の 1 ファイルの mtime で RUNNING / STALL を判定する。
   同定できなければ `UNKNOWN` を返す。**「cwd 内の最新 jsonl」で代用しない**
   (親・兄弟・無関係セッションの活動を子の活動と取り違え、closed 済みが RUNNING に見えた)。
   **--cwd は案件フォルダを指定する** (母艦と同じ cwd だと同定が難しくなる)
3. **成果物 mtime** — spec の「境界」内ファイルの更新

判定は `scripts/dispatch_status.py` が 1–2 を機械実行する。3 は案件依存なので母艦が見る。
`--no-pin` を付けると台帳へ書かずに読むだけになる。

## send は鮮度ガード付きで撃つ (無防備 send の禁止)

`mycmux_agent_cli.py send` の期待値は `--expect-epoch` / `--expect-attention-id` /
`--expect-revision` / `--expect-input-revision` の4点を揃える。
attention が無い場合も `--expect-attention-id null` (または `none`) で JSON null を明示する。
epoch・attention・session revision・input revision が送信時の状態に合わなければ送信は拒否される。

取得元は `mycmux_agent_cli.py status --session <PTY-sessionId>` の `session.state_view`。
bridge の入口も Python 実体のフルパスを使う:
`python "~/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py" status --session <PTY-sessionId>`。

```bash
# 状態と画面の確認 → 本文投入 → 自分の input revision + 1 を確認 → 安定後 Enter 1回
python ~/.claude/skills/session-dispatch/scripts/dispatch_send.py --slug 260813-yabat-ch2 --text "<指示>"
# 今観測した attention を対象にする (既定の一般送信は attention=none)
python ~/.claude/skills/session-dispatch/scripts/dispatch_send.py --slug 260813-yabat-ch2 --text "<回答>" --expect-attention
# 期待値のみ / 状態・期待値4点・送る本文を確認 (どちらも送信しない)
python ~/.claude/skills/session-dispatch/scripts/dispatch_send.py --slug 260813-yabat-ch2 --show
python ~/.claude/skills/session-dispatch/scripts/dispatch_send.py --slug 260813-yabat-ch2 --text "<指示>" --dry-run
```

- 台帳の status がクローズ集合なら送らない。同じ slug に active が2本あれば `--spawn-ts` で特定する
- 本文送信は bridge の構造化送信を再利用する。`--enter` も受け付けるが、本文があれば既定で Enter まで行う
- 空本文の `--enter` は、現在の状態・画面・input revision が安定したときに semantic Enter を1回だけ送る既存の明示操作。別コマンドで投入した本文の追跡は引き継げないため、本文投入後の後追いには使わない
- `SEND-REFUSED` (exit 3) は対象・状態を検証できず停止。引数不足は exit 2、`draft_not_observed` など Enter 要求前の送信処理失敗は exit 1。結果 JSON の `enter_sent` は false
- Enter 要求を送ったら `enter_sent: true` と exit 0 (応答消失を含む。明示的な `sent: false` 拒否は false / exit 1)。`residue_remains`・検証不能時も自動再送させないため exit 0 とし、stdout の単一 JSON に `warning` を付ける。`ok` / `confirmed` は `observed_delivered` のときだけ true。`--show` / `--dry-run` の `enter_sent` は false
- 残留は最後の入力行に始まる本文だけで判定し、送信履歴の本文は除外する。入力行を特定できない場合は Enter 直前からの画面変化で `observed_delivered` / `residue_remains` を分ける。根拠は `detail` に出す
- `observed_delivered` は配送の観測までで、受信者の実行・適用の証明ではない。exit 0 だけで配送確定とせず、`result` / `confirmed` を見る。`enter_sent: true` なら本文も Enter も自動再送せず、現状を読み直す
- 素の `mycmux_agent_cli.py send --enter` へ切り替えず、この一括処理を使う

## 起動直後の NO-LOG (trust プロンプト詰まり)

新規フォルダを `--cwd` にすると Claude Code の folder-trust プロンプトで入力待ちになり、
セッション JSONL が作られない (dispatch_status.py で NO-LOG のまま)。spawn から 90 秒たっても
NO-LOG なら canonical state と画面を確認する。AskUserQuestion は
`python "~/.claude/skills/mycmux-bridge/scripts/mycmux_bridge.py" answer-ask` の規定経路を使う。
単独 Enter が適切な入力待ちと確認できた場合だけ `dispatch_send.py --slug <slug> --text "" --enter` を使い、
確認できない状態での素の Enter や本文への後追い Enter は行わない。

## STALL 時の介入

- **先に判断カードを確認**: `ops_common.py list --asks` に当該セッションのカードがあれば STALL ではなく
  正当な判断待ち — answer-ask で回答する (STALL 介入・催促を送らない)
- カードが無い idle (silent blocker) は契約違反 → `dispatch_send.py` で
  「ask を発行するか自分で判断して続行せよ」を届ける。人間向けカードを親が代作しない
- 返答が来ない・壊れている場合はタブを目視 (可視タブなので画面で確認できる) → 手動判断
- `UNKNOWN` (子ログを同定できない) は STALL ではない。まず `tab_id` / `claude_session_id` が
  台帳にあるかを見る。無ければ子に自己申告させるか、その dispatch は DONE.md と成果物だけで検収する

## watcher (dispatch_watch.py) — 自動検収+自動 close

spawn 直後に親が `python ~/.claude/skills/session-dispatch/scripts/dispatch_watch.py --slug <slug>`
をバックグラウンド起動する (1 dispatch = 1 watcher)。挙動:

- DONE.md 検知 → spec の `## 自動検収 (machine gate)` の verify ブロックを PowerShell で実行
- 全行 PASS + `auto_close: true` → `close-tab` 実行 + 台帳 `{status: closed, verify: auto-pass}` 追記
  → verdict `DONE-VERIFIED-CLOSED` (exit 0)
- close 失敗 → `close_failed` とエラーを記録し `DONE-VERIFIED-CLOSE-FAILED` (exit 1)。`closed` にはしない
- PASS + auto_close false → `DONE-VERIFIED-KEEP` (タブ温存・exit 0)
- FAIL or gate 無し → `DONE-NEEDS-REVIEW` (タブ温存・exit 1 → 親が実体検収してから手動 close)
- ログ停止 45分 → `STALL` (exit 2) / 180分 → `TIMEOUT` (exit 2) — どちらもタブは触らない
- 結果詳細は `<dispatch-dir>/VERDICT.md`。台帳パスは env `DISPATCH_LEDGER` で差し替え可 (テスト用)
- **fail-closed**: close-tab はこの dispatch の行が持つ `tab_session_id` にしか撃たない。
  台帳上すでにクローズ集合なら `CONFIG-ERROR` (exit 3) で何もしない。同じ slug に active が
  2本あるときも撃たずに止まる → `--spawn-ts <spawn時のts>` で対象を特定して再実行する

close は可逆: 子の会話ログは `~/.claude/projects/<cwdスラッグ>/*.jsonl` に残り、
resume パレット (Ctrl+Shift+T) からいつでも復帰できる。タブを閉じても失うものは無い。

## 検収 (親の義務)

DONE.md の「検証手順」を母艦が実行して初めて done。子の「保存しました」を信じない
(feedback_subagent_save_claim_verify — 具体的数字つきの保存報告ごと幻覚だった実例あり)。
検収 NG なら `dispatch_send.py` で差し戻すか、spec を直して新タブで撃ち直す。

## 片付け

- 検収後: `close-tab --session <tab_session_id>` → `dispatch_ledger.py update --slug ... --spawn-ts ...
  --status closed` を追記 (session ID は必ず当該 dispatch の行から取る。`dispatch_status.py --all` の
  tab_session 列は末尾24文字の表示なので、そこからコピーしない)
- dispatch-dir (spec/DONE) は残す (作業証跡)。月次で `~/.claude/dispatch/_archive/YYYYMM/` へ移動
- タブを放置しない — mycmux はアイドル 120 分で自動 dormant になるが、閉じるのが正
  (project_mycmux_memory_pressure の再発防止)

## 並列の上限と分割粒度

- 同時 open は 3 本まで。4 本目からは前の検収を先に済ませる
- 分割は「章・学年・科目・案件」など自然な独立単位で。相互依存する作業を並列にしない
  (マージ判断が母艦に返ってきて母艦が重くなる — 分散の意味が消える)

## L2 / L3 展望 (未実装 — 設計メモ)

- **L2 残量監視**: 子 JSONL の usage (input+cache 合計) を tail して消費を実測 →
  閾値 (例: 700k) で母艦が `spawn --handoff-from-session <claude_session_id>` により後継を起動
  (crsm handoff = 履歴から引継ぎ書を自動生成)。子の claude_session_id は SessionStart hook で
  台帳へ自己申告させる (sessionId 非露出ギャップの回避)
- **L3 push 管制塔**: mycmux の status feed push (reference_jcode_mycmux_knowledge) で
  完了・STALL を push 受信 → ポーリング全廃。並列エージェント管制塔 (project_mobile_buddy_fork) と合流

## 根拠データ (2026-07-30 実測・816 セッション)

- >200k 消費 30% / >400k 11% / 最大 998k。compact 4% (1M 運用が吸収)
- 素材投入型 (パス束開始) は >200k 率 44% で分散効果が最大
- 引継ぎ書コピペ起動 49 本 = 手動分散の既存実績。本 skill はその自動化
- 分析レポート: `~/reports/_quick/2026-07/セッション実測分析_—_パターン分類とタブ自動スポーン構想_0730-0242.html`

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
