// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { UsageRhythm } from "../../src/components/ailog/UsageRhythm";
import { rhythm } from "../helpers/ailogPlanAFixtures";
const dom=(metric: "ioTokens" | "totalTokens" | "turns", report=rhythm) => new DOMParser().parseFromString(renderToStaticMarkup(<UsageRhythm report={report} metric={metric} />), "text/html");
it.each([["ioTokens", "230"], ["totalTokens", "460"], ["turns", "23"]] as const)("shows every named slot and its exact %s amount as a horizontal bar", (metric, peak) => {
  const page=dom(metric);
  expect(page.querySelectorAll("[data-rhythm-slot]")).toHaveLength(31);
  const lastHour=page.querySelector('[data-rhythm-slot="23"]')!;
  expect(lastHour.textContent).toContain("23時");
  expect(lastHour.lastElementChild?.textContent).toBe(peak);
  expect(page.body.textContent).toContain("最多 23時");
  expect(page.querySelector("details")).toBeNull();
});
it("keeps zero values and no peak in both full cycles", () => {
  const empty={ ...rhythm, byHour: rhythm.byHour.map(row => ({ ...row, turns: 0 })), byWeekday: rhythm.byWeekday.map(row => ({ ...row, turns: 0 })) };
  const page=dom("turns", empty);
  expect(page.querySelectorAll("[data-rhythm-slot]")).toHaveLength(31);
  for (const row of page.querySelectorAll("[data-rhythm-slot]")) expect(row.lastElementChild?.textContent).toBe("0");
  expect(page.body.textContent?.match(/記録なし/g)).toHaveLength(2);
});
it("does not collapse either cycle when no activity days are present", () => {
  const page=dom("ioTokens", { ...rhythm, activeDays: 0, days: [], byHour: rhythm.byHour.map(row => ({ ...row, io: 0 })), byWeekday: rhythm.byWeekday.map(row => ({ ...row, io: 0 })) });
  expect(page.querySelectorAll("[data-rhythm-slot]")).toHaveLength(31);
  expect(page.body.textContent).toContain("曜日");
});
