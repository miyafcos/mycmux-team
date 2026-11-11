// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { TextDecoder, TextEncoder } from "node:util";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/components/dashboard/useTranscriptHistory", () => ({
  useTranscriptHistory: (_descriptor: unknown, reader: unknown) => reader,
}));
vi.mock("../../src/components/terminal/terminalLinkProvider", async original => ({
  ...await original<typeof import("../../src/components/terminal/terminalLinkProvider")>(),
  resolveTextLocalPathLinks: vi.fn(async () => []),
}));

import { ArchiveTranscript } from "../../src/components/dashboard/ArchiveTranscript";
import { ChatTranscript } from "../../src/components/dashboard/ChatTranscript";
import { DashboardLinkedText } from "../../src/components/dashboard/DashboardLinkedText";
import type { ArchiveItem, SemanticEvent, SemanticEventEnvelope, TranscriptDescriptor } from "../../src/lib/livebrief";
import type { HistoryState, TranscriptHistoryReader } from "../../src/stores/transcriptHistoryStore";

const decode = (bytes: Uint8Array | number[]) => new TextDecoder("utf-8").decode(new Uint8Array(bytes));
const fromHex = (hex: string) => decode(Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16)));
const utf8 = new TextEncoder().encode("ダッシュボード");
const cut = decode(utf8.slice(0, -1));
const R = decode([0x83]);
const ping = fromHex("3132372e302e302e312082c92070696e672082f09197904d82b582c482a282dc82b720333220836f8343836782cc8366815b835e3a");
const tasklist = fromHex("8fee95f13a208e7792e882b382ea82bd8ff08c8f82c988ea927682b782e9835e8358834e82cd8ec08d7382b382ea82c482a282dc82b982f18142");
const date = fromHex("32303236944e31318c8e3993fa20373a34383a3138");
const noteText = "文字コードが合わず、記録の時点で読めなくなった字があります。";
const descriptor: TranscriptDescriptor = {
  ptySessionId: "tidy-pty", tabId: "tidy-tab", expectedAgentKind: "claude", expectedAgentSessionId: "tidy-agent",
};
const item = (index: number, kind: ArchiveItem["kind"], text: string, extra: Partial<ArchiveItem> = {}): ArchiveItem => ({
  occurrenceId: `claude:tidy-agent:g:${index * 10}:0`, sourceStart: String(index * 10), sourceEnd: String(index * 10 + 10),
  slot: 0, kind, text, timestamp: null, bodyRef: null, callId: null, tool: null, target: null, aliases: [], ...extra,
});
const toolItems = (text: string) => [
  item(0, "toolCall", "ping 127.0.0.1", { tool: "Bash", target: "ping 127.0.0.1", callId: "call" }),
  item(1, "toolResult", text, { callId: "call" }),
];
let host: HTMLDivElement, root: Root, state: HistoryState, reader: TranscriptHistoryReader;
const readBody = vi.fn();
async function renderArchive(tabPresentation = true) {
  await act(async () => root.render(<ArchiveTranscript descriptor={descriptor} prepared={reader} compact tabPresentation={tabPresentation} />));
}
function plainFor(entry: ArchiveItem): HTMLElement {
  const container = host.querySelector(`[data-archive-member="${entry.occurrenceId}"]`)
    ?? host.querySelector(`[data-archive-row="${entry.occurrenceId}"]`);
  return container!.querySelector<HTMLElement>(".cmux-dashboard-msg-plain")!;
}
function expectNote(container: Element, text: string) {
  const notes = container.querySelectorAll(".cmux-tool-output-note");
  expect(notes).toHaveLength(1);
  expect(notes[0].textContent).toBe(noteText);
  expect(notes[0].getAttribute("role")).toBe("note");
  expect(container.firstChild).toBe(notes[0]);
  expect(notes[0].nextSibling?.textContent).toBe(text);
}
async function openBody(entry: ArchiveItem) {
  const container = host.querySelector(`[data-archive-member="${entry.occurrenceId}"]`)
    ?? host.querySelector(`[data-archive-row="${entry.occurrenceId}"]`);
  const button = container!.querySelector<HTMLButtonElement>('button[aria-label="本文の続きを表示"], button[aria-label="元の記録を表示"]')!;
  await act(async () => button.click());
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector("[data-archive-body-block]")).not.toBeNull(), { timeout: 1_000, interval: 10 });
  });
  return host.querySelector<HTMLElement>(".cmux-archive-body")!;
}
function envelope(kind: SemanticEvent, index: number): SemanticEventEnvelope {
  return { eventId: `tool-event-${index}`, sourceRevision: index, occurredAt: index * 1_000, sourceByteStart: 0, sourceByteEnd: 1, kind };
}
async function renderChat(summary: string | null) {
  const events = [
    envelope({ type: "toolStart", call_id: "call", tool: "Bash", target: cut }, 1),
    envelope({ type: "toolEnd", call_id: "call", tool: "Bash", target: cut, ok: true, summary }, 2),
  ];
  await act(async () => root.render(<ChatTranscript events={events} compact />));
  expect(events[1].kind).toEqual({ type: "toolEnd", call_id: "call", tool: "Bash", target: cut, ok: true, summary });
  return host.querySelector<HTMLElement>(".cmux-dashboard-toolfold-item")!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  state = {
    descriptor, status: "ready", readerId: "fixture", sourceGeneration: "g", items: toolItems(cut), pages: [],
    olderCursor: null, newerCursor: null, continuation: null, reachedStart: true, reachedFence: true,
    loading: null, following: false, newTail: false, error: null, notice: null, version: 0,
  };
  readBody.mockReset();
  reader = {
    getSnapshot: () => state, subscribe: () => () => {},
    get snapshot() { return state; }, visible: true,
    setBeforeMutation: vi.fn(), setVisible: vi.fn(), setSelection: vi.fn(), cancelSearch: vi.fn(),
    setFollowing: vi.fn(), readBody,
  } as unknown as TranscriptHistoryReader;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("tool output display boundaries", () => {
  it("V-1 tidies a grouped tool result without a note or source mutation", async () => {
    await renderArchive();
    const plain = plainFor(state.items[1]);
    expect(plain.textContent).toBe("ダッシュボー…");
    expect(plain.textContent).not.toContain(R);
    expect(plain.querySelector(".cmux-tool-output-note")).toBeNull();
    expect(state.items[1].text).toBe(cut);
    const group = host.querySelector<HTMLDetailsElement>(".agent-tab-tool-group")!;
    expect(group.open).toBe(false);
    await act(async () => { group.open = true; group.dispatchEvent(new Event("toggle")); });
    expect(group.open).toBe(true);
  });

  it.each([["ping", ping], ["tasklist", tasklist], ["date", date]])(
    "V-2 annotates a grouped unreadable %s result exactly once", async (_label, text) => {
      state = { ...state, items: toolItems(text) };
      await renderArchive();
      expectNote(plainFor(state.items[1]), text);
      expect(state.items[1].text).toBe(text);
    },
  );

  it("V-3 preserves calls, user/agent text, questions, attachments and source records in the same conversation", async () => {
    const unchanged = [item(0, "user", cut), item(1, "assistant", ping), item(2, "toolCall", cut, { tool: "Bash" }),
      item(4, "question", ping), item(5, "attachment", cut), item(6, "source", ping), item(7, "diagnostic", cut)];
    const result = item(3, "toolResult", cut);
    state = { ...state, items: [...unchanged.slice(0, 3), result, ...unchanged.slice(3)] };
    await renderArchive();
    const records = host.querySelector<HTMLButtonElement>('button[aria-label^="記録の詳細"]')!;
    await act(async () => records.click());
    for (const entry of unchanged) {
      const row = host.querySelector(`[data-archive-member="${entry.occurrenceId}"]`)
        ?? host.querySelector(`[data-archive-row="${entry.occurrenceId}"]`);
      expect(row?.textContent).toContain(entry.text);
      expect(row?.querySelector(".cmux-tool-output-note")).toBeNull();
    }
    expect(plainFor(result).textContent).toBe("ダッシュボー…");
    expect(plainFor(result).querySelector(".cmux-tool-output-note")).toBeNull();
  });

  it.each([["cut", cut, "ダッシュボー…", false], ["unreadable", ping, ping, true]] as const)(
    "V-4 handles an ungrouped %s result", async (_label, text, expected, lossy) => {
      state = { ...state, items: toolItems(text) };
      await renderArchive(false);
      expect(host.querySelector(".agent-tab-tool-group")).toBeNull();
      const plain = plainFor(state.items[1]);
      if (lossy) expectNote(plain, expected);
      else {
        expect(plain.textContent).toBe(expected);
        expect(plain.querySelector(".cmux-tool-output-note")).toBeNull();
      }
      expect(plainFor(state.items[0]).textContent).toBe("ping 127.0.0.1");
    },
  );

  it.each([
    ["cut body", false, cut, "ダッシュボー…", false],
    ["unreadable body", false, ping, ping, true],
    ["cut source", true, cut, cut, false],
    ["unreadable source", true, ping, ping, false],
  ] as const)("V-5 handles %s with sourceText=%s", async (_label, sourceText, text, expected, lossy) => {
    const entry = item(0, "toolResult", "body preview", { bodyRef: "body" });
    state = { ...state, items: [entry] };
    readBody.mockResolvedValue({ text, cursor: null, sourceText });
    await renderArchive();
    const body = await openBody(entry);
    const pre = body.querySelector("pre")!;
    expect(pre.textContent).toBe(expected);
    expect(body.querySelectorAll(".cmux-tool-output-note")).toHaveLength(lossy ? 1 : 0);
    if (lossy) {
      expect(pre.previousElementSibling?.className).toBe("cmux-tool-output-note");
      expect(pre.previousElementSibling?.textContent).toBe(noteText);
      expect(pre.previousElementSibling?.getAttribute("role")).toBe("note");
    }
    expect(readBody).toHaveBeenCalledWith(entry, null, expect.any(AbortSignal));
    expect((await readBody.mock.results[0].value).text).toBe(text);
  });

  it.each(["user", "assistant", "toolCall", "question", "attachment", "source"] as const)(
    "V-5 leaves a non-result %s body unchanged", async kind => {
      const entry = item(0, kind, "body preview", { bodyRef: "body" });
      state = { ...state, items: [entry] };
      readBody.mockResolvedValue({ text: ping + "\n" + cut, cursor: null, sourceText: false });
      await renderArchive();
      if (kind === "source") {
        await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="記録の詳細"]')!.click());
      }
      const body = await openBody(entry);
      expect(body.querySelector("pre")!.textContent).toBe(ping + "\n" + cut);
      expect(body.querySelector(".cmux-tool-output-note")).toBeNull();
    },
  );

  it("V-6 tidies both the first three lines and the full summary", async () => {
    const summary = [cut, "second", "third", cut].join("\n");
    const tool = await renderChat(summary);
    expect(tool.querySelector(".cmux-dashboard-tool-output")!.textContent).toBe("ダッシュボー…\nsecond\nthird");
    expect(tool.querySelector(".cmux-dashboard-tool-fulltext > div")!.textContent).toBe("ダッシュボー…\nsecond\nthird\nダッシュボー…");
    expect(tool.querySelector(".cmux-tool-output-note")).toBeNull();
    expect(tool.firstElementChild!.textContent).toContain(cut); // Tool target remains recorded text.
  });

  it("V-6 adds one note even when the unreadable line is beyond the preview", async () => {
    const summary = [cut, "second", "third", ping, cut].join("\n");
    const tool = await renderChat(summary);
    const output = tool.querySelector(".cmux-dashboard-tool-output")!;
    expect(tool.querySelectorAll(".cmux-tool-output-note")).toHaveLength(1);
    expect(output.previousElementSibling?.className).toBe("cmux-tool-output-note");
    expect(output.previousElementSibling?.textContent).toBe(noteText);
    expect(output.previousElementSibling?.getAttribute("role")).toBe("note");
    expect(output.textContent).toBe("ダッシュボー…\nsecond\nthird");
    expect(tool.querySelector(".cmux-dashboard-tool-fulltext > div")!.textContent).toBe(["ダッシュボー…", "second", "third", ping, "ダッシュボー…"].join("\n"));
  });

  it.each([null, ""])("V-6 adds nothing for an absent summary %j", async summary => {
    const tool = await renderChat(summary);
    expect(tool.querySelector(".cmux-dashboard-tool-output")).toBeNull();
    expect(tool.querySelector(".cmux-dashboard-tool-fulltext")).toBeNull();
    expect(tool.querySelector(".cmux-tool-output-note")).toBeNull();
  });

  it.each([true, false])("V-7 preserves linked DOM with tabPresentation=%s for ordinary output", async tabPresentation => {
    const text = "日本語 https://example.com/report\nordinary";
    state = { ...state, items: toolItems(text) };
    await act(async () => root.render(<>
      <div className="baseline"><DashboardLinkedText text={text} context={null} /></div>
      <ArchiveTranscript descriptor={descriptor} prepared={reader} compact tabPresentation={tabPresentation} />
    </>));
    const baseline = host.querySelector(".baseline")!;
    const plain = plainFor(state.items[1]);
    expect(plain.innerHTML).toBe(baseline.innerHTML);
    expect(Array.from(plain.childNodes, node => node.nodeType)).toEqual(Array.from(baseline.childNodes, node => node.nodeType));
    expect(plain.children).toHaveLength(1);
    expect(plain.firstElementChild?.tagName).toBe("A");
    expect(plain.querySelector(".cmux-tool-output-note")).toBeNull();
  });

  it("V-8 uses one note class with exactly the specified existing theme tokens", () => {
    const css = postcss.parse(readFileSync("src/components/dashboard/ToolOutputText.css", "utf8"));
    const rules: postcss.Rule[] = [];
    css.walkRules(rule => { rules.push(rule); });
    expect(rules.map(rule => rule.selector)).toEqual([".cmux-tool-output-note"]);
    const declarations: Record<string, string> = {};
    rules[0].walkDecls(declaration => { declarations[declaration.prop] = declaration.value; });
    expect(declarations).toEqual({
      color: "var(--cmux-text-dim)", "font-size": "var(--cmux-font-size-xs)",
      "line-height": "normal", "white-space": "normal", margin: "0 0 2px",
    });
    const globals = postcss.parse(readFileSync("src/global.css", "utf8"));
    const defined = new Set<string>();
    globals.walkDecls(/^--cmux-/, declaration => { defined.add(declaration.prop); });
    for (const match of css.toString().matchAll(/var\((--cmux-[\w-]+)\)/g)) {
      expect(defined.has(match[1])).toBe(true);
    }
    css.walkDecls(declaration => { expect(declaration.prop.startsWith("--")).toBe(false); });
  });
});
