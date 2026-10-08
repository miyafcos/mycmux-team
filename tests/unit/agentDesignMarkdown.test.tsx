// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { agentDesignApi, type DesignDocument } from "../../src/lib/agentDesignApi";
import { syntheticCatalog as catalog } from "../fixtures/agent_home/catalog";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main", toggleMaximize: vi.fn() }) }));
vi.mock("../../src/hooks/useAccountsPolling", () => ({ useAccountsPolling: vi.fn() }));
vi.mock("../../src/hooks/useCliLoginEvents", () => ({ useCliLoginEvents: vi.fn() }));
vi.mock("../../src/components/layout/AccountsButton", () => ({ AccountsButton: () => <button>Accounts</button> }));
vi.mock("../../src/components/layout/WindowControls", () => ({ WindowControls: () => <button>Close window</button> }));
vi.mock("../../src/components/ailog/AiLogButton", () => ({ AiLogButton: () => <button>Log</button> }));
vi.mock("../../src/components/dashboard/DashboardButton", () => ({ DashboardButton: () => <button>Dashboard</button> }));
vi.mock("../../src/components/settings/SettingsDialog", () => ({ default: () => null }));
import { DocumentView } from "../../src/components/agentDesign/DocumentView";
import { ItemDetail } from "../../src/components/agentDesign/ui";
import TitleBar from "../../src/components/layout/TitleBar";
import { SkillsButton } from "../../src/components/skills/SkillsButton";
import { agentDesignStrings as s } from "../../src/components/agentDesign/agentDesignStrings";
import { skillsStrings } from "../../src/components/skills/skillsStrings";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const raw = "---\r\npaths:\r\n  - src/**\r\n---\r\n# Heading\r\n\r\n- Item\r\n\r\n| A | B |\r\n|---|---|\r\n| One | Two |\r\n\r\n> Quote\r\n\r\n\x60\x60\x60ts\r\nconst value = 1;\r\n\x60\x60\x60\r\n\r\n[Link](https://example.test)\r\n<script>globalThis.AD_CANARY = 1</script><img src=x onerror=\"globalThis.AD_CANARY=2\"><a href=\"javascript:AD_CANARY=3\">Blocked</a>\r\n";
const doc: DesignDocument = { id: "test", body: raw, fields: [], size: { chars: raw.length, bytes: raw.length, lines: 24 }, status: "present",
  frontmatter: { paths: ["src/**"] }, toc: [{ level: 1, text: "Heading" }],
  html: '<h1>Heading</h1><ul><li>Item</li></ul><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>One</td><td>Two</td></tr></tbody></table><blockquote><p>Quote</p></blockquote><pre><code>const value = 1;\n</code></pre><p><a href="https://example.test">Link</a></p><a>Blocked</a>' };
beforeEach(() => {
  vi.restoreAllMocks(); mocks.invoke.mockReset(); mocks.open.mockReset(); mocks.open.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "agent_design_cached" || command === "agent_design_refresh") return catalog;
    if (command === "agent_design_skills") return { generatedAt: catalog.generatedAt, categories: [], skills: [], hiddenCount: 0, newCount: 0 };
    if (command === "agent_design_document") return doc;
    if (command === "get_test_profile") return null;
    throw new Error(command);
  });
  host = document.createElement("div"); host.dataset.cmuxThemedRoot = "true"; document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.replaceChildren(); vi.restoreAllMocks(); });
const render = async (value: ReactNode) => { await act(async () => root.render(value)); };
const click = async (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
};
describe("agent design Markdown and direct skills entry", () => {
  it("opens the shelf on a first visit even before agent design has a cached catalogue", async () => {
    vi.spyOn(agentDesignApi, "peek").mockReturnValue(null);
    const cached = vi.spyOn(agentDesignApi, "cached").mockResolvedValue(null);
    const refresh = vi.spyOn(agentDesignApi, "refresh").mockResolvedValue(catalog);
    await render(<SkillsButton />);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-controls="skills-panel"]')!.click());
    expect(cached).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("agent_design_skills", { cwd: null });
    expect(document.querySelector("#skills-panel .skills-panel")).toBeTruthy();
  });
  it("renders headings, lists, tables, code, quotes, links and frontmatter without Markdown punctuation", async () => {
    await render(<DocumentView document={doc} />);
    expect(host.querySelector(".skills-markdown h1")?.textContent).toBe("Heading");
    expect(host.querySelector(".skills-markdown li")?.textContent).toBe("Item");
    expect(host.querySelector(".skills-markdown th")?.textContent).toBe("A");
    expect(host.querySelector(".skills-markdown blockquote")?.textContent).toBe("Quote");
    expect(host.querySelector(".skills-markdown pre code")?.textContent).toContain("const value");
    expect(host.querySelector(".ad-frontmatter")?.textContent).toContain('["src/**"]');
    expect(host.textContent).not.toContain("# Heading");
    expect(host.textContent).not.toContain("|---|");
    expect(host.querySelector(".ad-document-source")).toBeNull();
  });
  it("restores every original character including frontmatter and CRLF, with line numbers, and switches back", async () => {
    await render(<DocumentView document={doc} />); await click(s.sourceDocument);
    expect([...host.querySelectorAll(".ad-source-line code")].map(el => el.textContent).join("")).toBe(raw);
    expect(host.querySelectorAll(".ad-line-number")).toHaveLength(raw.split("\n").length - 1);
    expect(host.querySelector(".ad-line-number")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector("script,img")).toBeNull();
    await click(s.renderedDocument); expect(host.querySelector(".skills-markdown h1")).toBeTruthy();
  });
  it("uses the sanitized backend HTML so active content is neither displayed nor executed", async () => {
    await render(<DocumentView document={doc} />);
    expect(host.querySelector("script,img,[onerror],[onclick],a[href^='javascript:']")).toBeNull();
    expect(host.innerHTML).not.toMatch(/<script|onerror=|javascript:|AD_CANARY/);
    expect((globalThis as Record<string, unknown>).AD_CANARY).toBeUndefined();
  });
  it("opens web links through the same shell handler as skills", async () => {
    await render(<DocumentView document={doc} />);
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="https://example.test"]')!.click());
    expect(mocks.open).toHaveBeenCalledWith("https://example.test");
    await act(async () => host.querySelector<HTMLAnchorElement>("a:not([href])")!.click());
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });
  it("gives long documents a working table of contents", async () => {
    const scroll = vi.fn(); HTMLElement.prototype.scrollIntoView = scroll;
    await render(<DocumentView document={{ ...doc, body: raw.repeat(8), toc: [{ level: 1, text: "Heading" }, { level: 2, text: "Second" }], html: doc.html + "<h2>Second</h2>" }} />);
    const toc = host.querySelector(".ad-document-toc")!;
    expect(toc).toBeTruthy();
    await act(async () => toc.querySelectorAll<HTMLButtonElement>("button")[1].click());
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
  });
  it("gives comparison documents independent source switches and distinct heading IDs", async () => {
    await render(<><DocumentView document={doc} /><DocumentView document={doc} /></>);
    const headings = [...host.querySelectorAll(".skills-markdown h1")];
    expect(new Set(headings.map(el => el.id)).size).toBe(2);
    await act(async () => host.querySelectorAll<HTMLButtonElement>(".ad-document-tools button")[1].click());
    expect(host.querySelectorAll(".ad-document-source")).toHaveLength(1);
    expect(host.querySelectorAll(".skills-markdown")).toHaveLength(1);
  });
  it("shows non-Markdown with line numbers and opens formerly disallowed settings", async () => {
    await render(<DocumentView document={{ ...doc, html: undefined, body: "plain <text>" }} />);
    expect(host.querySelector("pre code")?.textContent).toBe("plain <text>");
    expect(host.querySelector(".ad-line-number")?.textContent).toBe("1");
    expect(host.querySelector(".ad-document-tools")).toBeNull();
    const item = catalog.items.find(i => !i.documentAllowed)!;
    await render(<ItemDetail item={item} catalog={catalog} api={agentDesignApi} onBack={vi.fn()} onSkill={vi.fn()} />);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_design_document", { id: item.id, cwd: catalog.cwd });
  });
  it("uses the decorated on-open response in the shared item detail", async () => {
    const item = catalog.items.find(i => i.documentAllowed)!;
    await render(<ItemDetail item={item} catalog={catalog} api={agentDesignApi} onBack={vi.fn()} onSkill={vi.fn()} />);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_design_document", { id: item.id, cwd: catalog.cwd });
    expect(host.querySelector(".skills-markdown h1")?.textContent).toBe("Heading");
  });
  it("places the two distinct real buttons together and opens their respective panels", async () => {
    await render(<TitleBar onOpenOnlinePanel={vi.fn()} />);
    const design = host.querySelector<HTMLButtonElement>('button[aria-controls="agent-design-panel"]')!;
    const skills = host.querySelector<HTMLButtonElement>('button[aria-controls="skills-panel"]')!;
    expect(skills.title).toBe(skillsStrings.title);
    expect(skills.getAttribute("aria-label")).toBe(skillsStrings.title);
    expect(design.parentElement?.nextElementSibling).toBe(skills.parentElement);
    expect(skills.querySelector("svg")?.outerHTML).not.toBe(design.querySelector("svg")?.outerHTML);
    expect(skills.querySelector("svg")?.getAttribute("width")).toBe("12");
    await act(async () => skills.click());
    expect(document.querySelector("#skills-panel .skills-panel")).toBeTruthy();
    expect(document.querySelector("#agent-design-panel")).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("agent_design_skills", { cwd: null });
    await act(async () => skills.click());
    await act(async () => design.click());
    expect(document.querySelector("#agent-design-panel .ad-view")).toBeTruthy();
    expect(design.getAttribute("aria-expanded")).toBe("true");
  });
});
