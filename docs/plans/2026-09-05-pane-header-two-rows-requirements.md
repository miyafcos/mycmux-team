# ペインの見出しを 52px の 2 行にする 要件定義 (2026-09-05)

読者 = この実装を担当するエージェント / 語り手 = mycmux 開発者 (弊社) / 相手 = 宮崎さん (GO 判断) / その先 = 公開ミラー `miyafcos/mycmux-team` の閲覧者。

モック (静止・実寸): `C:/Users/miyaz/.claude/dispatch/260905-mycmux-ux-review/mocks_v2/m2b_header_2rows.html` (id `m2b-300` / `m2b-240` / `m2b-300-light`)、比較用の 1 行案 `m2a_header_instrument.html`、Astra の `astra/mock_actions.html`。
出典の報告: `C:/Users/miyaz/reports/mycmux_UX設計見直し_20260905.html` 4 章 (判断 4: 案 B を第一候補にして 240 / 300 / 1200px で実機比較)。
前段: `docs/plans/2026-09-05-attention-band-requirements.md` (帯)。**着手は到達性便 (⋮ メニューの button 化) と帯の後** — PaneTabBar を同時に触らない。

---

## 1. 背景

### 1.1 実測した現状

| # | 事実 | 出典 |
|---|---|---|
| P1 | ペインの見出し (PaneTabBar) は幅で 7 段階に畳む: `full → slim → compact → compact3 → compact2 → compact1 → micro`。縮小時の境界 560 / 360 / 250 / 210 / 170 / 130px、拡大時 600 / 400 / 290 / 238 / 198 / 158px (ヒステリシス) | `src/components/workspace/PaneTabBar.tsx:295-345` |
| P2 | 実運用の 300px は `compact`、最悪幅 240px は `compact3`。`full` は 新規 / 保存 / 右分割 / 下分割 / 拡大 / ダッシュボード / 閉じる の 7 ボタン、`compact3` は 拡大 / 右分割 / 閉じる、`micro` は 0 | `PaneTabBar.tsx:345, 1448-1540` |
| P3 | タブ名は末尾省略 (`textOverflow: ellipsis`)。300px では `node.e…` のように識別子が消える | `PaneTabBar.tsx:875-879` / 実機画面の拡大 |
| P4 | 状態は 種別ドット 6px・英字バッジ 10px・未読/固定の記号が同居。理由の語は無い | `PaneTabBar.tsx:785` / `src/global.css:413` |
| P5 | 見出しの高さは 36px 固定 (`PANE_HEADER_HEIGHT`)。入力欄 (composer) はペイン高さ 200〜224px 付近で非表示になる規則がある | `src/lib/constants.ts` / `paneComposerContract.test.ts` |
| P6 | ダッシュボードの計器行 (`モデル (effort) │ CTX │ 経過`) は純粋関数で独立している。Claude Code は自分の最下行に モデル・effort・CTX を印字する | `src/components/dashboard/instrumentLine.ts` / 実機画面 |
| P7 | 「New terminal tab」の `title` を契約テストが検査している | `tests/test_no_restart_ui_surface_contract.py:50` |

### 1.2 既にある土台 (作らずに呼ぶ)

| # | 事実 | 出典 |
|---|---|---|
| T1 | 種別マーク `AgentKindIcon`、種別色 `KIND_COLORS` | `src/components/icons/AgentIcons.tsx` / `src/lib/agentKindColors.ts` |
| T2 | 状態語と理由: ダッシュボードの `stateLabels.ts` (注意軸 × 活動軸) と `sessionStatusSignals.ts` | `src/components/dashboard/stateLabels.ts` / `src/lib/sessionStatusSignals.ts` |
| T3 | 中間省略 `middleEllipsis` (ランチャーで実装済み) | `src/components/workspace/launcherModel.ts` |
| T4 | ⋮ メニュー (到達性便で `button` 化・キー対応済みの前提) | `PaneTabBar.tsx` の `MenuItem` |
| T5 | 密度トークン `--cmux-space-*` と `uiDensity` の契約 (standard = 現行同値) | `src/global.css` / `tests/unit/uiDensity.test.ts` |

---

## 2. 決定事項

- **D1. 240 / 300px (compact 以下) では見出しを 52px の 2 行にする。** 1 行目 = `[種別マーク][作業名 (中間省略)][タブ数 ▾]`、2 行目 = `[状態理由 1 行][新規][操作]`。`full` / `slim` (360px 以上) は現行の 1 行 36px のまま (7 ボタン)。
- **D2. 状態理由は語で出す。** 「作業中・変更箇所を検証」「回答待ち・方針を選ぶ」「完了・検証が完了」のように、活動軸 + 直近の要旨。要旨は既存の `lastLog` / 注意の理由から取り、無ければ活動軸だけ。色は状態色トークン (`--cmux-status-*`) を使い、語を必ず併記。
- **D3. 「操作」ボタンは ⋮ メニューを開く (T4)。** 畳まれた全操作 (分割・拡大・ダッシュボード・公開・複製・固定・全タブ・閉じる・検索・復元) はそこから届く。提案 3 の一覧が入るまでは既存 ⋮ のまま。
- **D4. 「新規」は 2 行目に常設。** 300px で新規タブが ⋮ に隠れる現状 (到達性の欠陥 1) を、見出し側でも解消する。`title="New terminal tab"` は維持 (P7)。
- **D5. 高さ +16px の代償を測ってから既定にする。** 実装は表示フラグ (`paneHeaderTwoRows`・設定「通知とレイアウト」) で切り替え可能にし、既定は OFF で出荷。240 / 300 / 1200px の実機比較で GO なら既定 ON。
- **D6. モデル・effort・CTX は描かない。** Claude Code が最下行に出す (P6)。Codex だけ出す案は Phase 2 で判断。
- **D7. 機能集合は不変。** 7 段階の各ボタンの機能・ドラッグ移動・タブ名編集 (ダブルクリック)・固定・複製・全タブ一覧は全部残す。
- **D8. 既存の 7 段階の畳みは消さない** (比較用に残し、フラグ OFF では現行どおり)。

### 2.1 非目標

- `full` / `slim` の 2 行化 (広い幅では 1 行で足りる)
- 見出しからの直接回答 (帯・質問カードの役目)
- 案 A (1 行の計器行) の同時実装 — 案 B の実機比較で不採用なら案 A を別便で

---

## 3. 画面仕様

- **S1.** 2 行の高さ 52px (26 + 26)。1 行目: マーク 14px・作業名 12px (太字)・右端にタブ数 `1タブ ▾` (押すと全タブ一覧)。2 行目: 状態理由 11px・右端に `新規` `操作` の 2 ボタン (高さ 20px)。
- **S2.** 作業名は中間省略 (T3)。末尾の識別子 (`…dows`) を残す。
- **S3.** 状態理由の語: 活動軸 (作業中 / 回答待ち / 承認待ち / 完了 / 停止 / エラー) + 「・」+ 要旨 (最大 12 文字・中間省略)。回答待ち・承認待ちは帯 (attention band) と同じ語・同じ色。
- **S4.** ボタンはすべて `button type="button"`・`title` 日本語・キー到達可 (到達性便の規則)。
- **S5.** ライト/ダークとも既存トークンのみ。日本語 11px 以上。240px で横溢れ 0。
- **S6.** 240 ↔ 300px を 100 往復して layout が 2 フレーム以内に落ち着く (Astra の受入)。入力欄 (composer) の非表示境界は +16px ぶん見直し、規則を `paneComposerContract.test.ts` に反映。

---

## 4. 受入条件 (機械検査)

1. フラグ ON・300px: 見出しが 52px・2 行。1 行目に作業名 (中間省略)・タブ数、2 行目に状態理由・新規・操作。フラグ OFF: 現行と同一 (既存テスト全緑)。
2. 名前 0 / 1 / 30 / 100 文字、タブ 1 / 10 / 50、注意 0 / 1 / 複数、固定あり/なし で名前領域が 0px になるケース 0。
3. 直接ボタン + ⋮ の操作集合が、フラグ OFF の 7 段階 (同じ幅) と一致。到達喪失 0。
4. 状態理由が stateLabels の語と一致し、回答待ちの色・語が帯と同じ。
5. 日本語 computed font size ≥ 11px、`tokenContract` / `themeContrast` / `uiDensity` / `uiQualityTokens` 全緑。
6. `test_no_restart_ui_surface_contract.py` 緑 (`title="New terminal tab"` 維持)。
7. 入力欄の非表示境界と端末の rows / cols の再計算が、+16px を含めて `paneComposerContract` / `terminalLayoutSignature` のテストで固定される。

---

## 5. 段階

- Phase 1 — 到達性便 (⋮ の button 化) と帯の取り込みを待つ。
- Phase 2 — フラグつきで 2 行見出しを実装 (既定 OFF)。規模 450〜750 行 (テスト込み)。
- Phase 3 — 240 / 300 / 1200px の実機比較 (宮崎さん)。GO なら既定 ON、NO なら案 A を検討。

## 6. 未決事項

- U1. 2 行目の要旨をどこから取るか (`lastLog` の先頭か、注意の理由か)。実装前に 11 列の実データで見る。
- U2. `slim` (360〜400px) を 2 行にするか (現状は 1 行のまま)。
- U3. Codex ペインにモデル・effort を 2 行目へ出すか (D6)。
