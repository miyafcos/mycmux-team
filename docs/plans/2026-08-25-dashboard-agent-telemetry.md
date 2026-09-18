# ダッシュボード計器情報 (Agent Telemetry) 設計ドラフト

- 日付: 2026-08-25
- 状態: **draft — 未承認・実装未着手**
- 背景: ダッシュボードの各セッション表示が、ターミナル側で見えている Claude Code statusline
  (モデル名・CTX%・コスト・sid) より情報量が少ない。加えてサブエージェント / ワークフローの
  中身がどこにも見えない。

## 1. 課題の実体

ダッシュボード行が出すのは「色棒 (種別) + ラベル + プレビュー1行 + 状態ピル + 経過分」のみ
(`src/components/dashboard/DashboardCardRow.tsx:59-107`)。列ヘッダ (`ChatColumn.tsx:110-155`) と
ミニマップチップ (`minimapModel.ts:8-46`) も同様で、モデル名・トークン・コスト・sid は一切出ない。

一方、情報源は既にリポジトリ内にほぼ揃っている:

| 情報 | 既存の在り処 |
|---|---|
| モデル名 / effort | ailog `parse_claude.rs:188-213` / `parse_codex.rs:270-290` |
| トークン (input/output/cache) | 同上 (`message.usage` / `token_count.total_token_usage`) |
| コスト (参考価格) | `ailog/price.rs::cost_for_turn` (+ `price_source` で「参考」明示) |
| サブエージェント名 | `parse_claude.rs:94-104` (`agent-name` → `agent_names`) |
| agentSessionId (sid) | `paneMetadataStore` / `pane-sessions/<pty>.txt` — **既に保持済み・未表示なだけ** |
| transcript の所在解決 | `livebrief/mod.rs:640` `locate_transcript(kind, session_id)` |

livebrief の adapter (`livebrief/adapter.rs`) は transcript 全レコードを decode 済みなのに
`usage` / `model` を読み捨てている。ここが最短の追加ポイント。

なお Claude Code の statusline は stdin JSON (`model.display_name` / `effort.level` /
`context_window.used_percentage` / `cost.total_cost_usd` / `rate_limits` / `session_id`) を
受けて描画しているだけであり、同じ情報は transcript から再構成できる。statusline への
依存 (sidecar 出力等) はユーザー環境の `~/.claude/settings.json` 設定に結合するため主経路にしない。

## 2. 要素の役割規定 (何を・なぜ出すか)

表示情報を 3 レイヤに規定する。レイヤごとに「答える問い」を固定し、出す場所を決める。

| レイヤ | 答える問い | 要素 | 主な出口 |
|---|---|---|---|
| A. Identity | 誰が・どこで動いているか | agent種別 / モデル名+effort / cwd / branch+dirty / sid (先頭8桁) | カード行・列ヘッダ |
| B. Consumption | どれだけ使ったか・あとどれだけ持つか | CTX% (バー) / コスト (≈$参考) / turn数 / compact回数 | カード行・列ヘッダ |
| C. Structure | 中で何が動いているか | サブエージェント一覧 (名前+状態) / ワークフロー phase | カード配下チップ・詳細面 |

**非対象 (明示的に出さない)**: アカウント単位の 5h/7d レート枠。既に AccountsButton /
UsageTab で可視 (`src/stores/usageStore.ts`) であり、セッション面に重複させない。

cwd / branch は既に OSC7 + `git_branch.rs` で取得済み。新規はレイヤ A のモデル名・sid 表示、
レイヤ B 全部、レイヤ C 全部。

## 3. 統一スキーマ — `AgentTelemetry`

ツール差を Rust 側で吸収し、フロントには正規化済みの 1 型だけを渡す。
`LiveSessionBrief` に載せる (ポーリング経路・binding・世代管理をそのまま流用)。

```
AgentTelemetry {
  model:    { name: string, effort?: string }          // 最新 turn の値
  context:  { pct?: number, tokens?: number }          // コンテキスト占有。算出不能なら省略
  cost:     { usd: number, source: "computed" }        // price.rs 由来の参考価格。UI は ≈ 前置
  turns:    { count: number, compacts: number }
  children: [{ name: string, kind: "subagent"|"workflow",
               state: "running"|"done"|"unknown", startedAt?: ts }]
}
```

- すべてのフィールドは optional 扱いで劣化許容 (statusline.mjs と同じ設計思想:
  「never crash, never print undefined」)。
- コストは flat プラン下の API 換算参考値。`price_source` を通し、UI は断定表現を避ける
  (ailog の既存方針と同一。`docs/design/ailog-series-colours.md` 系の parity を崩さない)。

## 4. ツール別取得経路

| ツール | 経路 (主) | 各値の取り方 |
|---|---|---|
| claude | transcript tail (livebrief 拡張) | model/effort/usage = `message.usage`・`message.model` (parse_claude と同ロジック)。CTX% = 直近 assistant turn の input+cache_read+cache_creation ÷ モデル窓サイズ (窓サイズ表は price.rs 側に併設)。children = `agent-name` レコード + 同 transcript dir の `agent-*.jsonl` 増分 |
| claude-codex | 同上 (`~/.claude-codex/config/projects`) | ルートは `ailog/mod.rs:62-80` の定義を共用 |
| codex | rollout tail (`codex_rollout.rs` 拡張) | model/effort = `turn_context`。CTX = `token_count.total_token_usage` (累積=占有そのもの)。窓サイズは config モデルから。children = v1 非対応 (Codex に構造化サブエージェント記録がない) |
| grok | `~/.grok/sessions` (v1 は最小: sid のみ) | 後続便 |
| (補助) 画面パース | `tabSweep.ts:152-160` の statusline 正規表現を流用 | mycmux 外で起動された素のタブ・transcript 未解決タブ向け。`XTermWrapper.tsx:1455-1462` で noise として捨てている行を専用 store へ流す。transcript 経路と競合したら transcript 優先 |

- 実装位置: `adapter.rs::decode_record` に `TurnStats` を追加 → `reducer.rs` で累積 →
  `LiveSessionBrief` に `telemetry: AgentTelemetry` を追加。**追加 I/O ゼロ** (既に読んでいる
  ファイルの捨てているフィールドを拾うだけ)。
- ailog DB との関係: ライブ値は livebrief (揮発)、履歴・累計・横断分析は従来どおり ailog。
  ダッシュボード詳細面から `ailog_session_detail(kind, sid)` へのリンクを張る程度に留め、
  ダッシュボードのために index 頻度は変えない (`useAilogAutoIndex` の 60s クールダウンは維持)。

## 5. 表示規格 (同一規格で見せる)

全ツール共通の「計器行」1 行をスロット順固定で定義する:

```
<モデル名> (effort) │ CTX ▓▓░░ 34% │ ≈$1.23 │ sid a1b2c3d4
```

- スロット順: model → CTX → cost → sid。欠けたスロットは詰める (空白プレースホルダを出さない)。
- 出口は 3 箇所 (survey どおり、ここに足せば全画面に効く):
  1. `DashboardCardRow.tsx:101-105` — 状態ピル行の下に計器行 (dim・小サイズ)
  2. `ChatColumn.tsx:121-131` — 列ヘッダ meta に計器行
  3. `minimapModel.ts` — チップは CTX% のみ (数字 1 個。それ以上は入れない)
- children はカード配下のチップ列 (`├ opus:review (running)` 風)。詳細展開は ChatColumn /
  詳細面のみ。ミニマップには出さない。
- 状態語彙の一本化 (`stateLabels.ts` / `dashboardStrings.ts`) は崩さない — 計器行は
  状態とは独立した「計器」であり、attention/activity 語彙に混ぜない。
- CTX ≥80% で警告マーク (statusline.mjs の `warn()` と同じ閾値 50/80)。compact 直後は
  CTX がリセットされるので `compacts` カウントを添えて説明可能にする。
- CardRow (幅 256px) はコンパクト表記 (CTX バー省略・スロット wrap 可) を正とする。
  完全 1 行表記は ChatColumn 以上の幅を持つ出口に適用する。(Fable 裁定 2026-08-25)

## 6. 実装フェーズ案 (承認後)

1. **便0 (即効・数行)**: sid 表示。`agentSessionId` は既に paneMetadataStore にある —
   カード行・列ヘッダに出すだけ。
2. **便1**: livebrief `TurnStats` (model / effort / CTX / cost / turns) + 計器行 UI 3 出口。
3. **便2**: children (claude 系サブエージェント / ワークフロー phase)。
4. **便3**: 画面パース補助経路 + codex CTX の窓サイズ精度上げ + grok。

各便で `npx tsc --noEmit` / `npx vitest run` / `run_windows_tests.py` / `pytest tests/` 全通過。
livebrief のフィールド追加は `tests/test_command_sync_contract.py` と telemetry 系 vitest の
契約に触らないか要確認。

## 7. 決定事項・未決事項

- [x] 取得経路の主軸 = **transcript 主 + 画面パース補助** (2026-08-25 宮崎さん確定)
- [x] コスト表示 = する (statusline 同等の情報量が要求の起点。≈ 前置の参考価格表記)
- [x] children の粒度 = カード配下チップ + 詳細面で展開 (「中身が見たい」要求に対応)
- [ ] Claude Code の CTX% 算出式の裏取り (statusline 実測値と transcript 再構成値の突合) — 便1 の受け入れ条件に含める
- [ ] AskUserQuestion 対応 (ab845bd / 3fb0b42) の実機動作確認 — 本件と独立に未完了
