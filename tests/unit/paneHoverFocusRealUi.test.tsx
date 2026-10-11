// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResumeRecoveryPanel, resumeRecoveryStrings } from "../../src/components/terminal/AgentResumeRecoveryPanel";
import { setup, cleanup, mount, content, textarea, pointer, advance, mocks } from "./paneHoverFocusHarness";
import { TerminalTurnChip } from "../../src/components/terminal/TerminalTurnChip";
import { useUiStore } from "../../src/stores/uiStore";

let uiRoots: Root[];
beforeEach(() => { setup(); uiRoots = []; });
afterEach(async () => { for (const root of uiRoots) await act(async () => root.unmount()); await cleanup(); });
const active = () => useUiStore.getState().activePaneId;
async function aim(x = 20, element = content()) { await act(async () => { pointer(element, "pointermove", { clientX: x }); }); }

function Recovery({ initial = false }: { initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return <AgentResumeRecoveryPanel model={{ type: "conflict", hiddenOwner: false }}
    confirmation={open ? { working: true, hidden: false } : null} busy={false} error={false}
    onTakeover={() => setOpen(true)} onConfirm={() => setOpen(false)}
    onOpenOwner={vi.fn()} onFresh={vi.fn()} onOriginal={vi.fn()} onSaved={vi.fn()} />;
}
async function recovery(initial = false, session = "a") {
  const container = document.createElement("div"); content(session).append(container);
  const root = createRoot(container); uiRoots.push(root);
  await act(async () => { root.render(<Recovery initial={initial} />); });
  return { root, container };
}
async function clickText(container: Element, text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
  expect(button).toBeDefined(); await act(async () => { button.click(); });
}

describe("F2 real recovery confirmation", () => {
  it.each([0, 1])("F2 confirmation button %i keeps selection and focus before arm", async (index) => {
    await mount(); const { container } = await recovery(true);
    const button = container.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")[index];
    await act(async () => { button.focus(); }); await aim(); await advance(200);
    expect(active()).toBe("a"); expect(document.activeElement).toBe(button);
    expect(mocks.focus.get("b")).not.toHaveBeenCalled();
  });
  it("F2 region to alertdialog to region cancels dwell without focus or fresh movement", async () => {
    await mount(); const { container } = await recovery();
    await act(async () => { textarea("a").focus(); }); await aim(); await advance(20);
    await clickText(container, resumeRecoveryStrings.takeover);
    expect(container.querySelector("[role=alertdialog]")).not.toBeNull();
    await clickText(container, resumeRecoveryStrings.cancel);
    expect(container.querySelector("[role=region]")).not.toBeNull();
    await advance(200); expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    await aim(21); await advance(); expect(active()).toBe("b");
  });
  it.each(["first-frame", "retry"])("F2 opening an unfocused real confirmation protects %s", async (phase) => {
    await mount(); const { container } = await recovery();
    await act(async () => { textarea("a").focus(); });
    if (phase === "retry") mocks.refused.add("b");
    await aim(); await advance(100, false);
    if (phase === "retry") await advance(0);
    const attempts = mocks.focus.get("b")!.mock.calls.length;
    await clickText(container, resumeRecoveryStrings.takeover); mocks.refused.delete("b");
    await advance(0); await advance(200);
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    expect(mocks.focus.get("b")).toHaveBeenCalledTimes(attempts);
  });
  it("F2 removal of the real confirmation invalidates the old dwell", async () => {
    await mount(); const { root, container } = await recovery(); await aim(); await advance(20);
    await clickText(container, resumeRecoveryStrings.takeover);
    await act(async () => { root.render(null); });
    await advance(200); expect(active()).toBe("a");
    await aim(21); await advance(); expect(active()).toBe("b");
  });
  it("F2 recovery region padding is not ordinary terminal content", async () => {
    await mount(); const { container } = await recovery(false, "b");
    await act(async () => { textarea("a").focus(); });
    await aim(20, container.querySelector<HTMLElement>("[data-agent-resume-recovery]")!);
    await advance(200); expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
  });
});


async function turnChip(session = "a", mode: "scroll" | "transcript" = "scroll") {
  // The real popup lives below xterm, where unrelated output mutations are ignored.
  const container = document.createElement("div"); content(session).querySelector(".xterm")!.append(container);
  const root = createRoot(container); uiRoots.push(root);
  await act(async () => {
    root.render(<TerminalTurnChip index={0} total={1} label="prompt" mode={mode}
      canPrev={false} canNext={false} rows={[{ key: "prompt", label: "prompt", markIndex: 0 }]}
      onPrev={vi.fn()} onNext={vi.fn()} onJump={vi.fn()} onListOpen={vi.fn()} />);
    textarea("a").focus();
  });
  const toggle = async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>(".terminal-turn-chip__label")!.click(); });
  };
  return { container, toggle };
}

describe("F3 real turn-history popup", () => {
  it.each(["scroll", "transcript"] as const)("F3 open %s list preserves real xterm focus before arm", async (mode) => {
    await mount(); const { container, toggle } = await turnChip("a", mode);
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => { container.querySelector("button")!.dispatchEvent(mouseDown); });
    expect(mouseDown.defaultPrevented).toBe(true);
    await toggle(); expect(container.querySelector(".terminal-turn-list")).not.toBeNull();
    expect(document.activeElement).toBe(textarea("a"));
    await aim(); await advance(200);
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    expect(container.querySelector(".terminal-turn-list")).not.toBeNull();
    expect(mocks.focus.get("b")).not.toHaveBeenCalled();
  });
  it("F3 opening after arm and closing without movement cancels the old dwell", async () => {
    await mount(); const { toggle } = await turnChip(); await aim(); await advance(20);
    await toggle(); await toggle(); await advance(200);
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    await aim(21); await advance(); expect(active()).toBe("b");
  });
  it.each(["first-frame", "retry"])("F3 an unfocused real list protects %s", async (phase) => {
    await mount(); const { container, toggle } = await turnChip();
    if (phase === "retry") mocks.refused.add("b");
    await aim(); await advance(100, false);
    if (phase === "retry") await advance(0);
    const attempts = mocks.focus.get("b")!.mock.calls.length;
    await toggle(); mocks.refused.delete("b"); await advance(0); await advance(200);
    expect(container.querySelector(".terminal-turn-list")).not.toBeNull();
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
    expect(mocks.focus.get("b")).toHaveBeenCalledTimes(attempts);
  });
  it("F3 real popup gaps in another terminal cannot activate it", async () => {
    await mount(); const { container, toggle } = await turnChip("b"); await toggle();
    await aim(20, container.querySelector<HTMLElement>(".terminal-turn-list")!); await advance(200);
    expect(active()).toBe("a"); expect(document.activeElement).toBe(textarea("a"));
  });
  it("F3 dismissing the real popup needs a fresh movement before activation", async () => {
    await mount(); const { toggle } = await turnChip(); await toggle();
    await aim(); await advance(200); await toggle(); await advance(200);
    expect(active()).toBe("a");
    await aim(21); await advance(); expect(active()).toBe("b");
  });
  it("F3 a persistent unrelated listbox remains eligible", async () => {
    await mount(); await act(async () => {
      textarea("a").focus();
      const persistent = document.createElement("div"); persistent.setAttribute("role", "listbox");
      content("a").append(persistent);
    });
    await aim(); await advance(); expect(active()).toBe("b");
  });
});
