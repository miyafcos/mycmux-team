# サイドバーのキャラ (pet) の状態設計 (2026-09-10)

読者 = 宮崎さん (採否判断) と実装を担当するエージェント / 語り手 = mycmux 開発者 (弊社) / 相手 = 宮崎さん / その先 = 公開ミラー `miyafcos/mycmux-team` の閲覧者。

対象コード: `src/components/layout/TabBar.tsx` (集約) / `src/components/layout/TabItem.tsx` (描画の可否) / `src/components/workspace/PetSprite.tsx` (行と周期) / `src-tauri/hooks/mycmux_hook.py` と `src-tauri/src/agent_state/hook.rs` (hook 由来の attention・8 章)。観測契約の正本は `src-tauri/src/session_state/mod.rs` と `docs/plans/2026-08-31-observation-contract-roadmap.md`。pet の行の契約の正本は openai/codex の `codex-rs/tui/src/pets/model.rs` (2 章の互換表に転記)。
実装は 2026-09-10 13:35 に着手 (Codex 2 レーン・9 章)。

---

<div class="callout warn">現状の分岐は「待ち→手を振る / エラー→怒る / 停滞→居眠り / 作業→走る / それ以外→まばたき」の 5 段だが、「待ち」と「作業」の入力の大半が<b>画面で観測中のタブでしか更新されない画面スキャン値</b>なので、裏のワークスペースでは呼ばれても手を振らず、止まっても休まない。加えて行の使い方が本家 Codex の契約と 2 か所ずれていて (人間待ちに挨拶の行、停滞に「入力待ち」の行)、外部 pet では作者の意図と違う絵が出る。設計案は本家の 5 状態と同じ行を同じ意味で使い (呼んでる 6 / 困ってる 5 / 走ってる 7 / 見て見て 8 / 寝てる 0)、backend のセッション状態フィード 1 本から導く。着手前の実測で、そのフィードの hook 由来 attention が「放置」でも立ち「答えても」消えないことが分かったため、観測契約側 (hook 転送と backend の解除) も同時に直す (8 章)。判断 6 点は 2026-09-10 に宮崎さんが確定した (7 章)。</div>

## 1. 背景

### 1.1 実測した現状

| # | 事実 | 出典 |
|---|---|---|
| P1 | ワークスペース行のキャラは 5 分岐: `waiting>0 → waving` / エラー → `failed` / 停滞あり → `waiting` (行 6) / `working>0 → running` / それ以外 `idle` | `TabBar.tsx:277-285` |
| P2 | 「待ち」の入力は `deriveDisplayStatus` = `meta.agentStatus === "waiting"` だけ。これを立てるのは XTermWrapper の画面スキャン (承認プロンプトの正規表現・AskUserQuestion の画面) のみで、backend の attention (`input` / `approval`) は見ていない | `notificationStatus.ts:31` / `XTermWrapper.tsx:1757-1772` |
| P3 | 画面スキャンは xterm の `onWriteParsed` で走り、端末のアンマウント時に listener ごと破棄される。マウントされるのは表示中の 1 ワークスペース (`MAX_MOUNTED_WORKSPACES = 1`) の、各ペインで前面にあるタブだけ。それ以外のタブでは `agentStatus` が離れた時点の値で凍る | `XTermWrapper.tsx:2470-2476, 2616` / `WorkspaceView.tsx:26` |
| P4 | backend のセッション状態フィードは全セッションぶん届く: `attention.kind` (none / input / approval / rate_limited / error / done)、`uiState` (working / idle / waiting / done / unknown)、`activity` (streaming / running_silent / idle / unknown)。`uiState` は attention が input / approval / rate_limited / error なら waiting、done なら done、無ければ activity から working / idle | `sessionAttentionStore.ts:138-149` / `ipc.ts:527-528` / `session_state/mod.rs:273-285` |
| P5 | 「作業中」= `processIsShell === false` かつ (`outputActive` または `workingPatternVisible` または backend 出力が 15 秒以内)。前 2 つは画面由来で裏では凍る。backend の `activity` (running_silent = 出力は無いがプロセスは動いている) は未使用 | `notificationStatus.ts:35-45` |
| P6 | 停滞 (`stallStore`) は headless buffer で裏でも 30 秒ごとに判定する。閾値 5 分、理由は `no_output` / `queued_input` / `silent` / `pty_dead` の 4 種。attention が立っているタブは候補から外れる | `stallStore.ts:21-25, 102-116` / `tabSweep.ts:13` |
| P7 | エラー判定は `attention.kind === "error"` だけ。`rate_limited` は含まず、既読でも続く | `TabBar.tsx:261` |
| P8 | `idle` は裏では静止画 (frame 0)、表示中は 1.1 秒周期で再生。状態の切替は 1.5 秒の保持が上げ下げ一律 (`waving` / `failed` だけ即時) | `TabItem.tsx:161` / `PetSprite.tsx:66-73` |
| P9 | 実装が持つ行は 0 idle / 3 waving / 4 jumping / 5 failed / 6 waiting / 7 running の 6 つ。行 1・2・8 は未使用、`jumping` は型にあるだけで TabBar は出さない。周期は行 3〜7 が本家と一致、行 0 だけ本家の 6 倍速 (1100ms、本家は 6600ms) | `PetSprite.tsx:21-33` / 2.1 の互換表 |
| P10 | backend で `done` を出すのは Codex の rollout 監視だけ。Claude の hook は AttentionRequired → `input` のみを ingest し、Stop (turn_ended) と UserPromptSubmit (turn_active) は session_state に何も届けない | `codex_rollout.rs:504` / `agent_state/hook.rs:772-793` |
| P11 | backend の attention に失効処理は無い (`stale_after` は保存されるだけ)。解除は同じ source からの `none`、新しい attention、プロセス再起動 (epoch) のいずれか。hook は `none` を送らない | `session_state/mod.rs:329-352` |
| P12 | 他の面は別の語彙を持つ: ダッシュボード (needsHuman / error / running / noUpdate / done / acknowledged / idle / stopped)、ミニマップ (working / waiting / idle)、グループ化 (working / waiting / done / error / idle) | `dashboardModel.ts:24` / `minimapModel.ts:127` / `groupingLineage.ts:5` |
| P13 | 外部 pet の `pet.json` は id / displayName / description / spritesheetPath / spriteVersionNumber / kind だけ (ギャラリー配布物の実物)。本家は `animations` で行の意味を上書きできるが、ギャラリーの pet は使っていない。実装は `name` しか読まない | codex-pets.net の `monchhichi` 配布 zip / `codex_pets_model.rs:388-451` / `commands/pets.rs:44-56` |
| P14 | Claude Code の hook は Notification を全部 `attention_required` として転送する。Notification の `notification_type` は 12 種あり、ブロッキングは permission_prompt / elicitation_dialog / elicitation_url_dialog / agent_needs_input の 4 つだけ。`idle_prompt` (放置) や `auth_success` も `input` になる。AskUserQuestion は Notification を出さない (PreToolUse で `tool_name: AskUserQuestion` が出るだけ) ので、裏のタブの AskUserQuestion は hook では届かない | `~/.claude/settings.json` の hooks / `src-tauri/hooks/mycmux_hook.py` / Claude Code docs hooks#notification (2026-09-10 確認) |
| P15 | 実タブ 3 本で、ターンが終わって空のプロンプトで止まっているのに `attention=input, ui_state=waiting` (source は hook、`state_since` は 5 分前)、答えて作業を再開しているのに `input` のまま、を確認した (2026-09-10 13:1x) | `mycmux_agent_cli.py status` の state_view / `read` の画面 |
| P16 | Claude Code は空のプロンプトで待機中でも約 10 秒ごとに PTY 出力を出す (`last_output` が 10 秒間隔で届き `activity=streaming` のまま)。出力の新しさや activity では「作業中」と「待機中」を区別できない | 同上の `recent_evidence` |
| P17 | プロセス監視は PTY の最深の子プロセスを前面プロセスとみなす。エージェントが Bash ツールを実行中は bash が最深になり `process_status=idle` / `processIsShell=true` になる | `pty/monitor/runner.rs:139-153` / `monitor/detection.rs:25` / `pty/monitor.rs:37-47` |

### 1.2 「思ったとおりに動かない」の正体

P2 と P3 から、症状は次の 7 つに分解できる。

| # | 症状 | 原因 |
|---|---|---|
| S-A | 裏のワークスペースで AskUserQuestion や承認に入っても手を振らない。走ったまま 15 秒後に静止画になる | 「待ち」の入力が画面スキャン値だけで (P2)、裏では更新されない (P3)。backend の `input` / `approval` は立っているのに読んでいない |
| S-B | 待ちのまま別のワークスペースへ移り、外から (send やリモート) 答えると、手を振り続ける | 凍った `agentStatus` を解除する経路が画面スキャンしか無い (P3) |
| S-C | 全部止まっているのに休まない。裏は静止画、表示中は 1.1 秒周期のまばたきで「点滅」に見える | 行 0 の周期が本家の 6 倍速 (P9)。停滞の 5 分後にだけ行 6 が出るが、それは本家では「入力待ち」の絵 (P1, P6) |
| S-D | 出力の無い長い道具実行 (15 秒超) で走るのをやめる | backend の `running_silent` を見ていない (P5) |
| S-E | レート制限で止まっても知らせない | `rate_limited` をエラーに含めていない (P7) |
| S-F | 外部 pet を入れると、人間待ちで「やあ」と挨拶し、停滞で手招きする | 行 3 は本家では状態に使わない挨拶、行 6 は本家の「入力待ち」(2.1) |
| S-G | (backend を読むように直しただけでは) 放置した Claude が全部「呼んでる」になり、答えても消えない | hook の `input` が idle_prompt でも立ち、解除経路が無い (P14, P15)。未読リングとダッシュボードの「返答待ち」も今この誤表示を出している |

### 1.3 既にある土台 (作らずに呼ぶ)

| # | 事実 | 出典 |
|---|---|---|
| T1 | セッション状態フィード (attention / uiState / activity / lastOutputAt) が全タブぶん `sessionAttentionStore` にある | `sessionAttentionStore.ts` (`attentionBySession` / `statusSignalsBySession`) |
| T2 | 「画面で観測できているか」の考え方は socket API に既にある (`screenObserved = isTerminalMounted(sessionId)` → `agentStatusStale`) | `socketCommands.ts:611-627` / `terminalCache.ts` の `liveTerms` |
| T3 | 停滞の判定と理由 | `stallStore.ts` |
| T4 | スプライトの行と再生 (CSS `steps()`)、reduced-motion の固定 | `PetSprite.tsx` / `PetSprite.css` |
| T5 | ワークスペース行の未読リング (未読の attention を数える) と、タブ単位の既読判定 `attentionCategory` (未読の done だけ "done" を返す) | `TabItem.tsx` の `UnseenAttentionRing` / `sessionAttentionStore.ts:213-224` |
| T6 | hook の経路: Claude Code の Notification / PermissionRequest / Stop / UserPromptSubmit / SessionEnd → `mycmux_hook.py` → `hook.observe` → `hook.rs` → session_state。原本は `src-tauri/hooks/mycmux_hook.py` (`settings.rs` が `include_bytes` で配布し `~/.mycmux/hooks/v1/` に置く) | `agent_state/settings.rs:15, 53` / `docs/adr/0009` |
| T7 | Evidence の source には優先順位がある (Hook=0 が最上位、ScreenScan=1、…)。`apply_attention` の `none` は同じ source しか消さない | `session_state/mod.rs:60-70, 329-352` |

---

## 2. 語彙 (先に固定する)

### 2.1 本家 Codex の行の契約と互換

一次資料: openai/codex `codex-rs/tui/src/pets/model.rs` (`default_animations`)、同 `ambient.rs` (`PetNotificationKind`)、公式 pet `codex-spritesheet-v4.webp` (CDN `persistent.oaistatic.com/codex/pets/v1/`)、codex-pets.net の実物 (Monchhichi = v2 11 行、mika-grok = v1 9 行) と一覧 API 250 体 (v2 が 217 体、v1 が 33 体)。

| 行 | 本家の名前 | 本家 TUI が当てる状態 | 公式 pet の絵 | 外部 pet の絵 (実物 2 体) | 今の実装 | 新設計 |
|---|---|---|---|---|---|---|
| 0 | idle (6 コマ・6600ms) | 何もなし | 正面で時々まばたき | 同じ | idle (1100ms・裏は静止) | **寝てる** (本家の周期) |
| 1 | running-right (8) | 状態に使わない | 右へ走る | 同じ | 未使用 | 使わない |
| 2 | running-left (8) | 状態に使わない | 左へ走る | 同じ | 未使用 | 使わない |
| 3 | waving (4・700ms) | 状態に使わない | 片手で「やあ」 | 同じ | 人間待ち | 使わない |
| 4 | jumping (5・840ms) | 状態に使わない | 跳ぶ | 同じ | 型だけ | 使わない |
| 5 | failed (8・1220ms) | Blocked | 顔を覆う・×× の目 | 泣く・落ち込む | エラー | **困ってる** |
| 6 | waiting (6・1010ms) | Needs input | 顎に手を当てて待つ | 手招き・笑顔の呼びかけ | 停滞 (Clawd だけ居眠りの絵) | **呼んでる** |
| 7 | running (6・820ms) | Running (Thinking) | ノート PC で打つ | 走る・集中 | 作業中 | **走ってる** |
| 8 | review (6・1030ms) | Ready | 両手を上げて喜ぶ | 得意げ・指差し | 未使用 | **見て見て** |
| 9 | look-right-side (8) | v2 のみ・状態に使わない | (v2 なし) | 右を見回す | 未使用 | 使わない |
| 10 | look-left-side (8) | v2 のみ・状態に使わない | (v2 なし) | 左を見回す | 未使用 | 使わない |

- **形式の互換は現状で 100%**: 幅 1536・セル 192×208・8 列で、行数 9 (v1) と 11 (v2) を受け付ける。使う行は全部 0〜8 なので、v1 でも v2 でも欠けた行を代用することは起きない。
- **意味の互換は現状 2 か所ずれ**: 行 3 (挨拶) を人間待ちに、行 6 (入力待ち) を停滞に使っている。新設計は本家の 5 状態を同じ行・同じ意味で使い切り、行 1〜4 と 9〜10 は意味を勝手に与えないために使わない。
- 周期は行 5〜8 を本家の合計と同じにする (実装済みの 3〜7 は既に一致)。行 0 だけ本家のコマ別の長さ (1680 / 660 / 660 / 840 / 840 / 1920ms) に直す。
- 本家は状態のアニメーションを 3 周回してから idle のコマに落ち着き、状態が続く間もそのまま (`app_state_animation` の `loop_start`)。新設計は状態が続く間ずっと回す。宮崎さんの要件 (呼んでいる間は動き続ける) に合わせた意図的な逸脱で、行と意味は変えない。

### 2.2 段の名前と見た目

段の名前は「人から見て何をしてほしいか」で付ける。ダッシュボードの語 (needsHuman 等) とは層が違うので同じ語を使わない。

| 段 | 名前 | 意味 | 絵 (行) | 周期 |
|---|---|---|---|---|
| 1 | <span class="chip ng">呼んでる</span> `calling` | 人が答えないと AI が進めない (AskUserQuestion・承認・打ちかけの入力) | 行 6 waiting | 1010ms / 6 コマ (本家と同じ) |
| 1' | <span class="chip warn">困ってる</span> `stuck` | エラーやレート制限で止まった。人の処置が要る | 行 5 failed | 1220ms / 8 コマ (本家と同じ) |
| 2 | <span class="chip accent">走ってる</span> `working` | 人は呼ばれていない。AI が作業中 | 行 7 running | 820ms / 6 コマ (本家と同じ) |
| 2' | <span class="chip accent">見て見て</span> `ready` | ターンが終わって、まだ見ていない | 行 8 review | 1030ms / 6 コマ (本家と同じ) |
| 3 | <span class="chip ok">寝てる</span> `resting` | そのワークスペースの全タブが止まっている | 行 0 idle | 6600ms / 6 コマ (本家と同じ・コマ別の長さ) |

- 段 1 と 1' は同じ「人が要る」層の 2 つの見た目。集約の優先は 呼んでる > 困ってる > 走ってる > 見て見て > 寝てる。
- 「寝てる」は名前であって、絵は本家の「何もなし」(休んでいる姿)。どの pet も作者がその意味で描いている。
- 既読かどうかは「見て見て」だけに効く (見たら寝てるへ)。呼んでる・困ってるは状態が続く限り出す。未読リング (T5) は「まだ見ていない」を担当し、段は「今の状態」を担当する。

---

## 3. 判定

### 3.1 入力 (タブ 1 本につき)

| 入力 | 出どころ | 画面で観測していないタブでも動くか |
|---|---|---|
| `attention.kind` (8 章の修正後は、Claude でも input が「本当に人待ち」のときだけ立ち、done がターン終了で立つ) | backend のセッション状態フィード (T1) | 動く (hook・プロセス監視・Codex rollout 由来) |
| `activity` / `lastOutputAt` (`backendLastOutputAt`) | 同上 / PTY 出力 | 動く。ただし待機中の Claude も 10 秒ごとに出力する (P16) |
| `agentStatus === "waiting"` / `workingPatternVisible` / `outputActive` | 画面スキャン (P2) | 動かない (凍る)。観測中のタブだけ信頼する |
| 観測中かどうか | `liveTerms.has(sessionId)` (T2 の `isTerminalMounted`) | 静的 |
| 既読 | `seenAttentionByTab` (T5) | 動く |
| `stall.reason` | 停滞判定 (T3) | 動く |
| タブ種別 | `tab.type` (terminal / web / browser / online) | 静的 |

使わない入力: `processIsShell` (Bash ツール実行中に shell 扱いになる・P17) と `uiState` (attention と activity の合成で、単独では待機と作業を分けられない・P16)。

### 3.2 分類表 (上から順に見て最初に当たった段)

| # | 条件 | 段 | 備考 |
|---|---|---|---|
| R0 | タブ種別が web / browser / online | 寝てる | attention を持たない (D7) |
| R1 | 観測中のタブ かつ `agentStatus === "waiting"` | 呼んでる | 見えているものは画面が正 |
| R2 | 観測していないタブ かつ `attention.kind ∈ {input, approval}` | 呼んでる | S-A を直す本体。観測中のタブでは backend の input / approval を段 1 に使わない (backend が解除し損ねても画面を優先) |
| R3 | `attention.kind ∈ {rate_limited, error}` | 困ってる | S-E を直す。既読でも続く |
| R4 | `stall.reason === "queued_input"` | 呼んでる | 打ちかけの入力が送られていない = 人の操作待ち |
| R5 | `attention.kind === "done"` | 未読なら見て見て、既読なら寝てる | **「走ってる」より先に置く**。待機中の Claude は 10 秒ごとに出力するので (P16)、done で先に止める。Codex は rollout、Claude は 8 章の修正で出る |
| R6 | `stall.reason ∈ {no_output, silent, pty_dead}` | 寝てる | 5 分動きが無いものを「走ってる」とは言わない |
| R7 | 観測中のタブ かつ `workingPatternVisible` | 走ってる | 画面のスピナーが正 |
| R8 | `outputActive` または `backendLastOutputAt` が 15 秒以内 | 走ってる | S-D を直す。`processIsShell` は見ない (P17) |
| R9 | `activity === "running_silent"` | 走ってる | 出力の無い長い処理 |
| R10 | それ以外 (idle / unknown / attention none で出力なし) | 寝てる | S-C を直す |

「観測中」はワークスペース単位ではなくタブ単位 (ペインの前面にあるタブだけがマウントされる・P3)。T2 と同じ考え方で、画面の値は観測できている間だけ使う。

### 3.3 集約 (ワークスペース 1 行につき)

全ペインの全タブを R0〜R10 で分類し、優先 (呼んでる > 困ってる > 走ってる > 見て見て > 寝てる) の最大を取る。タブが 0 本なら寝てる。1 本でも呼んでいれば他が走っていても呼んでる。走っているタブと見終わっていないタブが並ぶときは走ってる (忙しさが先、未読はリングが持つ)。

### 3.4 落ち着かせ方

| 遷移 | 保持 | 理由 |
|---|---|---|
| どこから → 呼んでる / 困ってる | 即時 | 人を呼ぶ状態は 1 秒も遅らせない (現行の waving / failed 即時と同じ) |
| 走ってる → 寝てる / 見て見て | 3 秒 | 道具呼び出しの合間 (数百 ms〜2 秒) で休みに落ちない。現行の 1.5 秒では短い |
| 寝てる / 見て見て → 走ってる | 即時 | 動き出しは目で追いたい |
| 呼んでる / 困ってる → 下の段 | 即時 | 答えた瞬間に走り出すのが答えた実感になる |
| 見て見て → 寝てる (既読) | 即時 | 見た瞬間に落ち着く |

- 表示中かどうかで動きを止めない。`animate` は段だけで決める (現行の `active || petState !== "idle" || …` を撤廃)。寝てるは 6.6 秒周期なので常時再生でも目障りにならず、負荷も無視できる。
- `prefers-reduced-motion` はコマ 0 固定 (現行維持)。

---

## 4. 決定事項

- **D0. 観測契約 1 本から導く。** 段は backend のセッション状態フィード (T1) から決め、画面スキャン値は観測中のタブの即応用に限定する (R1 / R2 / R7)。他の面 (ダッシュボード・ミニマップ) の語彙は変えない (P12)。当初の「Rust は変えない」は着手前の実測 (P14〜P17) で撤回し、観測契約側も直す (D9・8 章)。
- **D1. 寝てる = 行 0 idle を本家の周期で。** 確定 (2026-09-10 宮崎さん・Q1' で決め直し)。Q1 の「行 6」は外部 pet では「呼んでる」の絵になるため撤回。
- **D2. 停滞は寝てる、打ちかけの入力 (`queued_input`) は呼んでる。** 確定 (2026-09-10 宮崎さん・Q2)。
- **D3. 困ってる (エラー・レート制限) は行 5 の別の見た目。** 確定 (2026-09-10 宮崎さん・Q3)。
- **D4. 見て見て = 行 8 review を出す。** 確定 (2026-09-10 宮崎さん・Q4)。未読の done で出し、見たら寝てるへ。Codex は rollout、Claude は D9 で出る。
- **D5. 行の意味は本家に合わせる (意味の互換 100%)。** 呼んでる 6 / 困ってる 5 / 走ってる 7 / 見て見て 8 / 寝てる 0。行 1〜4 と 9〜10 は使わない。周期は行 0 と 8 も本家に合わせる。
- **D6. 状態が続く間はアニメーションを回し続ける。** 本家の「3 周で idle に落ち着く」からの意図的な逸脱 (2.1)。
- **D7. web / browser / online タブは寝てる (仮置き)。** attention を持たないため。web-read で会話状態が取れるようになったら R8 相当を足す。
- **D8. 設定は増やさない。** 表示 ON / OFF (`petDisplayMode`) と候補選択は現行のまま。
- **D9. hook 由来 attention の意味を正す (観測契約側)。** 確定 (2026-09-10 宮崎さん・Q5「A 両方直す」)。内容は 8 章。

---

## 5. 実装の置き場

| レーン | 場所 | 変更 | 規模 |
|---|---|---|---|
| 2 (フロント) | `src/lib/petState.ts` (新規) | 純関数 3 つ: `classifyPetTier(input)` (R0〜R10)、`aggregatePetTier(tiers)` (3.3)、`petSpriteStateFor(tier)` (2.2 の行対応)。保持時間の定数 | 新規 100 行前後 |
| 2 | `TabBar.tsx` の `WorkspaceTabEntry` | `attentionBySession` / `statusSignalsBySession` / `seenAttentionByTab` / `stalls` / `metadata` / 観測中集合を集めて `petState` に渡す。現行の 5 分岐を削る。`now` は 15 秒ごと | 変更 50 行 |
| 2 | 観測中集合 | `liveTerms` の set / delete 3 か所と同期する小さな store (`terminalObservationStore`) | 新規 30 行 |
| 2 | `TabItem.tsx` | `animate` を段だけで決める | 変更 5 行 |
| 2 | `PetSprite.tsx` / `PetSprite.css` / `PetTab.tsx` | 状態名を 5 つに置換 (calling / stuck / working / ready / resting)。`resting` は行 0 をコマ別の長さで (keyframes に比率 0 / 25.45 / 35.45 / 45.45 / 58.18 / 70.91%)。保持時間を「上げ即時 / 下げ 3 秒」に分ける | 変更 60 行 |
| 2 | `README.md` §キャラ | 「6 アニメーション」の一文を 5 状態 (本家と同じ行) の説明に差し替え | 文言 |
| 1 (backend) | `src-tauri/hooks/mycmux_hook.py` | Notification の `notification_type` がブロッキングでない 8 種なら送らない。PreToolUse は AskUserQuestion だけ送る | 変更 20 行 |
| 1 | `src-tauri/src/agent_state/settings.rs` | PreToolUse (AskUserQuestion) → attention_required、PostToolUse (AskUserQuestion) → turn_active を hook 登録に足す | 変更 20 行 |
| 1 | `src-tauri/src/agent_state/hook.rs` | turn_active → none、turn_ended → done、終了系 → none を session_state に ingest | 変更 40 行 |
| 1 | `src-tauri/src/session_state/mod.rs` | Hook の none は source を問わず attention を消す (Hook は最上位・T7) | 変更 10 行 + テスト |
| 1 | `docs/adr/0012-hook-attention-semantics.md` | event → attention の対応表と根拠 | 新規 |

2 レーンは同じ worktree で境界を分けて並走し、それぞれ自分のファイルだけをローカルコミットする (push は母艦)。

---

## 6. 検証 (出す前に決めておく)

- 単体 (レーン 2) `tests/unit/petState.test.ts`: R0〜R10 を 1 行ずつ (観測中 / 未観測の両方)、集約の優先 5 × 5、保持時間 (fake timers で 3 秒)、既読で見て見て → 寝てる、**待機中の Claude** (done 既読 + 3 秒前の出力 → 寝てる)、**Bash ツール実行中** (attention none + 2 秒前の出力 → 走ってる)、web タブ、タブ 0 本。
- 単体 (レーン 2) `tests/unit/petSprite.test.ts` (既存に追加): 5 状態の行番号が 2.1 の表と一致すること、行 0 の keyframe 比率、v1 (9 行) と v2 (11 行) の両方で 5 状態の行が範囲内にあること。
- 単体 (レーン 1) `session_state/tests.rs`: Hook の none が ScreenScan の approval を消す / turn_ended で done、次の turn_active で消える / 古い none は新しい input を消さない。`tests/test_agent_hook_script.py`: idle_prompt は届かない、permission_prompt は届く、PreToolUse は AskUserQuestion だけ届く。
- 既存: `npx tsc --noEmit` / `npx vitest run` / `python scripts/run_windows_tests.py` / `python -m pytest tests/`。
- 実機 (テスト機を `--profile` で隔離して起動):

| # | 手順 | 期待 | 現状 |
|---|---|---|---|
| S1 | 裏のワークスペースで Claude に AskUserQuestion を出させる | 呼んでる (行 6) | 走る → 静止画 |
| S2 | 裏のワークスペースで出力の無い道具実行を 30 秒以上させる | 走り続ける | 15 秒で静止画 |
| S3 | 全タブをプロンプトで止める | 寝てる (6.6 秒周期) | 1.1 秒周期 / 静止画 |
| S4 | レート制限に当てる | 困ってる (行 5) | 反応なし |
| S5 | S1 の状態で、別セッションから send で答える | 走り出す (hook の turn_active で解除) | 手を振り続ける |
| S6 | Codex または Claude のターンを終えて見ない | 見て見て (行 8)。タブを見たら寝てる | 反応なし |
| S7 | 外部 pet (Monchhichi v2 / mika-grok v1) を取り込んで S1・S3・S4・S6 を繰り返す | 作者の絵の意味どおり (手招き / 休み / 落ち込み / 喜び) | 挨拶と手招きが逆に出る |
| S8 | Claude を空のプロンプトで 2 分放置する (idle_prompt) | 寝てる (呼ばない・未読リングも出ない) | attention input が立つ |
| S9 | 承認プロンプトを出させて、表示中に答える | 呼んでる → 走ってる、リングも消える | 承認だけ正しく動く |

---

## 7. 判断の記録 (6 問・2026-09-10 宮崎さん確定)

<div class="cards">
<div class="card"><p class="card-t">Q1 寝てるの絵 = 行 6 → Q1' で撤回</p><p><span class="chip warn">撤回</span> 同梱 Clawd の行 6 は居眠りの絵だったが、本家の行 6 は「入力待ち」で、公式 pet は顎に手を当てて待ち、外部 pet は手招きする (2.1)。寝てるに使うと外部 pet で「呼んでる」の絵が出る。</p></div>
<div class="card pick"><p class="card-t">Q1' 寝てるの絵 = 行 0 idle を本家の周期で</p><p><span class="chip ok">確定</span> 本家の「何もなし」と同じ行。どの pet も作者が休んでいる姿を描いている。6.6 秒周期なので点滅に見えない。退けた案 = 行 6 のまま (Clawd 専用の見た目) / 行 0 静止画 (「切れている」に見える)。</p></div>
<div class="card pick"><p class="card-t">Q2 停滞 (5 分無出力) = 寝てる</p><p><span class="chip ok">確定</span> 「走ってる」と言い続けるのは嘘になり、「困ってる」は 5 分無出力が失敗と限らない。打ちかけの入力 (queued_input) だけは人の操作待ちなので呼んでる。退けた案 = 停滞も困ってる / 走ってるのまま。</p></div>
<div class="card pick"><p class="card-t">Q3 困ってる = 行 5 の別の見た目</p><p><span class="chip ok">確定</span> 呼んでる (行 6) と区別が付き、「答えれば進む」と「処置が要る」を見分けられる。退けた案 = 呼んでるに統合して 3 段だけにする。</p></div>
<div class="card pick"><p class="card-t">Q4 見て見て = 行 8 review を出す</p><p><span class="chip ok">確定</span> 本家の 5 状態を全部使い切る。未読の done で出し、見たら寝てるへ。Claude の done は Q5 の修正 (Stop → done) で揃う。退けた案 = 出さない (完了は寝てるに畳む)。</p></div>
<div class="card pick"><p class="card-t">Q5 スコープ = A 観測契約も直す</p><p><span class="chip ok">確定</span> 着手前の実測 (P14〜P17) で、hook 由来の input が放置でも立ち答えても消えないと分かった。pet だけ直しても裏の「呼んでる」が常時点灯するので、hook 転送と backend の解除を同時に直す (8 章)。退けた案 = pet だけ (裏の AskUserQuestion は未解決のまま) / 一旦止める。</p></div>
</div>

---

## 8. 観測契約側の修正 (D9・レーン 1)

hook の event と attention の対応を次のとおりにする。正本は実装後に `docs/adr/0012-hook-attention-semantics.md`。

| hook の event | 今 | 修正後 |
|---|---|---|
| Notification (`permission_prompt` / `elicitation_dialog` / `elicitation_url_dialog` / `agent_needs_input`) | input | input (変更なし) |
| Notification (`idle_prompt` / `auth_success` / `elicitation_*` の完了系 / `agent_completed` / `quota_*`) | input | 送らない (転送スクリプトで落とす) |
| PermissionRequest | input | input (変更なし) |
| PreToolUse (`AskUserQuestion`) | 届かない | input (settings に登録を足す) |
| PostToolUse (`AskUserQuestion`) | 届かない | none (答えた) |
| UserPromptSubmit (turn_active) | 何もしない | none (Hook の none は source を問わず消す) |
| Stop (turn_ended) | 何もしない | done (ターンごとに新しい attention_id) |
| SessionEnd / process_exited / cancelled | 何もしない | none |
| failed / rate_limited | 何もしない | 据え置き (今回は触らない) |

影響: サイドバーのキャラだけでなく、未読リング (T5)、ダッシュボードの「返答待ち」「完了」、`Ctrl+Alt+A` の順送りが同じ attention を読むので、全部が正しくなる。Claude にも「完了 (未読)」が付くようになる。

---

## 9. 実装の台帳

| レーン | 担当 | spec | 状態 |
|---|---|---|---|
| 1 backend | Codex `gpt-6-astra` xhigh | `~/.claude/dispatch/260910-pet-backend/spec.md` | 13:35 着手 → 14:02 コミット `fae2ac32` (8 ファイル・Rust 1,219 PASS・pytest 41 PASS) → 母艦受理 |
| 2 frontend | Codex `gpt-6-astra` high | `~/.claude/dispatch/260910-pet-frontend/spec.md` | 13:35 着手 → 13:46 コミット `a0e847ac` (11 ファイル・vitest 4,213 PASS・tsc 0) → 母艦受理 (pytest の失敗は WSL bash スタブと oracmux の drift = 環境要因・母艦環境で 93 PASS) |
| 監査 | Codex `gpt-6-astra` xhigh (read-only) | `~/.claude/dispatch/260910-pet-audit/spec.md` | 14:11 着手 → 14:24 FINDINGS (Blocker 0 / High 3 / Medium 3 / Low 1) → 10 章の裁定 |
| 3 修正便 | Codex `gpt-6-astra` xhigh | `~/.claude/dispatch/260910-pet-fix/spec.md` | 14:32 着手 → 14:49 コミット `78bd2890` (10 ファイル・pytest 56 PASS・vitest 4,235 PASS・tsc 0)。Rust スイートは RAM ゲート待ちで母艦がデタッチ実行 |

受け入れは母艦が独立検証 (テスト実行・diff・実機 S1〜S9) してから。feed への配信は別の GO。

## 10. 監査の裁定と修正便 (2026-09-10 14:30)

読み取り専用の Codex 監査 (`~/.claude/dispatch/260910-pet-audit/FINDINGS.md`・Blocker 0 / High 3 / Medium 3 / Low 1) を母艦が裁定した。

| ID | 重大度 | 内容 | 裁定 |
|---|---|---|---|
| F-1-04 | High | 承認プロンプト (PermissionRequest) に答えても、裏タブの `input` は Stop まで残る | **直す**: 承認が要るツール (Bash / PowerShell / Edit / Write / MultiEdit / NotebookEdit / WebFetch / WebSearch / Agent / Skill) の PreToolUse を `turn_active` として届ける。呼び出しごとに python 起動 0.1 秒の代償は宮崎さんが受け入れた (Q6) |
| F-5-01 | High | 別の Stop hook が停止を差し止めて作業が続くと、Done が作業表示を隠す | **直す**: 観測中タブはスピナー (`workingPatternVisible`) を Done より優先。裏タブは F-1-04 の PreToolUse で解除される |
| F-1-03 | Medium | Codex の rollout Done と hook の Done が別 ID で、既読が未読に戻る | **直す**: Done 中に届いた Done は同じ attention として扱う (ID を保持して source を足す) |
| 実測 | – | ターン開始直後、出力が出るまでの数秒が寝てるになる (テスト機 S5) | **直す**: hook で解除された直後 (`state_since` 15 秒以内・activity が idle でない) は走ってる |
| F-1-01 | High | 別ターンの遅れた `turn_active` が未回答の待機を消し得る | 受け入れ (ADR に記録)。hook は同期送信で再送も無く、遅延経路が実運用に無い |
| F-1-02 | Medium | PostToolUse が PreToolUse より先に届くと質問が再度 input になる | 受け入れ。Claude Code の hook は逐次同期で、この順序は起きない |
| F-2-01 | Medium | resume 中に mapping 書込が失敗すると正当な終了を捨てる | 受け入れ (複合障害)。ADR に記録 |
| F-4-01 | Low | pytest の fixture が実 settings の形を写していない | 受け入れ。次の契約テスト整備で扱う |

修正便 = `~/.claude/dispatch/260910-pet-fix/spec.md` (Codex Astra xhigh・14:3x 着手)。

### テスト機での実測 (profile `pet`・exe 14:16 ビルド・CDP で行番号を読む)

| # | 手順 | 結果 |
|---|---|---|
| S3 | 空のテスト機に 3 ワークスペースを作る | 3 つとも行 0・周期 6600ms (寝てる) |
| S2 / S6 | 裏のワークスペースに Claude を立てて sleep を実行させる | 行 7 (走ってる) → Stop で行 8 (見て見て)。Claude が sleep を裏実行にしたため走ってるは約 20 秒 |
| S8 (旧転送) | ターン終了から 62 秒後 | 本番の旧転送スクリプト経由で idle_prompt が `input` になり行 6 が点灯 = 新転送で消える対象そのもの (テスト機は hook の登録と転送スクリプトを更新しないため、S8 の実機確認は本番更新後) |
| S5 | 外から指示を送る | `turn_active` で `input` が解除 → 行 7 → 行 8。出力が出るまでの 2〜5 秒だけ行 0 (修正便で対処) |
| S1 (観測中) | 表示中タブで AskUserQuestion | 画面スキャンで行 6 → 回答後に行 8 |
| S1 (裏)・S9 | 裏タブの AskUserQuestion / 承認 | テスト機では hook の登録が本番のままなので未確認。本番更新後に確認する |
