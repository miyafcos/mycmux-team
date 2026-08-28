# タブ再配置 (tab grouping) 設計計画 — 2026-08-25

status: 設計確定 (宮崎さん承認の壁打ち決定 + Oracle 設計相談を反映)
実装体制: Grok 実装 / Codex Sol 監査 / Fable 品質裁定 (canary レーン)
Oracle 相談記録: `C:\Users\miyaz\.oracle\sessions\mycmux-tab-grouping-design\artifacts\transcript.md`

## 1. 背景と目的

spawn は既定で呼び出し元ペインに同居タブとして積まれる。朝の母艦 → 案件母艦 → 作業者、
と派生していくと「1ペインに複数案件のタブが混在」「同一案件が複数ワークスペースに散在」
する。現行のタブ整理は「閉じる」+「AI命名」のみで、配置の再編成はできない。

新機能「タブ再配置」= 全ワークスペースのタブをAIが分析し、案件・役割ごとの再配置プランを
複数案提示 → ユーザーが取捨選択 → ワンクリック適用 (1世代 undo つき)。
名称は既存「タブ整理」(閉じる系) と語を分けるため「タブ再配置」とする。

## 2. 確定仕様 (壁打ち決定リスト)

| # | 決定 | 却下案と理由 |
|---|---|---|
| 1 | タブ単位で判定し、移動先の列・ペイン構成までAIが設計 | ペイン単位のみ (混在ペインを分解できず本命ケースに効かない) |
| 2 | 全ワークスペース横断。既存WSへの合流・新WS新設の両方を提案 | 現WS限定 (散在を直せない) |
| 3 | 切り口の異なる2〜3案を1コールで返させ並記 → 1案選択 → グループごと採用/保留 + タブ単位の除外・付け替え | 一括承認のみ (1タブの誤判定で全滅) |
| 4 | 分析はオンデマンド (ボタン押下・十数秒待ち)。バックグラウンド事前分析は後便 | 定期分析 (常時トークン消費・鮮度問題) |
| 5 | AIの提案は的外れがある前提。取捨選択のしやすさを最優先 (宮崎さん明言) | — |
| 6 | 1WS=1案件に固定しない。WSあたりタブ数が適正 (目安3〜8枚) になるよう小案件は1〜3件同居可 (列で分ける・グループ名は「国語課+雑務」式)。大案件は専有 | 機械的な1案件1WS分割 (俯瞰しづらく使いにくい — 宮崎さん運用FB) |
| 7 | ラベル・WS名は日本語基本。ただし固有名詞 (mycmux / claude / codex 等) はアルファベットのまま可。一般語 (fix / build 等) は日本語 | 全面カタカナ化 (固有名詞が逆に読みにくい — 宮崎さんFB) |

Fable 自己決定 (Oracle 助言と異なる点は明記):
- 移動はレイアウト操作のみ。PTY を殺さない・閉じない。作業中タブも移動可
- DEAD タブ (no_live_pty_session 等) は対象外 (閉じる側の管轄)
- 新WS・グループ名はAIが日本語命名 (日本語基本・固有名詞アルファベット可・短く)
- モデルは既存AI設定 (provider/model) を共用。mode="grouping" で run_tab_sweep_judge を流用
- undo スナップショットは v1 ではフロントメモリ内1世代 (Oracle は Rust 永続+再起動後復元を
  提案したが、data.json スキーマ拡張の故障面積を避けて後便化)

## 3. 既存資産 (接続先)

| 資産 | 場所 | 用途 |
|---|---|---|
| moveTabToPane(srcWs, srcPane, tabId, dstWs, dstPane) | src/stores/workspaceLayoutStore.ts:1148 | 参考実装 (クロスWS移動・空ペイン掃除・splitColumns 更新) |
| createWorkspace(name, gridTemplateId, panes, splitColumns, options) | src/stores/workspaceListStore.ts:210 | 新WS作成 (pet 等の生成規約はここが正) |
| _replaceWorkspaces(workspaces) | src/stores/workspaceListStore.ts:239 | アトミック全置換 = commit と undo 復元の土台 |
| run_tab_sweep_judge(prompt, requestId, mode) | src-tauri/src/commands/tab_sweep.rs:137 | AI CLI 実行。mode allowlist に "grouping" 追加 (JUDGE=90s/NAMING=180s、GROUPING=180s) |
| invoke パターン | src/lib/autoPaneNaming.ts:130 | invoke<string>("run_tab_sweep_judge", {prompt, requestId, mode}) + abort_tab_sweep_judge |
| scanNamingContext / tail 読み / 状態行除去 | src/components/layout/tabSweep.ts | 全WS版 scanGroupingContext の雛形 |
| ミニマップ (WS→ペイン→タブチップ) | src/components/dashboard/minimapModel.ts ほか | プラン・差分プレビュー描画に流用 |
| PaneTab.origin { kind: "human"/"agent", parentTabId } | src/types/workspace.ts:79 | spawn 系譜 = クラスタリングの強シグナル。系譜の連結成分は決定的に前計算してプロンプトへ |
| トースト | useToastStore | 補助通知 (undo 主導線は固定バー) |

## 4. アーキテクチャ — 4段パイプライン

```
AI応答 → validate → ValidatedProposal → (ユーザー編集) → EditedProposal
       → compile → LayoutTransaction → commit (_replaceWorkspaces 1発) → Undoバー
```

- AI は「論理プラン」(どのタブをまとめ・どこへ置く意図か・列/ペイン骨格) だけ返す。
  実 Workspace/Pane の ID 採番・操作順序・split 比率・フォーカス・削除判断は返させない
- compile はフロントの決定的関数: EditedProposal + 現在レイアウト → 新 workspaces 配列 +
  expectedResult (全タブの最終位置 + フォーカス先)。純関数でテスト可能にする
- commit は `_replaceWorkspaces` 1回のアトミック置換 (逐次 moveTabToPane を UI 経路では
  使わない — 中間状態のレンダー・購読者通知の嵐・部分失敗を構造的に排除)。
  新WSオブジェクトの生成規約 (pet・色・normalizeSplitColumns) は createWorkspace と同一に
  なるようファクトリを共有する
- commit 後に実際の store 状態を expectedResult と照合し、一致して初めて成功扱い。
  不一致・例外時はスナップショットへ即ロールバック

### 4.1 分析入力 (scanGroupingContext)

全ワークスペース走査。生きた terminal タブ全件について:
tabId / sessionId / label / labelSource / cwd / agentKind / origin (human・agent+parentTabId) /
workspaceId・workspaceName / paneId・列位置 / lastOutputAt / tail (末尾14行・状態行除去済み)。
DEAD 判定タブは除外。origin.parentTabId の連結成分 (spawn 系譜クラスタ) を決定的に前計算し、
プロンプトに明示する。分析時に AnalysisBaseline (各タブの workspaceId/paneId/sessionId) を保存。

### 4.2 AI応答スキーマ (JSON のみ・コードフェンス禁止)

```ts
type GroupingResponse = {
  schemaVersion: 1;
  plans: Array<{
    planId: string;                    // プラン内一意
    title: string;                     // 日本語・短く
    rationale: string;                 // 表示用。実行判断に使わない
    strategy: "project" | "role" | "minimal_move" | "mixed";
    groups: Array<{
      groupId: string;
      title: string;                   // 日本語 (新WS名の候補を兼ねる)
      disposition: "reorganize" | "keep";
      tabIds: string[];                  // keep でも必須 (layout=null のタブ列挙先。2026-08-25 改訂)
      destination:
        | { kind: "new_workspace"; proposedName: string }   // 日本語名
        | { kind: "existing_workspace"; workspaceId: string }
        | { kind: "current_locations" };                    // keep 用
      layout: { columns: Array<{ panes: Array<{ title: string;
        role: "mother" | "worker" | "review" | "mixed" | "unspecified";
        tabIds: string[] }> }> } | null;                    // keep なら null
    }>;
    unassignedTabIds: string[];        // AI が分類できなかったタブ
    warnings: Array<{ code: "LOW_CONFIDENCE" | "MIXED_PROJECT" | "UNCLEAR_ROLE"
      | "EXISTING_WORKSPACE_CONFLICT"; tabIds: string[]; message: string }>;
  }>;
};
```

検証 (機械強制):
- plans 2〜3件 / 各 ID はスコープ内一意 / 未知 tabId 禁止 / プラン内で各タブは
  groups(layout or keep)・unassignedTabIds のどこか **正確に1回** 出現 /
  existing_workspace は分析時点で実在した ID のみ / current_locations ⇔ layout null /
  空ペイン・空列禁止 / 新WS名は空・重複禁止・日本語基本 (固有名詞アルファベット可) /
  列数・ペイン数に上限 (列4・ペイン/列4)
- **検証単位はプラン**: トップレベル破損 = 全体 invalid / プラン単体の破損 = 当該プランのみ
  破棄 / 有効プランが2件未満 → 自動で1回だけ再生成 → それでも1件なら1案として表示
  (比較不足を明記) → 0件なら分析失敗 (raw 表示つきエラー)
- パーサは 1〜3 件の plans を受理する (プロンプトは初回2〜3案を要求するが、再生成後の
  1案表示を成立させるため受理側は1件を拒否しない。2026-08-25 改訂)
- v1 制約: 列は等幅・ペイン既定比率 (AI に比率を返させない)。既存WSへの合流は
  「新規ペインを末尾列に追加」のみ (既存タブの再編はしない)
- プロンプトの配置目標 (確定仕様 #6): 1WS=1案件に固定せず、WSあたりタブ数 3〜8枚目安。
  小案件は1〜3件同居可 (列で案件を分け、グループ名は「国語課+雑務」式)。大案件は専有

### 4.3 適用 (compile + commit)

1. 適用直前に AnalysisBaseline と現在レイアウトを突合 (stale 分類):
   - 対象タブが閉じた / sessionId 不一致 / 対象タブが手動移動済み / 移動先既存WSが消えた
     → **ブロック** (差分を全数列挙して編集モードへ戻す。勝手な除外はしない)
   - 分析後に増えた新規タブ → 継続可 (現在位置に残す) / 対象外タブの増減・移動 → 原則継続可
2. スナップショット: workspaces 全体 + activeWorkspaceId + 選択状態を deep copy (メモリ内)
3. compile: 新 workspaces 配列を純関数で構築 (新WS生成・グループ束ね・空ペイン整理・
   splitColumns 正規化・フォーカス追従先の決定)
4. commit: `_replaceWorkspaces` 1発 → 実状態と expectedResult を照合 → 不一致なら即ロールバック
5. フォーカス追従: 表示中タブが移動したら移動先WSを active に。store 選択更新と xterm の
   DOM focus/fit は分離し、fit はレイアウト確定後に1回だけ
6. 空になったWSは**自動削除しない** (適用完了バーに「N個のWSが空になりました [確認する]」
   を出し、個別削除に誘導)
7. 結果レポート: moved / kept / blocked-skip / errors を全数列挙 (丸めない)

### 4.4 undo (1世代・メモリ内)

- 適用完了直後、画面下部に固定 Undo バー:
  「再配置を適用しました — Nタブ移動 [元に戻す] [変更内容を見る] [×]」
- 寿命: 時間で消さない。次のレイアウト変更 (手動移動・タブ増減・再適用) を検知したら失効し
  「その後レイアウトが変更されたため元に戻せません」に切替。×で閉じてもパネル上部から
  再呼び出し可
- 復元 = スナップショットを _replaceWorkspaces で全置換。復元前に現在レイアウトと
  スナップショットの sessionId 集合を照合し、差分があれば失効扱い (v1 は安全側)

## 5. UIUX — 同一画面内の3段階モード (ウィザードではなく戻れるモード切替)

ダッシュボード内「タブ再配置」ビュー。固定ヘッダー / 中央作業領域 / 固定アクションバーの3層。
ヘッダーに [1 案を比較]─[2 内容を編集]─[3 適用前確認] のステップ表示 (クリックで戻れる・
編集状態は保持)。

### モード1: 案を比較
- 左: 案カード (ラジオ選択。案名 / 一文の方針 / 移動タブ数 / 新規WS数 / 現状維持数 / 警告数)
- 右: 選択中案の大プレビュー (ミニマップ流用・After 中心。ヘッダーに「現在を表示」トグル)
- 描き分け: 移動タブ=アクセント色+移動元を小さく併記 / 現状維持=弱い中性色 /
  未分類 (unassigned)=警告色 / 新規WS=破線枠 / 既存WS=実線枠

### モード2: 選択案を編集 (左35% / 右65%)
- 左: グループ一覧 (カード単位の 採用/保留。保留=「現状位置に残す」の意味に固定。
  エラー状態=赤・適用不可)
- 右: 選択グループの構成 (移動先表示+[変更] / 列・ペイン骨格とタブ行)
- 付け替え (ドラッグなし): タブ行クリックで選択 (複数可) → 下部に選択バー → [移動先…] →
  ポップオーバーでグループ選択 (既定ペインへ。ペイン指定は展開時のみ)。
  「＋新しいグループ」もここから
- 却下: 常時セレクトボックス / モーダル連打 / ドラッグ専用 / 行クリック=即移動モード

### モード3: 適用前確認
- 編集操作を止め差分確認に集中。[現在 / 適用後 / 差分] 切替 (既定=差分・同一キャンバス切替)
- 差分表示: 移動タブ=移動元→先ラベル併記 / 新規WS=破線+「新規」 / 保留=現状維持アイコン /
  空になるWS=警告 (「削除されません」) / stale=ブロッカー表示
- 数値サマリー + [適用]。確認モーダルは出さない (このモード自体が確認)

### アニメーション (v1: 飛翔なし)
- 適用: ①作業領域を操作不能化+進捗 → ②新レイアウトへクロスフェード →
  ③移動タブチップを**同時に** 150〜250ms ハイライト (計400〜600ms)
- opacity + 軽い scale(.99) / チップは背景フラッシュか短いアウトライン / 新規WSに「新規」
  バッジ数秒 / prefers-reduced-motion で全停止
- モード切替・カード状態変化は 150〜220ms の CSS transition。トークンのみ使用

## 6. Rust 変更 (最小)

- tab_sweep.rs: mode match に Some("grouping") アーム + GROUPING_TIMEOUT (180s)。それ以外触らない

## 7. 実装順序 (Oracle 助言採用)

- **Phase A (先行・最重要)**: ロジック層 `tabGrouping.ts` — scan / prompt / validate /
  compile / commit / stale / undo を純関数中心で実装し、AIなしの固定プランで単体テスト
  (破壊試験: 途中失敗・stale・undo失効・expectedResult 不一致)
- **Phase B**: UI 3モード (パネル・カード・ポップオーバー・差分表示・Undoバー)
- **Phase C**: 配線 (入口ボタン・ダッシュボード召喚・Rust mode・契約テスト更新)
- 実装前に実コードで確認して報告する5点 (Oracle 指摘の未確定):
  ① _replaceWorkspaces で選択状態・layoutMetrics がどう扱われるか
  ② WS/Pane ID を維持したまま全置換して購読側 (xterm mount) が安定するか
  ③ タブの PTY 同一性は sessionId で足りるか
  ④ splitColumns 変更で xterm の unmount/再生成が起きるか (起きるなら fit 手順を厳守)
  ⑤ 手動レイアウト変更の検知手段 (undo 失効・stale に使う)

## 8. テスト・受け入れ条件 (機械照合)

1. `npx tsc --noEmit` クリーン
2. `npx vitest run` 全緑 (新規: プロンプト構築 (系譜・全WS・日本語制約) / スキーマ検証の
   異常系全種 (§4.2) / プラン単位 invalid と再生成分岐 / compile の純関数テスト
   (新WS・合流・空ペイン整理・splitColumns) / stale 分類表どおりの判定 / undo 失効 /
   expectedResult 照合とロールバック)
3. `python -m pytest tests/` 全緑 (test_tab_sweep_command_contract.py の mode allowlist 更新含む)
4. `python scripts/run_windows_tests.py` 全緑
5. tokenContract / themeContrast / uiDensity / uiQualityTokens 契約を新CSSが破らない
6. 境界照合: git status 全量 (untracked 含む) で指定ファイル外の変更ゼロ
7. 実機スモーク (宮崎さん or Fable): 分析→複数案→編集→適用→undo の一巡

## 8.5 封印解除 (enable) 条件 — 2026-08-25 Oracle round3 裁定で v2 に改訂

経過: Grok実装 → Sol監査 round1 REJECT → Grok修正 `f99d78b` → Sol round2 再REJECT
(新規Critical 2) で canary 打ち切り → Oracle 設計裁定 (詳細設計の正本 =
**2026-08-25-tab-grouping-oracle-round3.md**・実装者は必ず直読)。
監査記録 = 同フォルダ sol-audit-r1 / grok-fix-r1 / sol-audit-r2。

体制 (round3 以降): **エンジン実装 = Codex gpt-5.6-sol / 監査 = Opus 5 / 裁定 = Fable**。
Grok は本レーンの中核実装から外す (2ラウンド連続で新規回帰を混入した実測による。
ラダー「fail 後の再委譲 = sol」準拠)。

Gate 進行 (oracle-round3 §F。次 Gate へ進む条件を満たすまで先へ行かない):
- **Gate 0 (完了)**: 本節+oracle-round3 で仕様と不変条件を確定
- **Gate 1**: エンジンを UI から切り離して実装 — CommitTicket (OCC・入力/出力署名・
  完全一致 fail-closed) / allocationSeed 決定的ID+identity validator /
  PersistentLayoutProjection による commit・rollback・undo の canonical 照合。
  破壊試験を先に赤で書く (NEW-01/02 再現・連続適用・並行変更・duplicate 全種・
  commit/rollback 破損・selection 退避つき undo)
- **Gate 2**: store 境界 — pure workspace factory 共有 (B-11) / アトミック復元 action /
  commit mutex / global undo 導線 (C-16) / layout revision 購読
- **Gate 3**: Panel を prepare/commit の新 API へ接続 (transaction 直渡し廃止)
- **Gate 4**: UI 実操作テスト (RTL+user-event) と Tauri adapter integration (E-06/E-07・C-03/C-13)
- **Gate 5**: 実機 smoke (実PTY 継続・remount・focus/fit・入力) + 性能実測
  (100tab 確認画面 p95≤100ms / 編集 p95≤50ms / tail 100tab p95≤2s・8〜16並列)
- **Gate 6**: Opus 独立監査 (新規欠陥探索を明示・対応表は補助資料)

追加必須条件 (oracle-round3 §E「不足していた enable 条件」):
commit mutex / ticket 単回使用 / 永続型変更の schema gate / _replaceWorkspaces 後の
永続化確認 / rollback_failed 後の再Apply 禁止+診断導線。

最終解除 = Gate 6 ACCEPT (Blocker/Critical/High=0) + 宮崎さんの実機触ってGO。

## 9. v1 で削るもの (後便)

- バックグラウンド事前分析 (状態変化トリガ)
- ドラッグ編集 (クリック操作と意味論を共通化した補助として v2)
- タブ飛翔アニメーション (FLIP)
- AI 指定の任意 split 比率 / 既存WSの全面再編
- 複数世代 undo・履歴 UI / undo スナップショットの Rust 永続化 (再起動後復元)
- stale 提案の自動修復 (v1 は差分提示+編集へ戻すのみ)
- 空WSの自動削除 (独立した掃除機能として扱う)
