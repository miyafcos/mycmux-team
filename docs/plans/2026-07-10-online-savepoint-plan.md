# Online セーブポイント共有 — 設計書 v1 (2026-07-10)

> **履歴資料:** 共有フォルダを前提にした本設計は、2026-07-14のlocal-first受け渡し仕様で置き換えられました。現行仕様は `README.md` の「セーブポイント」を参照してください。

## 0. 背景と一言サマリ

mosaic.inc (Multiplayer Claude Code / cmux 本家チームの新作) の調査から派生した宮崎案。
Mosaic 型の「リアルタイム同席」ではなく、**「作業のセーブポイントを公開し、他の人 (または別PCの自分) がワンクリックで途中から引き継ぐ」** 非同期モデルを mycmux に実装する。

- 調査レポート: `C:\Users\miyaz\reports\mosaic_inc_chosa_20260710\mosaic_inc調査_20260710.html`
- CRDT 再現デモ (別レイヤ・本計画のスコープ外): 同フォルダ `crdt_saigen_demo_20260710.html`
- memory: `project_mycmux_multiplayer.md`

### 設計判断の核 (宮崎さん発言 2026-07-10 より)

1. 「一緒に同時に Claude Code を使える必要はない。**セーブポイントを作る**みたいなもの」
2. 主用途は「**途中からセッションを引き継ぎたい**」— 会話から派生 (fork) させる。元の作業に影響しない
3. 引き継ぎ先は普通のワークスペースと同じ見た目・同じ操作感で開く
4. エントリは登録順・**2日程度で自動消滅**。ボタンは何回でも押せる
5. 他者間のパス差は「全員が同じ会社 Dropbox をローカルに持っている」性質で吸収する

## 1. UX 仕様 (2026-07-10 夜 宮崎FB反映済み: upsert 方式 + 専用パネル)

### 1.1 公開側 (セーブポイントを作る)

- タブバー右上に **「共有ポイント作成」ボタン** を新設 (アクティブペインが Claude Code セッションのとき有効)
- 押すと: サマリ1行の確認ダイアログ (自動生成文を編集可) → バンドル生成 → 共有フォルダへ書き出し → トースト「Online に公開しました」
- **1セッション = 1エントリ (upsert 方式)**。同じセッションで2回目以降に押すと既存エントリを最新状態で上書き更新 (セーブポイントの上書き保存)。ボタン表示は初回「共有ポイント作成」→ 以降「共有ポイント更新」
- 公開中のセッションはタブに小さな共有バッジを表示 (いま公開されている自覚を持てるように)

### 1.2 参加側 (Online パネル)

- サイドバー/メニューから **「Online」専用パネル** を開く (ターミナル文字ではなく React 製のリッチUI ペイン。前例 = ファイルエクスプローラーペイン)。ランチャーが表示される領域に1枚ドーンと出るイメージ
- 表示: カード型一覧。カード = `👤ユーザー / 案件・フォルダ名 / サマリ1行 / 最終更新N時間前` (+ ⚠パス警告 / 📌ピン)
- **検索ボックス** (ユーザー名・案件名・サマリの自由文検索)。並びは基本 **最終更新の新しい順で上位表示** (ピンは最上段固定)
- カードをクリック → モード選択:
  - **「要約から開始」(既定)** — 新規セッション + 引き継ぎ要約 (handoff.md) を初回コンテキストに注入
  - **「完全再開」** — トランスクリプト jsonl を自機に配置して `claude --resume` (会話の全記憶つき)
- 選ぶと**新しいペインでそのセッションが開く** (通常のワークスペース/ペインと同じ見た目・操作感)。Online パネルは開いたままなので、続けて別のカードも選べる (何回でも・複数同時可)
- エントリはクリックしても消えない (再利用可)。「一回限り」区別は作らない
- 48時間 (最終更新から) で自動掃除、ピン留めで延長

## 2. バンドル仕様 (引き継ぎの実体)

共有フォルダ: `{DROPBOX}\_mycmux_online\` (社内共有済み領域の直下。最終パスは実装時に確定)

```
{DROPBOX}\_mycmux_online\
  miyazaki_<session-id先頭8桁>\   ... フォルダ名 = 作成者+セッションID (upsert キー。日時は manifest 側)
    manifest.json        ... メタ情報 (下記 schema)
    handoff.md           ... 引き継ぎ要約 (人間可読・要約モードの注入元)
    transcript\
      <session-id>.jsonl ... Claude Code セッション原本のコピー (完全再開用)
```

更新時は同フォルダへ全ファイル上書き (`updated_at` を進める)。tmp 書き→rename のアトミック方式で、受け手が読取り中でも壊れないようにする。

### manifest.json schema (v1)

```json
{
  "schema": 1,
  "author": "miyazaki",
  "machine": "home-windows",
  "created_at": "2026-07-10T21:30:00+09:00",
  "updated_at": "2026-07-10T23:05:00+09:00",
  "expires_at": "2026-07-12T23:05:00+09:00",
  "pinned": false,
  "summary_line": "モモスタ数学B3 組版まで完了、B4の図版差し替えから再開",
  "cwd": "{DROPBOX}/事務関係/駿台/モモスタ数学",
  "claude_session_id": "<uuid>",
  "files_touched": ["{DROPBOX}/事務関係/駿台/モモスタ数学/...", "..."],
  "warnings": ["C:/Users/miyaz/work/tmp.py は Dropbox 外 (相手側に存在しない可能性)"]
}
```

### handoff.md の生成

構成は既存 resume-context hook (「前回の到達点」注入) と同型:
**やったこと / 現在地 / 次の一手 / 触ったファイル / 未解決の判断**。
生成方法は transcript 末尾からの抽出 + headless `claude -p` での要約 (Stop hook の既存要約があれば再利用)。

## 3. パス正規化

- 公開時: `<自機の Dropbox ルート>` で始まる絶対パスを `{DROPBOX}/...` にトークン化
- 参加時: 自機設定の Dropbox ルートで展開し、存在チェック。欠けがあればエントリに ⚠ 表示
- 各自の Dropbox ルートは mycmux 設定 (data.json) に `dropbox_root` として1回だけ登録
- Dropbox 外のパスはそのまま記録し warnings に積む (ブロックはしない)

## 4. 完全再開モードの技術詳細

Claude Code の会話原本 = `~/.claude/projects/<sanitize(cwd)>/<session-id>.jsonl`
(sanitize = パス区切り等を `-` 化。例: `C:\Users\miyaz` → `C--Users-miyaz`)

参加側の手順 (mycmux が自動でやる):
1. manifest の cwd を自機パスに展開 → そのフォルダを実際の作業ディレクトリにする
2. `transcript/<id>.jsonl` を `~/.claude/projects/<sanitize(展開後cwd)>/` へコピー
3. そのcwdで `claude --resume <session-id>` を起動するペインを開く

### Phase 0 検証結果 (2026-07-11 実施・全項目クリア)

検証手順: `~/tmp_phase0_savepoint/a` で合言葉を覚えさせたテストセッション (`claude -p`) を作成 →
jsonl を `b` 用の project ディレクトリへコピー → `b` を cwd に resume。

- [x] **cwd 不一致は許容される** — jsonl 内部の `"cwd"` は A のパスのまま、B の project ディレクトリ (`C--Users-miyaz-tmp-phase0-savepoint-b`) に置いて B から resume 成功。合言葉・場所とも完全に記憶保持 (「合言葉=クロネコ42、場所=A地点」)。**内部 cwd の書き換えは不要**
- [x] **原本は無傷** — resume の追記は B 側コピーにのみ入り、A の原本 jsonl は行数不変
- [x] **`--fork-session` が公式に存在し、そのまま「派生」に使える** — `claude -p --resume <id> --fork-session` で新 session_id が発行され、記憶は保持。join の既定はこれ
- [x] **ID 衝突はファイル名リネームだけで解決** — jsonl を別 UUID のファイル名でコピーし、その UUID で resume 成功。**内部 sessionId フィールドの書き換えも不要** (ファイル名が正)
- [x] 環境 (MCP・権限・ツール) は付いてこない (仕様) — handoff.md に前提ツールを書く運用でカバー
- 補足: project ディレクトリ名の sanitize は非英数字→`-` (アンダースコアも `-` になる。例: `tmp_phase0_savepoint` → `tmp-phase0-savepoint`)。実装時は自前 sanitize せず「join 先 cwd で一度 `claude` を起動させて CLI 自身に正しいディレクトリを作らせてからコピー」が安全
- 同一人物の別PC間では既にセッションバックアップ (`G:/マイドライブ/pc-backup/claude-data/`) で同型の移送実績あり

**結論: 完全再開モードの技術リスクは消えた。join の実装 = 「jsonl を join 側 project ディレクトリへ任意 UUID 名でコピー → `claude --resume <そのUUID> --fork-session`」の2手で確定。**

## 5. 期限と掃除

- 既定 48h (`expires_at`)。mycmux 起動時 + 日次で `_mycmux_online` をスキャンし、期限切れの非ピンエントリをフォルダごと削除
- 削除は「作成者のマシンだけが自分のエントリを消す」ルールにする (全員が消しに行くと Dropbox 競合の元)
- ピン留め = manifest の `pinned: true` (一覧から切替可)

## 6. セキュリティ / NDA

- 初版のアクセス制御は **Dropbox の共有権限に全委譲** (社内で管理済み・新しい仕組みを作らない)
- 素材が元々置いてある箱と同じ Dropbox 内で完結するため、NDA 上の新規懸念なし (Mosaic の他社リレー経由問題は構造的に発生しない)
- 社外ユーザーとの共有は非目標 (将来の別計画)

## 7. 実装フェーズ

| Phase | 内容 | 規模 |
|---|---|---|
| **0. 検証スパイク** | ✅ 完了 (2026-07-11)。§4 検証結果参照 — cwd不一致許容/原本無傷/--fork-session発見/IDリネームのみで衝突解決 | 済 |
| **1. publish** | ✅ 完了 (2026-07-11・commit 5422654)。`scripts/savepoint_publish.py` + pytest 6件 (全体 69 passed)。実セッションで E2E 済み。使い方: `python scripts/savepoint_publish.py --cwd <dir> --session latest --online-dir <共有先> [--summary/--next-step]`。config = `~/.mycmux/savepoint.json` (dropbox_root/online_dir/author/machine)。handoff.md は決定的生成 (headless claude 不使用 = コスト0・§9の論点解消)。manifest に files_written / git_branch を追加 (schema v1 のまま additive) | 済 |
| **2. Online パネル + 要約モード join** | ✅ 完了 (2026-07-11・commit 615865b・Codex gpt-5.6-sol 実装+親検収)。Rust `list_online_savepoints`/`join_savepoint_summary` + React OnlinePanel (カード/検索/ピン優先ソート/要約join→新ペイン)。既存ペイン起動機構を再利用 | 済 |
| **3.5. GUI publish 経路** | ✅ 完了 (2026-07-11・commit 1f5f575)。設定メニュー経由しか入口がなかった publish を GUI 化: Rust `publish_savepoint` (savepoint_publish.py の native 移植・upsert で created_at と pinned 保持・python 側も pinned 保持に統一)。ペインタブバー右側に Claude Code タブ限定のブックマークボタン (公開中はアクセント色・ポップオーバーでサマリ1行入力)。`onlineSavepointStore` が公開済み session_id を追跡。Online パネルのカードに `セッション <先頭8桁>` と「このPCで開いているセッション」バッジを追加し、どのセッションが登録済みかの経路を明示。UI 配線は Codex gpt-5.6-sol 実装+親検収 | 済 |
| **3. 完全再開モード + ピン/掃除** | ✅ コア完了 (2026-07-11・commit f028bd2)。`scripts/savepoint_join.py` (summary/full の join 準備・fresh UUID 移植・`--resume <id> --fork-session` 発行) + `scripts/savepoint_cleanup.py` (自機エントリのみ期限削除・pinned 保持・残骸tmp掃除・--dry-run)。pytest 7件追加。E2E: publish→join full→resume fork で記憶保持を実証。UI 配線も ✅ 完了 (commit 694353c): `join_savepoint_full` (Rust ネイティブ移植)・`toggle_savepoint_pin` (atomic)・`cleanup_online_savepoints` (パネル表示時 fire-and-forget)。online 系 Rust テスト5件 | 済 |
| **4. (別線)** | 観戦モード (Remote WS)・共同入力・CRDT 共有編集ペイン (Yjs) — 本計画とは独立 | — |

実装は Codex 委譲 + 親検証の既存運用 (日本語リテラルは母艦 Write)。
着手前提: WebView2 gpu-process CPU 問題 (7/9 起票) を悪化させないこと — 本機能はフォルダ監視 (低頻度ポーリングで可) 以外に常駐負荷を持たない設計とする。

## 8. 非目標 (初版で作らないもの)

- リアルタイム同席・共同入力・観戦 (Phase 4 / Remote の領分)
- CRDT 共有テキスト編集 (再現実証済みだが別計画: レポート §3.5)
- 一回限りエントリ、社外共有、Dropbox 以外のトランスポート

## 9. 未確定事項 (実装時に決める)

- `_mycmux_online` の正確な設置場所 (事務関係直下か、専用共有フォルダか — 共有範囲=見せたい相手の範囲なので宮崎さん判断)
- ユーザー名の出所 (data.json に表示名を1項目足すのが最小)
- サマリ自動生成のコスト (headless claude 呼び出し1回/公開。重ければ transcript 末尾抽出のみに落とす)
- Dropbox 同期遅延中のエントリ表示 (manifest が先に届きtranscriptが未達のケース → manifest に全ファイルのハッシュを持たせ、揃うまで「同期中」表示)
