// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AgentResumeRecoveryPanel, resumeRecoveryStrings as s, type AgentResumeRecoveryPanelProps } from "../../src/components/terminal/AgentResumeRecoveryPanel";

async function panel(props: Partial<AgentResumeRecoveryPanelProps>, body: (host: HTMLDivElement, actions: AgentResumeRecoveryPanelProps) => Promise<void>) {
  const actions: AgentResumeRecoveryPanelProps = {
    model: { type: "conflict", hiddenOwner: false }, confirmation: null, busy: false, error: false,
    onOpenOwner: vi.fn(), onTakeover: vi.fn(), onFresh: vi.fn(), onOriginal: vi.fn(), onSaved: vi.fn(), onConfirm: vi.fn(), ...props,
  };
  const host = document.createElement("div"); const root = createRoot(host);
  try { await act(async () => root.render(<AgentResumeRecoveryPanel {...actions} />)); await body(host, actions); }
  finally { await act(async () => root.unmount()); }
}
async function click(host: HTMLDivElement, label: string) {
  const button = [...host.querySelectorAll("button")].find(item => item.textContent === label)!;
  expect(button).toBeDefined(); expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
describe("SI pane recovery actions", () => {
  it("shows three working actions inside the refused pane", async () => panel({}, async (host, a) => {
    await click(host, s.openOwner); await click(host, s.takeover); await click(host, s.fresh);
    expect(a.onOpenOwner).toHaveBeenCalledOnce(); expect(a.onTakeover).toHaveBeenCalledOnce(); expect(a.onFresh).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-agent-resume-recovery="conflict"]')).not.toBeNull();
  }));
  it("hidden owners still have takeover and fresh actions", async () => panel({ model: { type: "conflict", hiddenOwner: true } }, async (host, a) => {
    expect(host.textContent).toContain(s.hiddenOwner);
    expect(host.querySelectorAll("button")[0].disabled).toBe(true);
    await click(host, s.takeover); await click(host, s.fresh);
    expect(a.onTakeover).toHaveBeenCalledOnce(); expect(a.onFresh).toHaveBeenCalledOnce();
  }));
  it("confirmation describes working and hidden owner, cancellation is explicit", async () => panel({ confirmation: { working: true, hidden: true } }, async (host, a) => {
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(host.textContent).toContain(s.confirmWorking); expect(host.textContent).toContain(s.confirmHidden);
    await click(host, s.cancel); await click(host, s.confirmStop);
    expect(a.onConfirm).toHaveBeenNthCalledWith(1, false); expect(a.onConfirm).toHaveBeenNthCalledWith(2, true);
  }));
  it("SDK choices open original, saved or fresh, and missing originals keep usable actions", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await panel({ model: { type: "restore", choice: { kind: "claude", agentSessionId: "saved", candidates: [id] } } }, async (host, a) => {
      await click(host, s.original); await click(host, s.saved); await click(host, s.fresh);
      expect(a.onOriginal).toHaveBeenCalledExactlyOnceWith(id); expect(a.onSaved).toHaveBeenCalledOnce(); expect(a.onFresh).toHaveBeenCalledOnce();
    });
    await panel({ model: { type: "restore", choice: { kind: "claude", agentSessionId: "saved", candidates: [] } }, error: true }, async (host, a) => {
      expect(host.textContent).toContain(s.noOriginal); expect(host.textContent).toContain(s.failed);
      await click(host, s.saved); await click(host, s.fresh);
      expect(a.onSaved).toHaveBeenCalledOnce(); expect(a.onFresh).toHaveBeenCalledOnce();
    });
  });
});
