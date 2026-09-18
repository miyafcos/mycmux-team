# hook の attention は入力待ち・ターン終了・再開を区別する

Status: proposed (2026-09-10・母艦の採否待ち)

hook の観測を reconciler が受理した後、次の対応で session_state に渡す。
Done は応答ターンの終了であり、依頼全体の完遂を保証しない。
前提は [ADR 0009](0009-agent-hook-realm-and-per-launch-capability.md) と
[ADR 0010](0010-agent-state-canonical-reconciler.md) に従う。

## 検討した選択肢

- Notification をすべて入力待ちにする案は、放置通知でも返答待ちになるため採らない。
- ScreenScan だけで解除する案は、hook 由来の入力待ちが残るため採らない。
- 時間の経過だけで解除する案は、実際の再開を表す hook を活用できないため採らない。

## 結果

| hook event_kind | attention | attention_id |
|---|---|---|
| attention_required | Input | agent-hook:{launch}:{canonical_event_id} |
| turn_active | None | なし |
| turn_ended | Done | 初回は agent-hook:{launch}:{canonical_event_id}、既に Done なら既存 ID を維持 |
| process_exited / session_terminated / cancelled | None | なし |
| failed / rate_limited | 今回は既存動作を据え置く | 更新しない |

- Accepted のみを反映し、Duplicate / StaleLaunch は attention を更新しない。
- sync_mapping の既存の判定を反映にも使い、旧セッションの遅延 Stop / SessionEnd は新しい入力待ちを変更しない。
- Hook の None は全 source の attention を消す。ただし現在の attention より古い観測は無視する。
- ScreenScan の None は自分の source だけを除く。解除後の新しい完全な scan は再び承認待ちを立てられる。
- stale_after は既存の有限値を維持し、hook の証拠を無期限に固定しない。
- attention_required の Notification は notification_type で選別し、接続前に情報通知を落とす。
- 転送する値は permission_prompt / elicitation_dialog / elicitation_url_dialog / agent_needs_input、未知値、キーなし。
- 落とす値は idle_prompt / auth_success / elicitation_complete / elicitation_response / agent_completed / quota_auto_resume_fired / quota_auto_resume_stale / quota_auto_resume_disabled。
- Claude の PreToolUse は managed group を 1 つ登録し、`--event-kind pre_tool_use` を helper に渡す。
- matcher は `AskUserQuestion|Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch|Agent|Skill`。
- helper の変換は下表のとおり。wire の event_kind と backend の parse_state 契約は変えない。PostToolUse は matcher=AskUserQuestion / turn_active のまま。
- Done が連続する間は同一 attention として扱い、最初の ID を保持して source を追加し、observed_at / stale_after を更新する。別 ID の古い観測は従来どおり無視する。Done → None → Done では新しい ID を付ける。

| Claude hook / tool_name | helper 引数 | wire event_kind → attention |
|---|---|---|
| PreToolUse / AskUserQuestion | pre_tool_use | attention_required → Input |
| PreToolUse / matcher 内の他 10 ツール | pre_tool_use | turn_active → None |
| PreToolUse / その他・tool_name 欠落 | pre_tool_use | 転送しない |
| PostToolUse / AskUserQuestion | turn_active | turn_active → None |

## この裁定が誤りと分かる観測

2026-09-10 の母艦実測では、idle_prompt が Input を立て、再開・終了後も解除されなかった。
実ペイン 3 本で、空のプロンプトや再開後の出力中に hook 由来の返答待ちが残った。
AskUserQuestion は Notification を出さず、背景ペインで質問を検知できなかった。
再開 hook より新しい正当な入力待ちを消す、または旧セッションの終了が現セッションを変える場合は再検討する。

## 帰結

サイドバーのキャラ・未読リング・ダッシュボードの返答待ちは修正後の attention を読む。
Claude にもターンごとに異なる ID の Done が付き、次の再開で消える。
Codex rollout と Hook の連続する Done は最初の ID を共有し、同一ターンの後着通知で既読を未読に戻さない。
登録はアプリの既存 install 経路で反映する。実 settings.json とインストール済み helper は今回編集しない。
承認対象ツールごとの Python 起動約 0.1 秒は、承認後の再開を届けるための代償として受け入れる (2026-09-10 宮崎さん決定)。

## 既知の制限

- F-1-01: 別ターンの遅延 turn_active は待機を消し得る。同期 hook 送信では実運用の遅延経路がない、という前提で受け入れる。
- F-1-02: PostToolUse が PreToolUse より先に届くと回答済みの Input を再生成し得るが、同期 hook ではその順序は起きない。
- F-2-01: 既知セッションへの resume と mapping 書込失敗が重なると、後続の正しい終了が旧セッション扱いで抑止され得る。
- F-4-01: pytest の fixture は実 settings の形を写さず、所有判定の command fallback も再現しないため、実登録の証明は Rust の merge テストに依存する。
