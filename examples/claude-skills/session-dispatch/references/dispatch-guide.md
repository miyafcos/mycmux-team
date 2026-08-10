# dispatch-guide — 運用詳細 (SKILL.md の下層)

## 台帳 `~/.claude/dispatch/ledger.jsonl`

1 dispatch = 1 行 (JSON)。母艦が spawn 直後に append し、状態変化時は「status を変えた行を追記」する
(上書きしない — 最新行が真実。append-only で競合を避ける)。

```json
{"ts": "2026-07-30T12:34:56", "slug": "260730-example-ch2", "label": "example-ch2",
 "dir": "<ホーム>/.claude/dispatch/260730-example-ch2", "cwd": "<spawn時の--cwd>",
 "tab_session_id": "<spawn応答のsessionId>", "tab_id": "<spawn応答のtabId>", "target": "claude",
 "status": "open", "workstream": "<案件ASCIIキー>", "stage": "build"}
```

- `status`: `open` (作業中) → `done` (DONE.md 検収済) → `closed` (close-tab 済)。異常時 `abandoned`
- `verify` (watcher が書く): `auto-pass` (機械検収 PASS) / `auto-fail` (FAIL → needs_review 扱い)
- `workstream` (ASCII キー): 案件識別子。非 ASCII の表示名が要る場合は `workstream_label` を
  別行でエディタツール (Write/Edit) により追記 (Windows のシェル経由だと cp932 破損の恐れ)
- `stage`: 固定バケット `prep / build / verify / done` (spawn 時=`build`、DONE.md 検出=`verify`、
  母艦の検収通過=`done`)。`closed` は stage でなく status
- 状態変化は差分行 (`{ts, slug, stage}` / `{ts, slug, status}`) の追記でよい (slug キー後勝ちマージ)

## spawn 応答と tab_session_id

spawn の stdout は mycmux socket の応答 JSON。`sessionId` (タブの pty セッション ID) が返る —
これをそのまま台帳の `tab_session_id` に入れる。close-tab / send / rename はこの ID を使う。
応答に sessionId が無いバージョンでは `panes --all` の出力から label で特定する。

## 完了検知 3層 (docs/agent-integration.md の規約準拠)

1. **DONE.md** — `<dispatch-dir>/DONE.md` の実在 = 子の完了自己申告
2. **子セッション JSONL 増分** — Claude の実行ログは `~/.claude/projects/<cwdをスラッグ化>/*.jsonl`。
   スラッグ化規則は `re.sub(r'[^A-Za-z0-9]', '-', cwd)`。spawn 後に作成された最新 jsonl の
   mtime が動いていれば RUNNING、数分止まっていれば STALL (質問待ち・ハング・限界到達)。
   **--cwd は案件フォルダを指定する** (母艦と同じ cwd だと母艦自身のログと混線して監視が濁る)
3. **成果物 mtime** — spec の「境界」内ファイルの更新

判定は `scripts/dispatch_status.py` が 1–2 を機械実行する。3 は案件依存なので母艦が見る。

## 起動直後の NO-LOG (trust プロンプト詰まり)

新規フォルダを `--cwd` にすると Claude Code の folder-trust プロンプトで入力待ちになり、
セッション JSONL が作られない (dispatch_status.py で NO-LOG のまま)。**spawn から 90 秒たっても
NO-LOG なら素の Enter を 1 発 send する** (既定選択 = Yes, proceed が通る):
`send --session <tab_session_id> --text "" --enter`

## STALL / ASK 時の介入

- **先に ASK.md を確認**: `<dispatch-dir>/ASK.md` があれば STALL ではなく正当な判断待ち —
  内容を読んで回答を send する (催促を送らない)
- ASK.md が無い idle (silent blocker) は契約違反 → `send` で「ASK を書くか自分で判断して続行せよ」を届ける
- `send --session <tab_session_id> --text "<回答>"` → 3秒以上あけて `send --session <id> --text "" --enter`
  (ペースト扱いで Enter が飲まれる対策の後追い Enter)
- 返答が来ない・壊れている場合は resume パレットから子セッションを開いて目視 → 手動判断

## watcher (dispatch_watch.py) — 自動検収+自動 close

spawn 直後に親が `python ~/.claude/skills/session-dispatch/scripts/dispatch_watch.py --slug <slug>`
をバックグラウンド起動する (1 dispatch = 1 watcher)。挙動:

- DONE.md 検知 → spec の `## 自動検収 (machine gate)` の verify ブロックを実行
  (Windows は PowerShell、それ以外は bash)
- 全行 PASS + `auto_close: true` → `close-tab` 実行 + 台帳 `{status: closed, verify: auto-pass}` 追記
  → verdict `DONE-VERIFIED-CLOSED` (exit 0)。close-tab には env `MYCMUX_AGENT_CLI` が必要
- PASS + auto_close false → `DONE-VERIFIED-KEEP` (タブ温存・exit 0)
- FAIL or gate 無し → `DONE-NEEDS-REVIEW` (タブ温存・exit 1 → 親が実体検収してから手動 close)
- ログ停止 45分 → `STALL` (exit 2) / 180分 → `TIMEOUT` (exit 2) — どちらもタブは触らない
- 結果詳細は `<dispatch-dir>/VERDICT.md`。台帳パスは env `DISPATCH_LEDGER` で差し替え可 (テスト用)

close は可逆: 子の会話ログは `~/.claude/projects/<cwdスラッグ>/*.jsonl` に残り、
resume パレット (Ctrl+Shift+T) からいつでも復帰できる。タブを閉じても失うものは無い。

## 検収 (親の義務)

DONE.md の「検証手順」を母艦が実行して初めて done。子の「保存しました」を信じない
(具体的な数字つきの保存報告ごと幻覚だった実例がある)。
検収 NG なら send で差し戻すか、spec を直して新タブで撃ち直す。

## 片付け

- 検収後: `close-tab --session <tab_session_id>` → 台帳に status=closed 行を追記
- dispatch-dir (spec/DONE/ASK) は残す (作業証跡)。月次で `~/.claude/dispatch/_archive/YYYYMM/` へ移動
- タブを放置しない — mycmux はアイドルで自動 dormant になるが、閉じるのが正

## 並列の上限と分割粒度

- 同時 open は 3 本まで。4 本目からは前の検収を先に済ませる
- 分割は「章・学年・科目・案件」など自然な独立単位で。相互依存する作業を並列にしない
  (マージ判断が母艦に返ってきて母艦が重くなる — 分散の意味が消える)
