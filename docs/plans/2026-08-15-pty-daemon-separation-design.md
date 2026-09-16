# PTY デーモン分離 設計書 (アプリと AI セッションの分離)

Date: 2026-08-15
Status: **設計のみ。実装の承認はまだ出ていない。** 実装 GO は宮崎さんの明示承認が出てから。
位置づけ: 全面改善プログラム `kaizen/perf-stability` の Phase 3。Phase 1+2 (12項目) は master 合流済み (`f03644e`)。
前提合意: 分離の対象は**全ペイン一律**で設計する (2026-08-15 宮崎さん裁定)。実装は段階投入するが、
「AI ペインだけ挙動が違う」二重構造は作らない。

---

## 1. 目的と、いま起きていること

やりたいこと: mycmux (GUI アプリ) を閉じても・落ちても・更新しても、走っている AI セッション
(claude / codex の PTY) が生き続ける構造。tmux でいう server/client 分離。

現状の実体は「復元」ではなく「再現」である。実コードで確認した事実:

- PTY はアプリのプロセス内メモリにしか存在しない (`pty/manager.rs:35` の `DashMap`)。
  アプリが終われば PTY・スクロールバック・世代情報はすべて消える。
- アプリ再起動後の復元は、**同じ session_id で PTY を新規 spawn し直している**
  (`src/lib/workspaceRestore.ts` → `XTermWrapper.tsx:1859` → `commands/terminal.rs:77`)。
  引き継ぐのは session_id・cwd・起動引数・起動 env の 4 つだけ。
- 会話が続いて見えるのは `claude --resume <id>` / codex resume という **CLI 側の機能**による。
  プロセスは毎回死んでいる。
- 画面はスクロールバック 256 KB のプロセス内リング (`pty/session.rs:20,542`) にしかなく、
  再起動をまたぐのは data.json の `terminal_snapshot` (数行のテキスト) のみ。
- 「アプリが死んだら PTY も死ぬ」は設計ではなく副作用。`kill_all()` は正常終了経路にしかなく
  (`lib.rs:517`, `commands/window.rs:308`)、クラッシュ時は ConPTY のハンドルが閉じることで
  子が死ぬことに依存している。ジョブオブジェクトも `CREATE_NEW_PROCESS_GROUP` も使っていない。

一方で、分離に必要な部品は既に揃っている。

1. `remote/ws_handler.rs` は既に**フロントを介さず** `PtySession` を直接操作している
   (`broadcast.subscribe()` / `write()` / `resize()` / `get_scrollback()`)。デーモンの IPC 面は
   これの一般化で足りる。
2. 出力フレーム `MCX1` / `MCS1` は magic + generation + seq + resync + 絶対オフセットを持ち、
   ACK フロー制御 (in-flight 512 KB / 16 バッチ / 2.5 秒 ACK タイムアウト) とセットで動いている
   (`pty/session.rs:97-142, 201-403`)。**プロセス境界を越える前提の設計**であり、ワイヤプロトコルに
   ほぼそのまま転用できる。
3. 同一プロセス内の再アタッチ (`manager.rs:91` の `create_or_reattach` → `replace_data_channel`) は、
   generation を +1 して in-flight を捨て再同期フラグを立てる。意味論として既に
   「クライアントの切断・再接続」そのもの。
4. 認証とディスカバリの雛形がある (`~/.mycmux/mycmux.port` + `mycmux.token`、fail-closed)。
5. `--profile` によるランタイムディレクトリ隔離が既にある (`test_profile.rs`)。

### 分離を難しくしている本当のポイント

PTY 側ではなく**権威の置き場所**にある。`pane.spawn` はストア更新 → React マウント →
`create_session` の順でしか起こらず、`pane.send_text` の送信確認は xterm.js のバッファを読んでいる
(`src/components/layout/socketCommands.ts:1111-1300`)。つまり「どのペインがどの session_id か」の
権威は UI にある。PTY だけデーモン化しても、UI が居ない間の新規 spawn・送信確認はできない。

本設計は**この権威を移さない**。移さないことで何が実現でき、何が実現できないかを 3 章で線引きする。

---

## 2. 方式比較

### 方式A — 専用 PTY デーモン + ローカル IPC (推奨)

PTY の生成・保持・破棄を、アプリとは別プロセスの常駐デーモン (`mycmuxd`) に移す。
アプリは「表示するクライアント」になる。

- **ConPTY 制約との整合**: ConPTY は後付けの再接続ができないため、既存 PTY をあとからデーモンへ
  引き渡す部分実装は成立しない。**最初からデーモンが ConPTY を open する**構成にすれば制約に触れない。
  デーモンは疑似コンソールの所有者であり続け、アプリはバイトストリームだけを受け取る。
- **トランスポート**: Windows = 名前付きパイプ (`\\.\pipe\mycmux-ptyd[-profile]`)、
  Unix = Unix domain socket。既存 socket.rs は loopback TCP だが、あれを踏襲しない。
  理由は 2 つ — (a) 同一マシンの他ユーザープロセスからも接続できてしまい、防御がトークン 1 枚に
  なる、(b) 出力バルク転送のコピー回数が増える。名前付きパイプなら OS の ACL で本人限定にできる。
  トークン (`~/.mycmux/ptyd.token`) は多層防御として併用し、**デーモンの生存期間で維持**する
  (アプリ起動ごとの再生成をやめる。既存 socket.rs の再生成仕様はそのまま)。
- **プロトコル**: 制御は JSONL (既存 socket.rs と同型)、データは同一接続上のバイナリフレーム。
  コマンドは `hello(protocol_version)` / `list` / `spawn` / `attach` / `detach` / `write` /
  `write_if_revision` / `resize` / `scrollback(from_offset)` / `kill` / `pids`。
  出力は `MCX1` をそのまま流す。アプリ側は受け取ったフレームを Tauri Channel へ中継するだけになり、
  フロントの復号・ACK・再同期ロジック (`attachEpoch.ts` / `planTerminalScrollbackRecovery`) は**無改造**。
- **デーモンは何も発明しない (dumb executor)**: spawn 要求には確定済みの command / args / env / cwd /
  size だけを渡す。`sanitize_launch_env`・resume 検証・OSC7 フック注入・パス系 env の正規値再注入は
  **アプリ側に据え置く** (`commands/terminal.rs:102-249`)。デーモンは自発的にプロセスを再起動しない
  (auto-respawn 禁止)。
- **env 継承の遮断**: portable_pty の子はデーモンの env を継承する。デーモンは起動時に
  `lib.rs:212-231` と同じ 17 キーを `remove_var` し、さらに spawn 時は「要求で渡された env のみ」を
  適用する。安全弁をアプリから移すのではなく、**境界の両側に同じ弁を置く**。
- **監視系の扱い**: `monitor` / `livebrief` は PID と ファイルを見ているだけなので、
  デーモンから PID 一覧を取れれば従来どおりアプリ側で動く。介入書き込みの
  `input_revision` CAS (`session.rs:922`) だけはデーモン API へ移す (`write_if_revision`)。
- **コスト**: `src-tauri` は単一クレートなので、cargo workspace 化して tauri 非依存の
  `pty-core` (PtySession / SessionManager / osc7 / scrollback) を切り出す前段が要る。
  vendored `portable-pty-0.8.1` はそのまま `pty-core` から参照する。

**Windows 固有の罠**

| 罠 | 内容 | 対処 |
|---|---|---|
| ジョブオブジェクト | 現状 mycmux はジョブを使っていないが、アプリが誰かのジョブ配下で起動されるとデーモンもジョブを継承し、**アプリを kill した瞬間に道連れで死ぬ** | デーモン起動は `DETACHED_PROCESS` + `CREATE_BREAKAWAY_FROM_JOB`。ジョブが breakaway を許可していない場合は失敗するので、WMI `Win32_Process.Create` によるデタッチ起動へフォールバック (deploy スクリプトで実績のある手法) |
| セッション0分離 | Windows サービス化するとデーモンは Session 0 で走り、ユーザーの DPAPI・資格情報・ドライブマップ・GUI を持たない。claude / codex の認証が壊れる | **サービス化しない**。ログオンユーザーのセッション内の通常プロセスにする。ログオフで死ぬのは許容 (4 章「やらないこと」) |
| 権限 (integrity level) | アプリとデーモンの一方だけを管理者で起動すると名前付きパイプに接続できない | `hello` 応答に integrity level を載せ、不一致は明示エラー。デーモンは常にアプリと同じ権限で起動する |
| ConPTY のウィンドウフラッシュ | vendored portable-pty は `CREATE_NO_WINDOW` / `DETACHED_PROCESS` を**意図的に使わず** `SW_HIDE` で隠している (interactive launcher が壊れるため、`vendor/.../win/psuedocon.rs:121-127`) | PTY 子プロセスの起動フラグは現行踏襲。`CREATE_NO_WINDOW` を使うのはデーモン自身の起動だけ |
| ツリーキル | portable-pty の kill は `TerminateProcess` を**直接の子 1 つ**にだけ呼ぶ。孫は ConPTY 断に依存 | デーモンの kill は現行と同じ意味論を維持。確実に落としたい場面は既存の `taskkill /T /F` 経路を使う |
| 単一インスタンス | プロファイルごとに 1 体でなければセッションが分裂する | 名前付き mutex `Local\miyazaki-mycmux-ptyd[-profile-X]` + ポートファイルの atomic 作成。負けた側は即終了して勝者へ接続 |

### 方式B — 既存の多重化ツール (tmux / abduco / dtach / zellij) に載せる

- **Windows で不成立**。tmux にネイティブ Windows 版はない。MSYS2 / Cygwin 版は ConPTY ではなく
  Cygwin の pty 実装で動くため、Windows ネイティブの node / claude.exe を安定して扱えない
  (端末サイズ通知・シグナル・コードページの互換問題)。abduco / dtach は Unix 専用。
  主戦場が Windows である以上、この方式は要件を満たさない。
- macOS / Linux では成立するが、mycmux の出力経路 (MCX1 + ACK フロー制御 + 絶対オフセット再同期) を
  捨てて tmux control mode に載せ替える必要があり、**OS ごとに二重実装**になる。
  スクロールバックの意味論も変わる (tmux は行単位、mycmux はバイト単位のリング)。
- **判定: 却下**。ただし将来 Unix 版で「外から tmux でも attach できる」互換口を出す案としては
  棚上げ可能。今回の設計には含めない。

### 方式C — 分離しない。「復元を速く・無損失に」する

- スクロールバックをセッションごとのリングファイルへ落とし、再起動時に完全再現する。
  AI の継続は従来どおり CLI の resume。
- 利点: 常駐プロセスが増えない。実装が局所的で、既存の安全弁 4 段に一切触らない。
  更新時の再起動が「一瞬で元の画面に戻る」体験にはなる。
- 限界: **アプリを閉じている間に AI が走り続けることは原理的に達成できない**。
  長時間タスクは更新のたびに中断し、`--resume` で再開されるだけ。宮崎さんの要求そのものは満たさない。
- **判定: 単独では不採用。ただし方式A の Step 0 として価値がある** (デーモン化しても
  「デーモンが死んだとき」「セッションを跨いだ画面履歴」は別問題として残るため)。

### 推奨

**方式A**。理由は 3 つ。

1. ConPTY の制約 (後付け再接続不可) は「最初からデーモンが open する」構成なら回避でき、
   これは方式A でしか成立しない。
2. 既存の MCX1 / generation / ACK / 再アタッチ意味論が、そのまま client-server の意味論になっている。
   ワイヤプロトコルを新規設計する必要がない。
3. フロント非依存で PTY を叩く前例 (`remote/ws_handler.rs`) が既に production で動いており、
   「アプリの UI が居なくても PTY は操作できる」ことは実証済み。

---

## 3. 何が実現でき、何が実現できないか (期待値の線引き)

権威 (どのペインがどの session_id か) を UI に残すため、実現範囲は次のとおりになる。

| シナリオ | 方式A 導入後 |
|---|---|
| アプリを閉じる / 更新で再起動する | **走っている AI はそのまま走り続ける**。再起動後 attach すると、途切れていない出力が続きから読める |
| アプリがクラッシュする | 同上。出力はデーモンのリングに溜まり続ける |
| アプリが居ない間に新しいペインを spawn したい | **できない** (UI が権威のため)。外部からの `pane.spawn` は従来どおりアプリ起動中のみ |
| アプリが居ない間に外部から `pane.send_text` したい | **できない**。送信確認が xterm.js バッファ依存のため。1.x で別途扱う |
| デーモンが死ぬ | セッションは道連れで終了する (ConPTY の所有者が消えるため)。復帰は UI の明示操作 |
| ログオフ / 再起動 | デーモンも終了する。永続化はしない |

---

## 4. やらないこと (今回の範囲外)

- 別マシンからの attach (既存 remote 機能の範囲を広げない)
- Windows サービス化・ログオン時の自動常駐
- スクロールバックのディスク永続 (方式C の一部。別テーマとして切る)
- data.json の書き手をデーモンにすること (デーモンは data.json を読み書きしない)
- レイアウト権威 (ペイン ↔ session_id の対応) をデーモンへ移すこと
- 既存 socket.rs (`mycmux.port` / `mycmux.token`) のプロトコル変更
- ConPTY の既存セッションをデーモンへ引き渡す実装 (原理的に不可)
- tmux 互換プロトコルの提供
- スマホ remote (`remote/ws_handler.rs`) の外部公開範囲の変更 — 参照先をデーモンへ差し替えるだけ

---

## 5. 移行戦略

**設計は全ペイン一律**。実装は下記の段で入れるが、段の途中でも「ペインの種類によって挙動が違う」
状態は作らない (切り替えの単位はペイン種別ではなく**設定フラグ**)。

| 段 | 内容 | 出荷単位 |
|---|---|---|
| S0 | cargo workspace 化 + `pty-core` クレート抽出。**振る舞い変更ゼロ**。既存 4 検証と契約テストがそのまま通ること | 単独リリース可 (無害) |
| S1 | `mycmuxd` 実装 + アプリ側クライアント。設定 `ptyDaemonEnabled` 既定 **OFF**。ON のとき新規セッションのみデーモン経由 | テストプロファイルで先行 |
| S2 | テストプロファイルで既定 ON → 実機確認 → 本番既定 ON。アプリ内 PTY 経路はフォールバックとして残す | 触って GO 必須 |
| S3 | `remote` / `livebrief` / `monitor` の参照をデーモン API へ寄せる | |
| S4 | アプリ内 PTY 経路の撤去 (1.x) | |

### v0.4.0 型の事故 (全ペイン自動 resume) を繰り返さないための設計条項

事故の本質は「意図していないのに、保存されていた情報を根拠にプロセスが自動で起動された」ことだった。
デーモン化は**同型の穴を新しい境界に作り直す危険がある**ため、次を設計条項として固定する。

1. **デーモンは自発的に spawn しない**。要求されたときだけ spawn する。auto-respawn 機能は持たない。
2. **アプリ起動時に、デーモンに残っているセッションへ自動で全 attach しない**。UI が明示的に要求した
   session_id だけ attach する。孤児セッションは一覧に「復帰可能」として出すだけで、勝手に画面へ戻さない。
3. **`sanitize_launch_env` はアプリ側に据え置く** (`commands/terminal.rs:557-631`)。デーモンは受け取った
   env に対して同じ検証を**もう一度**通す (二重化であり、移譲ではない)。
4. **`EPHEMERAL_LAUNCH_ENV_KEYS` / `stripEphemeralLaunchEnv` は無改造** (`SocketListener.tsx:757-786`)。
   デーモン経由でも永続化される launch_env の中身は現行と 1 バイトも変わらない。
5. **`dedupeAgentSessionsInConfigs` は UI 側のまま** (`SocketListener.tsx:597`)。同一 agent_session_id の
   二重 resume を防ぐ責務はデーモンに移さない。デーモンは resume の概念を知らない。
6. **`lib.rs` の `remove_var` 17 キーはデーモン起動時にも実行する**。デーモンを親シェルから起動した
   場合に `MYCMUX_*` が全 PTY へ降りる経路を塞ぐ。
7. `tests/test_ephemeral_env_keys_contract.py` / `test_command_sync_contract.py` /
   `test_session_restore_agent_kind.py` は**維持**。振る舞いを変えずにパスを追加する。

---

## 6. 障害時の挙動

| 事象 | 挙動 |
|---|---|
| **デーモンが死ぬ** | アプリはパイプ断を検知し、該当ペインに「デーモン切断」を表示。指数バックオフでデーモンを再起動する。PTY は ConPTY の所有者が消えたため道連れで終了しており、セッションは exited 扱い。**自動で再 spawn はしない** (5 章の条項1)。復帰は UI の明示操作 |
| **アプリが死ぬ** | デーモンは attach 数 0 で走り続ける。出力はリングに溜め続け、上限を超えたら古い方から捨てる (絶対オフセットは進み続けるので、アプリ側は「欠落あり」を検出して TUI redraw を要求できる = 現行 `planTerminalScrollbackRecovery` と同じ経路)。次回アプリ起動時にセッション一覧を提示する |
| **両方死ぬ** | 何も残らない (現状と同じ)。孤児プロセス (claude 等) は ConPTY 断で死ぬ想定だが保証はないため、アプリ起動時に既知の PID を突き合わせて孤児候補を一覧提示する |
| **デーモンの二重起動** | 名前付き mutex + パイプ名の排他で 1 体に収束。負けた側は即終了して勝者のパイプへ接続。プロファイルが違えば別の名前空間なので共存する |
| **アプリの二重起動** | 既存の単一インスタンス mutex が先に効く。子ウィンドウは従来どおりリーダー選出で処理 |
| **版数不一致 (アプリだけ更新された)** | `hello` で `protocol_version` を交換。**互換**なら継続。**非互換**かつセッション 0 件なら旧デーモンを終了させて新版を起動。**非互換かつセッション有**なら旧デーモンを維持したまま「旧版セッション」として扱い、ユーザーに「閉じてよいか」を出す。**デーモンが自分自身を更新することはしない** |
| **デーモンだけが古いまま残る** | 上と同じ経路。updater はデーモンを差し替えない (アプリの exe と同梱し、次回起動時のハンドシェイクで判定する) |
| **トークンファイルが読めない** | 既存 socket.rs と同じ fail-closed。全拒否してエラーを出す |
| **権限不一致 (片方だけ管理者)** | `hello` で検出して明示エラー。暗黙に別デーモンを立てない |

---

## 7. 検証計画

「アプリを kill しても AI が生きている」を機械的に示す手順。**すべて `--profile ptyd` のテスト
プロファイルで実施**し、本番プロファイルには触れない。

### 7-1. 生存の実証 (E2E・手で 1 回、CI では 2 と 5 を自動化)

```powershell
# 1. テスト機を起動
& "$HOME\mycmux-app\mycmux.exe" --profile ptyd
# 2. デーモンが立ったことを確認
Get-Process mycmuxd | Select-Object Id, StartTime
# 3. ペインで途切れないカウンタを走らせる (session_id を控える)
#    python -c "import time,sys
#    [(print(i), sys.stdout.flush(), time.sleep(1)) for i in range(600)]"
# 4. アプリだけを強制終了 (正常終了経路を通さない)
Stop-Process -Name mycmux -Force
# 5. デーモンと孫プロセスの生存を確認
$d = (Get-Process mycmuxd).Id
Get-CimInstance Win32_Process -Filter "ParentProcessId=$d" |
  Select-Object ProcessId, Name, CommandLine
# 6. アプリを再起動して attach → カウンタが途切れず続いていること
```

合格条件: 手順 5 で子プロセスが生存していること。手順 6 で受信フレームの
`scrollback_start` / `scrollback_end` が**単調増加かつ欠落なし**であること (欠落があれば
resync フラグが立つので、フラグが立たないことを以て証明する)。

### 7-2. 事故再発防止の機械検証 (新規 pytest)

`tests/test_ptyd_contract.py` に以下を固定する。

1. **env 継承ゼロ**: `MYCMUX_RESUME=claude` / `MYCMUX_SESSION_ID=<uuid>` を注入した環境から
   デーモンを起動し、spawn した PTY 内の `env` に `MYCMUX_RESUME` / `MYCMUX_SESSION_ID` が
   **出ないこと**。
2. **auto-respawn 無し**: セッションの子を外から kill したあと、デーモンが新しいプロセスを
   立てないこと (一定時間後の `pids` が空)。
3. **自動 attach 無し**: デーモンにセッションが残った状態でアプリを起動し、UI が要求しない限り
   attach が 0 件であること。
4. **プロトコル版**: `hello` の非互換版で接続したとき、既存セッションを kill しないこと。
5. 既存 `test_ephemeral_env_keys_contract.py` / `test_command_sync_contract.py` /
   `test_session_restore_agent_kind.py` が無改造で通ること。

### 7-3. 既存 4 検証 (段ごとに全通過が条件)

```
npx tsc --noEmit
npx vitest run
python scripts/run_windows_tests.py
python -m pytest tests/
```

---

## 8. 未解決の宿題 (この設計とは別に残っているもの)

- Phase 1+2 の feed リリース。テストプロファイルで宮崎さんが触って GO を取る手順が未実施。
- worktree `C:\Users\miyaz\mycmux-kaizen` (branch `kaizen/perf-stability`) の片づけ。
  **削除は宮崎さんの承認が必要**。
- S0 (workspace 化) を単独リリースとして先に出すか、S1 とまとめるかは実装 GO 時に決める。
