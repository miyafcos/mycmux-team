# ランチャー再設計 要件定義 (2026-09-03)

読者 = この実装を担当するエージェント / 語り手 = mycmux 開発者 (弊社) / 相手 = 宮崎さん (唯一の利用者) / その先 = 公開ミラー `miyafcos/mycmux-team` の閲覧者。

モック (実寸・動作する): `docs/plans/mockups/2026-09-03-launcher-redesign-mock.html`

> **改訂 (2026-09-03 第2版)** — 初版は既存の `CrsmPalette` (<kbd>Ctrl+P</kbd> = Open Resume) を見落とし、resume 一覧の走査を新規実装する前提で書いていた。宮崎さんの「今ある resume 機能とかぶる」という指摘で判明。D2 のデータ取得を既存 API へ、D3 の <kbd>Ctrl+K</kbd> オーバーレイを取り下げ、D4 を案Y (検索駆動) ベースへ改めた。
>
> **改訂 (2026-09-03 第3版)** — アイコン対応を調べる過程で、**カタログ正本 `src/lib/agentCatalog.ts` (216行) と env 組み立て `buildLaunchSpecEnv()`、model/effort 選択 UI `AgentSelector.tsx` が既に存在する**ことが判明した (T9〜T11)。第2版の Phase 1 (カタログ正本の新設) は**丸ごと不要**。残る実装は「既存パーツを 240px の縦長に並べる React コンポーネント1本 + アイコン2件」まで縮む。§4・§5・§6・§10 を書き換えた。

**この文書の教訓**: 同じ見落としを3回した (CrsmPalette → AgentIcons → agentCatalog)。**新しく作ると書く前に、その名前で `src/lib/` と `src/components/` を必ず grep すること。**

---

## 1. 背景

宮崎さんの指摘 (2026-09-03):

> ランチャーの設計が前時代すぎるような気がしています。マウス操作だけでは完結できず、文字面を追って理解しないといけないので微妙な気がしています。(中略) 縦長表記でデザイン的にもわかりやすくて、マウス操作でも完結するようなデザインが望ましい。

### 1.1 実測した構造的な問題

| # | 事実 | 出典 |
|---|---|---|
| P1 | ランチャーは PTY 内で動く bash の ANSI 描画。マウス報告がこの端末チェーンに届かない | `src-tauri/src/launcher.sh` / 診断用 `~/.mycmux/bin/mouse-probe.sh` が残置されている |
| P2 | 19項目がフラットな一列。グルーピングなし | `launcher.sh:1554-1574` の `options` 配列 |
| P3 | スクロールがない。`draw_menu` は全項目を無条件に echo するので、ペインが短いと上端が流れる | `launcher.sh:1619-1634` |
| P4 | 番号選択が2桁対応のため「1 を押したら 0.15 秒待って第2キーを見る」判定を持つ | `launcher.sh:1697-1710` |
| P5 | bash と PowerShell の2本を契約テストで同期させる二重管理 | `launcher.sh` 1,802行 / `launcher.ps1` 1,145行 / `tests/test_launcher_catalog_contract.py` |
| P6 | 起動候補は3階層に分かれている (19項目 → ディレクトリ種別 → 28/21件)。resume だけ CLI 側の別 TUI へ丸投げ | `__launch_dir_menu` / `commands` の `--resume` |

### 1.2 実測した規模

| 対象 | 件数 | 取得元 |
|---|---|---|
| エージェント起動項目 | 19 | `launcher.sh` の `options` |
| 開発ディレクトリ | 28 | `~/.mycmux/launch-roots.txt` |
| 案件ディレクトリ | 21 (`update_launch_anken.py` が自動更新・`●MM/DD` 付き) | 同上 |
| ディレクトリ MRU | 8 | `~/.mycmux/launch-dirs-mru.txt` |
| Claude セッション | **14,048 本** / 51 プロジェクト | `~/.claude/projects/**/*.jsonl` |
| Codex rollout | **4,570 本** | `~/.codex/sessions/**/rollout-*.jsonl` |
| ワークスペース | 3 (ペイン計 11・タブ計 18) | `%APPDATA%/com.miyazaki.mycmux/data.json` |

### 1.3 実測したペイン幅 — 設計上の最重要制約

「モモスタ」ワークスペースは `split_columns = [[7],[3],[2],[4],[5],[6],[0],[1]]`、`column_widths` が全て `1.0` の **横8分割・均等幅**。

- 1920px ディスプレイ → **1ペイン = 240px**
- 2560px ディスプレイ → 1ペイン = 320px
- 高さは画面いっぱい (概ね 950〜1000px)

**アスペクト比 1:4 の極端な縦長**。Chrome 拡張 `google-drive-link-search` の popup (330px) より狭い。等幅フォントで約30桁しかなく、現行メニューの `claude-codex (Codex Models)` は27文字でギリギリ、案件名 `駿台/モモスタ/数学 (●09/03)` は溢れる。

### 1.4 既にある土台

| # | 事実 | 出典 |
|---|---|---|
| T1 | ペイン種別は既に4種 (`terminal` / `browser` / `online` / `web`)。React で描く面がある | `src/types/workspace.ts:42` |
| T2 | `MYCMUX_LAUNCH_TARGET` = 「メニューを出さずに直接起動する」env 経路が既に動いている | `launcher.sh:1063-1100` |
| T3 | PTY 側からフロントへ「このタブを別種別に差し替えろ」と指示する経路が既にある (Web タブ化) | `__open_web_tab_from_pseudo_command` |
| T4 | resume 時に session_id から jsonl を引き、`cwd` を復元して cd する処理が既にある | `__prepare_claude_resume` (`launcher.sh:255`) |
| **T5** | **セッション検索オーバーレイが既に実装済み** — Fuse.js のファジー検索、kind フィルタ、cwd チップ、最大10,000件の仮想スクロール | `src/components/CommandPalette/CrsmPalette.tsx` / <kbd>Ctrl+P</kbd> = `crsm.palette` "Open Resume" (`src/lib/keybindings.ts:51`) |
| **T6** | **セッション一覧 API が既にラベルを返す** — `CrsmSessionEntry` は `label` / `preview` / `last_activity` / `cwd` / `files_modified` / `incomplete_tasks` / `has_user_messages` を持つ | `src-tauri/src/commands/crsm.rs:171` (`crsm_list_sessions`) / `src/lib/ipc.ts:824` |
| **T7** | **各社の公式マークが既に SVG で入っている** — `ClaudeAgentIcon` / `CodexAgentIcon` / `GrokAgentIcon` / `AntigravityAgentIcon`、および Claude と Codex を重ねた `HybridAgentIcon` (= claude-codex)。`AgentKindIcon({ kind, size, chip })` がチップ描画まで担う | `src/components/icons/AgentIcons.tsx` (143行) |
| **T8** | Web プリセットは Rust 側に5件定義済み (`chatgpt` / `gemini` / `grok` / `claude` / `notebooklm`)。ただし `WebPanePreset` は `id` / `label` / `url` / `profileDir` のみで**アイコンを持たない** | `src-tauri/src/commands/webpane.rs:60-110` / `src/components/workspace/webPaneApi.ts:3` |
| **T9** | **カタログ正本が既にある** — `AGENT_CATALOG` は 11 エントリ (agent 6 + web 5)。各行が `target` (= `MYCMUX_LAUNCH_TARGET`) / `label` (ランチャーのメニュー行と同一) / `kind` / `cli` / `agentKind` / `models` / `efforts` を持つ。**model・effort の全選択肢もここにある** | `src/lib/agentCatalog.ts` (216行) |
| **T10** | **起動 env の組み立ても実装済み** — `buildLaunchSpecEnv({target, model, effort})` が `MYCMUX_LAUNCH_TARGET` / `_MODEL` / `_EFFORT` を返す。`sanitizeLaunchSpecValue` がフラグ注入 (`--model -x`) を弾く | `src/lib/agentCatalog.ts` の末尾 |
| **T11** | **model / effort を選ぶ UI も実装済み** — New Workspace ダイアログがカタログを読んで描いている | `src/components/setup/AgentSelector.tsx` (128行) |

---

## 2. 決定事項

宮崎さんとの設計対話 (2026-09-03) で確定。

- **D1. React ペインに置き換える。** タブ種別に `launcher` を追加し、WorkspaceView が React コンポーネントを描く。TUI メニューの描画・キー処理は使わなくなる。
- **D2. カタログの範囲は「起動 + 続きから」。** ただし resume 候補は **既存の `crsm_list_sessions` を呼ぶ** (T6)。走査もラベル生成も作り直さない。
- **D3. ペイン内埋め込みのみ。** 新規ペイン・新規タブを開いたときにその場に出る (画面遷移を増やさない)。**当初案の <kbd>Ctrl+K</kbd> オーバーレイは取り下げる** — <kbd>Ctrl+P</kbd> の Open Resume (T5) と機能が重複するため。§7 に将来案を記録。
- **D4. 既定表示は指定順の5セクション、打つと横断1本になる (案Y)。** 何も打っていない状態では **新規に起動 → Web → 開発 → 案件 → 続きから** の順にセクションが並び、マウスだけで完結できる。検索語が入った瞬間にセクションの壁が消え、全カタログを横断した1本のリストになる。
- **D5. 起動処理は `launcher.sh` に残す。** React は「何を起動するか」を決めるだけで、session ID 採番・pane マッピング・cwd 復元・env 前処理は既存 bash に委ねる (T2 の経路)。責務の移管をしないぶん移行リスクが小さい。

### 2.1 並び順の根拠 (D4)

| 順 | セクション | 理由 |
|---|---|---|
| 1 | 新規に起動 | 新規ペインを開く動機の大半。最上段に置いて指を止めない |
| 2 | Web | 起動の一種なので直下 |
| 3 | 開発 (28件) | 起動先を変えてから起動する流れ |
| 4 | 案件 (21件) | 同上 |
| 5 | 続きから | <kbd>Ctrl+P</kbd> と役割が重なるので最下段。直近数件のショートカットに留める |

### 2.2 非目標

- 起動画面を1つに集約しない (宮崎さんが「起動のたびに1画面通すのは微妙」と明示)
- <kbd>Ctrl+K</kbd> オーバーレイを作らない (D3)
- 既に開いているタブ・ワークスペースへの**移動**は載せない。「起動」と「移動」を1つの検索窓に混ぜない
- TUI ランチャーの即時撤去はしない (§8)

---

## 3. 画面仕様

**幅 240px を最悪ケースとして設計する。** 320px では余白と行間だけが広がる。

- **S1.** 1列リストを基本にする。2列カードグリッドは 1列 120px となり、日本語 11px 下限 (`uiQualityTokens.test.ts`) と両立しない。
- **S2.** 検索欄は最上部に固定し、ペインを開いた時点でフォーカスを持つ。打てば絞れる・打たなくても選べる。
- **S3.** 検索語が空のときは §2.1 の順で5セクションを出す。セクション見出しは 11px / `--cmux-text-tertiary`、右端に件数つきの「すべて」を置き、上位N件を超える分はそこから展開する。
- **S4.** **検索語が入ったらセクションの壁を消し、横断1本のリストにする。** 起動先 (新規に起動・Web) だけはチップの見た目を保ち、リストの先頭に置く。
- **S5.** 行は `[識別色ドット 8px] [主ラベル 12px] [副ラベル 11px] [右端の時刻 11px モノスペース]`。時刻・状態は右端で桁を揃え、目で追わずに済むようにする。
- **S6.** ラベルが溢れるときは末尾省略ではなく**中間省略**にする。`駿台/モモスタ/数学` は末尾が識別子であり、末尾を削ると区別できなくなる。
- **S7. 新規に起動・Web の各項目には、左に公式マークを置く** (2026-09-03 宮崎さん指示「わかりやすいので」)。**既存の `AgentKindIcon` (T7) を呼ぶ**。新しくアイコンを起こさない。

  | 項目 | アイコン | 状態 |
  |---|---|---|
  | Claude Code | `ClaudeAgentIcon` | 既存 |
  | Codex | `CodexAgentIcon` | 既存 |
  | claude-codex (Codex Models / Open Models) | `HybridAgentIcon` | 既存 — Claude と Codex の重ね。**自作ツールなのでこの合成が正しい** |
  | Grok Build | `GrokAgentIcon` | 既存 |
  | Antigravity (agy) | `AntigravityAgentIcon` | 既存 |
  | ChatGPT (Web) | `CodexAgentIcon` | 流用 (同じ OpenAI マーク) |
  | Grok (Web) | `GrokAgentIcon` | 流用 |
  | Claude.ai (Web) | `ClaudeAgentIcon` | 流用 |
  | **Gemini (Web)** | — | **新規に用意する** |
  | **NotebookLM (Web)** | — | **新規に用意する** |

  `AntigravityAgentIcon` は Antigravity 独自の意匠なので、**Web の Gemini に流用しない**。新規2件は `AgentIcons.tsx` に同じ書き方 (viewBox 24、`useId` でグラデーション ID を衝突回避) で足す。

- **S8.** 色には2系統ある。**ロゴ内の色は公式値** (`ClaudeAgentIcon` の `#d97757` 等) をそのまま使い、**行のテキスト・ドット・チップ背景は既存 `KIND_COLORS`** (`src/lib/agentKindColors.ts` — claude `#f0a878` / codex `#8ab8e8` / claude-codex `#7dcc97` / grok `#f38ba8` / antigravity `#4285f4`) に揃える。新しい色を作らない。トークンを足す場合は `global.css` に定義してから使う (`tokenContract.test.ts` が未定義 `var(--cmux-*)` を弾く)。

- **S9.** 新規起動・Web はピル型チップの横並びにする (行より密度が高く、240px で2〜3個入る)。

- **S10. カタログ正本の項目名と、チップの表示名を分けて持つ。** アイコンが識別を担うぶん文字は削れる。240px では長い項目名が入らない。

  | 正本の項目名 | チップ表示 |
  |---|---|
  | `claude-codex (Codex Models)` | claude-codex |
  | `claude-codex (Open Models)` | cc (Open) |
  | `Antigravity (agy)` | agy |
  | `Grok Build` | Grok |

  検索は**正本の項目名に対して**当てる (`cc (Open)` と表示していても `Open Models` で引ける)。ホバー時のツールチップには正本名を出す。
- **S11.** フッタに現在の cwd を 1 行で常時表示し、そこから変更もできる。
- **S12.** キーボードだけでも完結する。上下移動・Enter・Esc は現行と同じ意味を保つ。

---

## 4. データソース

- **DS1. 起動先カタログ** — **既存の `AGENT_CATALOG` (T9) をそのまま読む。新しい正本を作らない。**

  `AGENT_CATALOG.filter(e => e.kind === "agent")` = `LAUNCHABLE_AGENTS` が「新規に起動」の6件、`kind === "web"` が「Web」の5件。並びもカタログの定義順でよい。

  | # | `target` | `label` (正本の項目名) |
  |---|---|---|
  | 1 | `claude` | Claude Code |
  | 2 | `codex` | Codex |
  | 3 | `claude-codex` | claude-codex (Codex Models) |
  | 4 | `claude-codex-open` | **claude-codex (Open Models)** |
  | 5 | `grok` | Grok Build |
  | 6 | `agy` | Antigravity (agy) |
  | 7-11 | `web-chatgpt` / `web-gemini` / `web-grok` / `web-claude` / `web-notebooklm` | ChatGPT (Web) 他 |

  **claude-codex は2種とも出す** (2026-09-03 宮崎さん指示)。カタログには両方あるので、フィルタで落とさないこと。

  現行19項目のうち resume 4件は「続きから」に吸収し、`Custom...` は検索欄の導線 (§6.1) に、`Change directory` 3件は開発・案件セクションになる。この3群はカタログに載っていない (`LAUNCHER_ONLY_TARGETS` として契約テストが除外している) ので、ランチャー側で足す。
- **DS2. ディレクトリ** — `~/.mycmux/launch-roots.txt` (`案件:` 接頭辞で dev/anken を分ける現行フォーマットを踏襲)、`~/.mycmux/launch-dirs-mru.txt`。案件側は `update_launch_anken.py` がバックグラウンド更新する現行動作を維持。
- **DS3. 続きから** — **既存の `crsmListSessions` (`src/lib/ipc.ts:824`) を呼ぶ。** 走査・ラベル生成・`has_user_messages` による除外は既に実装済み (T6)。ランチャー側は上位N件だけを表示し、「すべて」は <kbd>Ctrl+P</kbd> の Open Resume を開く。
  - `CrsmPalette` は初回 1,000件 / 深掘り 10,000件で取っている (`SESSION_FETCH_LIMIT_INITIAL` / `_DEEP`)。ランチャーは**さらに小さい上限**で呼び、初回描画をブロックしないこと。
  - `preloadCrsmSessions` (`AppShell.tsx:33` で import 済み) が既にプリロードを持つ。ランチャーはこのキャッシュに相乗りできるか確認する。
- **DS4. 除外** — `has_user_messages` が false のセッションは出さない。メタ情報のみの jsonl (`type: last-prompt` / `mode` / `permission-mode` だけの行) が実在する。

> 参考: 初版は `~/.claude/projects/**/*.jsonl` を自前で mtime 走査する設計だった (実測 14,048本で 0.70秒、上位60本の中身読みで 0.12秒)。既存 API があるため**採用しない**。この数字は将来 crsm 側の性能を評価するときの目安としてのみ残す。

---

## 5. 起動経路

```
React ランチャー
   │ 「これを起動する」だけを決める
   ▼
MYCMUX_LAUNCH_TARGET=<target> [+ model/effort/cwd/session_id]
   │ 既存の env 経路 (launcher.sh:1063)
   ▼
launcher.sh  ← メニューを出さずに直行
   │ session ID 採番 / pane マッピング書き込み / cwd 復元 /
   │ fugu env / trust cwd / hook cap / Web タブ置換
   ▼
実プロセス (claude / codex / grok / agy) または Web タブ
```

- **L1. env の組み立ては `buildLaunchSpecEnv()` を呼ぶ (T10)。自前で文字列を作らない。** `sanitizeLaunchSpecValue` のフラグ注入対策 (`--model -x` を弾く正規表現) を迂回しないこと。session ID 採番も React 側に持ち込まない。
- **L2.** resume は session_id を渡し、`__prepare_claude_resume` に cwd 復元まで任せる (T4)。
- **L3.** Web タブは `buildLaunchSpecEnv` が `kind !== "agent"` を弾くので、そのままでは通らない。既存の Web タブ生成経路 (`webPaneApi` / `__open_web_tab_from_pseudo_command`) を使う。
- **L4.** model / effort の選択肢は `AGENT_CATALOG` の各エントリが持っている (T9)。`AgentSelector.tsx` (T11) が同じデータで UI を描いているので、**実装前に読んで流用できる部分を決める**。

---

## 6. 現行機能の移植表 (全数・退行防止)

`launcher.sh` の 49 関数を分類した。**「React へ移す」列の機能を落とすと退行になる。**

### 6.1 React へ移す (UI・13件)

| 関数 | 現行の役割 | React での扱い |
|---|---|---|
| `draw_menu` | メインメニュー描画 | カタログ表示 (§3) |
| `__open_menu_fd` / `__read_menu_event` | メニュー用 FD とキー入力 | 不要 (DOM イベント) |
| `__mycmux_read_key_with_timeout` | 2桁数字判定の 0.15 秒待ち | **不要にする** (P4 の解消) |
| `__mycmux_lower_ascii_into` | bash 4 未満向け小文字化 | 不要 |
| `__pick_list` / `__read_pick_event` | 絞り込み付き選択リスト | 検索欄に統合 |
| `__prompt_custom_command` | 任意コマンド入力 | **「Custom...」を残す** — 検索欄に打った文字列をそのままコマンドとして実行する導線 |
| `__spec_menu` / `__launch_spec_menu` | model / effort 選択 | **必須移植** (§6.3) |
| `__select_launch_root` / `__browse_launch_dirs` / `__launch_dir_menu` | ディレクトリ選択 3 経路 | 開発・案件セクション + フォルダを辿る導線 |

### 6.2 `launcher.sh` に残す (起動処理・30件)

session 採番 `__make_uuid` / `__stable_new_session_id` / `__claude_needs_new_session_id` / `__grok_new_session_id` / `__grok_needs_new_session_id` / `__grok_session_id_taken` / `__write_session_mapping`、resume 解決 `__prepare_claude_resume` / `__find_claude_session_file` / `__claude_session_cwd` / `__claude_project_key` / `__get_claude_project_dir` / `__get_claude_codex_project_dir`、セッション追跡 `__single_unclaimed_session_since` / `__poll_single_unclaimed_session` / `__track_latest_jsonl_in_dir` / `__track_claude_session` / `__track_claude_codex_session` / `__track_codex_session` / `__track_command_session`、env 前処理 `__ensure_fugu_env` / `__trust_claude_cwd` / `__mycmux_issue_hook_cap` / `__mycmux_with_hook_cap` / `__mycmux_is_windows_shell`、Web `__open_web_tab` / `__open_web_tab_from_pseudo_command`、spec 受け口 `__launch_spec_value` / `__read_launch_spec_from_env` / `__add_launch_spec_to_cmd`。

### 6.3 model / effort 選択 — 落としてはいけない

`~/.claude/rules/delegation.md` のティア配分 (Sol / Terra / Luna の使い分け、effort の指定) が**この UI に依存している**。ランチャーから model と effort を選べなくなったら退行。

**ただしデータは既に `AGENT_CATALOG` にある (T9)。** bash の `__spec_models_for` / `__spec_efforts_for` を読み写す必要はなく、カタログの `models` / `efforts` を描けばよい。参考値:

| target | `models` | `efforts` |
|---|---|---|
| `claude` | Fable (flagship) / Opus / Sonnet / Haiku | low / medium / high / xhigh / max |
| `codex` | Sol `gpt-5.6-sol` / Terra `gpt-5.6-terra` / Luna `gpt-5.6-luna` | **none** / low / medium / high / xhigh / max |
| `claude-codex` | 同上 (`CODEX_MODELS`) | low / medium / high / xhigh / max |
| `agy` | Gemini 3.1 Pro (High/Low) / 3.8 Flash (High/Medium/Low) / Claude Opus 4.6 (Thinking) / Claude Sonnet 4.6 (Thinking) | low / medium / high |
| `grok` / `claude-codex-open` | `NO_CHOICES` (モデル ID 非公開・アカウント依存) → 自由入力 | low / medium / high |

先頭は必ず `(default)` = フラグを付けない、という現行仕様を維持する (`buildLaunchSpecEnv` は model/effort が未指定なら env に載せない)。

### 6.4 データ管理 (React が読む / bash も使う)

`__load_roots_section` / `__record_dir_mru` / `__refresh_anken_roots_bg` / `__norm_path` / `__norm_path_into` / `__short_path` / `__short_path_into`。MRU の記録は React 側の起動時にも行う (どちらの経路でも MRU が育つこと)。

---

## 7. 既存 <kbd>Ctrl+P</kbd> (Open Resume) との関係

- `CrsmPalette` (T5) は既に「セッションをファジー検索して開き直す」機能を持つ。**ランチャーはこれを置き換えない。**
- ランチャーの「続きから」は**直近数件のショートカット**に留め、「すべて」で Open Resume を開く。同じ API (T6) を見るので表示が食い違わない。
- **将来案 (2026-09-03 宮崎さん着想・今回は保留)**: Open Resume 側に「新規に起動」を足せば、1つのパレットで再開と新規起動の両方が済む。実装するなら、ランチャー側の「続きから」との重複をどう扱うかを先に決めること。

---

## 8. 既存 TUI の扱い

- **当面は残置する。** `launcher.sh` は `.bashrc` から source され、mycmux 外の Git Bash でも動く。起動処理 (§6.2) は残すので、ファイル自体は消えない。
- メニュー部分 (§6.1) は死蔵になるが、**React ランチャーの実運用が安定するまで削除しない**。
- `launcher.ps1` も同様。**PowerShell 側だけ実装済みの差分** (`NO_COLOR` 7件 vs `launcher.sh` 0件 — `docs/agent-integration.md:94`) があるので、撤去時は差分を確認する。
- 撤去判断は React ランチャー配信の 1 ヶ月後に、使用実績を見て別途行う。

---

## 9. 契約テストへの影響

| テスト | 影響 | 対応 |
|---|---|---|
| `tests/test_launcher_catalog_contract.py` | **既に `agentCatalog.ts` ↔ bash ↔ ps1 の3者を検査している** (`LAUNCHER_ONLY_TARGETS` / `TARGET_ALIASES` つき)。ランチャーは同じカタログを読むので**追加の縛りは要らない** | 触らない。カタログに行を足すときだけ既存テストが効く |
| `tests/perf/test_week1_day1_behavior_contracts.py` | launcher のメニュー配列と順序を固定 | bash / ps1 を触らないので影響なし |
| `tests/unit/tokenContract.test.ts` | 未定義 `var(--cmux-*)` を禁止 | `--cmux-agent-*` を `global.css` に定義してから使う |
| `tests/unit/uiQualityTokens.test.ts` | 日本語 9px 禁止 (11px 下限) | §3 S1 で担保 |
| `tests/unit/themeContrast.test.ts` | WCAG 床 | 識別色 (S7) をライト/ダーク両方で検証 |
| `tests/unit/uiDensity.test.ts` | standard = 現行同値固定 | 新規コンポーネントなので既存値は動かさない |
| data.json schema guard (`docs/plans/2026-08-26-datajson-schema-guard.md`) | タブ種別に `launcher` を追加する | schema 側を更新し、旧版で開いたときの後方互換を確認 |
| `tests/test_ephemeral_env_keys_contract.py` | `MYCMUX_LAUNCH_TARGET` は既存の ephemeral キー | 新規キーを足す場合は必ずこの契約に登録する |

---

## 10. 段階

> 第2版にあった Phase 1 (カタログ正本の新設) は **T9 の発見により消滅**。正本も契約テストも既にあるので、作るものは実質 React コンポーネント1本とアイコン2件しかない。

- **Phase 1 — アイコン2件。** `AgentIcons.tsx` に Gemini と NotebookLM を足し、`AgentKindIcon` から引けるようにする (S7・U4)。既存5つと同じ書き方 (viewBox 24 / `useId` でグラデーション ID を衝突回避)。**この段階では誰も呼ばないので挙動は不変**、`themeContrast` / `tokenContract` だけ通ればよい。
- **Phase 2 — React ランチャー本体。** タブ種別 `launcher` を追加し、`WorkspaceView` が描く。§2.1 の5セクションのうち「新規に起動 / Web / 開発 / 案件」の4つ。
  - カタログは `AGENT_CATALOG` (T9)、env は `buildLaunchSpecEnv` (T10)、アイコンは `AgentKindIcon` (T7)、model/effort は `AgentSelector.tsx` (T11) を読んでから実装する。**新規に書くのは 240px のレイアウトと検索だけ。**
  - 開発・案件は `~/.mycmux/launch-roots.txt` (DS2) を読む。既存の読み取り実装が Rust / TS 側にあるか先に確認すること。
- **Phase 3 — 「続きから」。** `crsmListSessions` (T6) を小さい上限で呼び、非同期で差し込む。`preloadCrsmSessions` のキャッシュに相乗りできるか確認する。
- **Phase 4** — 実機で 1 週間運用し、宮崎さんの GO を取ってから TUI 撤去を判断 (§8)。

各 Phase は `npx tsc --noEmit` / `npx vitest run` / `python scripts/run_windows_tests.py` / `python -m pytest tests/` の全通過を完了条件とする。

### 10.1 着手前の必須手順 (3回の見落としを踏まえた規律)

**「新しく作る」と書いたものは、実装前に必ず既存を探すこと。** この文書自体が3回それに失敗している。

```bash
grep -ril "<作ろうとしているものの名前>" src/lib/ src/components/ src-tauri/src/
ls src/components/**/ && grep -n "defaultShortcut" src/lib/keybindings.ts
```

見つかったら、作らずに呼ぶ。仕様との差分だけを実装する。

---

## 11. 未決事項

- **U1.** 「すべて」を押したときの挙動。開発・案件はその場で伸ばす / 続きからは <kbd>Ctrl+P</kbd> を開く、で分ける案があるが、240px での見え方を実機で判断する。
- **U2.** 検索のマッチ規則。`CrsmPalette` は Fuse.js のファジー検索を使っている。ランチャーも同じにするか (「モモスタ」を `momo` で引けるか) を揃えて決める。**バラバラだと同じ語で結果が違って混乱する**ので、どちらかに統一する。
- **U3.** ライトテーマでの見え方。`GrokAgentIcon` と `CodexAgentIcon` は白プレート前提の意匠なので、ライトテーマで白背景に溶けないか実機で確認する。`themeContrast.test.ts` の WCAG 床も通す。
- **U4.** Gemini / NotebookLM の公式マーク (S7) をどこから持ってくるか。両者とも `AgentIcons.tsx` に無い。商標の扱いを含めて、SVG を自前で起こすか公式アセットを取るかを決める。
- **U5.** 新規ペインを開いたとき、ランチャーを出さず直前の起動を繰り返す導線 (「もう一度」) を置くかどうか。
- **U6.** 「New terminal tab」ボタンの文言 (`PaneTabBar.tsx:1460, 1574`)。押すと開くのはランチャーなので実態と合わないが、`tests/test_no_restart_ui_surface_contract.py:50` が `title="New terminal tab"` を検査しているため、変えるなら契約テストも同時に直す。Low なので Phase 2 では見送った。
- **U7. `browser` / `online` タブも PTY を持たない可能性が高い。** `tabHasPty` (`src/lib/tabLifecycle.ts`) は両者を意図的に true 側に残している — launcher の修正と同じ便で動かすと退行の切り分けができなくなるため。**別便で検証して、持たないなら述語に寄せる。** 現状は `killSession` / `removeWorkspaceScrollback` がこの2種にも呼ばれている。

---

## 12. Phase 2 実装後に見つかった欠陥と修正 (2026-09-03)

実装完了後、親セッションが独立監査を通して5件を検出した (監査タブは API 529 で報告を出せず、親が観点 A〜G を引き取って実施)。

**根本原因**: タブ種別の判定に `type === undefined || type === "terminal"` (ホワイトリスト) と `type !== "web"` (ブラックリスト) の2系統が混在していた。**新種別を足すとブラックリスト側が全部漏れる。** `web` を足したときは全箇所に手が入ったが、`launcher` はホワイトリスト側しか通っていなかった。

| ID | 欠陥 | 重大度 | 対応 |
|---|---|---|---|
| A-01 | launcher タブが socket API に `type: "terminal"` として報告される。委譲スクリプトの `send` が PTY 不在のまま成功に見える | High | 修正済 — `SocketListener.tsx` の型報告に `"launcher"` を追加、`ipc.ts` の `PaneTabConfig.type` を拡張 |
| A-02 | launcher タブが復元対象と判定される (`isRestorableTabConfig`) | Medium | 修正済 — `tabHasPty` に寄せ、重複していた二重判定も除去 |
| A-03 | `shouldShowPublishButton` が launcher を除外せず、公開ボタンが出る | Medium | 修正済 — `PaneTabBar.tsx:192` |
| A-04 | ペイン・ワークスペース削除時、存在しない PTY に `killSession` を呼ぶ | Low | 修正済 — `AppShell.tsx` 3箇所 + `WorkspaceView.tsx` 1箇所 |
| A-05 | 「New terminal tab」の文言が実態と合わない | Low | 見送り → U6 |
| A-06 | 「— 横断 N 件 (セクションなし) —」を **10px** で描いていた。日本語は 11px 下限 (`docs/design/typography-and-spacing.md:106`) | Medium | 修正済 — `var(--cmux-font-size-xs)` へ。**原因はモック側で、実装はそれを忠実に写しただけ**。モック (`.flat-note`) も同時に修正した |

`uiQualityTokens.test.ts` は 9px しか弾かないので、**日本語 10px はテストをすり抜ける**。モックを実装の手本として渡すときは、モック自身が規約を満たしているかを先に検査すること。

---

## 13. 実機フィードバック 1 回目 (2026-09-03 宮崎さん・テスト機 v0.62.0)

「だいぶ可愛いデザインになった」「待ち時間減ってめっちゃいい」「モデルが選べるのはいい」を前提に、修正点5件。

| ID | 指摘 | 原因 | 対応 |
|---|---|---|---|
| D-1 | チップの青枠と右の `⋯` が分かれて見える。**一囲みにしてほしい** | 枠線を2つのボタンそれぞれに描いていた。カーソル時に左だけ accent 色になり、右は idle のままで「隣接した別コントロール」に見えた | `chipShell` に枠を移し、内側の2ボタンは枠なしに。`⋯` 側の区切りは `borderLeft` 1本だけ |
| D-2 | `⋯` を押すと**横幅に広がりすぎて見づらい** | `<datalist>` のポップアップは WebView2 が描くため、ペイン幅を無視して選択肢の文字数ぶん横に伸びる | チップのリストに置換。240px 内で `flexWrap` して折り返す |
| D-3 | モデルを選ぶと**白背景に薄い文字**になる (色味の設計ミス) | 同上。ネイティブポップアップはブラウザ既定のライトパレットで出る。アプリのダークテーマと無関係に描かれる | 同上。`specChip` / `specChipOn` でトークンから色を取る |
| D-4 | 「その他 → ターミナル (従来のランチャー)」は**いらない** | Phase 3 までの橋渡しとして置いていた | セクションごと削除。`S.other` / `S.terminal` / `S.terminalTooltip` と未使用になった `addTabToPane` も除去 |
| D-5 | 開発・案件が**何も表示されない** | **テスト環境の仕様**。テストプロファイルの `runtime_dir()` は `~/.mycmux-<profile>/` を返すので `launch-roots.txt` が無い (`src-tauri/src/test_profile.rs:58`)。本番では表示される | 確認できるようテスト機の runtime dir へ台帳をコピー。コードは変更なし |

**D-6 (Gemini が開けない / NotebookLM がログインを求める) もテスト環境の仕様。** テスト機の WebView2 プロファイルは `EBWebView-<profile>` で新規のため、Google のログインを持っていない。本番は Google 系でプロファイルを共有する ([[project-web-pane-multi-service]])。

**教訓**: ネイティブの `<select>` / `<datalist>` は**幅もパレットもアプリ側から制御できない**。240px の縦長ペインでは使わない。既存の `AgentSelector.tsx` も同じ作りだが、あちらは幅のあるダイアログなので露見していなかった。

**再発防止**: `tabHasPty()` を `src/lib/tabLifecycle.ts` に新設し、`type !== "web"` の全箇所をそこへ寄せた。`tests/unit/tabLifecycle.test.ts` が「web と launcher は false / terminal と未設定は true / browser と online は true のまま」を固定するので、次に非 PTY 種別を足す人はこのテストで気づく。
