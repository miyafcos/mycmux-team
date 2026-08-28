# SOL independent audit — tab grouping round 2 (final closure check)

Verdict: **REJECT**

監査日: 2026-08-25  
対象 repo: `C:\Users\miyaz\cmux-for-linux-dev-master`  
修正 commit: `f99d78b8db3bbbbb0964bede6dd9e5df6b42d4fe`  
監査時 HEAD: `c46579c9f30fdc440c7a887564dafb3228e673ce`（`f99d78b` 後の `GROK_FIX_tab_grouping.md` への Rust test 記録追記のみ）

## 結論

round-1 の Blocker/Critical/High 32件は、`closed` 19件、`partial` 11件、`not-fixed` 2件。さらに `f99d78b` が新規 Critical を2件導入した。

1. Panel が確認画面で作った `LayoutTransaction` を commit に直接渡し、commit は適用直前の compile/stale 検査を全迂回する。確認後に閉じた対象タブを復活させ、分析後に追加された対象外タブを消しても、古い expectedResult と一致するため成功扱いになる。
2. 純粋化した既定ID factoryがcompileごとに `compile-1` へ戻る。1回目の適用で生成したpane/workspace IDと2回目が必ず衝突し、重複IDを持つworkspace配列をcommitできる。

入口 `TAB_GROUPING_ENTRY_ENABLED = false` は維持されているため、現行ソースの通常UIからこの経路は開かない。しかし本監査は未公開機能のenable gateであり、入口封印は欠陥のclosureではない。新規Critical、未完のHigh、仕様上の必須項目を「入口封印中」として延期した状態ではenable不可。

## 監査方法・境界

- round-1 正本 `docs\plans\2026-08-25-tab-grouping-sol-audit-r1.md` の全450行を再確認した。
- `git show f99d78b` の8変更ファイル（追加105 / 削除0のresponse tableを含む）について、全変更行を直接確認した。
- 現行 `GROK_FIX_tab_grouping.md` の対応表、won't-fix、仕様改訂提案、テストclaimを通読した。表のclaimはclosure根拠に使わず、現行コードとテスト本体で照合した。
- 現行コードのparser、edited validator、compile、commit、rollback、undo、Panel state machineと、新規14 testsを周辺文脈込みで確認した。
- `f99d78b` の変更先は表、3 source、4 testの8パスだけ。監査対象source/testには現行dirty差分がない。repoにはsocket/bridge等の無関係な既存dirtyがあり、変更・監査していない。
- 後続 `c46579c` は `GROK_FIX_tab_grouping.md` のRust結果追記だけで、監査対象source/test blobは `f99d78b` と同一。

## NEW findings

### [NEW-01][Severity: Critical][src/components/layout/TabGroupingPanel.tsx:298; src/components/layout/tabGrouping.ts:1648-1651]

Closure status: `new-issue`

**適用直前stale検査をprecompiled transactionが迂回し、閉じたタブの復活・新規タブの消失を成功扱いにする。**

Panelはrender時にcompileしたtransactionを `commitGroupingPlan(..., compiled.transaction)` へ渡す。commitは `precompiled` があれば `compileGroupingPlan` を呼ばないため、`classifyStale`、edited validation、現在workspaceからの再構築をすべて飛ばす。commit前snapshotは最新状態を取るが、直後に古いtransactionで全置換する。post-commit照合もその古いtransaction自身のexpectedを使うため、古い状態への巻き戻しを正常と判定する。

再現:

1. t1を移動する案を確認画面でpreviewし、transactionを保持する。
2. Apply handlerが走る前にt1を閉じる、または対象外t3を追加する（別購読・別操作によるstore更新でよい）。
3. 保持済みtransactionを第4引数に `commitGroupingPlan` へ渡す。
4. `replaceWorkspaces` はt1を復活させ、またはt3を消す。`verifyTransaction` は古いexpectedと一致するため `ok: true` を返す。

仕様 §4.2/§4.3 の「適用直前突合」「閉じた対象はblock」「分析後に増えた対象外tabは現在位置に残す」「tabを閉じない」に反する。既存testsはprecompiled引数を一度も実行していない。

### [NEW-02][Severity: Critical][src/components/layout/tabGrouping.ts:1238-1241,1292,1308]

Closure status: `new-issue`

**既定IDがcompileごとに再利用され、2回目の再配置でworkspace/pane IDが必ず衝突する。**

`compileSeq` は関数ローカルで毎回0から始まり、production Panelはuuid optionを渡さない。新規1pane+1workspaceなら毎回pane=`compile-1`、workspace=`compile-2` になる。ID衝突検査もない。

再現:

1. 既定optionで新規1pane+1workspace案をcompile/commitする。結果に `compile-1` / `compile-2` が残る。
2. 別のタブで同じ形の案を再度compileする。
3. 新しいpane/workspaceも `compile-1` / `compile-2`。既存workspace配列へ同じIDの新workspaceが追加される。
4. expectedResultも同じ曖昧なIDを持つため、現行verificationは重複を拒否せずcommit成功になり得る。

React key、workspace検索、splitColumns、focus/selectionのidentity前提を破る。`compiles the same proposal twice into identical transactions` は同一性だけをassertし、全既存IDに対する一意性と連続2回適用を検証していない。

## Round-1 Blocker/Critical/High closure matrix

Statusは指定語 `closed / partial / not-fixed` を使用する。

| ID | Severity | Status | 直接確認したclosure根拠 |
|---|---:|---|---|
| A-01 | Blocker | closed | edited validatorがadopted reorganize + current_locationsを拒否し、compile対象もnew/existingだけに限定。negative testはreplace 0回とtab/session保持を確認。 |
| A-02 | Critical | closed | 再分析冒頭でplan/edit/selection/popup/applied/errorをresetし、Applyはplans=0・parseError・appliedをgateする。旧案Apply経路は閉じた。 |
| A-03 | High | closed | parserは1〜3 raw plansを受理し、valid 1件をcomparisonInsufficientとして返す。2回目1案・2回目invalid・3回目なしのtestsあり。 |
| A-04 | High | closed | keep.layout exactly null、rationale/warnings必須、group/unassignedの非string ID拒否へ変更。fail-open変換は除去された。 |
| A-06 | High | closed | AI parseとedited validatorの双方でnew名同士・既存WS名との衝突を拒否する。 |
| B-01 | Critical | closed | production dependencyとPanel previewはactivePaneId null時にlastActivePaneIdを使う。Dashboard通常経路の追従元は復元された。追加test名は実default dependencyを使わないが、コード経路は確認できた。 |
| B-02 | Critical | closed | `paneFromTabs` がpreferred focus tabを検索しactiveTab/sessionへ反映する。2番目配置を直接assertする新testはないためcoverageはE-04でpartial扱い。 |
| B-03 | Critical | closed | 空paneはsessionId/activeTabIdとagent/resume/launch identityをblank化。移動session集合を1copyに保つtestあり。 |
| B-04 | High | closed | existing destinationへmerge後に `pruneWorkspacePanes` を再実行するため、source=destinationで残った空paneを除去する。専用regression testはない。 |
| B-05 | High | partial | 同一入力のdeterminismとPanel/Apply同一transactionは実装したが、NEW-01のstale迂回とNEW-02の再利用IDを導入。純粋性を安全に満たしていない。 |
| B-06 | High | closed | adopted reorganizeでgroup.tabIdsとflatten(layout)を再比較し、missing moved tabもthrowせず結果型で返す。 |
| B-07 | High | closed | target/destination集合を作り、edited validationより先にstale分類する。closed target testはreplace 0回を確認。 |
| B-08 | High | partial | session集合、splitColumns、non-empty pane active、empty/new WS、focusを追加したが、空paneのstale activeTabId、expected pane/workspace全構造、metrics、重複IDを照合しない。focus nullも照合しない。NEW-02を通し得る。 |
| B-09 | High | partial | rollback例外は結果型に封じたが、rollback後確認はtab locationだけ。永続的なsplit/metadata/focus/selection破損を成功したrestoreと誤認でき、persistent corruption/throw testsもない。 |
| B-10 | High | partial | signatureへwidth/height/labelを追加しactiveTabを除いたが、workspace color/pet/status、pane/tab agent・resume・launch metadata等は未監視。Undoは後続metadataを古いsnapshotで上書きできる。さらにrestoreSelection後の `setActiveWorkspace` が現active sessionをmapへ再保存し、捕捉済みlastActivePane mapを改変し得る。 |
| C-01 | Critical | closed | ×はmemoryを破棄せずhidden化し、Panel footerからrecallできる。dismiss/recall/restore testあり。Dashboard固定導線は別ID C-16。 |
| C-02 | High | closed | undo memoryにappliedWorkspacesを保存し、「変更内容を見る」はsnapshot/appliedの保存済みbefore/afterを使う。 |
| C-03 | High | partial | plan切替・再分析ではselection/popupをclearするが、group切替は `setSelectedGroupId` だけでselectedTabIdsとdestination popupをclearしない。round-1のgroup leakが残る。 |
| C-04 | High | closed | 未分類一覧、未分類への移動、既存pane titleを選ぶ移動先UIを追加。除外/付替えの主要経路は画面から実行できる。 |
| C-05 | High | closed | Apply失敗でstatus更新、edit復帰、stale/errors全件をbody/footerへ表示する。NEW-01では失敗自体を検出しない点は別finding。 |
| C-06 | High | closed | warning code/message/tabIdsを案カードに表示する。 |
| C-13 | High | partial | plan radio、step/current、tab/view aria-pressed、move popup role、Escape closeは追加。一方destination trigger/popupにはhaspopup/expanded/roleがなく、どちらのpopoverもfocus移動・返却・outside clickなし、radio group/keyboard選択もない。 |
| C-15 | High | closed | 成功transactionを`applied`へ固定し、成功後のlive workspaceを旧baselineで再compileしない。 |
| D-01 | High | partial | A-01/B-03経路と通常tab objectのspread保持は修正。ただしduplicate ID fail-closedは延期され、NEW-02では正常操作自身がduplicate IDを生成するためno-loss/no-corruption safety gateは未達。`keeps every original tab object field` testも全30前後のfieldではなくsessionId/label/cwdだけをassertする。 |
| E-01 | High | not-fixed | testはkeep.tabIdsを引き続き必須fixtureにし、仕様本文にないfield省略をdropすることを正解にした。A-05の仕様改訂前提を解消せず、schema driftをtestで固定している。 |
| E-02 | High | closed | 再生成後1案、2回目invalid+raw、初回2案no retry、最大2 callsを追加。 |
| E-03 | High | closed | 本当に閉じたtarget t1をcommit経由でtab_closedにし、replace 0回をassertするtestを追加。 |
| E-04 | High | partial | replaceCount=1とfocus/session、tab field一部は追加したが、focus no-op、active tabが2番目、split corruption、empty active ID、precompiled stale、重複IDをnegative実行しない。 |
| E-05 | High | partial | dismiss/recallとactiveTabをsignature外にする変更は確認したが、resize/rename/metadata、same-session move、reapply、lastActivePane完全restoreのtestsがない。既存expiry testは依然session追加を伴う。 |
| E-06 | High | partial | Panel testはSSR 2件だけのまま。今回の追加は再分析文言とstep ariaの文字列assertだけで、effect、3 mode、editing、Apply、rollback、Undo、race、popover操作を実行しない。 |
| E-07 | High | partial | source substring contractへentry=falseを1assert追加しただけ。invoke payload、abort、exactly-once replace、runtime no-closeを実行時に保証しない。 |
| G-01 | High | not-fixed | 元5 commitsが非連続という履歴事実は変わらない。ただしround-1は個別commit和集合で境界確認済みで、今回の単独 `f99d78b` 自体は8明示パスだけ。歴史的制約としては受容可能。 |

## won't-fix / boundary / deferral judgement

`GROK_FIX_tab_grouping.md` のwon't-fix一覧と、同等の「部分」「仕様改訂提案」「n/a」を全件評価した。`NOT ACCEPTABLE` はこの未公開機能をenableするgateとして延期を認めない、という意味。

| ID | Implementer理由 | 判定 | 理由 |
|---|---|---|---|
| A-05 / E-01 | 仕様本文への追記が先 | **NOT ACCEPTABLE** | 実装と正本schemaが不一致のまま最終gateを通せない。先に仕様改訂し、fixture/parserを同じ契約へ揃える必要がある。 |
| A-07 | 一般英単語の完全機械強制は不能 | acceptable | 固有名詞との意味判定は完全自動化不能。denylist+人手編集の既知制約として許容可能。 |
| A-10 | snapshot unavailableとall-DEADの区別は後便 | acceptable with warning | false-emptyになり再試行が必要だが、A-02修正後は旧案Applyへ進まない。安全性より可用性の問題。表示文言で判定不能を区別するのが望ましい。 |
| B-11 | createWorkspace共有はstore編集が必要で境界外 | **NOT ACCEPTABLE** | 新WS identity/factory規約はcompile safetyの中核。境界を広げるか共通pure factoryを抽出すべきで、NEW-02が実害を示す。 |
| B-12 | 既存列+合流の総列上限は後便 | **NOT ACCEPTABLE** | 仕様は最終列4上限。rendererは4へclampする一方splitColumnsは5以上になり得るため、構造不整合を既知のままenableできない。 |
| B-13 | 壊れたduplicate tab ID入力は後便 | **NOT ACCEPTABLE** | destructive layout compilerはfail-closedが必要。さらにNEW-02で機能自身がduplicate workspace/pane IDを作るため「壊れた外部入力だけ」ではない。 |
| C-08 | destination往復の骨格保持は後便 | acceptable | 編集内容を失うUX制約だが、Apply前に再確認でき、tab/session安全を直接破らない。 |
| C-16 | Dashboard下部固定Undoは境界外、Panel recallで代替 | **NOT ACCEPTABLE** | 仕様 §4.4 は画面下部固定で、Panelを閉じても復元導線が必要。Panel componentがunmountされる現構造は明示要件を満たさない。 |
| F-01 | 既存overlayに合わせたraw px | acceptable | 色token契約は守り、機能安全性に影響しない。design token debtとして別管理可能。 |
| F-02 | 100+ tab preview memoは後便 | **NOT ACCEPTABLE pending evidence** | 本機能の対象は多数tab。O(T²)走査を既知のまま延期するなら、少なくとも100+ fixtureのrender budget実測で受入基準内を証明する必要がある。 |
| F-05 | tail並列取得は後便 | **NOT ACCEPTABLE pending evidence** | AI call前の直列socket往復がtab数に比例する。100+ tab実測またはbounded parallel化なしに実用gateを閉じられない。 |
| E-06 | entry封印中なのでengine testsで代替 | **NOT ACCEPTABLE** | 封印はテスト省略理由ではなく、enable前にUI state machineを検証するための期間。High findingのfull DOM操作coverageが必要。 |
| E-07 | entry封印中なので実Tauri invokeは後便 | **NOT ACCEPTABLE** | source substringはdead code/commentでも通る。mode/abort/no-close/replace回数のintegration evidenceがenable前に必要。 |
| G-01 | git境界は明示addのみ | acceptable for round 2 | 元履歴は変えられない。個別commit patch和集合で監査したround-1方法と、単独f99の8パス境界で代替できる。 |
| G-03 | pane ID新採番を仕様改訂 | **NOT ACCEPTABLE until amended and smoked** | 現行仕様のpane ID維持claimと不一致。仕様改訂だけでなく、実WebView/xtermでremount・PTY継続・focus/fit・直後入力を確認する必要がある。 |

追加で、表が`fix`としたB-14も完全closureではない。`extendMetrics` は列indexでwidthを引き継ぎ、列削除でindexがずれる場合に別列のwidthを割り当てる。行pane数が変わると、その列の全row heightを既定値へ戻す。pane identity基準の保持ではない。

## Regression / claim review

- NEW-01、NEW-02は `f99d78b` の修正方法から生じた新規回帰。
- `GROK_FIX` の「Blocker/Critical/High は表のとおり修正」は不正確。11件がpartial、2件がnot-fixed。
- `keeps every original tab object field` というtest名に対しassertはsessionId/label/cwdのみ。実装の `{ ...found.tab }` は通常fieldを保持するが、test claimは全field証明にならない。
- `follows lastActivePaneId when dashboard cleared activePaneId` testはdependencyを手動で `getActiveSessionId = () => session-t2` に差し替えており、production fallback自体は実行しない。
- `compiles the same proposal twice into identical transactions` はdeterminismだけを証明し、一意IDというより強いproduction invariantを逆に見逃す。
- Panel SSR testはstate/effect/invoke/user-eventを実行しないため、C-03/C-13/NEW-01を検出できない。
- `TAB_GROUPING_ENTRY_ENABLED = false` の維持は確認した。欠陥の現行通常UI露出を防ぐ一時gateとしては有効だが、closure statusをclosedにはしない。

## Verification results

- `npx tsc --noEmit` — PASS。
- `npx vitest run tests/unit/tabGrouping.test.ts tests/unit/tabGroupingApply.test.ts tests/unit/tabGroupingPanel.test.tsx` — 3 files / 29 tests PASS。
- `python -m pytest tests/test_tab_sweep_command_contract.py -p no:xonsh -p no:cacheprovider -q` — 7 PASS。
- `npx vitest run` — 204 files / 2808 tests PASS。Canvas `getContext()`未実装warningのみ。
- `python -m pytest tests/ -p no:xonsh -p no:cacheprovider -q` — 355 PASS。実装者報告のupdater 1 failureは再現しなかった。
- `python scripts/run_windows_tests.py` — PASS。RAM gateにより`cargo -j 2`、`931 passed / 0 failed / 10 ignored`、2 test binaries PASS。
- 上記PASSは既存suiteの結果。NEW-01/NEW-02、未完Highの多くはsuiteにcaseがないため、緑であることはclosureを意味しない。

## Runtime / release separation

- source `src-tauri\tauri.conf.json`: v0.57.0。
- 稼働中 `C:\Users\miyaz\AppData\Local\mycmux\mycmux.exe`: file/product v0.56.0、SHA256 `99911A5A8E0CC4891F17685DFB7BDFCAB6C251EE6FFB1C95AA9064FC0C12305F`。
- 監査中の最新公開release/updaterはv0.56.0。v0.57.0 Release workflow（head `c0cb219`）はin progressだった。
- `f99d78b` はremote branchに含まれず、通常UI入口もfalse。したがって本報告はsource enable gateのREJECTであり、稼働中v0.56.0にNEW-01/NEW-02が入っているという意味ではない。

## Required closure before enable

1. precompiled transactionをcommitする直前に、最新workspaceに対するbaseline stale検査と、分析後追加tabを保持した再base/再compileを必須化する。同一preview identityを保つなら、transactionへ入力signatureを持たせて完全一致をfail-closedで検証する。
2. deterministicかつ既存workspace/pane IDと衝突しないIDを入力から導出するか、ID割当をcommit前の一意factoryへ分離し、連続2回適用・既存衝突negative testを追加する。
3. B-08/B-09/B-10の照合・rollback・undoをworkspace/pane/tab/metrics/selection/metadataまで仕様どおり完結させる。
4. C-03/C-13とE-04〜E-07を実操作/integration testsで閉じる。入口falseをテスト代替にしない。
5. A-05/E-01、B-12、C-16、G-03を仕様正本と実装のどちらかに統一し、必要な実機xterm smokeを通す。
