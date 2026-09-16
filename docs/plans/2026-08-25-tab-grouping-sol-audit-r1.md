# SOL independent audit — tab grouping round 1

Verdict: REJECT

監査日: 2026-08-25  
対象 repo: `C:\Users\miyaz\cmux-for-linux-dev-master`  
対象 commits: `0fddbe2`, `2e851f6`, `cc31963`, `e46cc75`, `43d8001`

## 結論

対象15 unit tests、TypeScript、全 Vitest、全 pytest、品質契約、Windows Rust wrapperは通過した。しかし、通常UI経路で旧提案・DEADタブを再適用できる状態遷移、フォーカス追従元の消失、空WSに移動済みsession identityが残る問題、undo snapshotの破棄、再生成後1案フォールバック不能がある。加えて、EditedProposalの不整合入力ではタブをstoreから消すfail-open経路があり、成功直後の画面も適用済み状態をstale blockerとして表示する。同日リリースの安全条件を満たさない。

## 監査方法と境界

- 一次資料 `docs\plans\2026-08-25-tab-grouping-plan.md`, `AMENDMENT_tab_grouping.md`, `GROK_DONE_tab_grouping.md` を直接通読した。
- 5 commitsを個別に `git show` / `git diff-tree` で確認し、新規ファイル全行と既存ファイルの全変更行を読んだ。
- 現行HEAD `024579d57f4306cac44f98fa66b2a74869b9309d` は対象scopeのblobを `43d8001` 以降変更していない。
- 指定5 commits自身の変更先は監査指示の11パス内だけで、削除・rename・境界外writeはなかった。
- dirty worktreeのsocket/bridge/integrations等は内容監査・修正を行っていない。
- grouping経路に `pane.close_tab`, `pane.close_tabs`, `killSession`, `removeWorkspace`, native/right-click menu, `window.confirm`, `window.alert` の呼出しはなかった。Rust grouping armもtimeout選択だけでPTY/layoutを変更しない。

## Findings

### A. 仕様・schema・分析パイプライン

#### [A-01][Severity: Blocker][src/components/layout/tabGrouping.ts:1003]

EditedProposalの `disposition="reorganize"` + `destination.kind="current_locations"` + 非null layoutを `validateEditedPlan` が拒否しない。compileはgroup.tabIdsを元ペインから除去する一方、destination分岐はnew/existingしかないため再挿入せず、消失後の状態からexpectedを作る。commit後照合も成功する。

再現: t1を含むadopted reorganize groupのdestinationだけcurrent_locationsへ変えてcompile/commitする。t1はworkspace storeから消える。「配置だけを変え、タブ/PTYを閉じない」という最上位安全条件に違反する。現UI helperは通常この形を作らないが、EditedProposal→compile境界がfail-closedではない。

#### [A-02][Severity: Critical][src/components/layout/TabGroupingPanel.tsx:181]

再分析開始時に `plans` は空にするが、`selectedPlanId`, `editedByPlan`, `selectedTabIds`, popup状態を消さない。新分析がinvalid/0-liveでも旧 `edited` が残り、Apply gateは `plans.length===0` と `parseError` を見ない。新scanだけが保存される。

再現: 初回分析成功→「やり直す」→pty snapshot失敗または全terminal DEADでinvalid→旧案の確認/適用。新baselineが空でもedited validatorは未知appearanceを拒否せず、workspaces上に残るDEAD tabを旧案で移動できる。DEAD除外とregeneration safetyを同時に破る。

#### [A-03][Severity: High][src/components/layout/tabGrouping.ts:829]

「再生成後も有効1案なら比較不足を明記して表示」が到達不能。parserはtop-level plansが1件だとplan検証前に全体invalidにするため、2回目が完全にvalidな1 planでもstatus invalidになる。

再現: 1回目invalid、2回目 `schemaVersion:1, plans:[validPlan]`。期待は1案表示、実際は「plans は2〜3件」。

#### [A-04][Severity: High][src/components/layout/tabGrouping.ts:697]

schema検証がfail-open。keepのlayout省略をnull相当で受理し、warnings省略を空配列へ変換し、非string rationaleを空文字へ変換し、group.tabIds/unassignedTabIdsの非string要素をfilterで捨てる。

再現: otherwise-valid responseでkeep.layoutを省略、rationale=7、warnings省略、unassignedTabIdsへ数値を混ぜる。planはdropされずvalidになる。plan単位invalidという仕様を満たさない。

#### [A-05][Severity: Medium][docs/plans/2026-08-25-tab-grouping-plan.md:87]

実装schemaは仕様にない `group.tabIds` を導入し、keepでは必須にしている。prompt例とtestsもこの拡張を正本扱いする一方、plan/amendmentは更新されていない。

再現: 仕様どおりlayout=nullのkeep groupを、仕様記載フィールドだけで返す。実装はkeep.tabIds空としてplanをdropする。必要なschema変更なら仕様側の改訂が先に必要。

#### [A-06][Severity: High][src/components/layout/tabGrouping.ts:763]

新WS名の重複禁止が初回AI案の新規名同士にしか効かない。既存WS名との衝突を検査できず、編集後validatorは新規名同士の重複さえ検査しない。

再現: 既存WS「案件甲」に対してnew_workspace proposedName「案件甲」を返す、またはUIで「新しいグループ」を2回作る。Applyが通り同名WSが複数生成される。

#### [A-07][Severity: Medium][src/components/layout/tabGrouping.ts:241]

「固有名詞のみalphabet可」を有限denylistで近似しているため、`deploy`, `release`, `frontend`, `backend`, `docs`, `monitor` など一般語が通る。逆に `GPT-5`, `Node.js` など正当な固有名詞は許可文字で落ちる。

再現: `isJapaneseGroupingName("deploy")` はtrue。amendmentの一般英単語日本語化を機械強制できない。

#### [A-08][Severity: Medium][src/components/layout/tabGrouping.ts:551]

scanで収集した `labelSource` をprompt payloadへ含めていない。plan §4.1の分析入力要件と不一致で、人手ラベルとAIラベルをモデルが区別できない。

再現: label文字列が同じuser-labelled tabとAI-labelled tabを用意する。送信JSONは同一のlabel情報になり、信頼度の異なる手掛かりが消える。

#### [A-09][Severity: Medium][src/components/layout/tabGrouping.ts:574]

promptのschema説明にpane roleの全enumとwarning code/object contractがなく、retryも同一promptをそのまま再送してparser issueを伝えない。

再現: modelが自然にrole=`main`やwarning=`TOO_MANY_TABS`を返すとplan drop。2回目も同じ不完全説明なので同じ欠陥を再現しやすい。

#### [A-10][Severity: Medium][src/components/layout/tabGrouping.ts:461]

pty metadata snapshotの一時取得失敗を `snapshot_unavailable` として全terminal除外し、実際のall-DEADと「判定不能」を区別しない。

再現: `getPtyMetadataSnapshot()`だけ一時失敗。全terminalが「生きたターミナルなし」となり、原因説明も再試行案内も出ない。

### B. compile・transaction・focus・undo engine

#### [B-01][Severity: Critical][src/components/layout/tabGrouping.ts:1451]

通常のDashboard経路で表示タブ追従元を失う。`DashboardView.tsx:425-428` はmount時にactivePaneIdをnullへするが、commit depsはactivePaneIdだけを読み、uiStore.lastActivePaneIdを使わない。`displayedTabId` はnullならactive WSの先頭paneを選ぶ。

再現: active WSのpane2/t2を表示中にDashboardを開く→t2を再配置→Apply。t2ではなくpane1/t1を表示元としてfocusWorkspace/sessionを計算し、移動したt2へ追従しない。snapshotのactiveSessionIdもnullになる。

#### [B-02][Severity: Critical][src/components/layout/tabGrouping.ts:1035]

移動前の表示タブが新しい同一pane内の2番目以降に置かれると、expected focusSessionIdはそのタブなのに `paneFromTabs` は先頭tabをactiveTabId/sessionIdに固定する。TerminalPaneはactiveTabしか描画しない。

再現: active=t2、AI pane.tabIds=[t1,t2]。store active sessionはt2、画面はt1。DOM focus/fit対象がなく、直後入力先を保証できない。

#### [B-03][Severity: Critical][src/components/layout/tabGrouping.ts:1055]

全タブ移動で空WSを残すと、先頭paneはtabs=[]になるだけで `pane.sessionId`, `activeTabId`, agent metadataが移動済みtabのまま残る。移動先にも同じsessionIdがあり、session ownershipが二重化する。

再現: ws-a唯一のt1/session-t1を新WSへ移動→空ws-aを選択。workspaceContainsSessionは空paneのstale sessionを有効とみなし、setActiveWorkspace/focus DOM queryは別WSのPTYと同じIDを扱う。

#### [B-04][Severity: High][src/components/layout/tabGrouping.ts:1055]

同じ既存WS内で全タブを新しい末尾列へ再編すると、除去段階で温存した空paneを合流後に再度pruneしない。

再現: ws-a唯一のpaneの全tabをdestination=existing_workspace/ws-aへ再編。結果は `[空pane, 新pane]` となり、「空ペイン整理」に反する。

#### [B-05][Severity: High][src/components/layout/tabGrouping.ts:1152]

compilerのproduction defaultがuuid、Date.now、pet store、Math.randomを読むため純粋・決定的でない。Panel previewとApplyは別々にcompileする。

再現: 同一EditedProposal + 同一workspacesを続けてcompile。新WS ID、createdAt、petが変わり、確認画面で見たtransactionと実際にcommitするtransactionが同一でない。

#### [B-06][Severity: High][src/components/layout/tabGrouping.ts:987]

EditedProposalで `group.tabIds` とlayout tabIdsの一致を再検証しない。validatorはlayoutのappearanceを数えるが、compile targetはgroup.tabIdsから作るため、`moved.get()` がthrowし得る。Panelのpreview useMemoにcatchがない。

再現: reorganize groupをgroup.tabIds=[t1], layout=[t2]、keep=[t1]にする。appearance検査は通り、compileが `missing moved tab t2` をthrowしてパネル描画を落とす。

#### [B-07][Severity: High][src/components/layout/tabGrouping.ts:1157]

分析後に合流先WSが消えた場合、classifyStaleより先のedited validationで一般errorを返すため、`workspace_missing` staleとして全数列挙されない。

再現: AI案のexisting destinationを分析後に削除してApply。返るのはerrorsのみ、stale=[]。stale分類表と編集復帰表示が一致しない。

#### [B-08][Severity: High][src/components/layout/tabGrouping.ts:1288]

post-commit expectedResult照合はtabId→workspace/pane/sessionだけ。focusWorkspaceId/focusSessionId、pane.activeTabId/sessionId、splitColumns、空/new WS保持、metricsを検証しない。focus setterを呼んだ後の実状態照合もない。

再現: replaceWorkspaces dependencyがタブ所在だけ保ってsplitColumnsからpaneを落とす、またはsetActiveWorkspace/applyActivationをno-opにする。commitは成功扱いでrollbackしない。

#### [B-09][Severity: High][src/components/layout/tabGrouping.ts:1494]

rollback成功を照合せず、rollback自体の例外を封じ込めない。mismatch pathのrestoreがthrowすればAPI外へ漏れ、catch内restoreが再度throwしても同様。

再現: replaceWorkspacesを「毎回破損」または「毎回throw」にする。部分適用を回収できず、`commitGroupingPlan` の結果型を返さない。

#### [B-10][Severity: High][src/components/layout/tabGrouping.ts:1339]

snapshotはlastActivePaneByWorkspaceを捕捉するがrestoreしない。layoutSignatureはcolumnWidths/rowHeights、tab label、color/pet/status、agent/resume metadataを含まないため、それらの後続変更をundoが古いsnapshotで上書きする。一方activeTabId変更はsignatureに含むため、単なるtab選択でundoを失効する。

再現: Apply後にsplitter resizeまたはtab rename/metadata sync→Undo。監視は失効させず変更を巻き戻す。別tabをクリックしただけの場合は逆に「レイアウト変更」と誤判定してUndo不能になる。

#### [B-11][Severity: Medium][src/components/layout/tabGrouping.ts:313]

新WS factoryをcreateWorkspaceと共有せず、petロジックとworkspace組立てを複製している。grouping側はcolor normalizationを通さず、metricsを常に等分値へ設定する一方、createWorkspaceはshape-valid options以外をundefinedにする。

再現: factory規約を片側だけ変更、またはmetrics/color parityを比較する。生成objectが同一規約にならず、plan §4の共有要件を満たさない。

#### [B-12][Severity: Medium][src/components/layout/tabGrouping.ts:1213]

各group layoutの4列上限しか見ず、既存WS列との合計・同一WSへ複数groupを合流した最終列数を検証しない。gridTemplateForは4へclampするがsplitColumnsは超過したまま。

再現: 既存4列WSへ1列groupを合流。splitColumns=5列、grid template=4列相当となる。

#### [B-13][Severity: Low][src/components/layout/tabGrouping.ts:358]

duplicate tab IDをMap/Recordで後勝ちにし、source removalはID一致の全copyへ効く。

再現: 異なるsessionIdの2 tabが同じid=`dup`の復元stateを読み込む。compileは両copyを外し、Mapに残った1copyだけ再挿入する。壊れた入力stateをfail-closedに拒否しない。

#### [B-14][Severity: Medium][src/components/layout/tabGrouping.ts:1080]

タブが1件でも出入りした既存WSは `applyEqualMetrics` で全columnWidths/rowHeightsPerColを既定等分へ置換する。既存WS合流は末尾列追加だけ、既存タブは再編しないというv1制約に対し、無関係な既存列のユーザー調整幅まで失う。

再現: 2列WSを70:30へresize後、片方のpaneから1 tabだけ新WSへ移動する。残る列・paneの構成に関係なく幅と各行高がすべて既定値へ戻る。

### C. UI state machine・editing・表示

#### [C-01][Severity: Critical][src/components/layout/tabGrouping.ts:1420]

Undoバーの×が表示だけでなく唯一のsnapshotを `undoMemory=null` にして破棄する。Panelの「直前の再配置」はundoが存在する時だけ描画され、押してもrevisionを増やすだけ。

再現: Apply→×→Panel内で再呼出し。button自体が消え、復元不能。plan §4.4の「×で閉じてもパネル上部から再呼び出し可」に反する。

#### [C-02][Severity: High][src/components/layout/TabGroupingPanel.tsx:594]

Undoバーの「変更内容を見る」はmode=confirmにするだけで保存済みreport/snapshotを表示しない。適用後live layoutと適用前baselineを再compileするためstaleになり、currentへfallbackする。

再現: Apply→変更内容を見る。直前diffではなく「状態が変わったため適用不可」またはcurrent相当が出る。

#### [C-03][Severity: High][src/components/layout/TabGroupingPanel.tsx:155]

selectedTabIdsとpopup状態がplan/group/reanalysisにscopeされずclearされない。

再現: plan Aでt1選択→plan Bへ切替→編集→移動先を選ぶ。plan Bのt1が意図せず移る。再分析でt1が対象外になった場合も未知IDを新案へ注入できる。

#### [C-04][Severity: High][src/components/layout/TabGroupingPanel.tsx:441]

編集画面はunassigned tabを表示せず、誤分類tabをunassigned/除外へ移す操作もない。pane指定UIもなく `reassignTabs` のpaneTitleは常に未使用で既定pane固定。

再現: AIがt1をunassignedにする、またはユーザーがt1だけ除外・第2paneへ移したい。画面から操作できず、仕様の主要編集経路を満たさない。

#### [C-05][Severity: High][src/components/layout/TabGroupingPanel.tsx:247]

Apply失敗時にstatusをerrorへ更新せず「適用しています…」のまま。parseErrorはcompareでしか描画されず、強制遷移先editでは見えない。stale詳細はconfirmだけ、mismatch/exceptionはedit footerにも出ない。

再現: expectedResult mismatchまたは複数staleでApply。編集画面に戻るが理由全件が表示されず、statusも誤る。

#### [C-06][Severity: High][src/components/layout/TabGroupingPanel.tsx:319]

plan.warningsはカードの件数にしか使わず、code/message/tabIdsをcompare/edit/confirmのどこにも描画しない。

再現: `EXISTING_WORKSPACE_CONFLICT` や `LOW_CONFIDENCE` が特定tabを指す案を返す。ユーザーは対象と本文を確認できない。

#### [C-07][Severity: Medium][src/components/layout/TabGroupingPanel.tsx:366]

group error用CSS `is-error` を一度も付けず、footerも先頭errorしか表示しない。

再現: 1-tab paneのtabを別groupへ移してsource paneを空にする。Applyは止まるがgroupは赤くならず、修正対象を特定できない。空pane/groupを削除するUIもないため詰む。

#### [C-08][Severity: Medium][src/components/layout/tabGrouping.ts:885]

destinationをcurrent_locationsへ変えるとlayoutをnullに捨て、再びnew/existingへ戻すと1列1pane defaultを作る。AI骨格と編集済みpane構成を保持しない。

再現: 3列案→現状位置→新WS。元の3列編集は失われる。「戻れるモード切替・編集状態保持」の期待とずれる。

#### [C-09][Severity: Medium][src/components/layout/TabGroupingPanel.tsx:587]

Apply後Undoバーに空WS件数と「確認する」がなく、適用前summaryだけに件数がある。`inspectEmpty` copyは未使用。

再現: 全tab移動で2 WSが空→Apply。完了バーは移動数しか示さず、空WS個別確認・削除への導線がない。

#### [C-10][Severity: Medium][src/components/layout/TabGroupingPanel.tsx:574]

全group保留/0移動でもApplyを有効にし、全workspacesをcloneしてreplaceし、0移動Undoを作る。

再現: 全groupを保留→Apply。「再配置を適用しました — 0タブ移動」と表示し、不要なtransaction/購読通知を発生させる。

#### [C-11][Severity: Medium][src/components/layout/TabGroupingPanel.tsx:175]

分析requestにgeneration guardがなく、古いrequestのcatch/finallyが新requestのstateとactiveRequestRefを上書きする。

再現: 分析A→再分析Bまたはclose/reopen→Aが遅れてreject。AがBのrequestIdをnullにし、Bをclose時にabortできず、古いerror/statusが表示される。

#### [C-12][Severity: Medium][src/components/layout/TabGroupingPanel.css:309]

Apply中lockはbodyのpointer-eventsだけ。keyboard操作、headerのmode/close、footerの再分析は有効で、reduced-motionでもJSの500ms lockは残る。

再現: Apply直後にTab/Enterで再分析またはmode変更。layout適用中のUI stateと競合する。

#### [C-13][Severity: High][src/components/layout/TabGroupingPanel.tsx:297]

主要選択UIのaccessibility stateが欠ける。案カードはradio/aria-pressedなし、stepはaria-currentなし、tab複数選択とconfirm viewはaria-pressedなし。popoversはaria-haspopup/expanded/controls、role、focus移動/返却、外側click/Escape処理がない。

再現: keyboard/screen readerだけで案比較→tab付替え。現在選択中の案/tab/viewとpopup状態を判別できず、EscapeはpopupでなくOverlay全体を閉じ得る。

#### [C-14][Severity: Medium][src/components/layout/TabGroupingPanel.tsx:110]

比較/確認previewでも全tabをactionのないbuttonとしてrenderする。

再現: 100 tabの確認画面。Tabキーで100個のno-op controlを通らないとApplyへ到達できない。

#### [C-15][Severity: High][src/components/layout/TabGroupingPanel.tsx:233]

Apply成功後もmodeはconfirm、scan/baselineは適用前のまま、live `workspaces` だけが置換される。`compiled` は即再計算され、正常に移動したtargetを `tab_moved` staleと判定するため、成功status/Undoバーと「状態が変わったため適用不可」が同時表示される。

再現: t1を別WSへ正常Applyする。store更新後の再renderでconfirm previewがcurrentへfallbackし、適用済みの正しい移動をstale blockerとして列挙する。「変更内容を見る」も同じ壊れた状態へ戻る。

#### [C-16][Severity: Medium][src/components/layout/TabGroupingButton.tsx:37]

UndoバーはPanel内部にしかなく、Panelを閉じるとcomponentごとunmountされ画面下部の固定Undo導線が消える。memoryが残っていれば再度Panelを開いた後にだけ表示されるが、plan §4.4の「適用完了直後、画面下部に固定」を満たさない。

再現: Apply直後にPanelを閉じる。Dashboard上にUndoバーは残らず、タブ再配置を開き直して再分析effectが走るまで直前操作の復元導線を見られない。

### D. Safety

#### [D-01][Severity: High][src/components/layout/tabGrouping.ts:1160]

明示的close/kill APIはないが、安全性が文字列上の「closeなし」だけでは成立しない。A-01はtabをstoreから消し、B-03/B-13はsession/tab ownershipを破損させる。PTY processをkillしなくてもUI/永続layoutから孤立させるため、no-close受入条件は未達。

再現はA-01、B-03、B-13のとおり。実sessionId全数・tab object全数がcommit前後で保存されるnegative testが必要。

### E. Tests

#### [E-01][Severity: High][tests/unit/tabGrouping.test.ts:73]

`validPlanJson` が仕様外のgroup.tabIdsを正規fixtureにし、parser testsが実装のschema逸脱を鏡写しする。仕様記載だけのkeep groupを試していない。

#### [E-02][Severity: High][tests/unit/tabGrouping.test.ts:235]

retry testは1回目not-json、2回目2 validだけ。初回1 valid、2回目1 valid、2回目0 valid、初回2 validでretryなし、3回目なしを検証せず、A-03を見逃す。

#### [E-03][Severity: High][tests/unit/tabGroupingApply.test.ts:227]

test名はclosed/session mismatch/moved/missingを主張するが、target t1はcurrent ws-bに存在し、closed t2はnon-target。期待配列にtab_closedもないためclosed blockerを一度も実行していない。

#### [E-04][Severity: High][tests/unit/tabGroupingApply.test.ts:258]

atomic commit testはreplace call countを数えず、focus/activeTab/splitColumns/pane identity/全tab fieldsをassertしない。expectedResult negativeはt2削除1ケースだけで、focus no-opや構造破損でも通る。

#### [E-05][Severity: High][tests/unit/tabGroupingApply.test.ts:274]

undo expiry testはlayout変更と同時にt9 sessionを追加するため、subscriptionが壊れてもrestore時session-set guardだけでfalseになる。same-session move、resize、rename/metadata change、tab click、再適用、×→recall、lastActivePane restoreを検証しない。

#### [E-06][Severity: High][tests/unit/tabGroupingPanel.test.tsx:8]

UI testsはSSR初期HTMLの文字列2件だけ。effect、AI invoke、3 mode遷移、edit保持、adopt/defer、reassignment、warnings、stale、Apply、rollback、Undo lifecycle、cancel raceを一切実行しない。

#### [E-07][Severity: High][tests/test_tab_sweep_command_contract.py:210]

Rust/UI契約testはsource substring検索だけ。grouping modeが同じinvokeに渡ること、abortがactive requestを止めること、exactly-once replace、close/kill不在を実行時に保証しない。文字列がcomment/dead codeへ移っても通る。

#### [E-08][Severity: Medium][tests/unit/tabGroupingPanel.test.tsx:16]

`stepConfirm` を同じ行で2回assertし、`not.toContain("font-size:9px")` は外部CSSを読まないSSR HTMLなのでfont floorを保証しない。9px自体も仕様違反ではない。

### F. Quality・copy・CSS・performance

#### [F-01][Severity: Medium][src/components/layout/TabGroupingPanel.css:44]

「token only」主張に反し、既存tokenで表現できるspacing/radius/motionを `5px 9px`, `999px`, `3px`, `2px 7px`, `220ms` などの生値で固定する。色はvar/color-mixのみで直書きはなかった。

再現: density/motion tokenを変更。grouping panelの余白・角丸・Apply transitionだけ追従しない。

#### [F-02][Severity: Medium][src/components/layout/TabGroupingPanel.tsx:84]

全workspacesを丸ごと購読し、各tabで `findTabLocation` の全layout走査、workspace.find、group.find+includesを反復する。selection/popup/highlightのlocal state更新でもpreview全件を再生成し、最悪O(T^2)。

再現: 100+ tabsで選択をtoggle。各renderでtab数分の全layout走査が走る。位置/kind Mapのmemo化とpreview分割がない。

#### [F-03][Severity: Medium][src/components/dashboard/dashboardStrings.ts:371]

「やり直す」はundoに読めるが、実際はAI再分析・編集破棄・待ち時間/課金を伴う。「再分析する」が実態に近い。CTAも見出し `3 適用前確認` を流用して命令形でなく、選択単位が「件」と「タブ」で揺れる。

再現: 編集後に「やり直す」。ユーザーのundo期待に反して編集案が消える。

#### [F-04][Severity: Low][src/components/dashboard/dashboardStrings.ts:373]

copy集約が不完全。「分析完了」「手順」「Nタブ」「新しいグループ」は直書きで、`buttonBusy`, `destinationExisting`, paneRole群, `inspectEmpty` は未使用。empty/unnamed文言もengine側と重複する。

再現: 文言・単位を一括修正しても表示/validation側に旧表記が残る。

#### [F-05][Severity: Medium][src/components/layout/tabGrouping.ts:491]

scanは全tabの `readTail` を二重loop内で1件ずつawaitし、独立なtail取得を直列化している。UIはオンデマンド分析を十数秒待つ前提だが、100 tabならAI呼出し前に100回のsocket往復を順番に待つ。

再現: 各 `readTail` が50msの100-tab fixtureではscanだけで約5秒かかる。bounded parallelまたは一括snapshotがなく、タブ数に比例して待ち時間を加算する。

### G. Commit boundary・実装者claim

#### [G-01][Severity: High][git-log:1]

指定5 commitsは連続していない。`0fddbe2` と `2e851f6` の間に対象外 `f029cea`（ailog 56 paths）があり、単純な両端diffは6 commits/67 pathsになる。

再現: `git diff --name-only 0fddbe2^ 43d8001`。監査境界証明には各5 commit patchの和集合を使う必要がある。個別commitの和集合は許可11 paths内でPASS。

#### [G-02][Severity: Medium][GROK_DONE_tab_grouping.md:41]

「5 commitsはpushしていない」は現況と一致しない。監査時のorigin/masterはHEAD `024579d` で、指定5 commitsすべてを祖先に含む。

再現: 5 SHAそれぞれで `git branch -r --contains <sha>` を実行するとorigin/masterを返す。後から別laneがpush/mergeした可能性はあるため、GROK_DONEの記録時点claimを現在のrelease境界には使えない。

#### [G-03][Severity: Medium][GROK_DONE_tab_grouping.md:15]

「既存pane idとsessionIdを保てばPTYを作り直さない」というclaimに対し、移動先paneは `tabGrouping.ts:1194` で常に新UUID。tab.sessionIdは保持するがpane idは保持せず、WorkspaceView key変更によるTerminalPane/XTerm remountが起こる。

再現: whole-pane相当のgroupも新pane IDになる。cacheがPTY processを維持する可能性はあるが、実WebViewでremount/focus/fit/入力継続を検証していないためclaimを確証できない。

#### [G-04][Severity: Low][src/components/layout/TabGroupingButton.tsx:37]

`43d8001` は命名/WSサイズfixというcommit説明に加え、Panelをopen中だけmountedにするlifecycle変更を含む。変更自体は妥当だが、commit目的とGROK_DONEの修正説明に未記載。

## Spec rules without test coverage

以下は既存testsに実行時coverageがない。部分文字列assertだけの項目も未coverageとして扱う。

1. 再生成1回目が有効1案、2回目も有効1案の場合の1案表示と比較不足表示。
2. 再生成後0案/top-level invalidでraw付き失敗し、3回目を呼ばないこと。
3. schema required fields/types全件: rationale, warnings, keep.layout exactly null, 配列内非string、unknown fieldsの方針。
4. duplicate planId/groupId/new WS name、既存WS名衝突、warning unknown tab。
5. current_locations iff layout nullのEditedProposal全組合せと、違反時にtabを1件も失わないこと。
6. edited group.tabIds/layout一致、未知ID、pane title/role、列4/ペイン4、empty column/paneの再検証。
7. labelSource、cwd、agentKind、origin、paneId、column、lastOutputAt、tail 14行・状態行除去のprompt payload。
8. lineageの入力順permutation、深いchain、複数cluster、missing/dead parent、cycle。
9. compile同一入力の完全同値、入力非変更、productionでstore/clock/randomを読まないこと。
10. new WS factoryのpet/color/split/metrics/createWorkspace parity。
11. 既存WS4列への合流、同一WSへ複数group合流、最終列/ペイン上限。
12. source=destination再編後の空pane除去。
13. 全tab移動後の空WS paneが移動済みsession/activeTab/agent metadataを所有しないこと。
14. duplicate tab/workspace/pane ID、生成UUID衝突をfail-closedにすること。
15. tab object全field、tabId、sessionId、不変対象pane IDがcommit前後で保存されること。
16. analyzed tabの真のtab_closed stale、session mismatch、manual move、missing destinationをcompile/commit経由で全数列挙すること。
17. 分析後の新規tab追加と対象外tabの追加/閉鎖/移動が現在位置に残り継続できること。
18. stale時にreplaceを1回も呼ばず、勝手に除外しないこと。
19. `_replaceWorkspaces` が成功時ちょうど1回で、逐次layout mutationがないこと。
20. post-commitでfocusWorkspace/session、activeTab、splitColumns、空/new WS保持までexpectedと一致すること。
21. 表示中tab移動時だけfocus followし、非表示tab移動ではfocus不変であること。
22. DashboardでactivePaneId=null・lastActivePaneIdのみ残る通常経路のfocus follow。
23. 移動tabが新paneの2番目以降になる場合のactiveTab/DOM focus/fit/入力継続。
24. DOM focus/fitがlayout確定後にちょうど1回で、reduced-motionでも不要な待機がないこと。
25. rollback自体のpersistent corruption/throw、rollback後のlayout/focus/selection完全一致。
26. snapshotのdeep copy、activeWorkspaceId、activeSessionId、lastActivePaneByWorkspace、selection状態の完全restore。
27. undoの手動move/tab add/tab close/reapply各失効、時間では失効しないこと。
28. undoのresize/rename/color/pet/metadata change方針と、通常tab選択で誤失効しないこと。
29. ×でbarを隠した後のPanel上部recall、Panel close/reopen後のrecall。
30. 「変更内容を見る」が保存済みbefore/after/reportを表示すること。
31. 3 mode往復とplan別edit state保持。
32. adopt/defer、keep、destination往復、all-deferred no-opのUI interaction。
33. tab reassignment exactly-once、same/cross group、cross plan、unassigned/exclude、pane指定、新group。
34. selectedTabIds/popupがplan/group/reanalysisを跨いで漏れないこと。
35. empty source groupの赤表示・全error表示・修復/削除導線。
36. plan warningsのcode/message/tabIds表示。
37. current/after/diffの3表示、既定diff、移動元label、新WS/既存WS/kept/unassigned描分け。
38. Apply failureのstale/mismatch/exception全件表示、status更新、編集mode復帰。
39. Apply中のpointer/keyboard/header/footer完全lock。
40. 空WSの「削除されません」と適用後「確認する」導線。
41. async analyzeのcancel/reopen/provider-change/late-result競合。
42. keyboard/screen-readerでradio、multi-select、view toggle、popoverを完遂できること。
43. grouping経路のstore/PTY実状態でtab/PTY closeなし、WS auto-deleteなし。
44. native/right-click menu、window.confirm/alert不使用のcontract。
45. CSS raw color禁止、Japanese font floor、theme contrast、density/motion/spacing/radius token追従。
46. 100+ tabでのrender count・preview performance。
47. Rust mode selectorのNone/judge/naming/grouping/invalid、180s timeout、actual Tauri registration/invocation。
48. 既存WSのユーザー調整済みcolumnWidths/rowHeightsを、無関係なtab移動で保持すること。
49. Apply成功直後に成功report/適用後diffを表示し、正常な移動をstale blockerへ誤分類しないこと。
50. Panelを閉じても画面下部のUndo導線が残り、再open/reanalysisなしで復元できること。
51. 多数tabのtail取得がbounded parallelで、scan時間が直列往復数に比例しないこと。

## 検証結果

- `npx tsc --noEmit` — PASS。
- `npx vitest run tests/unit/tabGrouping.test.ts tests/unit/tabGroupingApply.test.ts tests/unit/tabGroupingPanel.test.tsx` — 3 files / 15 tests PASS。
- `python -m pytest tests/test_tab_sweep_command_contract.py -p no:xonsh -p no:cacheprovider -q` — 7 PASS。
- `npx vitest run tests/unit/tokenContract.test.ts tests/unit/themeContrast.test.ts tests/unit/uiDensity.test.ts tests/unit/uiQualityTokens.test.ts` — 4 files / 588 tests PASS。
- `npx vitest run` — 204 files / 2794 tests PASS。Canvas getContext未実装warningは出たがfailなし。
- `python -m pytest tests/ -p no:xonsh -p no:cacheprovider -q` — 355 PASS。
- `python scripts/run_windows_tests.py` — PASS。RAM gate待機後 `cargo -j 2` で実行し、`931 passed / 0 failed / 10 ignored`、2 test binaries PASS。

## Positive confirmations

- scanはnon-terminal、declared、`no_live_pty_session`、`snapshot_unavailable`を分析対象外にする。
- grouping source/Rust armにclose/remove/kill APIはない。
- result workspace配列から既存WSを自動削除しない。
- 通常の移動tab objectではtabId/sessionIdを保持する。
- Rust `grouping` は180秒timeoutを選び、unknown modeは拒否する。
- Japanese textの実効font tokenはxs=11px、sm=12px、md=13pxで9px以上。
- CSS色はtheme variable/color-mixだけで、色literalはない。
- promptは全WS、lineage、3〜8 tabs/WS、小案件最大3件同居、列分離、固有名詞alphabet維持を明記する。

## What could not be verified

- 実AI CLIへのgrouping callと、実provider/modelが2〜3案を返す挙動。
- 稼働中 `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe` での分析→編集→Apply→Undo実機smoke。実行中v0.56.0は監査source buildではない。
- 実WebView/xtermでのpane remount、PTY process非再作成、focus/fit、直後入力継続。
- `git status` は `C:\Users\miyaz\cmux-for-linux-dev-master\pytest-cache-files-ueu0ljs1\` にPermission denied warningがあり、可視12 dirty entries以外の当該directory内部は確認できない。git object上の指定5 commits境界は個別diff-treeで確認済み。
