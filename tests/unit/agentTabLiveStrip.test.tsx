// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rows: vi.fn<() => string[]>(), parsing: vi.fn(), pending: vi.fn(), counter: vi.fn() }));
vi.mock("../../src/components/terminal/XTermWrapper", () => ({ getTerminalBufferLines: mocks.rows, isTerminalParsingCurrentOutput: mocks.parsing }));
vi.mock("../../src/components/terminal/terminalCache", () => ({ getTerminalWriteCounter: mocks.counter, isTerminalBufferWritePending: mocks.pending }));
import { AgentTabLiveStrip } from "../../src/components/terminal/AgentTabLiveStrip";
import { cropLiveTailScreen, liveTailBodyRows } from "../../src/lib/liveTail/crop";
import * as liveTail from "../../src/lib/liveTail/crop";
import { agentTabStrings } from "../../src/components/terminal/agentTabStrings";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/liveTail/screens2141.json"), "utf8")) as {
  seats: { agent: string; rounds: { rows: string[]; expected: { state: string; rows: string[]; marker: string } }[] }[];
};
function screen(agent: string, state: string) {
  return fixture.seats.find(seat => seat.agent === agent && seat.rounds.some(round => round.expected.state === state))!
    .rounds.find(round => round.expected.state === state)!;
}
let host: HTMLDivElement, root: Root, write: number, sequence = 0, tab: string;
const strip = () => host.querySelector<HTMLButtonElement>(".agent-tab-live-strip");
async function render(options: { live?: boolean; needsInput?: boolean; agent?: string; tabId?: string; sessionId?: string } = {}) {
  await act(async () => root.render(<AgentTabLiveStrip sessionId={options.sessionId ?? "screen-session"} tabId={options.tabId ?? tab}
    agentKind={options.agent ?? "claude"} live={options.live ?? true} needsInput={options.needsInput ?? false} />));
}
const tick = async (ms: number) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  write = 12; tab = `live-strip-${++sequence}`;
  mocks.rows.mockReset(); mocks.rows.mockReturnValue(screen("claude", "working").rows);
  mocks.parsing.mockReset(); mocks.parsing.mockReturnValue(true);
  mocks.pending.mockReset(); mocks.pending.mockReturnValue(false);
  mocks.counter.mockReset(); mocks.counter.mockImplementation(() => write);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("actual terminal rows above the tab composer", () => {
  it.each(["claude", "codex"])("shows the last two original %s working rows, then reads only after a write", async agent => {
    const captured = screen(agent, "working"); mocks.rows.mockReturnValue(captured.rows);
    await render({ agent });
    expect(mocks.rows).toHaveBeenCalledWith("screen-session", 40);
    expect([...strip()!.querySelectorAll(".agent-tab-live-strip__row")].map(row => row.textContent)).toEqual(captured.expected.rows.slice(-2));
    expect(strip()!.hasAttribute("data-agent-tab-live-pulsing")).toBe(false);
    await tick(2500);
    expect(mocks.rows).toHaveBeenCalledTimes(1);
    expect(strip()!.textContent).toBe(captured.expected.rows.slice(-2).join(""));
    const updated = captured.rows.map(row => row === captured.expected.marker ? row.replace(/\d+s/, "29s") : row);
    mocks.rows.mockReturnValue(updated); write++;
    await tick(250);
    expect(mocks.rows).toHaveBeenCalledTimes(2);
    expect(strip()!.textContent).toContain(updated.find(row => row.includes("tokens") || row.includes("esc to interrupt"))!);
    expect(strip()!.dataset.agentTabLivePulsing).toBe("true");
    await tick(3000);
    expect(mocks.rows).toHaveBeenCalledTimes(2);
    expect(strip()!.hasAttribute("data-agent-tab-live-pulsing")).toBe(false);
  });
  it.each(["claude", "codex"])("uses only the %s done marker's time and duration", async agent => {
    const captured = screen(agent, "done");
    const marker = agent === "claude" ? "✻ Churned for 1m 20s · done 15:21" : "Worked for 16s • 12:56";
    mocks.rows.mockReturnValue(captured.rows.map(row => row === captured.expected.marker ? marker : row));
    await render({ agent });
    expect(strip()!.textContent).toBe(agent === "claude" ? "終わり 15:21 (1 分 20 秒)" : "終わり 12:56 (16 秒)");
    expect(strip()!.querySelector(".agent-tab-live-strip__row")).toBeNull();
    await tick(5000); expect(mocks.rows).toHaveBeenCalledTimes(1);
  });
  it("shows only the captured time when completion duration cannot be parsed", async () => {
    mocks.rows.mockReturnValue(["answer", "Worked for unknown • 12:56"]);
    await render({ agent: "codex" });
    expect(strip()!.textContent).toBe("終わり 12:56");
  });
  it("keeps the API Error rows verbatim and never pulses them", async () => {
    const captured = screen("claude", "error"); mocks.rows.mockReturnValue(captured.rows);
    await render(); write++; await tick(250);
    expect(strip()!.dataset.agentTabLiveState).toBe("error");
    expect(strip()!.textContent).toBe(captured.expected.rows.join(""));
    expect(strip()!.hasAttribute("data-agent-tab-live-pulsing")).toBe(false);
  });
  it("shows only answer-waiting while the question stays in its own card", async () => {
    mocks.rows.mockReturnValue(["A private question?", "• Working (12s • esc to interrupt)"]);
    await render({ needsInput: true, agent: "codex" });
    expect(strip()!.textContent).toBe(agentTabStrings.liveAnswerWaiting);
    await act(async () => strip()!.click());
    expect(strip()!.textContent).toBe(agentTabStrings.liveAnswerWaiting);
    expect(strip()!.textContent).not.toContain("A private question?");
    await render({ needsInput: false, agent: "codex" });
    expect(strip()!.dataset.agentTabLiveState).toBe("working");
  });
  it.each([[], ["plain response"], ["❯"], ["• Working (broken • esc to interrupt)"]])("hides empty, unknown, prompt-only and malformed screens: %j", async (...rows) => {
    mocks.rows.mockReturnValue(rows as string[]);
    await render(); expect(strip()).toBeNull();
  });
  it("does not read an unparsed xterm and clears previously readable evidence", async () => {
    mocks.parsing.mockReturnValue(false);
    await render(); await tick(1000);
    expect(mocks.rows).not.toHaveBeenCalled(); expect(strip()).toBeNull();
    mocks.parsing.mockReturnValue(true); await tick(250);
    expect(mocks.rows).toHaveBeenCalledTimes(1); expect(strip()).not.toBeNull();
    mocks.parsing.mockReturnValue(false); await tick(250);
    expect(strip()).toBeNull(); expect(mocks.rows).toHaveBeenCalledTimes(1);
  });
  it("stops its 250ms timer while hidden and releases it on unmount", async () => {
    const interval = vi.spyOn(window, "setInterval");
    await render({ live: false });
    expect(interval).not.toHaveBeenCalled(); expect(mocks.counter).not.toHaveBeenCalled(); expect(strip()).toBeNull();
    await render(); expect(interval).toHaveBeenCalledWith(expect.any(Function), 250);
    await render({ live: false });
    const counts = [mocks.counter.mock.calls.length, mocks.rows.mock.calls.length];
    write++; await tick(2000);
    expect([mocks.counter.mock.calls.length, mocks.rows.mock.calls.length]).toEqual(counts);
    await render(); expect(mocks.rows.mock.calls.length).toBe(counts[1] + 1);
    await act(async () => root.render(null));
    const stopped = mocks.counter.mock.calls.length;
    await tick(2000); expect(mocks.counter).toHaveBeenCalledTimes(stopped);
  });
  it("expands to the last eight body rows and remembers the choice per tab across remounts", async () => {
    const captured = screen("claude", "working");
    await render();
    expect(strip()!.tagName).toBe("BUTTON"); expect(strip()!.type).toBe("button");
    expect(strip()!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => strip()!.click());
    expect(strip()!.getAttribute("aria-expanded")).toBe("true");
    expect(strip()!.querySelector(".agent-tab-live-strip__body")!.textContent).toBe(liveTailBodyRows(captured.rows, "claude", 8).join("\n"));
    expect(strip()!.textContent).not.toContain("❯");
    expect(strip()!.textContent).not.toContain("INSERT");
    await act(async () => root.render(null));
    await render(); expect(strip()!.getAttribute("aria-expanded")).toBe("true");
    await render({ tabId: tab + "-other" }); expect(strip()!.getAttribute("aria-expanded")).toBe("false");
    await render(); expect(strip()!.getAttribute("aria-expanded")).toBe("true");
    await act(async () => strip()!.click()); expect(strip()!.getAttribute("aria-expanded")).toBe("false");
  });
  it("resets an evicted session's counter without animating old output", async () => {
    await render(); write++; await tick(250);
    expect(strip()!.dataset.agentTabLivePulsing).toBe("true");
    write = 0; mocks.rows.mockReturnValue([]); await tick(250);
    expect(strip()).toBeNull();
    expect(cropLiveTailScreen([], "claude").state).toBe("unknown");
  });
});

describe("redraw and narrow-terminal evidence", () => {
  const displayedRows = () => [...strip()!.querySelectorAll(".agent-tab-live-strip__row")].map(row => row.textContent);

  it.each([
    ["claude", "✻ Brewed for 6s · done 15:13", "· Generating… (9s · ↓ 19 tokens)"],
    ["claude-codex", "✻ Brewed for 6s · done 15:13", "· Generating… (9s · ↓ 19 tokens)"],
    ["codex", "Worked for 6s • 15:13", "• Working (9s • esc to interrupt)"],
  ])("hides the previous %s completion only in the collapsed working strip", async (agent, done, marker) => {
    const rows = ["earlier output", done, marker];
    mocks.rows.mockReturnValue(rows);
    const crop = cropLiveTailScreen(rows, agent);
    expect(crop.state).toBe("working");
    expect(crop.rows.slice(-2)).toEqual([done, marker]);
    await render({ agent });
    expect(displayedRows()).toEqual([marker]);
    await act(async () => strip()!.click());
    expect(strip()!.querySelector(".agent-tab-live-strip__body")!.textContent).toBe(rows.join("\n"));
    await act(async () => strip()!.click());
    expect(displayedRows()).toEqual([marker]);
    expect(cropLiveTailScreen(rows, agent)).toEqual(crop);
  });

  it("keeps a current Running row and its spinner verbatim", async () => {
    const rows = ["⎿  Running…", "✽ Generating… (8s · ↓ 19 tokens)"];
    mocks.rows.mockReturnValue(rows);
    await render();
    expect(displayedRows()).toEqual(rows);
  });

  it.each(["working", "done", "error"])("retains the last %s screen through a 250ms redraw until a recognized screen arrives", async state => {
    const captured = screen("claude", state);
    mocks.rows.mockReturnValue(captured.rows);
    await render();
    const button = strip(), text = button!.textContent;
    mocks.rows.mockReturnValue(["unfinished redraw"]); write++;
    await tick(250);
    expect(strip()).toBe(button); expect(strip()!.textContent).toBe(text);
    expect(strip()!.dataset.agentTabLiveState).toBe(state);
    expect(strip()!.hasAttribute("data-agent-tab-live-pulsing")).toBe(state === "working");
    const next = ["⎿  Running…", "✶ Generating… (11s · ↓ 90 tokens)"];
    mocks.rows.mockReturnValue(next); write++;
    await tick(250);
    expect(strip()).toBe(button);
    expect(strip()!.dataset.agentTabLiveState).toBe("working");
    expect(displayedRows()).toEqual(next);
  });

  it("keeps retained evidence during continuing redraw writes, then expires exactly 3s after the last write", async () => {
    await render();
    const button = strip(), text = button!.textContent;
    for (let frame = 0; frame < 16; frame++) {
      mocks.rows.mockReturnValue(frame % 2 ? ["redraw " + frame] : []); write++;
      await tick(250);
      expect(strip()).toBe(button); expect(strip()!.textContent).toBe(text);
      expect(strip()!.dataset.agentTabLivePulsing).toBe("true");
    }
    const reads = mocks.rows.mock.calls.length;
    await tick(2750);
    expect(strip()).toBe(button); expect(strip()!.dataset.agentTabLivePulsing).toBe("true");
    await tick(250);
    expect(strip()).toBeNull(); expect(mocks.rows).toHaveBeenCalledTimes(reads);
    const fresh = ["  new body after expiry  ", "\tnew last row "];
    mocks.rows.mockReturnValue(fresh); write++;
    await tick(250);
    expect(strip()!.dataset.agentTabLiveState).toBe("active");
    expect(displayedRows()).toEqual(fresh);
  });

  it("holds and falls back for unreadable crops just as for unknown crops", async () => {
    await render();
    const button = strip(), text = button!.textContent;
    vi.spyOn(liveTail, "cropLiveTailScreen").mockReturnValue({
      ...cropLiveTailScreen([], "claude"), readable: false, state: "unreadable",
    });
    mocks.rows.mockReturnValue(["  unreadable body  ", " actual last row "]); write++;
    await tick(250);
    expect(strip()).toBe(button); expect(strip()!.textContent).toBe(text);
    await tick(3000);
    expect(strip()).toBeNull();
    write++; await tick(250);
    expect(strip()!.dataset.agentTabLiveState).toBe("active");
    expect(displayedRows()).toEqual(["  unreadable body  ", " actual last row "]);
  });

  it.each([
    ["claude", ["old output", "✻ Generating… (9s", "  · ↓ 19 tokens)  ", "────────────────", "❯ private draft", "────────────────", "-- INSERT --"]],
    ["codex", ["old output", "• Working (9s •", "  esc to interrupt)  ", "› private draft", "Context 42% used", "5 Ready"]],
  ] as const)("shows changing %s body rows only after an observed write and hides them after 3s of silence", async (agent, captured) => {
    const rows = [...captured];
    mocks.rows.mockReturnValue(rows);
    await render({ agent });
    expect(cropLiveTailScreen(rows, agent).state).toBe("unknown");
    expect(strip()).toBeNull();
    await tick(1000);
    expect(strip()).toBeNull(); expect(mocks.rows).toHaveBeenCalledTimes(1);
    write++; await tick(250);
    expect(strip()!.dataset.agentTabLiveState).toBe("active");
    expect(strip()!.dataset.agentTabLivePulsing).toBe("true");
    expect(displayedRows()).toEqual(liveTailBodyRows(rows, agent, 2));
    expect(strip()!.querySelector(".agent-tab-live-strip__status")).toBeNull();
    const updated = rows.map(row => row.includes("9s") ? row.replace("9s", "10s") : row);
    mocks.rows.mockReturnValue(updated); write++; await tick(250);
    expect(displayedRows()).toEqual(liveTailBodyRows(updated, agent, 2));
    expect(strip()!.textContent).toContain("10s");
    await act(async () => strip()!.click());
    expect(strip()!.querySelector(".agent-tab-live-strip__body")!.textContent).toBe(liveTailBodyRows(updated, agent, 8).join("\n"));
    await tick(2750);
    expect(strip()!.dataset.agentTabLivePulsing).toBe("true");
    await tick(250);
    expect(strip()).toBeNull(); expect(mocks.rows).toHaveBeenCalledTimes(3);
  });

  it.each(["working", "active"])("gives questions priority over retained %s evidence and its pulse", async state => {
    if (state === "active") mocks.rows.mockReturnValue(["plain response"]);
    await render();
    mocks.rows.mockReturnValue(["intermediate text"]); write++; await tick(250);
    expect(strip()!.dataset.agentTabLiveState).toBe(state);
    await render({ needsInput: true });
    expect(strip()!.dataset.agentTabLiveState).toBe("ask");
    expect(strip()!.textContent).toBe(agentTabStrings.liveAnswerWaiting);
    expect(strip()!.hasAttribute("data-agent-tab-live-pulsing")).toBe(false);
    await act(async () => strip()!.click());
    expect(strip()!.textContent).toBe(agentTabStrings.liveAnswerWaiting);
    await tick(3000);
    expect(strip()!.textContent).toBe(agentTabStrings.liveAnswerWaiting);
    await render();
    expect(strip()).toBeNull();
  });

  it("does not create active evidence from an empty body", async () => {
    mocks.rows.mockReturnValue([]);
    await render(); write++; await tick(250);
    expect(strip()).toBeNull();
  });

  it("extends the 220px collapsed last-row rule to active evidence with wrapping", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../src/components/terminal/AgentTabConversation.css"), "utf8");
    const narrow = css.slice(css.indexOf("@container agent-conversation (max-width: 220px)"));
    for (const state of ["working", "active"]) {
      expect(narrow).toContain(`[aria-expanded="false"][data-agent-tab-live-state="${state}"] .agent-tab-live-strip__row:not(:last-child)`);
    }
    expect(narrow).toContain('.agent-tab-live-strip__row:not(:last-child) { display: none; }');
    const rowStyle = css.slice(css.indexOf(".terminal-transcript-panel--tab .agent-tab-live-strip__row,"),
      css.indexOf('.agent-tab-live-strip[data-agent-tab-live-state="ask"]'));
    expect(rowStyle).toContain("white-space: pre-wrap");
    expect(rowStyle).toContain("overflow-wrap: anywhere");
  });
});

describe("pending terminal parse samples", () => {
  it("skips one queued-write sample without dropping the screen, retained evidence or pulse", async () => {
    await render(); write++; await tick(250);
    const button = strip(), text = button!.textContent, reads = mocks.rows.mock.calls.length;
    mocks.parsing.mockReturnValue(false); mocks.pending.mockReturnValue(true); write++;
    await tick(250);
    expect(strip()).toBe(button); expect(strip()!.textContent).toBe(text);
    expect(strip()!.dataset.agentTabLivePulsing).toBe("true");
    expect(mocks.rows).toHaveBeenCalledTimes(reads);
    mocks.parsing.mockReturnValue(true); mocks.pending.mockReturnValue(false);
    mocks.rows.mockReturnValue(["unfinished redraw"]);
    await tick(250);
    expect(strip()).toBe(button); expect(strip()!.textContent).toBe(text);
    expect(mocks.rows).toHaveBeenCalledTimes(reads + 1);
    mocks.rows.mockReturnValue(screen("claude", "done").rows); write++;
    await tick(250);
    expect(strip()).toBe(button); expect(strip()!.dataset.agentTabLiveState).toBe("done");
  });

  it("does not start a pulse or invent a screen from an unparsed write", async () => {
    await render();
    const button = strip(), text = button!.textContent;
    mocks.parsing.mockReturnValue(false); mocks.pending.mockReturnValue(true); write++;
    await tick(250);
    expect(strip()).toBe(button); expect(strip()!.textContent).toBe(text);
    expect(strip()!.hasAttribute("data-agent-tab-live-pulsing")).toBe(false);
    await render({ sessionId: "new-unparsed-session" });
    expect(strip()).toBeNull();
  });

  it("expires a continuous parse backlog at 3s even when write counters keep increasing", async () => {
    await render(); write++; await tick(250);
    mocks.parsing.mockReturnValue(false); mocks.pending.mockReturnValue(true);
    const button = strip(), reads = mocks.rows.mock.calls.length;
    for (let sample = 0; sample < 12; sample++) {
      write++; await tick(250);
      expect(strip()).toBe(button);
    }
    write++; await tick(250);
    expect(strip()).toBeNull();
    for (let sample = 0; sample < 4; sample++) {
      write++; await tick(250); expect(strip()).toBeNull();
    }
    expect(mocks.rows).toHaveBeenCalledTimes(reads);
    mocks.parsing.mockReturnValue(true); mocks.pending.mockReturnValue(false);
    await tick(250);
    expect(strip()!.dataset.agentTabLiveState).toBe("working");
    expect(strip()!.hasAttribute("data-agent-tab-live-pulsing")).toBe(false);
  });

  it("clears retained evidence immediately when the pending terminal is lost or cached", async () => {
    await render(); write++; await tick(250);
    mocks.parsing.mockReturnValue(false); mocks.pending.mockReturnValue(true);
    await tick(250);
    expect(strip()).not.toBeNull();
    mocks.pending.mockReturnValue(false);
    await tick(250);
    expect(strip()).toBeNull();
  });
});
