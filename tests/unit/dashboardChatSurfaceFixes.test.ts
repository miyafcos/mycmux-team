// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(`src/components/dashboard/${file}`, "utf8");
const base = read("DashboardView.css");
const surface = read("DashboardChatSurface.css");
const globals = readFileSync("src/global.css", "utf8");
let host: HTMLDivElement;
let style: HTMLStyleElement;

// jsdom does not resolve custom properties in dimensions. Resolve only the
// fixture's tokens, then let its CSS engine apply the real selectors/cascade.
function fixtureCss() {
  const tokens = new Map<string, string>();
  for (const source of [globals, surface]) postcss.parse(source).walkDecls(/^--cmux-/, declaration => {
    if (declaration.parent?.type === "rule" && [":root", ".cmux-dashboard-view"].includes(declaration.parent.selector))
      tokens.set(declaration.prop, declaration.value);
  });
  tokens.set("--cmux-read-font-size", "13px");
  const resolve = (value: string, depth = 0): string => depth > 8 ? value : value.replace(
    /var\((--[\w-]+)(?:,\s*([^()]+))?\)/g,
    (match, key: string, fallback: string) => resolve(tokens.get(key) ?? fallback ?? match, depth + 1),
  );
  return [globals, base, surface].flatMap(source => {
    const rules: string[] = [];
    postcss.parse(source).walkRules(rule => {
      if (rule.parent?.type !== "root") return;
      const copy = rule.clone();
      copy.walkDecls(declaration => { declaration.value = resolve(declaration.value); });
      rules.push(copy.toString());
    });
    return rules;
  }).join("\n");
}

beforeEach(() => {
  host = document.createElement("div");
  host.className = "cmux-dashboard-view";
  document.body.append(host);
  style = document.createElement("style");
  style.textContent = fixtureCss();
  document.head.append(style);
});
afterEach(() => { host.remove(); style.remove(); });

describe("dashboard chat surface regressions", () => {
  it("F-3 sizes text actions to their content and only icon actions to a square", () => {
    host.innerHTML = '<div class="cmux-archive-actions"><button>Stop searching</button><button><svg></svg></button></div>';
    const [text, icon] = host.querySelectorAll("button");
    expect(getComputedStyle(text).width).toBe("auto");
    expect(getComputedStyle(text).height).toBe("26px");
    expect(getComputedStyle(text).paddingInline || getComputedStyle(text).padding).toContain("8px");
    expect(getComputedStyle(text).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(icon).width).toBe("26px");
    expect(getComputedStyle(icon).padding).toBe("0px");
  });

  it.each(["is-user", "is-error"])("F-4 keeps the %s jump ring without clearing its own surface", kind => {
    host.innerHTML = `<div class="cmux-dashboard-msg ${kind}"></div>`;
    const bubble = host.firstElementChild!;
    const background = getComputedStyle(bubble).backgroundColor;
    bubble.classList.add("is-source-highlighted");
    const highlighted = getComputedStyle(bubble);
    expect(highlighted.backgroundColor).toBe(background);
    expect(highlighted.boxShadow).toContain("0 0 0 2px");
    expect(highlighted.boxShadow).toContain("60%");
    expect(highlighted.outline).toBe("none");
  });

  it.each([
    ["assistant", "user", "16px", "0px"],
    ["user", "assistant", "22px", "0px"],
    ["toolResult", "toolCall", "0px", "18px"],
    ["toolCall", "toolResult", "2px", "0px"],
    ["assistant", "toolResult", "8px", "0px"],
  ])("F-6 keeps %s after %s at either position in the virtual window", (kind, previous, top, left) => {
    host.innerHTML = `<div class="cmux-archive-log"><div aria-hidden="true"></div><div class="cmux-archive-row" data-kind="${kind}" data-prev-kind="${previous}">row</div></div>`;
    const row = host.querySelector<HTMLElement>(".cmux-archive-row")!;
    const first = getComputedStyle(row);
    expect(first.paddingTop).toBe(top);
    expect(first.paddingLeft).toBe(left);
    const prior = document.createElement("div");
    prior.className = "cmux-archive-row";
    prior.dataset.kind = previous;
    row.before(prior);
    expect(getComputedStyle(row).paddingTop).toBe(top);
    expect(getComputedStyle(row).paddingLeft).toBe(left);
    expect(surface).not.toMatch(/\+\s*\.cmux-archive-row/);
  });

  it("F-6 removes top spacing only from the first logical row", () => {
    host.innerHTML = '<div class="cmux-archive-row" data-kind="user">first</div>';
    expect(getComputedStyle(host.firstElementChild!).paddingTop).toBe("0px");
  });

  it("F-8 leaves a target-less tool result timestamp at the right edge", () => {
    host.innerHTML = '<details class="cmux-archive-tool"><summary><span class="cmux-dashboard-tool-name">Result</span><span class="cmux-dashboard-tool-time">11:33</span></summary></details>';
    expect(getComputedStyle(host.querySelector(".cmux-dashboard-tool-name")!).marginLeft).toBe("0px");
    expect(getComputedStyle(host.querySelector(".cmux-dashboard-tool-time")!).marginLeft).toBe("auto");
  });
});
