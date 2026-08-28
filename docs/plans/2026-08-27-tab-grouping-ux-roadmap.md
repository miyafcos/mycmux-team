# タブ再配置 — 「20% → 日常で使う」ロードマップ (2026-08-27 確定)

判断者 2 系統 (Oracle GPT-5.6 Sol Pro・Codex gpt-5.6-sol max) の独立回答を照合して母艦 (Fable) が統合した。
オーナー要求は 2 点のみ: **マウスで直観的に使える** / **動作が安定している**。現状 (G3-3 `e962f50`) の完成度は 20% (オーナー評価・両判断者とも妥当と判定)。

原本: `~/.oracle/sessions/tab-grouping-ux-gap-r2/artifacts/transcript.md` (Oracle) / 母艦 scratchpad `ux_gap_verdict_sol.md` (sol)。

## 両者が一致した設計判断

1. **② (内容を編集) を「編集可能な適用後配置図」に置き換える**。①閲覧 / ②編集 / ③凍結+比較 は**同じプレビュー部品・同じモデル**の表示モード違いにする。②専用の別コンパイラ・別レイアウトを作らない
2. **DnD 採用** (Pointer Events のみ・外部ライブラリと HTML5 Drag API 不使用)。ただし DnD 専用にせず、**複数選択後に移動先ペインをクリック**でも移動できる。既存の選択バー+ポップオーバーはキーボード代替・回復導線として残す。ドロップが変えるのは「どのペイン/グループに所属するか」だけ (タブ順・列幅・ペイン比率・自由配置は触らせない)
3. ①に **「この案で確認」(②を飛ばして③へ)** と「内容を編集」の 2 ボタン。無編集適用が最短経路
4. グループのスイッチは **「再配置する｜現状維持」の明示 2 択**。タブチップに状態 (移動先/現状維持/未分類) を常時表示。「変更対象のみ表示」
5. **編集内 1 手 undo と「AI 案に戻す」**。名称の最低限編集
6. **DnD 本体 (正常系) と中断系 (pointercancel / lostpointercapture / Esc / blur / scroll / resize / 対象消失 / Panel close / 右クリック / stale) は別便**。正常系を作ったセッションに中断系を自己検証させない
7. Gate 4 / 5 / 6 は削らない。実 PTY・xterm 再マウント・focus/fit・永続化を通した実機挙動が最大の未証明点

## 実欠陥 (封印解除前に必ず閉じる・sol 発見)

- 編集 IR: `reassignTabs` が元の空ペインを残す一方で validation は空ペインを禁止 → 1 タブのペインから移すと Apply 不能。移動先を `pane.title` で照合 → 同名ペインへ重複投入
- 画面外の `selectedTabIds` が残り、意図しない一括移動
- 生体表示がモックと本番で別契約: Panel は永続 `metadata` だけを読むが実時刻は `volatileMetadata`、正規の working 判定は `deriveDisplayStatus(metadata, volatile)`。表示木がペイン内限定で別ペインの作業者の系譜が消える
- 適用後の真実不一致: `result.durability` を捨てる・成功表示と衝突警告が同居・外部「変更内容を見る」が review intent を渡さない
- 線計測が scroll ごとに O(n²)・hover の reflow で端点がずれる

## 便構成 (順序・依存)

| 便 | 内容 | 依存 |
|---|---|---|
| **L1** | legacy 経路 (旧 compiler / 旧 review 導線 / undoMemory) を物理削除・①②③を `groupingBoundary.preview` 一本へ固定・参照 0 の契約 | G3-3b 受理 |
| **UX-1** | `EditCommand` 導入 (既存スイッチ/除外/ポップオーバーを移行)・編集 IR 不変条件 (安定 drop 先 ID = `groupId+columnIndex+paneIndex`・同名ペイン・空ペイン/空列正規化・名称重複)・編集内 1 手 undo・「AI 案に戻す」・名称最小編集 | L1 |
| **UX-1b** (UX-1 と並走) | 生体・系譜の本番契約: `volatileMetadata` + `deriveDisplayStatus`・ペイン横断の親表示・状態の非色表現・実 store 統合テスト | L1 |
| **UX-2** | ② = ③と同じ After 配置図を編集可能化・「この案で確認」ショートカット・「再配置する｜現状維持」2 択・タブ状態常時表示・変更対象のみ表示・選択の常時可視化 (グループ切替で解除)・Panel/Overlay 状態修正 (Escape 伝播・backdrop 右ボタン・closing 中 inert・popover clipping・durability 表示・review 再開) | UX-1, UX-1b |
| **UX-3** | Pointer DnD コア: 6〜8px 閾値・`setPointerCapture`・ghost (fixed layer・N 件表示)・semantic drop zone (安定 ID)・単一/複数・現状維持トレイ・選択後クリック移動・`pointermove` 中は store/plan/prepare/commit を変更しない (rAF 1 本で ghost と候補だけ更新)・drop 直前の対象と revision 再検証 | UX-2 |
| **UX-4** | DnD 中断系全経路・キーボード/focus 復帰・単一縦自動スクロール・背面イベント遮断・`aria-live` 通知 | UX-3 |
| **UX-5** | 確認・線の仕上げ: 同一 WS 内移動も差分に・クリック/focus で 1 件固定強調 (始点/終点/元→先文字)・色以外の識別・適用直後レビュー・線計測 O(n)/RAF 化・ResizeObserver 対象に端点 | UX-2, UX-4 |
| **G4** | RTL + user-event + Tauri adapter integration の実操作マトリクス (last-tab / 同名ペイン / 不可視選択 / prepare 再試行 / pointercancel / lost capture / Escape / 右ボタン・backdrop / 959・960・961px / 外部レビュー再開 / focus trap / 3 モード往復 / DnD=クリック=ポップオーバー同値 / stale / Apply 単回 / rollback / global undo) | UX-5 |
| **G5-P** (G4 と並走) | 100 タブ性能: 分布別 (10WS×10 / 1WS へ 100 / 100WS×1)・status 1 秒更新で線 geometry を再計算しない・elapsed 更新で全タブ再描画しない・pointermove の rAF 化・確認 p95≤100ms / 編集 p95≤50ms / tail p95≤2s・drag 中 50ms 超 long task なし | UX-4 |
| **G5-R** | 実 Tauri/WebView2・実 PTY・永続化・focus/fit・再起動・表示倍率 100/125/150/200%・Apply/undo 20 回反復 → **オーナー試触ビルド** (fresh `--profile`・feed 停止・SHA 記録) | G4, G5-P |
| **Gate 6** | Opus 独立監査 (Blocker/Critical/High = 0)・変更なし | G5-R |
| **解除** | オーナーが実機で 4 シナリオを説明なしで完了 → `TAB_GROUPING_ENTRY_ENABLED=true` の 1 行差分 (全スイート+隔離 profile smoke) → release → feed | Gate 6 |

## 日常使用 GO の観測条件 (Oracle)

オーナーが説明なしで完了: ①AI 案を無編集で確認・適用・undo ②1 タブを別 WS へドラッグ ③複数タブを選択し移動先ペインをクリック ④1 タブを現状維持へ戻して確認・適用。
実機: ライブ出力中の PTY を含めて適用・undo を連続 20 回で、PTY 停止 / 入力不能 / 出力重複 / focus 喪失 / 永続化巻き戻り / preview との配置不一致 / unhandled error / 再起動後の不正レイアウト が **ゼロ**。

## 後回し (両者一致)

列・ペインの自由な並べ替え / ペイン比率 / タブ順指定 / 空白ドロップで新 WS 自動作成 (新 WS はボタンで作り名前確定後にタブを置く) / 実ダッシュボードへの直接ドロップ / 飛翔アニメ・粒子 / 複数世代・再起動後 undo / バックグラウンド事前分析 / stale 自動修復 / 空 WS 自動削除 / タッチ最適化 / 慣性 DnD / 系譜・生体の追加装飾。

## 判断が誤りと分かる観測 (Oracle)

- 配置図版でもオーナーが目的地を迷い、完了時間・誤操作・主観評価が改善しない → ②の設計を再考
- 100/125/150% とスクロール・Alt+Tab・pointer cancel 試験で誤ドロップ・残留状態が収束しない → DnD を外し「選択後クリック」を主導線に
- 実 PTY・故障注入・20 回反復・再起動で統合固有の問題が 1 件も出ず性能だけが失敗要因 → 監査配分を性能へ

## 体制 (オーナー指示 2026-08-27)

母艦 = Fable (session-dispatch 可) / 作業 = Codex (モデル選定は母艦・既定 sol high、難所 xhigh) / 判断 = Oracle (不通時は Codex sol max で代替し復帰後に照合) / 品質保証 = Fable (隔離 worktree で red/green 反転 + Opus closure 監査)。
