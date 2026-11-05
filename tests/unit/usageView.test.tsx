// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { UsageView } from "../../src/components/ailog/UsageView";
import { usageBoundaryNote } from "../../src/components/ailog/UsageDaily";
import { WORK_TAG_OVERLAP_NOTE } from "../../src/components/ailog/WorkTagTable";
import { __resetAilogStoreForTests, useAilogStore } from "../../src/stores/ailogStore";
import { overview, series, models, breakdown, sessions, rhythm, viewProps } from "../helpers/ailogPlanAFixtures";
import { renderAllUsageSections } from "../helpers/renderAllUsageSections";
beforeEach(() => { __resetAilogStoreForTests(); useAilogStore.setState({ usageRhythm: rhythm }); });
afterEach(() => { __resetAilogStoreForTests(); vi.unstubAllGlobals(); });
const render=(extra={}) => renderToStaticMarkup(<UsageView {...viewProps(extra)} />);
it.each(["ioTokens","sessions"] as const)("shows daily bars for %s and leaves grouping with the breakdown table", metric => {
  const html=render({ series: series(), metric });
  const page=new DOMParser().parseFromString(html,"text/html");
  expect(page.querySelector("#ailog-trend svg")).not.toBeNull();
  expect(page.querySelectorAll('[role="tab"]')).toHaveLength(6);
  expect(page.querySelector("#ailog-trend [data-usage-grass]")).toBeNull();
  expect(page.querySelector("#ailog-trend [aria-label='単位']")).toBeNull();
});
it.each([["idle","前期間は未取得です"],["loading","前期間との比較を読み込み中"],["error","前期間を取得できません"]] as const)("keeps previous-period %s explanation with overview-only values", (status,message) => {
  expect(render({ overview, previousTotalsStatus: status })).toContain(message);
});
it("labels mismatched report periods instead of combining their auxiliary totals", () => {
  const different={ ...series(), range: { ...overview.range, to: overview.range.to+1 } };
  const html=render({ overview, series: different, previousTotalsStatus: "error" });
  expect(html).toContain("概要と日ごとの使用量の表示期間が異なるため");
  expect(html).toContain("前期間を取得できません");
  expect(html).not.toContain("cost-change-breakdown");
});
it("keeps active filters and their clear action beside an empty selection", () => {
  const html=render({ overview: { ...overview, totals: { ...overview.totals, sessions: 0 } }, noData: true, selection: { model: { key: "gpt-sample", label: "gpt-sample" } } });
  expect(html).toContain("モデル: gpt-sample");
  expect(html).toContain("絞り込みに一致する記録なし");
  expect(html).toContain("絞り込みを解除");
});
it("uses the six noun headings without main disclosures", () => {
  const html=render();
  for (const label of ["内訳","比較","セッション","手戻り","モデル切替","活動時間"]) expect(html).toContain(label);
  expect(html).not.toContain("<details");
  expect(html).not.toContain("つまずいた場所");
});
it("keeps the synthetic filter beside only the affected model table", () => {
  const page=new DOMParser().parseFromString(render({ series: series() }),"text/html");
  expect(page.querySelector("#ailog-compare")?.textContent).toContain("内部生成レコードをこの表から除く");
  expect(page.querySelector("#ailog-trend")?.textContent).not.toContain("内部生成レコード");
});
it("keeps non-additive work-tag explanations without a share column", () => {
  const props=viewProps({ overview, models: { ...models, overlapping: true }, series: series() });
  const html=renderAllUsageSections(props);
  const page=new DOMParser().parseFromString(html,"text/html");
  expect(page.querySelector("#ailog-purpose")?.textContent).toContain(WORK_TAG_OVERLAP_NOTE);
  expect(page.querySelector("#ailog-purpose")?.textContent).not.toContain("シェア");
});
it("discloses overlapping agent rows and the child inclusion exception next to their table", () => {
  const report={ ...breakdown, dimension: "agent", overlapping: true };
  const html=renderAllUsageSections(viewProps({ overview, breakdown: report, breakdownDimension: "agent" }));
  expect(html).toContain("同じターンを計上");
  expect(html).toContain("サブエージェント");
});
it("uses separate names for updating records and opening a conversation candidate", () => {
  const html=renderAllUsageSections(viewProps({ overview: { ...overview, indexFreshness: { lastIndexedAt: 1, staleFiles: 1 } }, sessions }));
  expect(html).toContain("記録を更新");
  expect(html).toContain("会話候補を開く");
  expect(html).not.toContain("次に見る");
});
it("only labels actual partial boundary days", () => {
  const from=Date.UTC(2026,9,1,15), to=from+86_400_000-1;
  expect(usageBoundaryNote({ from, to })).not.toContain("途中");
  expect(usageBoundaryNote({ from: from+1, to })).toContain("最初");
  expect(usageBoundaryNote({ from, to: to-1 })).toContain("最後");
});
