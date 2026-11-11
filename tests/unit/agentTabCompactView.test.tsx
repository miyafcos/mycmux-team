// @vitest-environment jsdom
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/components/dashboard/useTranscriptHistory", () => ({
  useTranscriptHistory: (_descriptor: unknown, reader: unknown) => reader,
}));
vi.mock("../../src/components/layout/socketCommands", () => ({ handleSocketCommand: vi.fn() }));

import { ArchiveTranscript } from "../../src/components/dashboard/ArchiveTranscript";
import { ReplyComposer } from "../../src/components/dashboard/ReplyComposer";
import type { DashboardCardModel } from "../../src/components/dashboard/dashboardModel";
import type { HistoryState, TranscriptHistoryReader } from "../../src/stores/transcriptHistoryStore";
import type { TranscriptDescriptor } from "../../src/lib/livebrief";
import { useComposerStore } from "../../src/stores/composerStore";
import { useLiveBriefStore } from "../../src/stores/liveBriefStore";
import { useAskQuestionStore } from "../../src/stores/askQuestionStore";

const css = readFileSync(resolve(import.meta.dirname, "../../src/components/terminal/AgentTabConversation.css"), "utf8");
const descriptor: TranscriptDescriptor = { ptySessionId: "compact-session", tabId: "compact-tab", expectedAgentKind: "codex", expectedAgentSessionId: "compact-agent" };
const diagnostics = [
  { field: "notice", code: "readerBusy", label: "ほかの会話を読み取り中です。少し待って再試行できます" },
  { field: "error", code: "permissionDenied", label: "この会話の記録を読み取れません" },
] as const;

let root: Root, host: HTMLDivElement, state: HistoryState, reader: TranscriptHistoryReader;
let style: HTMLStyleElement | null;

function ArchiveHarness({ tabPresentation = true, navigation = true, navigationHidden = false }: { tabPresentation?: boolean; navigation?: boolean; navigationHidden?: boolean }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <div className={tabPresentation ? "terminal-transcript-panel--tab" : "cmux-dashboard-view"}>
    <div className="terminal-transcript-panel__head">{navigation ? <div ref={setTarget} hidden={navigationHidden} /> : null}</div>
    <ArchiveTranscript descriptor={descriptor} prepared={reader} compact tabPresentation={tabPresentation} navigationTarget={target} navigationHidden={navigationHidden} />
  </div>;
}

function composerCard(): DashboardCardModel {
  const tab = { id: "compact-tab", sessionId: "compact-session", agentId: "codex", agentKind: "codex" as const, label: "Target", type: "terminal" as const };
  const pane = { id: "compact-pane", sessionId: tab.sessionId, agentId: "codex", activeTabId: tab.id, tabs: [tab] };
  const workspace = { id: "compact-workspace", name: "Workspace", gridTemplateId: "1x1" as const, panes: [pane], status: "running" as const, createdAt: 0 };
  return { workspace, workspaceId: workspace.id, workspaceIndex: 0, pane, paneId: pane.id, paneIndex: 0, tab, tabIndex: 0,
    background: false, attentionCategory: null, group: "working", status: "working", lastActivityAt: 0, label: tab.label,
    agentKind: "codex", unobserved: false, neverStarted: false, telemetryHealth: "live", operationalState: "running",
    task: null, latestInstruction: null, activityText: null, checkpoint: null, noUpdateMinutes: 0 };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state = { descriptor, status: "ready", readerId: "compact-reader", sourceGeneration: "g", items: [{
    occurrenceId: "codex:compact-agent:g:0:0", sourceStart: "0", sourceEnd: "10", slot: 0, kind: "user",
    timestamp: null, text: "Recorded message", bodyRef: null, callId: null, tool: null, target: null, aliases: [],
  }], pages: [], olderCursor: "older", newerCursor: "tail", continuation: null, reachedStart: false, reachedFence: true,
    loading: null, following: true, newTail: false, error: null, notice: null, version: 0 };
  reader = { getSnapshot: () => state, subscribe: () => () => {}, get snapshot() { return state; }, visible: true,
    setBeforeMutation: vi.fn(), setVisible: vi.fn(), setSelection: vi.fn(), setAnchor: vi.fn(), setFollowing: vi.fn(),
    cancelSearch: vi.fn(), reopen: vi.fn(), load: vi.fn(), latest: vi.fn(), first: vi.fn(),
  } as unknown as TranscriptHistoryReader;
  useComposerStore.setState({ draftBySession: {}, mentionTokensBySession: {}, commandKindBySession: {}, questionGuardBySession: {},
    dashboardOptimisticMessagesBySession: {}, dashboardRetryBySession: {} });
  useLiveBriefStore.getState().reset();
  useAskQuestionStore.getState().resetForTests();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); style = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); style?.remove(); window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("compact conversation tab boundaries", () => {
  it.each(diagnostics)("A-1 puts $field in the tab header without a separate notice row", async diagnostic => {
    state = { ...state, [diagnostic.field]: diagnostic.code };
    await act(async () => root.render(<ArchiveHarness />));
    const mark = host.querySelector('.terminal-transcript-panel__head [role="img"]');
    expect(mark?.getAttribute("aria-label")).toBe(diagnostic.label);
    expect(mark?.getAttribute("title")).toBe(diagnostic.label);
    if (diagnostic.field === "error") expect(mark?.getAttribute("data-dashboard-status")).toBe("error");
    expect(host.querySelector(".cmux-archive-notice")).toBeNull();
  });

  it.each(diagnostics)("A-2 retains the dashboard $field row even with a navigation portal", async diagnostic => {
    state = { ...state, [diagnostic.field]: diagnostic.code };
    await act(async () => root.render(<ArchiveHarness tabPresentation={false} />));
    const mark = host.querySelector('.cmux-archive-notice [role="img"]');
    expect(mark?.getAttribute("aria-label")).toBe(diagnostic.label);
    expect(host.querySelector(".terminal-transcript-panel__head .agent-tab-archive-status")).toBeNull();
  });

  it("keeps the tab's diagnostics readable until its navigation target exists", async () => {
    state = { ...state, notice: "readerBusy", error: "permissionDenied" };
    await act(async () => root.render(<ArchiveHarness navigation={false} />));
    expect(host.querySelectorAll(".cmux-archive-notice")).toHaveLength(2);
  });

  it("puts both tab diagnostics after the four navigation actions", async () => {
    state = { ...state, notice: "readerBusy", error: "permissionDenied" };
    await act(async () => root.render(<ArchiveHarness />));
    const actions = host.querySelector(".terminal-transcript-panel__head .cmux-archive-actions")!;
    expect([...actions.children].slice(0, 4).map(child => child.getAttribute("aria-label"))).toEqual(["最初へ", "前の指示へ", "次の指示へ", "最新へ"]);
    expect([...actions.children].slice(4, 6).map(child => child.getAttribute("aria-label"))).toEqual(diagnostics.map(diagnostic => diagnostic.label));
    expect(host.querySelector(".cmux-archive-notice")).toBeNull();
  });

  it("A-4 collapses the empty tab note while keeping the dashboard composer unchanged", async () => {
    const card = composerCard();
    const inputRef = createRef<HTMLTextAreaElement>();
    await act(async () => root.render(<div className="terminal-transcript-panel--tab"><ReplyComposer card={card} inputRef={inputRef} mentionTargets={[card]} tabSessionId={card.tab.sessionId} showSuggestions={false} /></div>));
    const note = host.querySelector<HTMLElement>(".cmux-dashboard-composer-note");
    if (note) {
      expect(note.childNodes).toHaveLength(0);
      expect(note.getAttribute("role")).toBeNull();
      // jsdom cannot measure geometry. Apply just the real :empty rule to
      // verify it removes this retained slot (including grid gap) from layout.
      style = document.createElement("style");
      style.textContent = css.match(/\.terminal-transcript-panel--tab \.cmux-dashboard-composer-note:empty\s*\{[^}]*\}/)?.[0] ?? "";
      document.head.append(style);
      expect(getComputedStyle(note).display).toBe("none");
    }
    await act(async () => root.render(<div className="cmux-dashboard-view"><ReplyComposer card={card} inputRef={inputRef} mentionTargets={[card]} showSuggestions={false} /></div>));
    expect(host.querySelector(".cmux-dashboard-composer-note")).toBeNull();
    expect(host.querySelector(".cmux-dashboard-composer-target")).not.toBeNull();
  });

  it("A-5 confines every CSS selector to the tab or its surface/fallback", () => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const stack: string[] = [];
    const splitSelectors = (value: string) => {
      let depth = 0, start = 0;
      const selectors: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (value[index] === "(" || value[index] === "[") depth++;
        else if (value[index] === ")" || value[index] === "]") depth--;
        else if (value[index] === "," && depth === 0) { selectors.push(value.slice(start, index).trim()); start = index + 1; }
      }
      selectors.push(value.slice(start).trim());
      return selectors;
    };
    let checked = 0;
    for (const match of clean.matchAll(/([^{}]*)([{}])/g)) {
      if (match[2] === "}") { stack.pop(); continue; }
      const prelude = match[1].trim();
      if (!prelude.startsWith("@") && !stack.some(parent => /^@(container|media|keyframes)\b/.test(parent))) {
        for (const selector of splitSelectors(prelude)) {
          expect(selector, "Unscoped conversation CSS").toMatch(/^(?:\.terminal-transcript-panel--tab\b|\.agent-tab-conversation-fallback\b|\[data-agent-tab-surface\])/);
          checked++;
        }
      }
      stack.push(prelude);
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe("tab archive diagnostic visibility and announcements", () => {
  it.each(diagnostics)("N-1 keeps the $field status row visible while navigation is hidden", async diagnostic => {
    state = { ...state, [diagnostic.field]: diagnostic.code };
    await act(async () => root.render(<ArchiveHarness navigationHidden />));
    const mark = host.querySelector('.cmux-archive-notice [role="img"]');
    expect(mark?.getAttribute("aria-label")).toBe(diagnostic.label);
    expect(mark?.closest(".cmux-archive-notice")?.getAttribute("role")).toBe("status");
    expect(mark?.closest("[hidden]")).toBeNull();
    expect(host.querySelector(".terminal-transcript-panel__head .agent-tab-archive-status")).toBeNull();
  }, 10000);

  it("N-2 moves both diagnostics between the header and body without remounting", async () => {
    state = { ...state, notice: "readerBusy", error: "permissionDenied" };
    await act(async () => root.render(<ArchiveHarness navigationHidden={false} />));
    const transcript = host.querySelector("[data-archive-view]");
    for (const hidden of [false, true, false]) {
      await act(async () => root.render(<ArchiveHarness navigationHidden={hidden} />));
      expect(host.querySelector("[data-archive-view]")).toBe(transcript);
      expect(host.querySelectorAll(".cmux-archive-notice")).toHaveLength(hidden ? 2 : 0);
      expect(host.querySelectorAll(".terminal-transcript-panel__head .agent-tab-archive-status")).toHaveLength(hidden ? 0 : 2);
      const selector = hidden ? '.cmux-archive-notice [role="img"]' : ".terminal-transcript-panel__head .agent-tab-archive-status";
      expect([...host.querySelectorAll(selector)].map(mark => mark.getAttribute("aria-label")))
        .toEqual(hidden ? [diagnostics[1].label, diagnostics[0].label] : diagnostics.map(diagnostic => diagnostic.label));
    }
  }, 10000);

  it.each([true, false])("N-3 keeps exactly one live status row in the body with diagnostics=%s", async populated => {
    if (populated) state = { ...state, notice: "readerBusy", error: "permissionDenied" };
    await act(async () => root.render(<ArchiveHarness />));
    const live = host.querySelectorAll('[data-archive-live="true"]');
    expect(live).toHaveLength(1);
    expect(live[0].getAttribute("role")).toBe("status");
    expect(live[0].classList.contains("cmux-dashboard-sr-only")).toBe(true);
    expect(live[0].classList.contains("cmux-archive-notice")).toBe(false);
    expect(live[0].closest(".terminal-transcript-panel__head")).toBeNull();
    expect(live[0].closest("[data-archive-view]")).not.toBeNull();
    expect(live[0].textContent).toBe(populated ? `${diagnostics[1].label} ${diagnostics[0].label}` : "");
  }, 10000);

  it.each([
    { scenario: "hidden navigation", props: { navigationHidden: true } },
    { scenario: "missing navigation target", props: { navigation: false } },
    { scenario: "dashboard presentation", props: { tabPresentation: false } },
  ])("N-4 removes the live row when switching to $scenario", async ({ props }) => {
    state = { ...state, notice: "readerBusy", error: "permissionDenied" };
    await act(async () => root.render(<ArchiveHarness />));
    expect(host.querySelectorAll('[data-archive-live="true"]')).toHaveLength(1);
    await act(async () => root.render(<ArchiveHarness {...props} />));
    expect(host.querySelector("[data-archive-live]")).toBeNull();
    expect(host.querySelectorAll('.cmux-archive-notice[role="status"]')).toHaveLength(2);
  }, 10000);
});

describe("tab archive row geometry and keyboard focus CSS", () => {
  it("S-1 keeps both separator rules and all their declarations inside the measured row", () => {
    expect(css).toContain('.terminal-transcript-panel--tab .cmux-archive-row[data-kind="user"][data-prev-kind] { position: relative; border-top: 10px solid transparent; padding-top: 11px; background-clip: padding-box; }');
    expect(css).toContain('.terminal-transcript-panel--tab .cmux-archive-row[data-kind="user"][data-prev-kind]::before { content: ""; position: absolute; top: 0; left: 0; right: 0; border-top: 1px solid color-mix(in srgb, var(--cmux-border) 70%, transparent); pointer-events: none; }');
  });

  it("S-3 draws the active search ring of a separated user row below the separator", () => {
    expect(css).toContain('.terminal-transcript-panel--tab .cmux-archive-row[data-kind="user"][data-prev-kind].cmux-archive-search-active { outline-color: transparent; box-shadow: inset 0 0 0 2px var(--cmux-accent); }');
    expect(css).toContain('.terminal-transcript-panel--tab .cmux-archive-row[data-kind="user"][data-prev-kind].cmux-archive-search-active::before { border-top-color: transparent; }');
  });

  it("S-2 forbids vertical outer margins on archive rows across every source CSS file", () => {
    const source = resolve(import.meta.dirname, "../../src");
    const cssFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? cssFiles(path) : entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
    });
    // Delimit only at the selector's top level: attribute values and :is(...)
    // can contain whitespace and commas without starting another compound.
    const splitAtTopLevel = (value: string, delimiter: RegExp): string[] => {
      let depth = 0, start = 0, quote = "";
      const parts: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (character === "\\") { index++; continue; }
        if (quote) { if (character === quote) quote = ""; continue; }
        if (character === '"' || character === "'") { quote = character; continue; }
        if (character === "(" || character === "[") depth++;
        else if (character === ")" || character === "]") depth--;
        else if (depth === 0 && delimiter.test(character)) { parts.push(value.slice(start, index).trim()); start = index + 1; }
      }
      parts.push(value.slice(start).trim());
      return parts.filter(Boolean);
    };
    const checkedFiles: string[] = [], violations: string[] = [];
    let checkedRules = 0;
    for (const path of cssFiles(source).sort()) {
      const content = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      if (!content.includes(".cmux-archive-row")) continue;
      const name = relative(source, path).replaceAll("\\", "/");
      checkedFiles.push(name);
      for (const rule of content.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const selector of splitAtTopLevel(rule[1], /,/)) {
          const compounds = splitAtTopLevel(selector, /[\s>+~]/);
          if (!/\.cmux-archive-row\b/.test(compounds[compounds.length - 1] ?? "")) continue;
          checkedRules++;
          for (const declaration of rule[2].matchAll(/(?:^|;)\s*(margin(?:-top|-bottom|-block(?:-start|-end)?)?)\s*:/gi)) {
            violations.push(`${name}: ${selector}: ${declaration[1]}`);
          }
        }
      }
    }
    expect(checkedFiles).toEqual(expect.arrayContaining([
      "components/terminal/AgentTabConversation.css", "global.css", "components/dashboard/DashboardChatSurface.css",
    ]));
    expect(checkedRules).toBeGreaterThan(10);
    expect(violations).toEqual([]);
  });

  it("R-1 draws the view switch focus ring inward while retaining its clipped container", () => {
    expect(css).toContain(".terminal-transcript-panel--tab .agent-tab-view-switch button:focus-visible { outline-offset: -2px !important; }");
    expect(css).toMatch(/\.terminal-transcript-panel--tab \.agent-tab-view-switch\s*\{[^}]*overflow:\s*hidden;/);
    expect(css).toContain(".terminal-transcript-panel--tab button:focus-visible { outline: 2px solid var(--cmux-accent); outline-offset: -2px; }");
  });
});
