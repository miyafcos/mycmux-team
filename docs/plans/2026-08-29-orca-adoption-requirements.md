# mycmux 要件定義: orca 由来のエージェント連携強化

- 起草: 2026-08-29 / 母艦 Fable
- 対象リポ: `~/cmux-for-linux-dev-master` (Tauri v2 + React 19 + xterm.js, GPL-3.0)
- 一次資料: stablyai/orca @ `4461108` (MIT, Copyright 2026 Lovecast Inc.) のソース精読 (7レーン fan-out) + mycmux 現状インベントリ
- 設計ゲート: Oracle (GPT-5.6 Sol Pro) 相談で D1/D2/D8/Phase を裁定・本書へ反映
- ステータス: 要件確定ドラフト (実装着手前に Phase 0 の ADR で契約を固定)

---

## 1. 背景と目的

orca は Claude Code / Codex / Grok などの CLI エージェントを並列 worktree で運用する ADE。mycmux と守備範囲が重なる。orca のソースを精読し、mycmux に不足している機能を洗い出した。

**調査の結論**: 当初 A 級と見ていた PTY 背圧・scrollback 永続化・アカウント切替は、**mycmux 側で既に同等以上に実装済み**だった (§3)。orca から新規に取り込む価値があるのは、mycmux が構造的に欠く4領域に絞られる。

- **エージェント hook (lifecycle イベントの能動申告)** — 完了検知を「ポーリングでの推測」から「エージェント自身の申告」へ転換する土台
- **Interactive Prompt カード** — エージェントの質問・承認待ちを構造化し1タップで回答するプロトコル
- **native OS 通知** — 現状 in-app に閉じている通知を OS レベルへ
- **rate-limit / reset の統一表示** — usage/cost はあるが reset countdown が provider 依存

目的は、この4領域を mycmux の既存アーキ (Tauri/Rust の PTY・認証付きローカルソケット・env sanitization) と整合する形で設計し、実装フェーズに渡せる要件へ落とすこと。

### 1.1 中核となる設計思想 (Oracle 裁定)

本要件の全体を貫く3原則。個々の機能要件はこれに従属する。

1. **真実は reconciler が構築する。** hook / rollout / process exit / title はいずれも**不完全な観測源**であり、どれも単独では真実でない。backend の canonical event reconciler が全入力を突き合わせて唯一の canonical state を構築し、UI・通知・カードはその read model を映すだけ。観測源から直接 toast/badge/カードを発火させない。
2. **agent 実行は fail-open、mycmux 状態変更は fail-closed。** 認証失敗・旧 launch・未知 provider・不正 payload でも hook helper は短時間で正常終了しエージェント処理を止めない。一方 mycmux 側はカード・unread・完了状態・通知を一切変更しない。
3. **identity は launch 単位。** capability も dedup も `pane × provider × launch_generation × app_instance` に束縛する。pane ID の再利用だけでは同一 launch とみなさない。これが無いと旧 agent の遅延 hook が同 pane の新 agent を完了扱いする。

## 2. スコープ

### 2.1 今回入れる (IN)

| ID | 領域 | orca 出典 | mycmux 現状 |
|---|---|---|---|
| F1 | エージェント hook substrate (受け口 + reconciler + ledger) | S1/T4 | 欠落 (ソケット基盤は流用可) |
| F2 | Attention vertical slice (Interactive Prompt カード + needs-input 通知) | T2 | 欠落 (報告インボックスは「使い物にならない」FB あり) |
| F3 | Completion vertical slice (完了検知 hook 統合 + 完了通知) | S1/T4 | partial (rollout パーサ+metadata) / OS 通知は未確立 |
| F4 | rate-limit / reset 統一表示 | L5 | partial (ailog に usage/cost) |

> **Phase 順は Oracle 裁定で F2 (Attention) を F3 (Completion) より前に置く** (§6)。報告インボックスの不満への直接回答を優先し、完了通知はその後。

### 2.2 今回入れない (OUT・理由つき)

- **モバイル (iPhone 遠隔) の実装** — 別途要件確定済みの独立計画 (`project-mycmux-iphone-remote-rebuild`)。desktop hook 品質のゲートをネットワークプロダクト設計へ拡散させない。**ただし「反映メモ」では弱い**: 今回の desktop event モデルに将来接続境界仕様 (§7.13) を固定し、後からモバイル transport を足しても event モデルを作り直さずに済むようにする。
  - orca 調査で得た知見: orca も push 通知は持たず connected WebSocket + local notification のみ。E2EE over WS + QR ペアリング + プロトコル版数ゲート + バイナリフレーム。→ mycmux の ntfy 採用方針の優位は揺らがない。
- **Design Mode** (UI 要素クリック→HTML/CSS+スクショをプロンプト挿入) — Web ペイン導入後の将来ネタ。
- **AI Vault・ブラウザペイン Cookie インポート・Automations** — 有用だが本要件の4領域と独立。別要件として切り出す (L5/L6 レポートを素材保存)。
- **アカウント別 runtime home 分離** — mycmux の常時同期+CAS 方式で機能同等に到達済み。作り替えは退行リスクに見合わない。

## 3. 前提: mycmux 現状インベントリ (実装済みの土台・L7)

新規実装が既存の到達点を壊さないための前提。すべてソース精読で確認済み。

- **ローカルソケット** (`src-tauri/src/socket.rs`): `~/.mycmux/mycmux.token` を port より先に公開、32byte hex を毎起動再生成、定数時間トークン照合、認証必須。コマンド面は `pane.spawn`/`send_text`/`read`/`close_tab` 等。**F1 の hook 受け口はこの listener のライフサイクルと transport だけを再利用する。既存の広権限トークンは hook に流用しない (§5 D1)**。
- **env sanitization** (`commands/terminal.rs` + `lib.rs` + 契約テスト `test_ephemeral_env_keys_contract.py`): always-strip / resume quartet / handoff quartet の3リストを同期。portable_pty の親 env 継承事故 (v0.4.0) の再発防止。**F1 の hook 用 env はこの3リストへ追加し整合させる (§7.4)**。
- **完了検知** (`pty/monitor/codex_rollout.rs` 他): Codex rollout JSONL パーサが attention/done 識別。**provider 依存で partial**、shell 完了はヒューリスティック。**F3 はこれを reconciler の1入力源に降ろす (§5 D2)**。
- **通知** (`lib/notificationStatus.ts` + `stores/attentionStore.ts` + `ToastHost.tsx`): 統一導出関数・in-app toast/badge/unread は完備。**native OS 通知は未確立** = F2/F3 の新規部分。
- **PTY 背圧** (`pty/session.rs`): watermark・coalescing・累積 ACK・drop+絶対 offset resync。orca の PtyProducerFlowController 相当は既存。**触らない**。
- **ailog** (`ailog/price.rs` + `usage/oauth_*.rs`): Claude/Codex/Grok の usage/cost。**reset countdown は provider 依存** = F4 の対象。

## 4. orca 移植候補の設計要点 (一次資料の蒸留)

### 4.1 hook 機構 (S1)
- orca は Claude `settings.json`・Codex `config.toml`+`hooks.json`・**Grok** (`grok-hook-config.ts` 等) の3系統に自前 hook を semantic merge で自動インストール。curl で `127.0.0.1:<ephemeral>/hook/<provider>` へ POST。
- 認証 = **listener-wide UUID bearer 1本**を全 hook-enabled PTY の env に注入。
- fail-open 徹底 (204 常時・`--fail` なし・title フォールバック30分窓)。
- **S1 が明示した弱点**: bearer が listener-wide → その PTY の任意の子孫が認証済み POST 能力を持ち、自 pane の lifecycle status 偽装・他 pane 詐称・存在しない pane 生成が可能。endpoint ファイルを shell が dot-source/call するためファイル差し替えでコマンド注入可能。→ **mycmux は §5 D8 でこれを踏襲しない**。

### 4.2 Interactive Prompt (T2)
- 検出第一源は hook の `interactivePrompt`、transcript は第二源。`AskPrompt { questions[] }` 正規化。
- 回答送信はエージェント別状態機械 (Claude=選択肢番号キー / Codex=セレクタ移動+Tab / Grok=整形テキスト)。
- 送信フレーミング: ①Ctrl+U で未送信行クリア → ②本文 (CR/LF 含むなら bracketed paste) → ③**500ms 後に別書き込みで CR**。per-PTY 直列化。
- 偽成功防止: selector 系はカード消去を全 verified write 完了まで待つ。cache 復元しない。

### 4.3 完了検知 coordinator (T4)
- 3系統統合 (title / hook / process 検査)。hook done は 1500ms quiet window、process-exit は「非エージェント化+子なし」を2回連続で完了証拠。
- dedup は pane-key scoped、hook identity = `state:agentType:floor(turn時刻)`。
- 通知ゲート: 鮮度10秒窓・PTY 生存確認・focus 抑制 (OS 抑制と分離)・unread を pane→tab→worktree 伝播・idempotent。

### 4.4 rate-limit / reset (L5)
- Claude/Codex/Gemini/Grok/Kimi/MiniMax の usage・rate-limit・reset を `ProviderRateLimits` 統一形へ集約。ポーリング15分・最小30秒 clamp・可視時のみ。

## 5. 判断分岐と裁定 (Oracle 設計ゲート反映)

> 本節の裁定は ADR に確定済み。正本はそちら:
> - D1 / D8 → [ADR 0009: エージェント hook は既存 listener の専用 realm で受け、認証は per-launch capability にする](../adr/0009-agent-hook-realm-and-per-launch-capability.md)
> - D2 → [ADR 0010: エージェントの状態は reconciler が確定する](../adr/0010-agent-state-canonical-reconciler.md)

### D1: hook 受け口アーキ — **既存 listener 再利用 + hook 専用認証 realm + Rust helper 経由**
- 既存 mycmux listener の**ライフサイクルと transport だけ**を再利用。**既存の広権限 socket token は再利用しない** (それは `pane.spawn`/`send_text`/`read`/`close_tab` まで届き、agent 配下の全子孫へ渡す設計は不可)。
- hook capability が許可するのは3操作のみ: ①lifecycle event 登録 ②Interactive Prompt 登録・応答待ち ③hook/helper health probe。`send_text`・pane 生成・読み取り・タブ閉鎖には**絶対に昇格できない別認証領域**。
- 障害隔離は同一 listener 内の**別 route・別認証・別 bounded queue・別 worker** で確保 (hook 処理が既存コマンドの mutex/executor を共有しないことを要件化)。別 HTTP listener は却下 (bind/token/stale/shutdown race/ファイアウォール面を二重化し故障面を増やす)。
- **provider hook からは curl でなく固定パスの軽量 Rust helper (`mycmux-hook.exe`) を経由**。理由: Codex は非管理 hook をハッシュ単位で信頼し、定義変更で再信頼が要る → 毎起動変わる port/token/versioned path を設定に埋めると hook 信頼が常時壊れる。**hook 設定は固定、動的情報 (endpoint/capability) は env と endpoint descriptor へ逃がす**。Tauri GUI 本体を `--hook` 兼用にはしない (single-instance/WebView 初期化/updater が短経路に混入)。

**capability 粒度 = per-launch** (per-pane でなく):
```
capability_id -> { app_instance_id, pane_id, provider, launch_generation,
                   managed_process_id?, created_at, state: ACTIVE|DRAINING|REVOKED }
```
- capability は最低256bit random。server 側だけが対応を保持。payload 内の pane_id/provider は認証根拠にせず、server が capability から導出して一致確認にだけ使う。
- pane close 直後に即 REVOKE しない (終了 hook と exit/close が競合)。10秒程度の `DRAINING` tombstone: ACTIVE=通常受理 / DRAINING=そのlaunchの terminal event だけ受理 / REVOKED=状態変更なし。ユーザー明示 close 時は terminal event を記録するが OS 完了通知は抑止。

**secret 配置 = 初版は env で良い** (named pipe secretless は後段候補・初版に入れない):
- 注入手順を厳密固定: ①親 env から全 `MYCMUX_HOOK_*` を strip → ②既存 `sanitize_launch_env` 適用 → ③fresh capability/launch ID/protocol version だけを managed agent へ注入 → ④process-wide env は変更せず子 process 用 `Command` へだけ設定 (`Command::env_remove` で明示除去してから注入・Windows は env 名大文字小文字無視) → ⑤resume/handoff/pane 再起動/provider 切替で必ず旧 capability 破棄+再発行。

**endpoint ファイル = JSON data-only・shell-source 禁止**:
```json
{ "schema_version": 1, "app_instance_id": "...", "transport": "tcp",
  "address": "127.0.0.1:43127", "helper_protocol_major": 1, "published_at": "..." }
```
広権限 token も hook capability もここに置かない。bind 成功後にのみ atomic replace で公開・最大サイズ制限・loopback 以外拒否・schema major 不一致拒否・random app_instance_id で現 instance 確認・symlink 無条件信頼しない・parse 失敗時 helper は即 exit 0。

### D2: hook と既存 rollout パーサの関係 — **両者を単一 reconciler へ入力** (優先順位切替でなく)
- 「hook=truth / rollout=fallback」は却下。両方を canonical event reconciler の入力にする。

| 入力源 | 役割 | 単独で OS 通知してよいか |
|---|---|---|
| Valid hook | 高信頼な semantic evidence | reconciler 確定後のみ |
| Rollout JSONL | fallback / 先行 provisional | grace 後のみ |
| Process metadata | 生存・終了の事実 | 「process terminated」だけ |
| title/shell heuristic | 低信頼な表示ヒント | 不可 |

- **provider の `Stop` = タスク完了ではない** (応答が終わっただけ)。normalized state を分ける:
  `TURN_ACTIVE / ATTENTION_REQUIRED / TURN_ENDED / PROCESS_EXITED / SESSION_TERMINATED / FAILED / CANCELLED / RATE_LIMITED`。**UI の「完了」が TURN_ENDED か SESSION_TERMINATED かを Phase 0 で固定** (曖昧だと「一回答しただけで完了通知」が増える)。
- **canonical identity**: `app_instance_id / pane_id / launch_generation / provider / provider_session_id / provider_turn_id (or synthetic_turn_generation) / event_kind`。**時刻を丸めただけの dedup key は不可**。turn ID を出さない provider は reconciler が ACTIVE 遷移時に synthetic generation を発行。
- **30分窓は却下 → turn 単位の短い grace**: hook 導入 launch は rollout terminal を PROVISIONAL 記録し初期3秒 hook を待つ (到着なら merge・3秒経過で fallback 確定)。hook 未導入 launch は grace なしで即確定。fallback 確定後の late hook は state 更新可だがカード/unread/OS 通知は再発火しない。**3秒は初期値・実測 p99 で 0.5〜5秒に調整・30分へは戻さない**。
- **exactly-once は user-visible side effect に置く** (ネットワーク配送でなく)。durable ledger に `canonical_event_id / source_event_ids[] / payload_hashes[] / current_state / state_version / card_created_at / unread_incremented_at / native_notification_emitted_at / acknowledged_at`。イベント受理と `notification_emitted_at` 確保を同一 transaction か durable outbox で。app 再起動後の rollout 再走査で同じ通知を再送しない。

### D8: セキュリティ厳格度 — **per-launch capability + membership 検証を採用** (over-engineering でない)
- mycmux は既に pane registry・launch token・認証 listener・env sanitization を持つ。追加コストが小さい状態で orca の弱点を移植する理由はない。
- **守るもの**: 他 pane/他 launch への偽装・stale event・広権限 socket command への昇格・shell-source 経由の code execution・notification/card 増幅。
- **守らないもの (非目標)**: 同一 launch 内の子孫プロセスによる自己 event 偽装・同一ユーザー権限のマルウェア・OS 管理者・agent 出力自体の虚偽。
- 完全防御は目指さない (同一ユーザーの PTY 内プロセスを敵とみなすと完全防御は不能で失効 race を増やす)。`DRAINING` を設け、安価な cross-pane/stale-launch 隔離だけを取る。
- endpoint は §D1 の通り Rust で data-parse・shell に通さない。

### Phase 骨格 — **Phase 0 (契約固定) 新設・Interactive Prompt を Phase 2 へ前倒し**
一次案の「hook 受け口だけを独立 Phase 1」は不十分 (認証/identity/dedup/interactive を後付けすると受け口の契約を壊す)。Phase 1 に reconciler と ledger まで含める。詳細は §6。

## 6. 機能要件 (Phase 別)

### Phase 0: 契約固定 (実装前の ADR)
実装着手前に以下を ADR/要件として固定する。
- normalized event taxonomy (8状態)・prompt protocol の3分類・launch generation の定義
- per-launch capability の構造・source precedence と競合表・exactly-once side effect の定義
- hook 設定の所有権・信頼状態 (Codex trust)・protocol version・threat model と非目標
- hook 未導入時の fallback・uninstall/rollback 手順
- **UI「完了」の意味 = TURN_ENDED か SESSION_TERMINATED かの確定**

### Phase 1: hook substrate
- stable Rust helper (`mycmux-hook.exe`) / 既存 listener の hook 専用 route / per-launch capability / endpoint descriptor / bounded queue / **durable event ledger** / **canonical reconciler**
- hook install/repair/remove (Claude/Codex/Grok の設定へ semantic merge・§7.5)
- health 表示: Codex trust 状態・helper version・last successful event
- **1 provider で実イベントを end-to-end 通す。UI 通知はまだ切り替えない**
- **受入条件**: 「受信できた」でなく、duplicate/out-of-order/app restart/pane reuse を含むイベント列が単一 canonical state へ収束すること (trace-driven 破壊試験・§8)

### Phase 2: Attention vertical slice (報告インボックス FB への直接回答)
- Claude の Interactive Prompt カード / PermissionRequest・Elicitation・AskUserQuestion adapter
- **prompt protocol 3分類**: OBSERVE (登録して即 ACK) / SYNC_DECISION (provider が hook 戻り値を待つ・permission allow/deny) / DEFER_RESUME (一度延期を返し後から明示回答・AskUserQuestion)
- **CAS 回答** (`PENDING → ANSWERED` 以外は拒否・二重クリック/別 window/遅延回答を provider へ二度送らない)
- stale/timeout/defer/resume の区別・`ATTENTION_REQUIRED` の native 通知・foreground かつ対象 pane 可視なら抑止
- in-app inbox の再構築
- **`send_text` は標準回答経路にしない**。構造化 hook response を優先。send_text は fallback 限定で、同 launch generation・同 provider session・同 pending prompt・pane が入力待ち再確認・未 CAS・shell に戻っていない、の全条件を満たす時だけ許可 (でないとカード押下時に agent 終了済みで回答文字列が shell command 実行される事故)

### Phase 3: Completion vertical slice
- hook + rollout の reconciliation / provisional + 短時間 grace / process metadata との競合処理
- hook 未導入 provider の fallback / 完了・失敗・終了の native 通知
- **legacy parser からの直接副作用を削除** (reconciler 経由に一本化) / provider parity

### Phase 4: rate-reset UX
- provider 別 raw event の正規化 / confidence・source・last observed timestamp / reset countdown / unknown・stale 表示 / clock jump・sleep 復帰・provider 仕様変更時の degrade
- ダッシュボード計器行 (既存) に差し込む。hook 基盤へ event type だけ先に予約し実装は本 Phase。

## 7. 非機能要件 (NFR)

### 7.1 配送・重複
ingress は at-least-once 前提。state transition と user-visible side effect は idempotent。app 再起動後も dedup 維持。event ID 保持は最低7日 or rollout cursor が完全通過するまで。同一イベントのカード/unread/OS 通知は各一回。

### 7.2 fail-open 性能 (初期受入値)
mycmux 稼働中: helper 起動から ACK まで p95 ≤ 100ms・p99 ≤ 250ms。mycmux 停止中: 250ms 以内に exit 0。observational hook の hard deadline: 500ms。interactive hook は provider 別 deadline を明示。timeout 時は agent 継続・mycmux 状態不変。

### 7.3 resource bounds
request body 最大 1MiB / endpoint descriptor 最大 16KiB / global 受信 queue 最大 2048 件 / capability ごと + global の rate limit。queue overflow 時は agent を止めず drop し集約 diagnostic を残す。payload 全体を error log へ出さない。serde parse や不正 UTF-8 で panic しない。

### 7.4 identity lifecycle
capability は launch 単位。pane ID 再利用だけでは同一 launch とみなさない。close 後10秒の DRAINING。app instance 変更で全 capability 無効化。resume と新 launch を区別。provider session ID の再利用を信用しない。

### 7.5 config mutation (settings.json 等への自動インストール)
semantic merge / 自分の hook entry だけに ownership marker / ユーザー定義の順序保持 / compare-and-swap か hash 確認 / concurrent edit 時は上書きせず再 merge / temp write+flush+atomic replace / backup と rollback / uninstall は自分の entry だけ削除 / unchanged なら書き直さない / Codex の hook trust 状態を検出し未信頼なら fallback へ落とす。
> **宮崎の `~/.claude/settings.json` には既存 hook (genshijin 等) が多数あるため、既存定義を破壊しないマージが絶対制約 (§8 V2 で機械検証)**。

### 7.6 version compatibility
helper protocol major/minor・app/helper/provider adapter version を記録。unknown field 許容。unsupported major は no-op。app update 中の旧 helper/新 app 組合せを試験。helper path 変更時の Codex 再信頼を明示。

### 7.7 observability (秘密を含めず計数)
`received / accepted / rejected_invalid_cap / rejected_stale_launch / rejected_wrong_provider / deduplicated / provisional / promoted_by_timeout / merged_with_hook / late_hook / queue_dropped / notification_emitted / notification_suppressed / prompt_stale / answer_cas_failed`。pane ごとに診断画面へ: hook installed / hook trusted / helper compatible / capability active / last hook event / fallback active / rollout cursor health。

### 7.8 privacy
capability・prompt answer・認証情報をログへ出さない。prompt 本文を crash report へ入れない。OS 通知は既定で本文を伏せ「Claude が回答を待っている」程度。lock-screen preview は明示 opt-in。payload 保存期間を定義。debug export 時に redaction。

### 7.9 native notification
Rust backend のみが発行。app foreground かつ対象 pane 可視なら既定で抑止。needs-input と terminal を別 channel/priority で扱う。OS permission 拒否時は in-app 表示へ degrade。**development 実行でなく installed Windows build で検収** (開発実行は PowerShell 由来の表示になる)。Explorer 再起動・sleep 復帰・通知センター無効時を試験。desktop action button は初版必須要件にしない (documented action API は mobile 向け)。

### 7.10 prompt 安全性
回答は CAS 一回限り。expiration 後の回答禁止。launch 変更後の回答禁止。provider structured response を優先。terminal `send_text` fallback には現在 prompt の再検証が必須。timeout 時の provider native UI 復帰を定義。取り消し・拒否・無視を区別。複数 window から同時回答しても一回だけ成功。

### 7.11 security boundary
§5 D8 の守るもの/守らないものを要件へ明記。

### 7.12 二重発火防止 (React/Tauri 固有)
canonical state・unread 加算・native notification は **Rust backend だけが所有**。React 側は read model 表示のみ。React Strict Mode は開発時に effect の setup/cleanup を追加実行するため、renderer の effect 内で通知/カード生成すると listener cleanup 漏れだけで二重発火する。複数 window 化時も各 WebView が同じ event を受信しても副作用を起こさない。

### 7.13 将来接続境界仕様 (モバイル向け・今回の event モデルに固定)
今回の desktop event モデルに次を固定し、後からモバイル transport を足しても作り直さずに済むようにする: globally stable event ID / schema version / idempotency key / ACK 可能な outbox / payload privacy class / mobile へ送出可否の redaction 区分 / state revision / answer command の CAS version。

### 7.14 右クリック導線の不採用
orca の worktree カードは右クリックメニュー前提だが、mycmux は WebView2 ネイティブメニューでフリーズ実害があり ⋮ ボタン方式が確定 (`feedback-no-rightclick-ui`)。カード UI 輸入時はこれを守る。

### 7.15 ライセンス
orca は MIT (Copyright 2026 Lovecast Inc.)。設計参照は自由。**ソースコードを逐語移植する場合は MIT 著作権表示を保持** (GPL-3.0 と互換)。ファイル単位で「再実装/逐語」を記録。

## 8. 検証手段 (受け入れ条件)

- **V1 (trace-driven reconciler)**: hook/rollout/process exit/restart/pane 再利用の時系列 fixture で canonical state と副作用が一意収束することを確認 (UI より先に実装・破壊試験)。
- **V2 (マージ非破壊)**: hook 自動インストール前後で `~/.claude/settings.json` の既存 hook が順序保持・無傷であることを diff で機械確認。uninstall で自分の登録のみ消えること。
- **V3 (二重発火なし)**: hook + rollout 両系統が動く状況で完了通知が1回だけ。React Strict Mode 下で listener 一重性。
- **V4 (fail-open)**: 受け口停止/不正 payload 投入でエージェントが止まらないこと。
- **V5 (カード回答)**: Claude/Codex/Grok の質問・承認プロンプトにカードから回答が届くことを実機確認 (遅延 Enter・CAS 含む)。
- **V6 (契約テスト全通過)**: `npx tsc --noEmit` / `npx vitest run` / `python scripts/run_windows_tests.py` / `python -m pytest tests/`。
- **V7 (native 通知)**: installed Windows build でバックグラウンド時に OS 通知が出て、foreground+可視時に抑制されること。

### 8.1 必須破壊試験 (Phase 1 受入の中核)
同じ hook を100回送信 / rollout terminal 後0〜10秒で hook 到着 / hook 到着後に rollout 再走査 / hook が逆順到着 / pane close と terminal hook 同時 / 同 pane で即再 launch / app crash 後再起動 / stale endpoint descriptor / old helper・new app / new helper・old app / config 編集中に自動 merge / Codex hook 未信頼 / 20 pane 以上から同時発火 / prompt を2 window から同時回答 / prompt 待機中に pane close / sleep 中に deadline 経過 / Windows パスの空白・日本語・括弧 / PowerShell・cmd・Git Bash・WSL / installed build で native 通知 / React Strict Mode 下で listener 一重性。

## 9. リスク・未確定事項

- **R1 (env 継承)**: hook 用 env が portable_pty で grandchild へ継承。§5 D1 の注入手順5ステップと `sanitize_launch_env` 整合が最大の設計難所。**誤りと分かる観測**: managed launch でも capability を agent process だけへ渡せず汎用親 shell 全体へ長時間露出する、または provider が hook subprocess へ env を安定継承しない、が実測された場合 → named pipe/broker 方式か instrumented wrapper 境界を再検討。
- **R2 (二重発火)**: reconciler の dedup 設計が甘いと通知重複。V3 で検証。**誤りと分かる観測**: hook と rollout を同一 turn へ結び付ける ID が実ログ上なく3秒以内でも異 turn の誤 merge が起きる → provider 別 reconciler へ分割し rollout cursor/transcript 位置を identity へ追加。
- **R3 (settings.json 破壊)**: 自動インストールのマージ失敗で既存 hook を壊すと実害大。V2 で機械検証。
- **R4 (逐語移植の混入)**: orca も mycmux レンダラも TS。安易な逐語コピーは MIT 表示義務と GPL 整合の記録漏れを招く。ファイル単位で記録。
- **R5 (Attention slice の前提)**: **誤りと分かる観測**: agent 質問の大半が構造化 hook で捕捉できず結局画面解析と send_text に依存する、または hook 応答待ちが通常操作を阻害する → Phase 2 を「観測専用 attention inbox」に縮小し completion 統合を先に完成。
- **未検証事項の継承**: S1/T2/T4 のレポートは「ソース精読ベース・実行なし」。採用を決めた項目は該当ソース (`agent-completion-coordinator.ts` 等) を実装前に再度直読する。

## 10. 実装着手の推奨順 (Oracle)

1. **D1/D8 の ADR を先に固定** — 「stable helper + 既存 listener の hook 専用 realm + per-launch capability + data-only descriptor」を正本に、env 注入・失効・DRAINING まで書く。
2. **UI より先に trace-driven reconciler を実装・破壊試験** — 30分窓でなく初期3秒 grace で測定。
3. **最初の user-facing vertical slice を Interactive Prompt + needs-input 通知に** — Claude の構造化 hook を対象に、カード生成・CAS 回答・stale 処理・installed build の native 通知まで通す。その後 completion 通知へ。
