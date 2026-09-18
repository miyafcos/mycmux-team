# タブ再配置の適用アニメーション 設計

状態: **裁定済み** (2026-08-29 宮崎さん承認)。論点1〜4はすべて推奨どおりで確定。
経緯: 実機で初めて通しで動かした際の宮崎さんフィードバック
(`~/.claude/dispatch/260829-grouping-ux/requirements.md`) を受けた設計。

---

推奨案は「AppShell 常駐フライト・プロキシ」方式。図のチップを軽量プロキシとして実ペインまで連続して運ぶ。
図内区間は既存の `groupingMeasuredMoveLines()` と既存 SVG path を凍結利用し、予告と実行の軌跡を同一にする。
図座標と実画面座標は、両方を viewport CSS px に正規化して接続する。`devicePixelRatio` は掛けない。
短い図内移動の途中で同期 commit を一度だけ行い、成功後に実ペイン矩形を測って接線連続の bridge へ進む。
パネルと Dashboard は commit 成功後に退き、プロキシだけが AppShell 常駐層に残って実画面へ着地する。
PTY・xterm DOM・native WebPane はアニメーション対象にせず、既存 sessionId と terminal cache の生存契約を保つ。
commit 前の失敗は同じ経路を逆走し、commit 後のユーザー操作はデータを戻さず演出だけを中止する。
アプリ設定は既定オンを推奨し、設定オフまたは `prefers-reduced-motion` では即時適用・即時収束する。
29タブでも1本の rAF、transform/opacity のみ、フレーム中の layout read と React 再描画なしを性能条件とする。
非表示 workspace の着地点と workspace 内移動の予告経路は親・宮崎さんの裁定事項。実装・コミットは本便では行わない。

# 便A1 — タブ再配置の適用アニメーション設計

## 1. 結論

宮崎さん決定済みの形を次の一本の遷移として実現する。

```text
確認図の before チップ
  └─ 既存の予告線をそのまま進む
       └─ 同期 commit（論理レイアウトの境目）
            └─ パネルと Dashboard が退く
                 └─ viewport 上の同じプロキシが実ペインへ着地
```

推奨は案A「AppShell 常駐フライト・プロキシ」。動かすのはラベル・色・移動先を持つ小さなチップだけであり、実ターミナル、xterm canvas、native WebPane、PTY は動かさない。既存予告線を正確に再生しつつ、パネルの座標系から実画面へ抜けられる。

## 2. 現状コードから確定できること

- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\layout\groupingMoveLines.ts`
  - `groupingMoveDiffs()` は workspace 間・workspace 内の両方の差分を持つ。
  - `groupingMoveLines()` が線にするのは workspace 間移動だけである。
  - `groupingMeasuredMoveLines()` は `fromRect`、`toRect`、実チップ位置 `destinationRect`、`leadIn`、迂回点 `routePoints` を返す。
  - 通常経路は cubic、障害物回避時は polyline。時間、進捗、取消状態は持たない。
- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\layout\TabGroupingPanel.tsx`
  - 予告線は side-by-side container 相対の DOM 実測値から描く。
  - ResizeObserver と scroll を rAF でまとめ、線の始終点を追従させている。
  - 現在の apply は同期 commit 後、`setTimeout(0)` で applying を解除するだけで、適用モーションはない。
- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\layout\groupingStoreAdapter.ts`
  - commit は同期かつ原子的で、成功後の永続化は非同期である。
  - mutation前のticket/preview検証失敗はstoreを変えずに拒否する。mutation後の不一致はbefore snapshotへrollbackし、rollback自体の失敗は境界をpoisonする。
  - grouping operation lock は同期 transition 内だけのもの。複数フレームのアニメーションロックとして延長できない。
- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\workspace\TerminalPane.tsx`
  - 実ペイン root に `data-dnd-workspace-id` と `data-dnd-pane-id` があり、commit 後の着地点を特定できる。
  - `data-session-id` は active tab の後方互換値なので、移動タブの着地点主キーには使わない。
- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\workspace\WorkspaceView.tsx`
  - layout 変更後に `mycmux:terminal-layout-change`、表示変更時に `mycmux:workspace-visibility-change` が発火する。
  - `MAX_MOUNTED_WORKSPACES = 1`。非アクティブ workspace の全実ペインを同時には測れない。
- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\common\OverlayShell.tsx`
  - open/closing 中は背景が inert になる。閉じアニメーションは120msであり、これを適用モーション全体へ延長すると操作を奪う。
  - unmount 時に元フォーカスへ戻すため、成功着地時のフォーカス方針と競合する。
- `C:\Users\miyaz\cmux-for-linux-dev-master\src\components\layout\TabGroupingPanel.css`
  - panel ancestor は `overflow:hidden`。既存 SVG をそのまま panel 外へ伸ばせない。
  - drag ghost には fixed、top layer、`pointer-events:none` の先例がある。

## 3. 2案比較

| 観点 | 案A: AppShell 常駐フライト・プロキシ（推奨） | 案B: 実ペイン FLIP 主導 |
|---|---|---|
| 決定済み体験 | 図内の同じチップが panel 外へ出て実ペインへ着地する | 図内チップを途中で実ペイン wrapper へクロスフェードし、実ペインを FLIP で収める |
| 予告線との一致 | 既存 path を直接サンプリングするため強い | 実ペインの first/last rect 間が別軌跡になりやすい |
| 座標系 | preview local → viewport CSS px → real pane rect | preview local と実 DOM FLIP の2機構が必要 |
| PTY安全性 | terminal DOM に触れず最も安全 | PTYは切らないが xterm/WebGL/native WebPane の表示負荷が高い |
| 失敗の逆走 | commit 前のプロキシを同じサンプル列で逆再生できる | commit 後の実 DOM を戻すとデータ rollback と見た目の同期が難しい |
| 29タブ | 小さいプロキシの transform/opacity に限定できる | 大面積 terminal の composite、ResizeObserver、fit と競合する |
| 新規／非表示ペイン | proxy の fallback 着地点を定義できる | first rect がなく FLIP 不能 |
| 実装量 | 中〜大。controller、常駐host、座標bridge、設定、試験 | 大。左記に加えて terminal/native pane ごとの例外処理が必要 |
| 新依存 | 不要 | 不要だが独自 FLIP 基盤が必要 |

案Bも「図から実画面へ連続着地」という決定済みの形は守る。しかし、実 terminal 全体を動かすことで、予告と違う軌跡、resize負荷、非表示 workspace、新規 pane の問題が増える。主方式にはしない。案Aの最後に100ms以下の静かな pane 枠強調を添える程度なら、FLIPの限定利用は可とする。

## 4. 推奨案Aの座標ブリッジ

### 4.1 適用開始時に凍結するもの

「適用」押下時、panel の closing や applying scale が始まる前に次を一度だけ採取する。

- `MeasuredGroupingMoveLine[]`
- side-by-side container の `getBoundingClientRect()`、`clientWidth`、`clientHeight`
- before/after チップの中心と寸法
- ticket の `expected.tabs[tabId]` が持つ宛先 `(workspaceId, paneId, sessionId)`
- 開始時 `layoutRevision` と ticket identity
- 有効モーション設定と `prefers-reduced-motion`

SVG local 座標から viewport 座標への変換は次の意味で統一する。

- x: container 左端 + local x × container 実幅 / SVG clientWidth
- y: container 上端 + local y × container 実高 / SVG clientHeight
- 単位は WebView2 の CSS px。`devicePixelRatio` は掛けない。

開始後は preview の scroll、resize、DPI変更に追従して経路を作り直さない。作り直すと予告線と実行線が変わるためである。window resize、DPI変更、visibility change が来たら、データは保ったまま演出を最終状態へ即時収束する。

### 4.2 既存経路を同一にする方法

図内区間は、現在 SVG に渡しているものと同じ path を使う。

- `routePoints` がある線: `groupingMoveLineRoutePath()` の polyline
- 通常線: `groupingMoveLinePath()` の cubic
- `leadIn` がある線: main path の後へ `groupingLeadInPath()` を連結

同じ `d` を非表示の SVGPathElement に与え、`getTotalLength()` と `getPointAtLength()` で開始時にサンプルする。フレーム中に path 計算はしない。

線はチップの辺から始まるので、path point にチップ中心をそのまま置くと開始時に半チップ分跳ぶ。チップ中心と path 始終点の差を進捗に合わせて補間し、最初は before チップ中心、図内区間の最後は after チップ中心へ厳密に一致させる。連続性の受入値は handoff 前後1px以下とする。

### 4.3 実ペインの着地点

commit 前に対象 workspace の layout event listener を設置する。commit 成功後、次の順で実着地点を確定する。

1. `mycmux:terminal-layout-change` または `mycmux:workspace-visibility-change` を待つ。
2. `(data-dnd-workspace-id, data-dnd-pane-id)` が完全一致する実ペイン root を探す。
3. full/slim tab bar に移動タブの `data-tab-id` があれば、そのタブ pill を第一着地点にする。
4. compact tab bar、新規 pane、inactive tab で pill がなければ、実ペイン root の tab bar 側中央を着地点にする。
5. 2フレーム連続で矩形差が1 CSS px未満なら確定する。待機上限は100ms。

100msで確定できなければ待たせない。測れた最新の pane rect、workspace navigation の順に fallback し、どちらもなければ proxy を短く fade して演出を終える。commit 成功自体は取り消さない。

図内 path の終端から実着地点までは、終端接線を維持する cubic bridge を加える。これは予告 path の置き換えではなく、図という模型から実画面へ抜ける後半区間である。図内区間は既存予告 path と bit-for-bit 同じに保つ。

## 5. タイムラインと状態境界

目安は総計240〜300ms。タブ数で総時間を延ばさない。

| 時点 | 見た目 | 論理状態 |
|---|---|---|
| 0ms | before チップと同じプロキシを作り、元チップだけ隠す | ticket・path・開始revisionを凍結 |
| 0〜80ms | プロキシが図内の既存 path を進む | storeはまだ変更しない |
| 約80ms | 動きを止めず seam を通過 | revision/ticketを再確認し、同期commitを一度だけ実行 |
| commit失敗 | 現在位置から同じ path を逆走 | dataがbeforeへ復旧済みならpanelを残す |
| commit成功 | proxyは図内後半を進行。背面で実layoutをsettle | 永続化ackは待たない |
| 約100〜180ms | panelとDashboardが既存120ms以内で退く | modal/inertを延長しない |
| 約120〜300ms | 同じproxyがbridgeを進み実paneへ着地 | 背景は操作可能、proxyは非操作 |
| 終端 | proxyを消し実pane/tabを表示 | animation stateを破棄 |

状態は概念上、`idle → snapshot → diagram-flight → commit-seam → landing-wait → bridge → settle`。失敗時だけ `diagram-flight/commit-seam → reverse → idle` へ戻る。

grouping runtime の operation lock は commit の同期区間だけで取得・解放する。アニメーション全体を lock しない。アニメーション側は別の generation token を持ち、遅延 callback は token 不一致なら何もしない。commit は token ごとに最大1回とする。

## 6. panel・Dashboard・実画面の引き継ぎ

現在の `TabGroupingButton` は Dashboard 内にあり、Dashboard を閉じると panel と ghost も一緒に unmount される。このため motion host は Dashboard conditional の外、AppShell が生存する themed root 直下に置く。

host の責務は次だけに絞る。

- 凍結済み snapshot と軽量プロキシを保持する。
- fixed viewport layer へ portal する。
- `aria-hidden="true"`、`pointer-events:none`、非focusableとする。
- 1本の rAF で全プロキシの transform/opacity を直接更新する。
- 完了、取消、token不一致で rAF、listener、DOM proxyを必ず除去する。

commit 成功後に panel と Dashboard へ退場要求を出す。panel の closing 120msは延長しない。既存 applying の全面ラベルと body scale は本motionと同時に出さない。主役の動きを1本にする。

成功時は `OverlayShell` の通常focus restoreをそのまま発火させると、着地後にDashboard内の元ボタンへフォーカスが戻る可能性がある。成功handoff時だけ、消滅するDashboard内要素への通常restoreを抑制する。

motion controllerはbridge中にfocusを書かない。modal解放後のcapture phaseでpointerdown、keydown、focusinを数えるhandoff専用input generationを持ち、ユーザー入力が1回でもあれば以後のfocus writeを禁止する。入力がなく、`document.activeElement` がbodyまたは切断済み要素の場合だけ、storeが選んだactive paneのtab/rootへ一度focusする。既存の `focusRevision` はactive pane変更中心であり、同一pane内の全操作を表せないため単独の判定材料にしない。

## 7. PTYを切らない設計

tear-out から転用するのは次の考え方だけである。

- sessionIdを不変にし、表示責務だけを移す。
- targetの受入準備後にsource表示を外す。
- commitを一度だけ成立させる。
- 失敗前はsourceを保持する。

`C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\src\window_registry.rs` 自体、adoption queue、window ownership transferは使わない。tear-out は別WebViewでxtermを再attachする仕組みであり、図から実ペインへの視覚プリミティブではない。

適用モーション中に禁止する操作は次である。

- `killSession`
- sessionIdの再採番
- terminal cacheの明示evict
- xterm DOM/canvasのportalへのreparent
- terminal screenshot、canvas clone、live pane全体のtransform
- native WebPaneの毎フレームbounds更新を起こす処理

grouping commitはworkspace snapshotとselectionの差し替えだけに留める。React上の再配置でXTermWrapperが一時unmountしても、既存terminal cacheと同じsessionIdで再attachする契約を使う。

## 8. 失敗・巻き戻し・割込み

### 8.1 commit 前の陳腐化

開始 `layoutRevision`、ticket、plan identityがseam直前に一致しなければcommitしない。現在位置から同じサンプル列を逆走し、panelを残して既存の再prepare導線を出す。

### 8.2 commit が失敗し、before復旧が確認済み

`preview_stale`、`commit_mismatch`、通常のcommit失敗で実stateがbeforeへ戻っている場合は、同じpathを現在位置から逆向きに再生する。元チップを再表示してからproxyを外し、既存error/statusをpanel内に残す。

### 8.3 rollback_failed / poisoned

実stateがbeforeと確認できないため、元へ戻ったように見せてはいけない。proxyをその場で短くfadeし、panelを閉じず、境界封印と復旧不能の既存errorを表示する。これは「巻き戻しの動き」よりデータ事実を優先する例外である。

### 8.4 commit 成功後の永続化失敗

`pending → failed/deferred` はメモリ上の適用失敗ではない。着地は最後まで進め、逆走しない。既存durability警告と再試行状態を残す。

### 8.5 ユーザー操作・外部変更

- seam前のEscape／backdrop close: commitせず80ms以内の短いreverseまたはfadeでproxyを除去し、その後は閉じる意思を尊重してpanelとDashboardのcloseを完了する。
- seam前の外部layout revision変更: commitせずreverseし、panelを残してstale/reprepare導線を出す。
- seam中: 既存の同期operation guardに任せる。二重commitしない。
- seam後のworkspace切替、pane drag、resize、DPI変更、visibility変更: ユーザー操作を優先し、motionだけを最新終端へsnapまたはfadeして破棄する。rollback/undoは呼ばない。
- 2回目の「適用」: generation tokenで無視し、commitは1回だけ。

成功後にrollbackすると、その後のユーザー操作を古いsnapshotで上書きするため禁止する。

## 9. アニメーションを切る設定

アプリ設定の既定はオンを推奨する。今回の機能価値そのものが予告から着地までの連続性であり、初回から見えるべきだからである。

- 設定名案: `タブ再配置の適用時に動きを表示`
- 配置案: `設定 > 表示 > 通知とレイアウト > レイアウト`
- 補足文案: `オフにすると、配置図から実画面への移動を省略して即時に切り替えます。Windows のアニメーション効果をオフにしている場合も動きません。`
- 永続化先: 既存 `C:\Users\miyaz\cmux-for-linux-dev-master\src\stores\settingsStore.ts` のversioned Zustand persist

有効判定は「保存設定がオン AND OSがreduced motionではない」。OS設定を強い側とし、アプリ内設定で強制オンにはできないようにする。`matchMedia('(prefers-reduced-motion: reduce)')` のchangeにも追従する。

設定オフ／reduced motion時は、経路proxyを作らず同期commitする。成功ならpanelとDashboardを即時に退かせ、実paneの最終状態を表示する。失敗ならpanelを残してerrorを表示する。点滅・pulse・自動スクロールを代替演出にしない。

## 10. 通知・Undo・永続化表示

置き換えるのは視覚的な成功文「再配置を適用しました — Nタブ移動」。次は削除しない。

- screen reader向けの visually-hidden `aria-live="polite"` 成功通知
- Undoの操作可能期間と「変更内容を見る」
- durabilityの `pending / failed / deferred`
- boundary poisoned、rollback失敗、commit失敗

現状のDashboard下部status barはflex領域を取り、panel退場時に現れると実ペイン高さを変える。着地中のlayout shiftを避けるため、成功文とUndoだけの表示はlayoutを取らない小型overlayにするか、着地前から同じ高さを予約する。安全警告は省略せず、着地後も常に見える経路へ移す。

永続化完了までpanelを残す案は採らない。commit成功後の保存は非同期であり、待たされる感じを生むためである。

## 11. 性能見積もりと上限

29タブ環境での設計予算:

- proxy: terminal内容を含まない軽量チップ最大29個
- scheduler: 全proxyで1本の rAF
- frame中の処理: 時刻計算1回、各proxyのtransform/opacity writeのみ
- layout read: 開始snapshot時とcommit後の着地点確定時だけ
- React state更新: phase境界だけ。毎frameは0回
- path計算: 開始時に既存pathを12〜16点程度へサンプル。frame中は再計算しない
- duration: 240〜300msで本数非依存。長いstaggerを使わない
- visual: blur、filter、大きなbox-shadow、terminal screenshot、canvas cloneを使わない

既存pure-data試験では100タブの線計算 median 5ms以下、dragはmedian 4ms以下の基盤がある。ただしこれはjsdom/pure dataであり、WebView2のpaint、GPU、PTY応答性を保証しない。

実装便の受入目安:

- WebView2実機で60Hz時 p95 frame 16.7ms以下を目標、33ms超のframeが連続しない
- animation中のlong task 50ms超を0件
- PTY echo latencyの増分 p95 20ms以下を目標
- 29 moved tabsでproxy脱落、順序逆転、二重着地なし
- 低性能時に自動で総時間を延ばさない。frame落ち時は時刻基準で終端へ追いつく

必要なら同一宛先・同一経路だけcount chipへ束ねる縮退を追加できるが、予告線との一対一対応を変えるため初版には入れず、実機計測後の裁定とする。

## 12. 実装時に必要な検証（本便では実行しない）

### unit / component

- path始点、handoff点、実pane着地点の前後差が1px以下
- commitは連打しても1回
- commit成功の phase 順序と全cleanup
- `preview_stale / commit_mismatch` の同path逆走
- `rollback_failed` では虚偽の逆走をしない
- Escape、backdrop、unmount、resize、DPI変更、visibility change、workspace切替、pane drag、2回目Applyのstale callback無害化
- reduced motion初期値と実行中changeでproxy 0、即時収束
- 29タブで rAF 1本、毎frameReact rerender 0、終了後queue/listener/ghost 0

### 実Tauri / Windows

- 長時間出力する対象sessionの sessionId とPTY PIDが前・中・後で同一
- 入力echoが継続し、sequence欠落・重複なし
- scrollback markerが移動後も残る
- 実WebView2で29タブのframe/long-task/PTY latencyを測る
- 動画または連続screenshotで、予告path上の開始、viewport handoff、実pane着地を確認する

既存テストは静的軌跡、rollbackデータ、100タブpure性能、PTYメタデータ保持までは保証するが、上記の視覚連続性と実PTY連続性は未保証である。技術unit PASSだけで最終受入にしない。

## 13. 親・宮崎さんの裁定が必要な論点

### 論点1: 非アクティブworkspace宛ての着地規則

現構造では実ペインが同時mountされるworkspaceは1つだけである。全宛先workspaceを順番に開くと、操作を奪い、待たせる要件に反する。

推奨裁定:

- commit後のfocus workspaceをhero着地として実ペインまで運ぶ。
- 同じvisible workspace内は各実tab/paneへ着地する。
- 非active workspace宛ては宛先workspace単位に束ね、実画面のworkspace navigation位置へ吸収する。データ上の最終pane配置はcommit済みである。

これは「図から実画面へ連続着地」を別案へ変えるものではなく、同時に存在しない実ペインの表示規則である。「全タブが必ず各実ペインへ見えて入る」を必須にする場合は、workspaceを順次切り替える別仕様が必要になるため、A1の「操作を奪わない」と両立しない。

### 論点2: workspace内移動の予告経路

現在の `groupingMoveLines()` はworkspace間移動だけを線にし、workspace内のpane移動には予告線がない。「予告と同じ軌跡」を全移動へ適用するには定義を足す必要がある。

推奨裁定:

- 既存workspace間線は変更しない。
- workspace内移動だけ、確認図でafterチップ位置までの局所pathを加える。
- 実行時はその追加pathを同じく凍結利用する。

予告なしで実行時だけ線を発明する案は採らない。

### 論点3: 設定の既定値

推奨はオン。OS reduced motionは常に優先してオフ。最終決定は親・宮崎さん。

### 論点4: 多数タブ時の束ね表示

初版は29個を個別に保つ。実WebView2の性能ゲートを落とした場合だけ、同一宛先・同一経路をcount chipへ束ねる。予告との対応が変わるため自動縮退として先に入れない。

## 14. セルフレビュー1周目 — 設計項目1〜5

- [x] 1. 図座標からviewport CSS px、commit後の実pane rectまでの変換とhandoffを定義した。
- [x] 1. panel/Dashboard退場、AppShell常駐host、同一path、接線連続bridgeを定義した。
- [x] 2. PTY/sessionId不変、terminal DOM非対象、tear-outから転用する思想と非転用部分を定義した。
- [x] 3. commit前失敗の逆走、rollback_failed例外、commit後操作の演出取消を定義した。
- [x] 4. アプリ設定、既定オン提案、OS reduced motion優先、即時経路を定義した。
- [x] 5. 29タブのframe/read/write/React/PTY予算と実機受入目安を定義した。
- [x] 2案を比較し、案Aを推奨した。
- [x] 判断が割れる4論点を親・宮崎さん裁定として分離した。

1周目判定: PASS。

## 15. セルフレビュー2周目 — 境界・決定済み形・Git

- [x] 実装コード、テスト、設定、依存、コミットを変更していない。
- [x] 書き込みは `C:\Users\miyaz\.claude\dispatch\260829-grouping-ux\report_A1.md` のみ。
- [x] 2案とも「図で動き始め、そのまま実画面へ引き継いで着地」を維持し、図だけ／実画面だけの別案へ戻していない。
- [x] 既存予告線を壊さず、workspace間は流用、workspace内は親裁定の追加扱いとした。
- [x] 新依存なしを前提にした。

開始時 `git status --porcelain`:

```text
warning: could not open directory 'pytest-cache-files-ueu0ljs1/': Permission denied
 M src-tauri/Cargo.toml
?? docs/mobile-chat-design-260829.md
```

最終確認でも同じ2件が残っている。いずれも本便開始前から存在する別作業であり、本便では変更・削除・stageしていない。したがって spec 記載の「porcelain が空」は文字どおりには満たせないが、task-scoped のrepo変更は0件である。既存差分を消して空にする操作は、本便の禁止範囲と他作業保護に反するため行わない。

2周目判定: 設計境界はPASS。ただしspecのliteralなrepo-cleanゲートは先行dirtyのためBLOCKED。本便のrepo変更は0件で、決定済み形は維持した。親が「開始時と同一かつtask-scoped変更0件」を代替ゲートとして裁定した場合のみDONEへ変更できる。

BLOCKER_A1
