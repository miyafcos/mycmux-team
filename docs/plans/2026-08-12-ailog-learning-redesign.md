# ailog 学び強化リデザイン計画 (2026-08-12)

## 背景 (宮崎さん FB 2026-08-12)

- 読み込みが遅い
- 見た目はそれっぽいが「学びがない」— 非エンジニアが毎日見て、自分の使い方を分析して成長・発見がある形になっていない

## 診断 (コード実査 2026-08-12)

「学びがない」は感覚でなく実装の穴。学びを生む部品が 3 つとも未接続・未実装。

1. **F3 要約が簡易版止まり**: spec (`spec_ailog_f3_summary.md`, session 65b351dc scratchpad) は
   findings (発見・ハマりどころ) / outcome (done|partial|abandoned) / rework 原因分類 / confidence まで
   要求していたが、実装 (`summarize.rs`) は 1 行要約 + 自由記述クラスタのみ。入力も first_prompt 500 字
   だけで、spec が最優先指定した「ユーザー発話全件・エラー tool_result・churn ファイル」を読んでいない。
   spec §6 の自己言及除外 (`origin='ailog-internal'`) も未実装 = 要約バッチ自身のログが集計を汚染する。
2. **`ailog_efficiency` が実装済みなのに UI 未接続**: effort 別 / サブエージェント有無 / compact 有無 /
   セッション長 4 分位の費用対効果比較が Rust 側に完成しているが、TS ラッパすら無い。
   `ailog_get_prices` / `ailog_set_price` も同様 (単価未設定 $0 計上を直す導線が無い)。
3. **手戻りの「実体」が死蔵**: `tool_event` (どのコマンド・ファイル・URL が失敗したか) と `file_touch`
   (どのファイルを何回書き直したか) は DB にあるが期間横断の集計 API が無い。画面は合成スコアのみ。

**遅さの主因はクエリ側** (インデックスはインクリメンタル対応済み):
- `refresh()` が 5 コマンド並列発行し、各自が `open()` + 全 turn テーブルのフルスキャン = 実質 5 重走査
- `sessions()` が limit 5000 で 1 行ずつ `query_row` (N+1)
- フィルタ切替のたびに 5 本フル再取得、クライアントキャッシュ無し

## 決定事項 (2026-08-12 AskUserQuestion で宮崎さん確定)

1. 柱 = **デイリーダイジェストを入口画面**にし、学びストック → 実験ボードの順で段階導入
2. 要約は**パネルを開いたら差分自動実行** (未要約分だけ裏で回す)
3. 性能対策 (ロールアップ導入) は**第 1 弾に含める**

## 設計コンセプト: 「集計を見る」→「教わる」

| 層 | 内容 | 主データ |
|---|---|---|
| ① デイリーダイジェスト | 開いた最初の画面 = 昨日の振り返り (完遂/中断内訳・最大手戻り事例と原因・金額対成果・今日の改善提案 1 つ) | F3 完全版の要約群 + 定量 |
| ② 学びのストック | findings (発見/ハマり/決定) のフィード + 同じ罠の再発警告 + 失敗コマンド・churn ファイルランキング | summary.findings / tool_event / file_touch |
| ③ 実験ボード | 「委譲は得か」「effort は見合うか」「長いセッションは損か」を問いカード形式で自分データが回答 | ailog_efficiency / breakdown 6 次元 |

補強: ルール準拠コーチ (300k 超セッション検出等、自分の運用ルールとの突合) は Phase 3 で扱う。

## Phase 1 (第 1 弾)

### 1a. 性能

- 目標: 全量 DB でパネル open →初回描画のクエリ時間を体感即時 (目安 <1s) に
- 候補手段 (実装者が設計判断してよい。数値の互換が絶対条件):
  - turn の日次ロールアップ表 (day × kind × model × project) をインデックス完了時に dirty-day 単位で更新
  - overview 系の集計を SQL 集計へ寄せ、5 コマンド間の重複スキャン解消
  - `sessions()` の N+1 を単一 JOIN クエリ化
  - `open()` ごとの DDL/pragma 再実行 (`schema::init` + `ensure_f3_columns` の `PRAGMA table_info`×7) の抑制
- 受け入れ: fixture 上で新旧クエリ結果が一致するテスト + 検証 4 コマンド全通過

### 1b. F3 完全版 (spec_ailog_f3_summary.md 準拠へ引き上げ)

- 入力: spec §2 の優先順位どおり (ユーザー発話全件 → エラー tool_result → 3 回以上編集ファイル →
  失敗後再実行 Bash → 最終アシスタントメッセージ → ツール統計 → 定量値)、12,000 字上限
- 出力 JSON: goal / goal_cluster (**固定 13 カテゴリへ丸め**・自由記述禁止) / outcome /
  findings[]{text, kind: cause|constraint|gotcha|decision|verified} / rework{happened, cause,
  category: spec-ambiguity|wrong-assumption|env-issue|tool-failure|scope-creep} / cost_note / confidence
- prompt_version を記録し、旧 version は再生成対象
- **自己言及除外 (spec §6)**: マーカー → `origin='ailog-internal'` → 既定除外 + `excluded_internal` 別枠表示
- 実行経路: `codex exec --model gpt-5.6-luna` 維持 (spec の claude -p から変更・コスト実績優先)。
  `-c features.fast_mode=false` 明示。findings 品質が不足したら terra へ昇格
- 日本語プロンプト文言は母艦 (Claude) が正本を書き、Codex は組み込みのみ (mojibake 防止)
- パネル open 時の差分自動: status 確認 → 未要約 > 0 なら自動 start (バッチ上限つき・進捗は既存 UI)

### 1c. デイリーダイジェスト

- 新テーブル `digest` (date, generated_at, prompt_version, json)
- 生成: 対象日の全セッション要約 (goal/outcome/findings/rework) + 定量 (コスト・手戻り内訳・
  失敗ツール上位・churn ファイル上位) を入力に LLM が合成。構成 = 完遂/中断内訳 / 最大手戻り事例と
  原因 / 金額に対して得られたもの / **今日の改善提案 1 つ**
- UI: パネル入口 = ダイジェストビュー (当日 + 前日)。従来ダッシュボードは「詳細」タブへ後退
- 自動生成: open 時、前日分が無ければ要約完了後に生成

## Phase 2: 学びのストック

- findings フィード (期間横断・kind 別フィルタ・検索)
- 再発検知: 類似 findings の LLM 判定 or 文字列近似 → 「同じ罠 2 回目」バッジ
- `tool_event` / `file_touch` の期間横断集計 API 新設 → 失敗コマンドランキング・churn ファイルランキング

## Phase 3: 実験ボード + コーチ + 単価

- `ailog_efficiency` の TS ラッパ + 問いカード画面
- `ailog_breakdown` 6 次元 (branch/effort/origin/title/agent) の切替 UI
- ルール準拠コーチ (300k 超セッション・生素材直読み検出など。ルール定義は設定化)
- 単価閲覧・編集 UI (`ailog_get_prices` / `ailog_set_price` 接続)

## 委譲計画

- 1a → 1b → 1c の順に Codex (gpt-5.6-terra, effort high) へ可視タブ委譲。仕様正本は本書 + F3 spec
- 完了条件・境界・セルフレビュー 2 周は各 spec に明記。親が検証 4 コマンド + fixture 一致で独立検証
