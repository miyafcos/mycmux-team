# エージェント hook は既存 listener の専用 realm で受け、認証は per-launch capability にする

Status: accepted (2026-08-29 Oracle 設計ゲート裁定)

エージェントの完了・質問・承認を「ポーリングでの推測」から「エージェント自身の申告」へ変えるため、Claude / Codex / Grok の lifecycle hook を mycmux が受け取る。受け口は**既存のローカル listener を再利用するが、既存の広権限トークンは流用せず hook 専用の認証領域を足す**。provider の hook からは curl でなく**固定パスの軽量 Rust helper** を経由させる。認証情報は listener 全体で1本の bearer ではなく、**`pane × provider × launch_generation × app_instance` に束縛した per-launch capability** とし、endpoint の受け渡しは shell に通さない JSON descriptor で行う。

一次資料は stablyai/orca @ `4461108` (MIT) のソース精読。要件本体は `docs/plans/2026-08-29-orca-adoption-requirements.md`。

## 検討した選択肢

- **orca と同じ listener-wide bearer + curl 直叩き** — 却下。orca は毎起動生成した UUID bearer 1本を hook-enabled な全 PTY の env に注入し、curl の argv ヘッダへ展開している。この形だと **その PTY の任意の子孫プロセスが認証済みの POST 能力を持つ**。自分の pane key は常に知っているので自分の lifecycle status を偽装でき、他の pane key を知ればそれも詐称でき、構文的に妥当な存在しない pane key も作れる (HTTP 経路は構文検証だけで生存ペインの membership を要求しない)。mycmux は既に pane registry・launch token・認証 listener・env sanitization を持っているので、追加コストが小さい状態でこの弱点を移植する理由がない。
- **hook 専用の別 HTTP listener を立てる** — 却下。障害隔離と実装の単純さは魅力だが、bind・port 公開・停止順序・token 生成と失効・stale endpoint 処理・single-instance 競合・終了時の競合・ログ・rate limit・互換性管理・セキュリティ製品から見た loopback listener を**すべて二重化**することになり、長期の故障面が増える。必要な隔離は同一 listener 内の別 route・別認証・別 bounded queue・別 worker で確保できる。
- **capability を per-pane にする** — 却下。寿命が長すぎる。同じ pane でエージェントを再起動した後、**旧プロセスから来た遅延 hook が新しいエージェントを完了扱いにできる**。
- **secret を env から外し named pipe / 継承 descriptor で渡す** — 初版では却下 (後段の hardening 候補として残す)。同一ユーザー権限のマルウェアまで脅威モデルに入れるなら env では足りないが、そこまで守るには Windows named pipe の client PID 確認・Job Object membership・breakaway・ConPTY・WSL 越境まで扱う必要があり、実装と検証のコストが初版に見合わない。
- **Tauri の capability 設定を hook 認証に使う** — 不可。あれは WebView から Rust command を呼べる範囲を制御するもので、外部プロセスから loopback listener に来る通信は保護しない。

## 結果

- **受け口**: 既存 listener の**ライフサイクルと transport だけ**を再利用する。hook capability が許可するのは ①lifecycle event の登録 ②Interactive Prompt の登録と応答待ち ③hook / helper の health probe の3つだけ。`pane.spawn` / `send_text` / `read` / `close_tab` へは**絶対に昇格できない別 realm** にする。hook 処理は既存コマンド処理の mutex / executor を共有しない。
- **helper 経由にする理由**: Codex は非管理 hook を**ハッシュ単位で信頼**し、定義が変わると再信頼まで hook をスキップする。毎起動変わる port・token・versioned path を設定ファイルに埋めると **hook 信頼が常時壊れる**。よって hook 設定は固定パスの helper を指し、動的情報は env と endpoint descriptor へ逃がす。Tauri GUI 本体を `--hook` で兼用しない (single-instance 処理・WebView 初期化・updater・クラッシュダイアログが hook の短時間経路に混入する)。
- **helper の要件**: 単一用途・GUI を出さない / stdin から上限付き JSON を読む / endpoint descriptor を data として読む / capability を env から読む / hard timeout 内に送信 / mycmux 停止中・descriptor 破損・認証失敗でも原則 exit 0 / stdout・stderr に payload と capability を出さない / シェルを起動しない / PowerShell・cmd・bash・WSL の quoting に依存しない / protocol major 不一致は no-op。
- **capability**: 最低 256bit の乱数。server 側だけが対応関係を保持する。payload 内の `pane_id` や `provider` を**認証根拠にしない** — server が capability から導出し、payload の値は一致確認にだけ使う。状態は `ACTIVE` (通常受理) / `DRAINING` (その launch の terminal event だけ受理) / `REVOKED` (状態変更なし)。pane close 直後に即 REVOKE せず**10秒の DRAINING tombstone** を置く (終了 hook と process exit / タブ閉鎖が競合するため)。ユーザーが明示的に pane を閉じた場合は terminal event を記録しても OS 完了通知は出さない。
- **env 注入の手順** (この順序を守る): ①親 env から全 `MYCMUX_HOOK_*` を strip → ②既存 `sanitize_launch_env` を適用 → ③fresh capability・launch ID・protocol version だけを managed agent へ注入 → ④process-wide env は変更せず子プロセス用 `Command` にだけ設定する (`Command::env_remove` で明示除去してから注入。Windows は env 名の大小を区別しない) → ⑤resume・handoff・pane 再起動・provider 切替では必ず旧 capability を破棄して再発行する。
- **endpoint descriptor**: `{schema_version, app_instance_id, transport, address, helper_protocol_major, published_at}` の JSON。**広権限 socket token も hook capability もここに置かない**。bind 成功後にのみ atomic replace で公開・最大サイズ制限・loopback 以外の address は拒否・schema major 不一致は拒否・stale PID でなく random な `app_instance_id` で現インスタンスを確認・symlink / reparse point を無条件に信頼しない・終了時に削除するが残存しても安全・parse 失敗時 helper は即 exit 0。orca のように**shell に dot-source / call させない** (同一ユーザーの書き手がファイルを差し替えると hook 発火時にコマンド注入できるため)。
- **fail の方向を分ける**: **エージェント実行については fail-open、mycmux の状態変更については fail-closed**。認証失敗・旧 launch・未知 provider・不正 payload でも helper は短時間で正常終了してエージェントを止めない。一方 mycmux 側はカード・unread・完了状態・通知を一切変更しない。
- **脅威モデルを明文化する**。守るもの = 他 pane / 他 launch への偽装・stale event・広権限 socket command への昇格・shell-source 経由の code execution・notification / card の増幅。**守らないもの** = 同一 launch 内の子孫プロセスによる自己 event 偽装・同一ユーザー権限のマルウェア・OS 管理者・エージェント出力自体の虚偽。完全防御は目指さない (同一ユーザーの PTY 内プロセスを敵とみなすと完全防御は不能で、失効 race を増やすだけ)。安価な cross-pane / stale-launch 隔離だけを取る。

## この裁定が誤りと分かる観測

managed launch でも capability を agent プロセスだけに渡せず、常に汎用の親 shell 全体へ長時間露出する、または provider が hook subprocess へ env を安定して継承しないことが**実測された**場合。そのときは named pipe / broker 方式か、instrumented wrapper 境界を再検討する。

## 帰結

- `sanitize_launch_env` の3リスト (always-strip / resume quartet / handoff quartet) に `MYCMUX_HOOK_*` を足し、`tests/test_ephemeral_env_keys_contract.py` の契約を更新する。この契約は v0.4.0 の全ペイン自動 resume 事故の再発防止そのものなので、迂回でなく拡張で通す。
- helper が新しい配布物として増える。バージョン不一致 (旧 helper × 新 app、新 helper × 旧 app) の試験が要る。helper のパスを変えると Codex の再信頼が必要になることを運用に明記する。
- Claude の `~/.claude/settings.json` には既存 hook が多数あるため、自動インストールは semantic merge (既存定義を順序保持・自分の entry だけに ownership marker・CAS か hash 確認・atomic replace・uninstall は自分の entry だけ削除) が絶対条件になる。
