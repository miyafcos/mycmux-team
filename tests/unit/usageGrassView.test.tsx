// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDayInput, type SeriesReport } from "../../src/lib/ailog";

const measurement = vi.hoisted(() => ({ width: 0 }));
vi.mock("../../src/hooks/useElementWidth", () => ({ useElementWidth: () => ({ ref: { current: null }, width: measurement.width }) }));

const renders = vi.hoisted(() => new Map<number, number>());
vi.mock("react/jsx-runtime", async importOriginal => {
  const runtime = await importOriginal<typeof import("react/jsx-runtime")>();
  const counted = (original: typeof runtime.jsx): typeof runtime.jsx => (type, props, key) => {
    if (type === "button" && props && "data-usage-day" in props) {
      const day = Number(props["data-usage-day"]);
      renders.set(day, (renders.get(day) ?? 0) + 1);
    }
    return original(type, props, key);
  };
  return { ...runtime, jsx: counted(runtime.jsx), jsxs: counted(runtime.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async importOriginal => {
  const runtime = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    const [type, props] = args;
    if (type === "button" && props && "data-usage-day" in props) {
      const day = Number(props["data-usage-day"]);
      renders.set(day, (renders.get(day) ?? 0) + 1);
    }
    return runtime.jsxDEV(...args);
  } };
});
import { UsageGrass } from "../../src/components/ailog/UsageGrass";
import { OverlayShell } from "../../src/components/common/OverlayShell";

const start = parseDayInput("2026-10-01")!;
const dayMs = 86400000;
const coverage = { models: [], tokens: 0 };
const report: SeriesReport = {
  range: { from: start, to: start + 9 * dayMs - 1, label: "検証" }, bucket: "day", groupBy: "model_raw",
  buckets: [0, 1, 3, 8].map(i => ({ bucket: start + i * dayMs, turns: 1, sessions: 2, costUsd: i + 1,
    groups: [{ group: "gpt-6.1-sol", turns: 1, sessions: 2, input: (i + 1) * 10, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: i + 1 },
      { group: "claude-opus-5-5", turns: 1, sessions: 1, input: 5, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }] })),
  priceSource: "test", priceCoverage: { priced: coverage, local: coverage, internal: coverage, flat: coverage, reported: coverage, unknown: coverage, coveredTokenRatio: 0.75 }, costNote: "",
};

describe("daily usage grid interactions", () => {
  let host: HTMLDivElement;
  let root: Root;
  const pick = vi.fn();
  const cell = (index: number) => host.querySelector<HTMLButtonElement>(`[data-usage-day="${start + index * dayMs}"]`)!;
  const heading = () => host.querySelector("[data-grass-breakdown] h3")!.textContent;
  async function key(target: Element, value: string) {
    await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); });
  }
  async function hover(index: number) {
    await act(async () => { cell(index).dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  }
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    pick.mockClear(); renders.clear(); measurement.width = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<UsageGrass report={report} metric="ioTokens" onPickDay={pick} />));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("renders nine inclusive days with accessible date, amount, leading model and percentage", () => {
    expect(host.querySelectorAll("[data-usage-day]")).toHaveLength(9);
    expect(cell(0).getAttribute("aria-label")).toBe("10/1（木） · 15 tok · gpt-6.1-sol 66.7%");
    expect(cell(2).getAttribute("aria-label")).toBe("10/3（土） · 0 tok · 記録なし");
    expect(host.querySelectorAll('[data-usage-day][tabindex="0"]')).toHaveLength(1);
  });
  it("moves focus by days and weeks, clamps at endpoints, and retains one Tab stop", async () => {
    await act(async () => cell(8).focus());
    await key(cell(8), "Home"); expect(document.activeElement).toBe(cell(0));
    await key(cell(0), "ArrowDown"); expect(document.activeElement).toBe(cell(1));
    await key(cell(1), "ArrowRight"); expect(document.activeElement).toBe(cell(8));
    await key(cell(8), "ArrowLeft"); expect(document.activeElement).toBe(cell(1));
    await key(cell(1), "ArrowUp"); expect(document.activeElement).toBe(cell(0));
    await key(cell(0), "ArrowUp"); expect(document.activeElement).toBe(cell(0));
    await key(cell(0), "End"); expect(document.activeElement).toBe(cell(8));
    await key(cell(8), "ArrowDown"); expect(document.activeElement).toBe(cell(8));
    expect(host.querySelectorAll('[data-usage-day][tabindex="0"]')).toHaveLength(1);
    expect(cell(8).tabIndex).toBe(0);
  });
  it("pins with Enter, unpins with Escape or a second activation, and supports Space", async () => {
    await key(cell(0), "Enter");
    expect(cell(0).getAttribute("aria-pressed")).toBe("true");
    expect(heading()).toBe("10/1（木）の内訳");
    await key(cell(0), "Escape");
    expect(cell(0).getAttribute("aria-pressed")).toBe("false"); expect(heading()).toBe("期間全体の内訳");
    await key(cell(1), " ");
    expect(cell(1).getAttribute("aria-pressed")).toBe("true");
    await act(async () => cell(1).click());
    expect(cell(1).getAttribute("aria-pressed")).toBe("false"); expect(heading()).toBe("期間全体の内訳");
  });
  it("previews on hover and focus, then returns to the pinned date or the full period", async () => {
    await hover(1); expect(heading()).toBe("10/2（金）の内訳");
    expect(host.querySelector('[role="tooltip"]')?.textContent).toContain("gpt-6.1-sol");
    await act(async () => cell(1).dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    expect(heading()).toBe("期間全体の内訳");
    await key(cell(0), "Enter");
    await act(async () => cell(3).focus());
    expect(heading()).toBe("10/4（日）の内訳");
    await act(async () => cell(3).blur());
    expect(heading()).toBe("10/1（木）の内訳");
  });
  it("passes the pinned day's timestamp to the existing filter action and clears with the return button", async () => {
    await act(async () => cell(1).click());
    const find = (text: string) => [...host.querySelectorAll("button")].find(button => button.textContent === text)!;
    await act(async () => find("この日に絞り込む").click());
    expect(pick).toHaveBeenCalledExactlyOnceWith(start + dayMs);
    await act(async () => find("期間全体に戻す").click());
    expect(heading()).toBe("期間全体の内訳");
    expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
  });
  it("offers all five legend levels and a newest-first table containing recorded days only", () => {
    expect([...host.querySelectorAll("[data-grass-legend]")].map(n => n.getAttribute("title"))).toEqual(["記録なし", "15 tok", "25 tok", "45 tok", "95 tok"]);
    expect(host.querySelector("summary")?.textContent).toBe("日ごとの数値を表で見る");
    expect([...host.querySelectorAll("tbody th")].map(n => n.textContent)).toEqual(["10/9（金）", "10/4（日）", "10/2（金）", "10/1（木）"]);
  });
  it("omits percentages for sessions and distinguishes daily unique counts from the extended period total", async () => {
    await act(async () => root.render(<UsageGrass report={report} metric="sessions" onPickDay={pick} />));
    const breakdown = host.querySelector("[data-grass-breakdown]")!;
    expect(breakdown.querySelector("strong")?.textContent).toBe("延べ 8");
    expect(breakdown.textContent).toContain("割合は出していません");
    expect(breakdown.textContent).not.toContain("%");
    expect(cell(0).getAttribute("aria-label")).not.toContain("%");
    await hover(0);
    expect(breakdown.querySelector("strong")?.textContent).toBe("2");
  });
  it("shows the empty-day message even though the period has other records", async () => {
    await act(async () => cell(2).click());
    expect(host.querySelector("[data-grass-breakdown]")?.textContent).toContain("この日の記録はありません。");
    expect(host.querySelectorAll("[data-grass-breakdown-row]")).toHaveLength(0);
  });
  it("changes the breakdown on hover without rendering any day button again", async () => {
    expect(renders.size).toBe(9);
    const before = new Map(renders);
    await hover(1);
    expect(heading()).toBe("10/2（金）の内訳");
    expect(renders).toEqual(before);
    await hover(3);
    expect(heading()).toBe("10/4（日）の内訳");
    expect(renders).toEqual(before);
  });
  it("includes the price coverage note for the cost metric", async () => {
    await act(async () => root.render(<UsageGrass report={report} metric="costUsd" onPickDay={pick} />));
    expect(host.querySelector("[data-grass-breakdown]")?.textContent).toContain("価格情報あり 75%");
  });

  it.each(["pinned", "focused"] as const)("consumes only the first Escape for a %s day inside the real overlay", async mode => {
    const close = vi.fn();
    await act(async () => root.render(<OverlayShell open onClose={close} ariaLabel="検証"><UsageGrass report={report} metric="ioTokens" onPickDay={pick} /></OverlayShell>));
    const dialog = document.querySelector<HTMLElement>(".cmux-overlay-panel")!;
    const target = dialog.querySelector<HTMLButtonElement>('[data-usage-day="' + start + '"]')!;
    await act(async () => { if (mode === "pinned") target.click(); else target.focus(); });
    if (mode === "pinned") expect(target.getAttribute("aria-pressed")).toBe("true");
    else expect(dialog.querySelector('[role="tooltip"]')).not.toBeNull();
    await key(target, "Escape");
    expect(close).not.toHaveBeenCalled();
    expect(document.body.contains(dialog)).toBe(true);
    expect(target.getAttribute("aria-pressed")).toBe("false");
    expect(dialog.querySelector('[role="tooltip"]')).toBeNull();
    expect(dialog.querySelector("h3")?.textContent).toBe("期間全体の内訳");
    await key(target, "Escape");
    expect(close).toHaveBeenCalledTimes(1);
  });
  it.each(["pinned", "focused"] as const)("lets only the second Escape reach a React ancestor for a %s day", async mode => {
    const ancestor = vi.fn();
    await act(async () => root.render(<div onKeyDown={ancestor}><UsageGrass report={report} metric="ioTokens" onPickDay={pick} /></div>));
    await act(async () => { if (mode === "pinned") cell(0).click(); else cell(0).focus(); });
    await key(cell(0), "Escape");
    expect(ancestor).not.toHaveBeenCalled();
    expect(cell(0).getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    await key(cell(0), "Escape");
    expect(ancestor).toHaveBeenCalledTimes(1);
  });
  it("sizes hidden columns from the period and every day, counts full-width names twice, and reserves all period rows", async () => {
    const japanese = "全角全角全角全角全角全角";
    const ascii = "abcdefghijklmnopqrstuv";
    const makeGroup = (name: string, input: number) => ({ group: name, input, output: 0, turns: 1, sessions: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
    const sized = { ...report, buckets: [
      { ...report.buckets[0], groups: [makeGroup(japanese, 99_000_000), makeGroup(ascii, 1)] },
      { ...report.buckets[1], groups: [makeGroup(japanese, 1_000_000), makeGroup(ascii, 1)] },
    ] };
    await act(async () => root.render(<UsageGrass report={sized} metric="ioTokens" onPickDay={pick} />));
    const measure = host.querySelector<HTMLElement>("[data-grass-measure]")!;
    expect(measure.getAttribute("aria-hidden")).toBe("true");
    expect(measure.style.visibility).toBe("hidden");
    expect(measure.hasAttribute("data-grass-breakdown-row")).toBe(false);
    expect(measure.querySelector("[data-grass-measure-name]")?.textContent).toBe(japanese);
    expect(measure.querySelector("[data-grass-measure-value]")?.textContent).toBe("9,900.0万 tok");
    expect(measure.querySelector("[data-grass-measure-share]")?.textContent).toBe("100.0%");
    expect([...measure.children].every(child => (child as HTMLElement).style.height === "0px")).toBe(true);
    expect(host.querySelectorAll("[data-grass-breakdown-row]")).toHaveLength(2);
    expect(host.querySelector<HTMLElement>("[data-grass-breakdown-rows]")?.style.minHeight).toBe("56px");
    await hover(2);
    expect(host.querySelectorAll("[data-grass-breakdown-row]")).toHaveLength(0);
    expect(host.querySelector<HTMLElement>("[data-grass-breakdown-rows]")?.style.minHeight).toBe("56px");
    expect(measure.querySelector("[data-grass-measure-value]")?.textContent).toBe("9,900.0万 tok");
  });
  it("keeps heading, action slot and total in that order and hides actions while previewing a different day", async () => {
    const header = host.querySelector<HTMLElement>("[data-grass-heading]")!;
    const order = () => [...header.children].map(child => child.tagName);
    const actions = host.querySelector<HTMLElement>("[data-grass-actions]")!;
    expect(order()).toEqual(["H3", "DIV", "STRONG"]);
    expect(actions.style.visibility).toBe("hidden");
    await act(async () => cell(0).click());
    expect(order()).toEqual(["H3", "DIV", "STRONG"]);
    expect(actions.style.visibility).toBe("visible");
    expect(actions.getAttribute("aria-hidden")).toBeNull();
    await hover(1);
    expect(heading()).toBe("10/2（金）の内訳");
    expect(actions.style.visibility).toBe("hidden");
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    await hover(0);
    expect(actions.style.visibility).toBe("visible");
    expect(host.querySelector("style")?.textContent).toContain("min-height: 32px");
    expect(host.querySelector("style")?.textContent).toContain("'heading actions total'");
  });
  it("uses an accent focus-visible outline separately from the inset pinned mark", async () => {
    await act(async () => cell(0).click());
    const rules = host.querySelector("style")!.textContent!;
    expect(rules).toContain("[data-usage-day]:focus-visible { outline: 2px solid var(--cmux-accent)");
    expect(rules).not.toContain("[data-usage-day]:focus {");
    expect(cell(0).style.boxShadow).toBe("inset 0 0 0 2px var(--cmux-text)");
    expect(cell(0).style.outline).toBe("");
    await act(async () => cell(1).focus());
    expect(cell(0).style.boxShadow).toContain("inset");
    expect(cell(1).style.boxShadow).toBe("");
    expect(document.activeElement).toBe(cell(1));
  });
  it("uses content width plus a 320-to-720px breakdown and a two-column definition list at width 1200", async () => {
    measurement.width = 1200;
    await act(async () => root.render(<UsageGrass report={report} metric="ioTokens" onPickDay={pick} />));
    const columns = host.querySelector<HTMLElement>("[data-grass-columns]")!;
    expect(columns.style.gridTemplateColumns).toBe("max-content minmax(320px, 720px)");
    expect(columns.style.gap).toBe("24px");
    const left = host.querySelector<HTMLElement>("[data-grass-left]")!;
    expect(left.style.width).toBe("max-content");
    expect(left.style.maxWidth).toBe("856px");
    const stats = host.querySelector<HTMLDListElement>("dl")!;
    expect(stats.style.gridTemplateColumns).toBe("max-content max-content");
    expect([...stats.querySelectorAll("dt")].map(el => el.textContent)).toEqual(["記録のある日", "連続", "最長", "最多"]);
    expect([...stats.querySelectorAll("dd")].map(el => el.textContent)).toEqual(["4 / 9 日", "1 日（10/9 まで）", "2 日", "10/9（金） 95 tok"]);
    expect([...stats.querySelectorAll("dd")].every(el => el.style.whiteSpace === "nowrap" && el.style.color === "var(--cmux-text)")).toBe(true);
  });
  it("keeps the narrow layout stacked with the same definition-list statistics", () => {
    expect(host.querySelector<HTMLElement>("[data-grass-columns]")?.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(host.querySelectorAll("dl dt")).toHaveLength(4);
  });
  it("keeps a keyboard preview and reanchors its hint after scrolling, then clears a pointer preview on scroll", async () => {
    const scroll = host.querySelector<HTMLElement>("[data-grass-scroll]")!;
    let left = 40;
    vi.spyOn(cell(0), "getBoundingClientRect").mockImplementation(() => new DOMRect(left, 200, 16, 16));
    cell(0).scrollIntoView = vi.fn(() => { left = 140; scroll.dispatchEvent(new Event("scroll")); });
    await act(async () => cell(8).focus());
    await key(cell(8), "Home");
    expect(document.activeElement).toBe(cell(0));
    expect(cell(0).scrollIntoView).toHaveBeenCalledTimes(1);
    expect(heading()).toBe("10/1（木）の内訳");
    expect(host.querySelector<HTMLElement>('[role="tooltip"]')?.style.left).toBe("148px");
    await hover(0);
    await act(async () => scroll.dispatchEvent(new Event("scroll")));
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    expect(heading()).toBe("期間全体の内訳");
  });
  it("retains a pinned day and Tab stop on refresh and resets both only when that day leaves the range", async () => {
    await act(async () => cell(1).focus());
    await key(cell(1), "Enter");
    const refreshed = { ...report, buckets: report.buckets.map(bucket => ({ ...bucket, groups: bucket.groups.map(group => ({ ...group, input: group.input + 1 })) })) };
    await act(async () => root.render(<UsageGrass report={refreshed} metric="ioTokens" onPickDay={pick} />));
    expect(cell(1).getAttribute("aria-pressed")).toBe("true");
    expect(cell(1).tabIndex).toBe(0);
    expect(host.querySelectorAll('[data-usage-day][tabindex="0"]')).toHaveLength(1);
    expect(heading()).toBe("10/2（金）の内訳");
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    const narrowed = { ...refreshed, range: { ...refreshed.range, from: start + 2 * dayMs } };
    await act(async () => root.render(<UsageGrass report={narrowed} metric="ioTokens" onPickDay={pick} />));
    expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(cell(8).tabIndex).toBe(0);
    expect(heading()).toBe("期間全体の内訳");
  });
  it.each([[4, 326], [5, 326], [0, 250]])("places the hint for day index %s below the top two rows and above other rows", async (index, top) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip" ? new DOMRect(0, 0, 200, 40) : new DOMRect(100, 300, 16, 16);
    });
    await act(async () => cell(index).focus());
    const hint = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(hint.style.top).toBe(top + "px");
    expect(hint.style.boxShadow).toBe("var(--cmux-shadow-popover, 0 3px 12px #0003)");
  });
  it("exposes all legend ranges as an image description", () => {
    const legend = host.querySelector('[data-grass-legend-row][role="img"]')!;
    expect(legend.getAttribute("aria-label")).toBe("少から多の凡例: 記録なし、15 tok、25 tok、45 tok、95 tok");
    expect(legend.querySelectorAll("[data-grass-legend]")).toHaveLength(5);
  });
  it("bounds the daily value table in a labelled keyboard-accessible scroll region", () => {
    const region = host.querySelector<HTMLElement>('[role="region"][aria-label="日ごとの数値を表で見る"]')!;
    expect(region.style.maxHeight).toBe("320px");
    expect(region.style.overflow).toBe("auto");
    expect(region.tabIndex).toBe(0);
    expect(region.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(region.closest("details")?.querySelector("summary")?.textContent).toBe("日ごとの数値を表で見る");
  });
  it("keeps weekday labels outside scrolling and right-aligns a month label in the final columns", async () => {
    const from = parseDayInput("2026-11-30")!;
    await act(async () => root.render(<UsageGrass report={{ ...report, range: { from, to: from + 7 * dayMs - 1, label: "検証" }, buckets: [] }} metric="ioTokens" onPickDay={pick} />));
    const scroll = host.querySelector("[data-grass-scroll]")!;
    const labels = host.querySelector<HTMLElement>("[data-grass-weekdays]")!;
    expect(scroll.contains(labels)).toBe(false);
    expect(labels.style.paddingTop).toBe("30px");
    const month = host.querySelector<HTMLElement>("[data-grass-month]")!;
    expect(month.textContent).toBe("12月");
    expect(month.style.right).toBe("0px");
    expect(month.style.left).toBe("");
    expect(host.querySelector<HTMLElement>("[data-grass-grid]")?.style.justifyContent).toBe("end");
    expect((month.parentElement as HTMLElement).style.width).toBe("24px");
  });
  it("renders distinct empty and zero-period messages, omits their peak statistic and omits zero-day leaders", async () => {
    await act(async () => root.render(<UsageGrass report={{ ...report, buckets: [] }} metric="ioTokens" onPickDay={pick} />));
    expect(host.querySelector("[data-grass-breakdown]")?.textContent).toContain("この期間の記録はありません。");
    expect([...host.querySelectorAll("dl dt")].map(el => el.textContent)).not.toContain("最多");
    const zero = { ...report, buckets: report.buckets.map(bucket => ({ ...bucket, groups: bucket.groups.map(group => ({ ...group, costUsd: 0 })) })) };
    await act(async () => root.render(<UsageGrass report={zero} metric="costUsd" onPickDay={pick} />));
    expect(host.querySelector("[data-grass-breakdown]")?.textContent).toContain("この期間のコスト相当は0です。");
    expect([...host.querySelectorAll("dl dt")].map(el => el.textContent)).not.toContain("最多");
    expect(cell(0).getAttribute("aria-label")).toBe("10/1（木） · ¥0.0");
    await hover(0);
    const hint = host.querySelector('[role="tooltip"]')!;
    expect(hint.children).toHaveLength(1);
    expect(hint.textContent).toBe("10/1（木） · ¥0.0");
    expect(host.querySelector("tbody tr:last-child td:last-child")?.textContent).toBe("—");
  });
});
