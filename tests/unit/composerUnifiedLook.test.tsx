// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleSocketCommand: vi.fn(),
  focusSessionSoon: vi.fn(),
  pushToast: vi.fn(),
}));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: mocks.handleSocketCommand }));
vi.mock("../../src/lib/focusController", () => ({ focusController: { focusSessionSoon: mocks.focusSessionSoon } }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: mocks.pushToast }) } }));
vi.mock("../../src/lib/skillsApi", () => ({ skillsApi: { peek: () => null, cached: async () => null } }));

import { PaneComposer } from "../../src/components/composer/PaneComposer";
import { ReplyComposer } from "../../src/components/dashboard/ReplyComposer";
import type { DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import type { ComposerTargetInput } from "../../src/lib/composerSend";
import { resetSessionDraft } from "../../src/lib/inputLineDraft";
import { useComposerStore } from "../../src/stores/composerStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";

const TIMEOUT = 10_000;
const SESSION = "unified-session";
const PLACEHOLDER = "メッセージを入力";
const read = (file: string) => {
  const path = resolve(import.meta.dirname, "../../", file);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const css = read("src/components/composer/composer.css");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const rules = (text: string) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(match => ({ selector: normalize(match[1]), body: normalize(match[2]) }));
const shared = (selector: string) => rules(css).find(rule => rule.selector === selector)?.body ?? "";

function composerCard(): DashboardCardModel {
  const tab = { id: "unified-tab", sessionId: SESSION, agentId: "codex", agentKind: "codex" as const, label: "Target", type: "terminal" as const };
  const pane = { id: "unified-pane", sessionId: SESSION, agentId: "codex", activeTabId: tab.id, tabs: [tab] };
  const workspace = { id: "unified-workspace", name: "Workspace", gridTemplateId: "1x1" as const, panes: [pane], status: "running" as const, createdAt: 0 };
  return { workspace, workspaceId: workspace.id, workspaceIndex: 0, pane, paneId: pane.id, paneIndex: 0, tab, tabIndex: 0,
    background: false, attentionCategory: null, group: "working", status: "working", lastActivityAt: 0, label: tab.label,
    agentKind: "codex", unobserved: false, neverStarted: false, telemetryHealth: "live", operationalState: "running",
    task: null, latestInstruction: null, activityText: null, checkpoint: null, noUpdateMinutes: 0 };
}

let host: HTMLDivElement;
let root: Root;

async function renderReply(card: DashboardCardModel | null = composerCard(), tab = true, tabAgentKind?: string) {
  await act(async () => root.render(
    <div className={tab ? "terminal-transcript-panel--tab" : "cmux-dashboard-view"}>
      <ReplyComposer card={card} inputRef={createRef<HTMLTextAreaElement>()} mentionTargets={card ? [card] : []}
        tabSessionId={tab ? SESSION : undefined} tabAgentKind={tabAgentKind} showSuggestions={false} />
    </div>,
  ));
}
async function renderPane(target: ComposerTargetInput = { command: "codex", agentKind: "codex" }) {
  await act(async () => root.render(<PaneComposer sessionId={SESSION} target={target} />));
}
function required<T extends Element>(selector: string): T {
  const element = host.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}
function expectReplyStructure() {
  expect(host.querySelectorAll(".cmux-composer-shell.cmux-dashboard-composer-row")).toHaveLength(1);
  const shell = required<HTMLElement>(".cmux-composer-shell");
  expect([...shell.children].map(child => child.tagName)).toEqual(["SPAN", "TEXTAREA", "BUTTON"]);
  expect(shell.children[0].matches("span.cmux-composer-badge")).toBe(true);
  expect(shell.children[0].textContent).toBe("Codex");
  const field = required<HTMLTextAreaElement>("textarea.cmux-composer-field.cmux-dashboard-composer-input");
  expect(field.placeholder).toBe(PLACEHOLDER);
  expect(field.rows).toBe(1);
  const send = required<HTMLButtonElement>("button.cmux-composer-send.cmux-dashboard-composer-send");
  expect(send.textContent).toBe("↵");
  expect(send.getAttribute("aria-label")).toBe("送信");
  expect(send.title).toBe("送信");
  expect(send.querySelector("svg")).toBeNull();
  expect(shell.nextElementSibling?.classList.contains("cmux-composer-hint")).toBe(true);
  expect(shell.nextElementSibling?.textContent).toBe("Shift+Enter で改行");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.handleSocketCommand.mockResolvedValue({ confirmed: true });
  useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {}, questionGuardBySession: {},
    dashboardOptimisticMessagesBySession: {}, dashboardRetryBySession: {} });
  useLiveBriefStore.getState().reset();
  useAskQuestionStore.getState().resetForTests();
  resetSessionDraft(SESSION);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(mocks.handleSocketCommand).not.toHaveBeenCalled();
  expect(mocks.focusSessionSoon).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("unified composer look", () => {
  it("U-1 shares the pane shell structure in the conversation tab", async () => {
    await renderReply();
    expectReplyStructure();
    expect(host.querySelector(".cmux-dashboard-composer-target")).toBeNull();
  }, TIMEOUT);

  it("U-2 shares the same structure and retains the dashboard destination line", async () => {
    await renderReply(composerCard(), false);
    expectReplyStructure();
    const target = required<HTMLElement>(".cmux-dashboard-composer-target");
    expect(target.textContent).toBe("送信先：このタブ（Target）");
    expect(target.nextElementSibling?.classList.contains("cmux-composer-shell")).toBe(true);
  }, TIMEOUT);

  it("U-3 replaces pane visual inline styles without changing its attributes or hint", async () => {
    await renderPane();
    const composer = required<HTMLElement>(".cmux-composer-root");
    expect(composer.getAttribute("data-composer-session")).toBe(SESSION);
    expect(composer.getAttribute("data-livebrief-interactive")).toBe("true");
    const shell = required<HTMLElement>(".cmux-composer-shell");
    expect([...shell.children].map(child => child.tagName)).toEqual(["SPAN", "TEXTAREA", "BUTTON"]);
    expect(shell.children[0].className).toBe("cmux-composer-badge");
    expect(shell.children[0].textContent).toBe("Codex");
    const field = required<HTMLTextAreaElement>("textarea.cmux-composer-field");
    expect(field.placeholder).toBe(PLACEHOLDER);
    expect(field.getAttribute("aria-label")).toBe("Codex へ送るメッセージ");
    expect(required<HTMLButtonElement>("button.cmux-composer-send").textContent?.trim()).toBe("↵");
    const hint = shell.nextElementSibling as HTMLElement;
    expect(hint.classList.contains("cmux-composer-hint")).toBe(true);
    expect(hint.textContent).toBe("Shift+Enter で改行・Esc でターミナルへ");
    for (const element of [composer, shell, shell.children[0], field, hint]) {
      expect(element.getAttribute("style") ?? "").not.toMatch(/background|padding|font|border|box-shadow|color/);
    }
  }, TIMEOUT);

  it.each(["mentions", "no card", "web"] as const)("U-4 omits a misleading agent badge with %s", async scenario => {
    const card = composerCard();
    if (scenario === "mentions") {
      useComposerStore.getState().addMentionToken(SESSION, { kind: "working-all", labelSnapshot: "動いてる全員" });
    }
    if (scenario === "web") card.tab = { ...card.tab, type: "web" };
    await renderReply(scenario === "no card" ? null : card);
    expect(host.querySelector(".cmux-composer-badge")).toBeNull();
    // Absence must not pass merely because the shared shell was never rendered.
    expect(host.querySelector(".cmux-composer-shell")).not.toBeNull();
  }, TIMEOUT);

  it.each([
    { name: "Claude", command: "claude", agentId: "claude", agentKind: "claude" },
    { name: "Codex", command: "codex", agentId: "codex", agentKind: "codex" },
    { name: "シェル", command: "bash", agentId: undefined, agentKind: undefined },
    { name: "Grok", command: "bash", agentId: undefined, agentKind: "grok" },
    { name: "claude-codex", command: "bash", agentId: undefined, agentKind: "claude-codex" },
    { name: "Oh My Pi", command: "bash", agentId: undefined, agentKind: "omp" },
    { name: "Cursor", command: "bash", agentId: undefined, agentKind: "cursor" },
  ])("U-4 matches the pane badge for $name", async ({ name, command, agentId, agentKind }) => {
    const card = composerCard();
    card.tab = { ...card.tab, commandArgv: [command], agentId, agentKind };
    card.pane = { ...card.pane, agentId: undefined, agentKind: undefined };
    await renderReply(card);
    expect(required(".cmux-composer-badge").textContent).toBe(name);
    await renderPane({ command, args: [], agentId, agentKind });
    expect(required(".cmux-composer-badge").textContent).toBe(name);
  }, TIMEOUT);

  it.each([
    { agentId: undefined, override: "grok", expected: "Grok" },
    { agentId: undefined, override: "claude", expected: "Claude" },
    { agentId: "codex", override: "claude", expected: "Codex" },
  ])("U-4 uses tabAgentKind=$override while preserving resolver precedence ($expected)", async ({ agentId, override, expected }) => {
    const card = composerCard();
    card.tab = { ...card.tab, agentId, agentKind: "shell", commandArgv: ["bash"] };
    card.pane = { ...card.pane, agentId: undefined, agentKind: "codex" };
    await renderReply(card, true, override);
    expect(required(".cmux-composer-badge").textContent).toBe(expected);
    await renderPane({ command: "bash", args: [], agentId, agentKind: override });
    expect(required(".cmux-composer-badge").textContent).toBe(expected);
  }, TIMEOUT);

  it.each([
    { name: "argv", target: { command: "bash", args: ["omp"] }, expected: "Oh My Pi" },
    { name: "launch environment", target: { command: "bash", launchEnv: { MYCMUX_LAUNCH_TARGET: "cursor" } }, expected: "Cursor" },
    { name: "pane fallback", target: { command: "grok", agentKind: "grok" }, expected: "Grok" },
  ])("U-4 resolves the same $name launch metadata as the pane", async ({ name, target, expected }) => {
    const card = composerCard();
    card.tab = { ...card.tab, agentId: undefined, agentKind: undefined, commandArgv: undefined,
      lastProcess: name === "pane fallback" ? undefined : target.command,
      ...(name === "argv" ? { commandArgv: [target.command, ...target.args!] } : {}) };
    card.pane = { ...card.pane, agentId: undefined, agentKind: undefined,
      lastProcess: name === "pane fallback" ? target.command : undefined,
      launchEnv: "launchEnv" in target ? target.launchEnv : undefined,
      ...(name === "pane fallback" ? { agentKind: "grok" } : {}) };
    await renderReply(card);
    expect(required(".cmux-composer-badge").textContent).toBe(expected);
    await renderPane(target);
    expect(required(".cmux-composer-badge").textContent).toBe(expected);
  }, TIMEOUT);

  it.each(["pane", "tab", "dashboard"] as const)("U-5 ties %s focus styling only to the textarea", async surface => {
    useComposerStore.getState().setDraft(SESSION, "draft");
    if (surface === "pane") await renderPane();
    else await renderReply(composerCard(), surface === "tab");
    const field = required<HTMLTextAreaElement>("textarea");
    const shell = required<HTMLElement>(".cmux-composer-shell");
    const hint = required<HTMLElement>(".cmux-composer-hint");
    const send = required<HTMLButtonElement>(".cmux-composer-send");
    expect(send.disabled).toBe(false);
    expect(shell.classList.contains("is-focused")).toBe(false);
    expect(hint.classList.contains("is-visible")).toBe(false);
    await act(async () => field.focus());
    expect(shell.classList.contains("is-focused")).toBe(true);
    expect(hint.classList.contains("is-visible")).toBe(true);
    await act(async () => field.blur());
    expect(shell.classList.contains("is-focused")).toBe(false);
    expect(hint.classList.contains("is-visible")).toBe(false);
    await act(async () => field.focus());
    await act(async () => send.focus());
    expect(document.activeElement).toBe(send);
    expect(shell.classList.contains("is-focused")).toBe(false);
    expect(hint.classList.contains("is-visible")).toBe(false);
    expect(shell.nextElementSibling).toBe(hint);
  }, TIMEOUT);

  it.each(["pane", "tab", "dashboard"] as const)("U-6 disables the empty %s send without inline opacity", async surface => {
    if (surface === "pane") await renderPane();
    else await renderReply(composerCard(), surface === "tab");
    const send = required<HTMLButtonElement>(".cmux-composer-send");
    expect(send.disabled).toBe(true);
    expect(send.style.opacity).toBe("");
  }, TIMEOUT);

  const declarations: Record<string, string> = {
    ".cmux-composer-root": "flex: 0 0 auto; display: grid; gap: 2px; padding: 4px 8px 6px; border-top: 1px solid var(--cmux-border); background: var(--cmux-bg);",
    ".cmux-composer-shell": "display: flex; align-items: flex-end; gap: 6px; padding: 4px 6px; border-radius: var(--cmux-radius-lg); background: var(--cmux-surface); box-shadow: inset 0 0 0 1px var(--cmux-border-hairline); transition: background 120ms ease-out, box-shadow 120ms ease-out;",
    ".cmux-composer-shell.is-focused": "background: var(--cmux-surface-raised); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cmux-accent) 40%, transparent), 0 2px 12px rgba(0, 0, 0, 0.18);",
    ".cmux-composer-badge": "flex: 0 0 auto; align-self: center; color: var(--cmux-text-dim); font-size: var(--cmux-font-size-xs); line-height: normal; white-space: nowrap;",
    ".cmux-composer-field": "flex: 1; min-width: 0; resize: none; border: none; outline: none; background: transparent; color: var(--cmux-text); font-family: var(--cmux-font-mono); font-size: var(--cmux-font-size-sm); line-height: 20px; padding: 2px 0; min-height: 24px; max-height: 120px;",
    ".cmux-composer-send": "flex: 0 0 auto; align-self: flex-end; border: none; background: transparent; color: var(--cmux-text-secondary); cursor: pointer; font-size: var(--cmux-font-size-sm); line-height: 20px; padding: 0 2px; animation: cmux-composer-send-in 90ms ease-out;",
    ".cmux-composer-send:disabled": "opacity: 0.3; cursor: default;",
    ".cmux-composer-hint": "display: flex; justify-content: flex-end; gap: 10px; padding: 0 8px; color: var(--cmux-text-dim); font-size: var(--cmux-font-size-xs); line-height: normal; visibility: hidden;",
    ".cmux-composer-hint.is-visible": "visibility: visible;",
  };
  it.each(Object.entries(declarations))("U-7a preserves every pane declaration in %s", (selector, expected) => {
    const body = shared(selector);
    expect(body, selector).not.toBe("");
    for (const declaration of expected.split(";").filter(value => value.trim())) expect(body).toContain(normalize(declaration) + ";");
  }, TIMEOUT);

  it("U-7b uses only defined theme tokens and the existing keyframes", () => {
    expect(css).not.toBe("");
    const global = read("src/global.css");
    for (const [, token] of css.matchAll(/var\((--cmux-[\w-]+)/g)) expect(global).toMatch(new RegExp(token + "\\s*:"));
    expect(global).toContain("@keyframes cmux-composer-send-in");
    expect(css).not.toMatch(/--cmux-[\w-]+\s*:/);
  }, TIMEOUT);

  it.each([
    "src/components/dashboard/DashboardView.css",
    "src/components/dashboard/DashboardChatSurface.css",
    "src/components/dashboard/DashboardA.css",
    "src/components/dashboard/DashboardUi.css",
    "src/components/terminal/AgentTabConversation.css",
  ])("U-7c removes old composer-specific selectors from %s", file => {
    for (const rule of rules(read(file))) {
      expect(rule.selector, file).not.toMatch(/\.cmux-dashboard-composer-(?:row|input|send)\b/);
    }
  }, TIMEOUT);

  it("U-7d leaves only dynamic height in pane inline styles", () => {
    const source = read("src/components/composer/PaneComposer.tsx");
    expect(source).not.toMatch(/\w+Style:\s*CSSProperties/);
    expect(source).toContain('import "./composer.css"');
    expect(source).toContain("className=");
  }, TIMEOUT);

  it("U-7e shares the label table, placeholder and sizing constants", () => {
    const common = read("src/components/composer/composerLook.ts");
    expect(common).toContain(PLACEHOLDER);
    for (const [file, prefix] of [
      ["src/components/composer/PaneComposer.tsx", "./"],
      ["src/components/dashboard/ReplyComposer.tsx", "../composer/"],
    ]) {
      const source = read(file);
      const names = source.match(new RegExp('import\\s*\\{([^}]+)\\}\\s*from\\s*"' + prefix.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&") + 'composerLook"'))?.[1] ?? "";
      expect(names).toContain("COMPOSER_PLACEHOLDER");
      expect(names).toContain("TARGET_LABEL");
      expect(names).toContain(file.includes("PaneComposer") ? "COMPOSER_LINE_HEIGHT" : "COMPOSER_MIN_HEIGHT");
      expect(source).toContain("placeholder={COMPOSER_PLACEHOLDER}");
    }
  }, TIMEOUT);
});
