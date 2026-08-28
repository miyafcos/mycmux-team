# Oracle Browser Transcript

Conversation: https://chatgpt.com/c/6a8d5fc4-da1c-83ee-98e3-44a0f6b5f3a1

## Prompt

mycmux (Tauri v2 + React 19 + Zustand のターミナルワークスペース) の新機能「タブ再配置」(全ワークスペースのタブをAIが分析→複数プラン提案→ユーザー編集→アトミック適用+undo) が、実装→独立監査→修正→再監査の2ラウンドで2回 REJECT になり詰まっている。あなたには前回この機能の設計相談をした (3段階モードUI・論理プラン+決定的コンパイラ・フルスナップショットundo等を採用済み)。今回はその実装が監査に落ちた詰まり所の裁定を求める。

添付資料 (すべて一次資料):
- 2026-08-25-tab-grouping-plan.md = 仕様正本 (§8.5 に現在の封印解除条件)
- 2026-08-25-tab-grouping-sol-audit-r1.md = 監査 round1 (REJECT・58 findings)
- 2026-08-25-tab-grouping-grok-fix-r1.md = 実装者の修正対応表 (19/32 closed)
- 2026-08-25-tab-grouping-sol-audit-r2.md = 監査 round2 (再REJECT・新規Critical 2・NOT ACCEPTABLE 判定リスト・Required closure 5項)
- tabGrouping.ts / TabGroupingPanel.tsx = 現行実コード (修正 f99d78b 適用後)

状況: 機能は TAB_GROUPING_ENTRY_ENABLED=false で UI から不可達のまま master に存在。リリース済み版に露出なし。急ぎはないが品質最優先で確実に着地させたい。

相談 (各項「推奨+根拠+却下理由」で。コードは TypeScript の具体設計まで):

A. **NEW-01 (Critical) の正解設計**: パネルが確認画面で compile した LayoutTransaction を commitGroupingPlan に precompiled として渡すと、適用直前の stale 検査・再検証を全迂回する。監査の提案は「commit 直前に最新 workspace への baseline stale 検査+分析後追加タブを保持した再base/再compile を必須化。同一 preview identity を保つなら transaction に入力 signature を持たせ完全一致を fail-closed 検証」。どの設計が正か: ①precompiled を廃止し commit 内で常に再compile (プレビューと実適用が乖離し得る問題は?) ②入力 signature (workspaces 配列の何をどうハッシュ?) ③その他。「確認画面で見たものと違うものが適用される」ことも「古い状態を適用する」ことも両方防ぐ設計を具体化してほしい。

B. **NEW-02 (Critical) の ID 設計**: compile を純関数化した結果、既定 ID factory が毎回 compile-1,2,... となり2回目適用で必ず衝突。決定性 (同一入力→同一出力・テスト可能) と一意性 (既存/過去適用との非衝突) の両立をどう設計するか。入力からの導出 (どの入力を種に?) / commit 直前の一意 factory 分離 / その他。

C. **検証・undo の明るい境界線**: B-08/09/10 が partial のまま。post-commit expectedResult 照合は何をどこまで照合すべきか (タブ所在だけ→どこまで広げる? 全構造 deep-equal は過剰?)。undo 失効 signature は何を監視し何を無視すべきか (監査は「resize/rename/metadata を監視外にすると古い snapshot で上書きする」「activeTab を監視すると誤失効」と両方向を指摘)。仕様の「完全に元へ戻せる/戻せない時は失効」を満たす最小で明確な線を引いてほしい。

D. **封印中機能のテスト戦略**: 監査は「入口封印はテスト省略理由にならない。UI state machine の実操作テストと Tauri invoke の integration 証拠が enable 前に必要」(E-06/E-07)。React 19 + vitest (jsdom, SSR文字列テストのみ現状) + Tauri という構成で、封印を保ったまま何をどう検証するのが現実的か (テストハーネス具体案・優先順)。

E. **監査の NOT ACCEPTABLE 判定の妥当性裁定**: round2 は won't-fix 群のうち B-11 (createWorkspace factory共有)・B-12 (合流時の総列上限)・B-13 (duplicate ID fail-closed)・C-16 (Dashboard下部固定Undoバー)・E-06/E-07・F-02 (100+tab性能)・F-05 (tail直列取得)・G-03 (pane ID採番+実機smoke) を enable 前必須と判定した。この線引きは妥当か。過剰な項目・逆に足りない項目があれば指摘してほしい (機能はゲート付き・個人用アプリ・利用者1名)。

F. **次サイクルの体制と進め方**: 実装者 Grok (grok-4.6) は2ラウンドとも新規回帰を混入 (round1: fail-open 系集中 / round2: 修正自体が Critical 2 を導入)。監査者 Codex gpt-5.6-sol は精度高い。次サイクルは (a) Grok 続投+spec 厳格化 (b) エンジン中核 (A〜C) を gpt-5.6-sol 実装に交代し UI/テストを Grok、監査を別系 (Opus) に (c) 全部 sol 実装+Opus 監査、のどれが良いか。また作業順序 (先に A/B の中核を単独で固めて破壊試験→その後周辺、など) の推奨は。

回答は日本語。A と B は実装者にそのまま渡せる粒度 (型・関数シグネチャ・検証手順) まで具体化してほしい。

## Answer

# 結論

* Aは「commit時に再compile」でも「古いprecompiledをそのまま適用」でもない。**確認画面で確定した CommitTicket を、完全一致した入力状態にだけ適用する optimistic concurrency control** が正解。状態が変わったら適用せず、再compile→再確認へ戻す。
* Bは「純関数なのに毎回同じID」と「commit時にランダムID」の二択ではない。**preview単位の一意な allocationSeed を入力に含め、論理座標から決定的IDを導出する**。同じpreviewでは同一、別preview・別適用では非衝突になる。
* Cは、post-commit/rollbackを「永続レイアウト射影の canonical deep-equal」に統一する。undoは**復元対象に含めるフィールドをすべて監視し、active selectionなど復元しない一時状態だけ無視**する。
* DのSSR文字列テストは不足。封印中にReact実操作テスト、Tauri invoke adapter integration、実WebView/xterm smokeの3層を通す。
* Eの監査線引きは概ね妥当。ただしF-02/F-05は「最適化実装必須」ではなく「性能基準を実測で満たすか、満たさなければ修正」が正確。B-11も「同じ関数の共有」自体ではなく「同一生成規約の単一正典」が必須。
* Fは **(c) 全部sol実装＋Opus監査** を推奨する。Grokは今回の中核修正から外す。UIだけ任せる案も、round2でUI実操作テスト未完・状態リーク残存なので採らない。

---

# A. NEW-01：CommitTicketによる完全一致適用

## 推奨

`precompiled?: LayoutTransaction` を削除し、次の2段階APIに置き換える。

```ts
type Sha256 = string & { readonly __brand: "Sha256" };
type PreviewId = string & { readonly __brand: "PreviewId" };

interface GroupingCompileContext {
  baseline: readonly AnalysisBaselineEntry[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  allocationSeed: string;
}

interface LayoutTransaction {
  workspaces: Workspace[];
  expected: GroupingExpectedResult;
}

interface GroupingCommitTicket {
  schemaVersion: 1;
  previewId: PreviewId;

  // 編集案そのもの
  planSignature: Sha256;

  // transactionを生成した入力
  inputSignature: Sha256;

  // ユーザーが確認した適用結果
  outputSignature: Sha256;

  context: GroupingCompileContext;
  transaction: LayoutTransaction;
}

type PrepareResult =
  | { ok: true; ticket: GroupingCommitTicket }
  | { ok: false; stale: StaleIssue[]; errors: string[] };

type CommitResult =
  | {
      ok: true;
      report: GroupingApplyReport;
      transaction: LayoutTransaction;
    }
  | {
      ok: false;
      kind:
        | "preview_stale"
        | "plan_changed"
        | "invalid_input"
        | "commit_mismatch"
        | "rollback_failed";
      stale?: StaleIssue[];
      errors: string[];
    };
```

```ts
export function prepareGroupingCommit(
  plan: GroupingPlan,
  current: readonly Workspace[],
  context: GroupingCompileContext,
): PrepareResult;

export function commitPreparedGrouping(
  ticket: GroupingCommitTicket,
  deps?: GroupingCommitDependencies,
): CommitResult;
```

## prepare手順

```ts
export function prepareGroupingCommit(
  plan: GroupingPlan,
  current: readonly Workspace[],
  context: GroupingCompileContext,
): PrepareResult {
  const validation = validateGroupingInput(plan, current, context);
  if (!validation.ok) return validation;

  const transaction = compileGroupingPlan(plan, current, context);
  if (!transaction.ok) return transaction;

  return {
    ok: true,
    ticket: {
      schemaVersion: 1,
      previewId: makePreviewId(),
      planSignature: hashCanonical(canonicalPlan(plan)),
      inputSignature: hashCanonical(
        canonicalCompileInput(current, context),
      ),
      outputSignature: hashCanonical(
        canonicalPersistentLayout(transaction.transaction.workspaces),
      ),
      context: structuredClone(context),
      transaction: structuredClone(transaction.transaction),
    },
  };
}
```

## commit手順

```ts
export function commitPreparedGrouping(
  ticket: GroupingCommitTicket,
  deps: GroupingCommitDependencies = defaultCommitDependencies(),
): CommitResult {
  const latest = structuredClone(deps.getWorkspaces()) as Workspace[];

  // 1. 現在入力がpreview生成時と完全一致するか
  const latestInputSignature = hashCanonical(
    canonicalCompileInput(latest, {
      ...ticket.context,
      activeWorkspaceId: deps.getActiveWorkspaceId(),
      activeSessionId: deps.getActiveSessionId(),
    }),
  );

  if (latestInputSignature !== ticket.inputSignature) {
    return {
      ok: false,
      kind: "preview_stale",
      stale: classifyStale(
        ticket.context.baseline,
        latest,
        targetTabIds(ticket),
        destinationWorkspaceIds(ticket),
      ),
      errors: [
        "確認後にレイアウトが変わりました。適用内容を再確認してください",
      ],
    };
  }

  // 2. ticket内部の改変・壊れたキャッシュを拒否
  if (
    hashCanonical(
      canonicalPersistentLayout(ticket.transaction.workspaces),
    ) !== ticket.outputSignature
  ) {
    return {
      ok: false,
      kind: "invalid_input",
      errors: ["適用チケットの内容が一致しません"],
    };
  }

  // 3. 同じ入力から再compileし、ticketと一致するか確認
  const recompiled = compileGroupingPlan(
    ticketPlan(ticket),
    latest,
    ticket.context,
  );

  if (!recompiled.ok) {
    return {
      ok: false,
      kind: "invalid_input",
      stale: recompiled.stale,
      errors: recompiled.errors,
    };
  }

  const recompiledOutput = hashCanonical(
    canonicalPersistentLayout(recompiled.transaction.workspaces),
  );

  if (recompiledOutput !== ticket.outputSignature) {
    return {
      ok: false,
      kind: "invalid_input",
      errors: ["確認時と適用時のコンパイル結果が一致しません"],
    };
  }

  // 4. snapshot → replace一回 → 完全照合 → 必要ならrollback
  return executeVerifiedTransaction(recompiled.transaction, deps);
}
```

`ticketPlan(ticket)`のため、実際にはticketへ`canonicalPlan`を保持するか、呼び出し側からplanを渡して`planSignature`を照合する。後者なら以下が明快。

```ts
commitPreparedGrouping(
  plan: GroupingPlan,
  ticket: GroupingCommitTicket,
  deps?: GroupingCommitDependencies,
): CommitResult;
```

## inputSignatureに含めるもの

「全Workspaceオブジェクトを無差別にJSON化」ではなく、compileが読む値を明示した射影にする。

```ts
interface CanonicalCompileInput {
  workspaces: Array<{
    id: string;
    name: string;
    gridTemplateId: string;
    splitColumns: string[][];
    columnWidths: number[];
    rowHeightsPerCol: number[][];
    panes: Array<{
      id: string;
      tabs: Array<{
        id: string;
        sessionId: string;
      }>;
      activeTabId: string;
      sessionId: string;
    }>;
  }>;

  baseline: Array<{
    tabId: string;
    sessionId: string;
    workspaceId: string;
    paneId: string;
  }>;

  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  allocationSeed: string;
}
```

配列順は意味を持つので保持する。オブジェクトキーはcanonical serializerで辞書順にする。`undefined`、関数、購読状態、xterm参照は含めない。

ただしcompileが将来 `workspace.color` やtab metadataを読むようになれば、この型も必ず拡張する。漏れを防ぐため、compileが生の`Workspace[]`を受ける設計より、最初に `CanonicalCompileInput` へ変換し、compileはそれだけを受ける方が強い。

## 分析後の追加タブをどう扱うか

仕様は「追加タブを現在位置に保持して継続可」だが、**確認後に追加されたタブまで黙ってrebaseして適用すると、確認した結果と実適用が異なる**。

したがって境界を次のように変更する。

* 分析後・確認画面へ入る前の追加タブ：最新状態へrebaseしてpreviewに含めてよい。
* 確認画面でticketを確定した後の変更：追加タブを含め、すべて`preview_stale`。
* UIは「新しいタブを保持した内容に更新しました」と表示し、再compileした差分画面へ戻す。
* ユーザーが更新後のpreviewを見た時点で新ticketを発行する。

これなら両方を満たす。

1. 閉じたタブを復活させない・新規タブを消さない。
2. 確認していない結果を適用しない。

## 却下

### ① commit内で常に再compileするだけ

却下。staleを防げても、確認画面とcommitの入力が異なる場合に別transactionを適用する。特に追加タブ保持、active tab、focus追従、既存WS合流結果が変わり得る。

### ② precompiled＋workspace signatureだけ

不十分。plan編集、baseline、active/focus、ID allocation seedがsignature外なら同一性を保証できない。

### ③ permissible changeならcommit時に自動rebase

却下。安全上許容できる変更と、ユーザーが確認済みかは別問題。品質優先なら再確認コストを取るべき。

---

# B. NEW-02：preview-scoped deterministic ID

## 推奨

ID生成を以下の2層に分ける。

1. `allocationSeed`をpreview作成時に一度だけランダム生成。
2. compile中は`allocationSeed + entity kind + 論理座標`から決定的にIDを導出。

```ts
interface GroupingAllocationContext {
  seed: string; // crypto.randomUUID(); preview中は固定
}

interface PlannedEntityKey {
  kind: "workspace" | "pane";
  planId: string;
  groupId: string;
  columnIndex?: number;
  paneIndex?: number;
}

export interface GroupingIdAllocator {
  workspaceId(groupId: string): string;
  paneId(
    groupId: string,
    columnIndex: number,
    paneIndex: number,
  ): string;
}
```

```ts
export function createDeterministicGroupingAllocator(
  seed: string,
  planId: string,
): GroupingIdAllocator {
  const derive = (...parts: Array<string | number>) =>
    `tg-${stableDigest([seed, planId, ...parts].join("\0")).slice(0, 24)}`;

  return {
    workspaceId: (groupId) =>
      derive("workspace", groupId),

    paneId: (groupId, columnIndex, paneIndex) =>
      derive("pane", groupId, columnIndex, paneIndex),
  };
}
```

compile APIは暗黙のfactoryを廃止する。

```ts
interface GroupingCompileOptions {
  allocationSeed: string;
  createdAt: number;
  newWorkspaceDefaults: NewWorkspaceDefaults;
}

export function compileGroupingPlan(
  plan: GroupingPlan,
  input: CanonicalCompileInput,
  options: GroupingCompileOptions,
): CompileResult;
```

`now()`、`uuid()`、`choosePet()`のような呼ぶたび変わる依存をcompile内部へ入れない。preview準備時に値を確定して入力化する。

```ts
interface NewWorkspaceDefaults {
  createdAt: number;
  pet?: Workspace["pet"];
  color?: Workspace["color"];
  status?: Workspace["status"];
}
```

複数の新WSでpetなどが個別に必要ならgroupId単位のmapにする。

```ts
type NewWorkspaceDefaultsByGroup =
  Record<string, NewWorkspaceDefaults>;
```

## 一意性のfail-closed検証

compile開始前と出力後の両方で検査する。

```ts
interface IdentityIssue {
  kind: "workspace" | "pane" | "tab" | "session";
  id: string;
  locations: string[];
}

export function validateLayoutIdentity(
  workspaces: readonly Workspace[],
): IdentityIssue[];
```

必須条件：

* workspace IDは全体一意。
* pane IDは全Workspace横断で一意。
* tab IDは全体で正確に1回。
* 生きたterminalのsessionIdも、仕様上1 terminal = 1 sessionなら全体一意。
* `splitColumns`内pane IDはそのWorkspaceの`panes`と一対一。
* 各paneの`activeTabId`は空文字または自身のtab。
* 空paneは`activeTabId/sessionId/agent/resume/launch identity`を持たない。
* 新規生成IDはcompile前の全workspace/pane ID集合と非衝突。
* transaction出力全体にも重複なし。

衝突時に別IDへ自動リトライしない。これは「同一入力→同一出力」を壊し、previewとcommitの差を生む。`allocationSeed collision`としてfail-closedし、新ticketを作り直す。

## なぜ一意になるか

* 同一ticket：seedと論理座標が同じなので同じID。
* 別preview：seedが別UUIDなので異なるID。
* 再compile：ticketのseedを再利用するため同一。
* undo後の再適用：新previewを作るので別seed。過去に作られたIDとも通常衝突しない。
* 万一衝突：全体identity検査が拒否する。

## createWorkspaceとの共有

`createWorkspace()`自体をcompilerから呼ぶ必要はない。副作用を持つならむしろ呼ばない。

共有すべきなのは純関数部分。

```ts
export function buildWorkspaceRecord(
  input: BuildWorkspaceInput,
): Workspace;

export function normalizeWorkspaceLayout(
  workspace: Workspace,
): Workspace;
```

通常作成とGrouping compilerの両方がこのpure factoryを使う。

## 却下

### 入力レイアウトだけからIDを導出

同じ案を後日もう一度適用すると同じIDになる。過去生成物が残っていれば衝突する。

### commit直前にcrypto.randomUUIDを採番

previewと実適用が一致しない。workspace/pane IDはfocus、splitColumns、React key、expectedResultに現れるため、「表示上同じ」では済まない。

### module-global counter

再起動、HMR、テスト順、並行previewに依存する。純粋性も永続一意性も保証しない。

### 衝突時だけsuffixを足す

現在レイアウト依存の隠れた再採番になる。preview/commitの完全一致保証を弱める。

---

# C. post-commit・rollback・undoの境界

## 推奨：PersistentLayoutProjectionを正典にする

transaction適用、rollback、undoで同じcanonical projectionを使う。

```ts
interface PersistentLayoutProjection {
  workspaces: Array<{
    // Workspaceの永続フィールド全部
    id: string;
    name: string;
    gridTemplateId: string;
    splitColumns: string[][];
    columnWidths: number[];
    rowHeightsPerCol: number[][];
    color: Workspace["color"];
    pet: Workspace["pet"];
    status: Workspace["status"];

    panes: Array<{
      // Paneの永続フィールド全部
      id: string;
      label?: string;
      tabs: PersistentTabProjection[];

      // 構造的一貫性確認用
      activeTabId: string;
      sessionId: string;
      agentId: string;
      cwd?: string;
      pinnedTabId?: string | null;

      // 実型に存在するresume/launch系を全列挙
      resumeSessionId?: string;
      launchCommand?: string;
    }>;
  }>;
}
```

「全部」の判断は推測でなく、`Workspace`、`Pane`、`PaneTab`型からallowlistを作る。新しい永続fieldが追加されたときテストを落とす型チェックを置く。

```ts
const persistentTab = (tab: PaneTab): PersistentTabProjection => ({
  id: tab.id,
  sessionId: tab.sessionId,
  label: tab.label,
  labelSource: tab.labelSource,
  cwd: tab.cwd,
  agentId: tab.agentId,
  origin: tab.origin,
  // resume/launch/status等、実型の永続fieldを残りなく列挙
});
```

## post-commitで照合するもの

* Workspaceの個数、順序、ID、永続metadata。
* Paneの個数、順序、ID、永続metadata。
* tabの個数、順序、ID、sessionId、全永続metadata。
* splitColumnsとpane集合の一致。
* columnWidths、rowHeightsPerCol、gridTemplateId。
* activeTabIdとpane.sessionIdの整合。
* duplicate workspace/pane/tab/session IDがない。
* expected focus workspace/session/tab。
* `lastActivePaneByWorkspace`の期待値。
* moved/kept/unassigned/empty/newなどのmetricsは、保存値ではなくtransactionから再計算してexpectedと照合する。

全構造deep-equalは過剰ではない。ただし**生のstore state全体**ではなく、Groupingが所有する永続レイアウト射影に限定する。

## rollback

現在の`restoreSnapshot()`のlocation mapだけの確認は不足。

```ts
const beforeSignature =
  hashCanonical(persistentLayoutProjection(snapshot.workspaces));

deps.replaceWorkspaces(structuredClone(snapshot.workspaces));
deps.restoreSelection(snapshot);

const afterSignature =
  hashCanonical(persistentLayoutProjection(deps.getWorkspaces()));

if (afterSignature !== beforeSignature) {
  return {
    ok: false,
    kind: "rollback_failed",
    errors: ["レイアウトの復旧を確認できませんでした"],
  };
}
```

selection復元後も以下を個別照合する。

* `activeWorkspaceId`
* `lastActivePaneByWorkspace`
* `activeSessionId`

`restoreSelection()`と`setActiveWorkspace()`を別々に呼んで相互に上書きさせない。復元用の単一store actionを作るべき。

```ts
restoreGroupingState(snapshot: GroupingSnapshot): void;
```

これが `_replaceWorkspaces` とselection mapを一回のZustand `set()`で復元する。

## undo失効の線

フルスナップショットundoを続けるなら、原則は単純。

> undoが上書きする値は全部監視する。監視しない値はundoでも上書きしない。

したがって次の変更は失効させる。

* tab追加・閉鎖・移動・並べ替え。
* workspace/pane追加・削除・並べ替え。
* resize、splitColumns、grid template変更。
* workspace rename、color、pet、status。
* pane label。
* tab label、cwd、origin、agent/resume/launch metadata。
* 再度のGrouping適用。

次は失効させない。

* active workspace/tab/sessionの選択。
* xterm focus。
* hover、popover、panel mode。
* terminal output、lastOutputAt等、undo snapshotで復元しない実行時情報。
* レイアウトに影響しない一時UI状態。

ただしactiveTabIdとpane.sessionIdが永続Workspace内に混在しているため、そのままsnapshot置換するとtab clickを巻き戻す。これを防ぐにはundo適用時に現在selectionを退避し、snapshot構造を復元後、存在するtab/sessionに限り現在selectionを再適用する。

```ts
const liveSelection = captureSelection(deps);
replaceStructuralSnapshot(snapshot.workspaces);
restoreSelectionIfStillValid(liveSelection);
```

これによりactive selectionをsignature外にしても古い値で上書きしない。

## 却下

* tab所在だけの照合：metadata、metrics、split、duplicate ID破損を見逃す。
* 生store全体のdeep-equal：terminal出力や一時UI状態で誤失敗する。
* rename/resizeを監視外のままsnapshot全置換：ユーザーの後続変更を黙って消す。
* activeTabを監視し、クリックだけで失効：undoの可用性を不必要に壊す。

---

# D. 封印中のテスト戦略

## 1. 最優先：エンジンの破壊試験

Vitestでpure/store harnessを作る。

```ts
interface GroupingTestHarness {
  getState(): TestWorkspaceState;
  mutateExternally(fn: (state: TestWorkspaceState) => void): void;
  commit(ticket: GroupingCommitTicket): CommitResult;
  replaceCalls(): number;
}
```

最低限必要なケース：

* preview後に対象tab close → replace 0回。
* preview後に対象外tab追加 → replace 0回、再確認要求。
* preview後に対象tab move/session変更。
* preview後にdestination WS削除。
* 同一ticketを2回compile → transaction完全一致。
* 別ticketで同型案 → 新規IDが異なる。
* 連続2回適用 → 全ID一意。
* duplicate workspace/pane/tab/session入力 → replace 0回。
* replaceが部分破損を返す → rollback。
* rollbackも破損/throw → `rollback_failed`。
* focus setter no-op。
* split/metrics/metadataだけ破損。
* resize/rename/metadata changeでundo失効。
* tab clickではundo継続。
* undoで現在selectionを保持。
* `lastActivePaneByWorkspace`完全復元。

## 2. React実操作テスト

`@testing-library/react`、`@testing-library/user-event`、jsdomを導入する。SSR文字列テストは補助へ降格。

入口定数をtrueにする必要はない。`TabGroupingPanel`を直接renderするか、依存注入したfeature harnessでマウントする。

```tsx
render(
  <TabGroupingPanel
    analysis={fakeAnalysisAdapter}
    commit={fakeCommitAdapter}
    workspaceStore={testStore}
  />,
);
```

テスト対象：

* 分析→案比較→編集→確認→適用。
* plan/group切替時のselected tabsとpopover reset。
* 再分析時の旧plan消去。
* Apply中の二重押下防止。
* 古い非同期responseが新scanを上書きしない。
* stale時に編集へ戻り、全理由を表示。
* Undo、dismiss、global recall。
* keyboard radio、Escape、outside click、focus移動・返却。
* destination popoverの`aria-haspopup/expanded`。
* abort/unmount。

## 3. Tauri adapter integration

Componentから直接`invoke()`せずadapter化する。

```ts
export interface GroupingJudgePort {
  judge(request: {
    prompt: string;
    requestId: string;
    mode: "grouping";
  }): Promise<string>;

  abort(requestId: string): Promise<void>;
}
```

production adapter：

```ts
export const tauriGroupingJudge: GroupingJudgePort = {
  judge: ({ prompt, requestId, mode }) =>
    invoke<string>("run_tab_sweep_judge", {
      prompt,
      requestId,
      mode,
    }),

  abort: (requestId) =>
    invoke<void>("abort_tab_sweep_judge", { requestId }),
};
```

Vitestでは`@tauri-apps/api/core`の`invoke`をmockし、次を実行時assertする。

* command名。
* payload exact match。
* `mode === "grouping"`。
* requestId一致。
* abort exactly once。
* stale response無視。
* Apply一回につき `_replaceWorkspaces` exactly once。
* close/kill commandが一度も呼ばれない。

Rust側はcommand handlerをCLI process runnerから分離し、mock runnerで：

* grouping allowlist。
* timeout。
* abort routing。
* stdout/stderr/exit code。
* unknown mode拒否。

## 4. 実WebView/xterm smoke

これは自動テストだけで代替しない。

* 実PTYで文字列を継続出力。
* 再配置。
* pane remount後も同じsessionが出力継続。
* 直後に入力し応答確認。
* focus/fit/resize確認。
* undo後も同じPTYへ入力可能。
* DevToolsでduplicate React keyなし。
* tab close/PTY killなし。

---

# E. NOT ACCEPTABLEの裁定

| 項目                      | 裁定     | enable前に必要な線                                                                      |
| ----------------------- | ------ | --------------------------------------------------------------------------------- |
| B-11 factory共有          | 修正して支持 | 同一関数呼出し自体ではなく、pure factory/normalizerを単一正典にする。通常作成とGroupingのcontract testが一致すればよい |
| B-12 総列上限               | 支持     | 最終構造が4列以内でなければcompile拒否。renderer clampへの依存は禁止                                     |
| B-13 duplicate ID       | 強く支持   | destructive全置換の前提条件。正常経路でもNEW-02が発生した以上、延期不可                                      |
| C-16 固定Undoバー           | 条件付き支持 | 現仕様のままなら必須。仕様を「Dashboard常設の再呼出し導線」に変える余地はあるが、Panel unmountで消える現状は不可               |
| E-06 UI実操作              | 強く支持   | 状態機械の不具合が既に残っている。SSRでは検出不能                                                        |
| E-07 invoke integration | 支持     | 本物の外部CLI起動まで毎回不要だが、adapter境界の実行時テストは必須                                            |
| F-02 100+tab            | 判定を修正  | memo化そのものは必須でない。100/200tab fixtureで操作応答基準を満たせば延期可                                 |
| F-05 tail直列             | 判定を修正  | bounded parallel化そのものは必須でない。実測が基準内なら直列でも可。ただし100+回の直列socket往復は失敗可能性が高い            |
| G-03 pane ID＋smoke      | 支持     | 仕様改訂とPTY継続の実機確認が必要。unit testだけではxterm remountを保証できない                              |

## 性能の受入基準

個人用アプリなので過剰な一般SLAは不要。次で十分。

* 100 tabs：確認画面の同期処理 p95 100ms以下。
* 編集操作：p95 50ms以下。
* 200 tabs：長時間タスク警告なし、1フレームを大幅に塞がない。
* tail収集：100 tabs p95 2秒以下、キャンセル可能。
* 同時tail取得：8〜16並列に制限。`Promise.all`無制限は避ける。

F-02/F-05はこの実測に通れば実装修正なしでACCEPTできる。

## 逆に不足しているenable条件

* **commit mutex**：Apply二重押下、別Grouping commit、manual layout mutationとの競合を禁止する。
* **ticket単回使用**：成功・失敗を問わず、commit開始済みticketの再利用を禁止。
* **schema/version gate**：Workspace/Pane/Tabの永続型が変わった場合、canonical projectionの更新漏れを検出する。
* **保存層の失敗確認**：`_replaceWorkspaces`後の永続化が非同期なら、store一致だけで成功扱いしてよいか確認が必要。
* **異常時の操作停止**：rollback_failed後は再Applyを許さず、レイアウト再読込/診断導線を出す。

---

# F. 次サイクルの体制

## 推奨：全部sol実装＋Opus監査

品質優先・急ぎなしなら(c)が妥当。

### 根拠

事実：

* round1ではfail-open系が集中した。
* round2では修正そのものがCritical 2件を新規導入した。
* UI state machineとintegration testも未完のまま「入口封印」を延期理由にした。
* sol監査は、既存テストが通っていても欠落negative caseを具体的に再現している。

推論：

* 問題はspecの細かさだけではなく、破壊的transaction設計に必要な不変条件の捉え方にある。
* Grok続投では、指摘項目を局所的に閉じながら別の不変条件を壊す第3回の可能性が高い。
* UIだけGrokへ分離しても、C-03/C-13/E-06の残件はUI状態機械そのものなので、適切な分離にならない。

### 却下理由

* (a) Grok続投：2回連続の新規回帰という観測に反する。spec追加だけで改善する根拠がない。
* (b) UI/テストをGrok：テストが実装の追認になる危険がある。今回まさにnegative coverage不足がCriticalを通した。
* sol実装＋sol自己監査：独立性が弱い。実装はsol、監査はOpus、最後に必要ならsolを再監査へ戻す方がよい。

## 作業順序

### Gate 0：仕様と不変条件だけを確定

コードを触る前に以下を正本へ追加する。

* CommitTicketとpreview stale規則。
* allocationSeedとID導出規則。
* PersistentLayoutProjection。
* undo復元対象/非対象。
* duplicate identity規則。
* total columns上限。
* pane ID新採番とPTY継続条件。
* 性能基準。
* rollback_failed時の扱い。

### Gate 1：A/B/CエンジンをUIから切り離して実装

対象はpure compiler、ticket、identity validator、verified commit、rollback、undoのみ。

この段階ではPanelを触らない。固定fixtureで破壊試験を先に書き、以下を満たすまで進めない。

* NEW-01/02再現テストが赤→修正後緑。
* 連続適用。
* concurrent mutation。
* duplicate全種。
* commit corruption。
* rollback corruption。
* metadata/selectionを含むundo。

### Gate 2：store境界を整備

* pure workspace factory共有。
* atomic restore action。
* commit mutex。
* global undo state/導線。
* layout mutation revisionまたはcanonical signature購読。

### Gate 3：Panelを新APIへ接続

Panelはtransactionを直接commitしない。

```ts
const prepared = prepareGroupingCommit(...);
setTicket(prepared.ticket);

// Apply
commitPreparedGrouping(editedPlan, ticket);
```

workspace changeを検知したらticketを無効化し、再確認へ戻す。

### Gate 4：UI実操作・invoke integration

E-06/E-07、C-03/C-13を閉じる。ここで入口はまだfalse。

### Gate 5：実機smokeと性能測定

実PTY、100+ tabs、tail、undo、focus/fitを確認する。

### Gate 6：独立監査

Opusへ渡すもの：

* 仕様正本。
* invariant一覧。
  -変更diff。
* 全negative test一覧。
* 性能測定結果。
* 実機smoke記録。

「前回findings対応表」は補助資料に留め、監査者には新規欠陥探索を明示する。

---

# 最優先の行動3つ

1. **CommitTicket・allocationSeed・PersistentLayoutProjectionを仕様正本へ先に確定する。**
   誤りが判明する観測：仕様どおり実装しても、同じticketの再compile結果が一致しない、またはpreview後の状態変更をcommitが受理する。

2. **solでA〜Cだけを独立実装し、NEW-01/02・rollback・undoの破壊試験を通す。**
   誤りが判明する観測：UIなしの固定fixtureでも、連続適用・duplicate入力・commit/rollback破損のいずれかがfail-closedにならない。

3. **その後にUI/invoke接続と実WebView/xterm smokeを行い、Opusへ独立監査を出す。**
   誤りが判明する観測：実PTYがpane再採番後に切断・再生成される、100 tabsで受入時間を超える、またはOpus監査でCritical/Highが残る。
