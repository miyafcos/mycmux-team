// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async (_event: string, _callback: (event: { payload: number }) => void) => () => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke,
}));
vi.mock("../../src/components/settings/tabs/JevSettingsSection", () => ({ JevSettingsSection: () => null }));
vi.mock("../../src/components/settings/tabs/ClaudeSkillsSection", () => ({ ClaudeSkillsSection: () => null }));
vi.mock("../../src/components/settings/tabs/AgentIntegrationsSection", () => ({ AgentIntegrationsSection: () => null }));
vi.mock("../../src/components/settings/tabs/CodexAppServerSection", () => ({ CodexAppServerSection: () => null }));
vi.mock("../../src/components/settings/tabs/DshAcpSection", () => ({ DshAcpSection: () => null }));

import { AiTab } from "../../src/components/settings/tabs/AiTab";

it("shows the configured full-text destination, saves a path and turns the mirror off", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const savedPath = "/tmp/fixture-ailog";
  let revision = 0;
  invoke.mockImplementation(async (command: string, args?: { root: string | null }) => {
    if (command === "get_app_settings") return { ailog_mirror_full_text_root: null };
    if (command === "set_ailog_mirror_full_text_root") return { root: args!.root, revision: ++revision };
  });
  try {
    await act(async () => root.render(<AiTab />));
    const section = host.querySelector('section[aria-label="AI ログの全文の控え"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("控えない");
    const input = section!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, savedPath);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const buttons = Array.from(section!.querySelectorAll("button"));
    await act(async () => buttons.find((button) => button.textContent === "保存")!.click());
    expect(invoke).toHaveBeenCalledWith("set_ailog_mirror_full_text_root", { root: savedPath });
    expect(section?.textContent).toContain(savedPath);
    await act(async () => buttons.find((button) => button.textContent === "控えない")!.click());
    expect(invoke).toHaveBeenLastCalledWith("set_ailog_mirror_full_text_root", { root: null });
    expect(section?.textContent).not.toContain(savedPath);
    expect(input.value).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("reloads the saved destination across windows and keeps the other input", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const listeners = new Set<(event: { payload: number }) => void>();
  listen.mockImplementation(async (event, callback) => {
    if (event === "ailog-mirror-full-text-root-changed") listeners.add(callback);
    return () => { listeners.delete(callback); };
  });
  let saved: string | null = null;
  let revision = 0;
  invoke.mockImplementation(async (command: string, args?: { root: string | null }) => {
    if (command === "get_app_settings") return { ailog_mirror_full_text_root: saved };
    if (command === "set_ailog_mirror_full_text_root") {
      saved = args!.root;
      const savedRevision = ++revision;
      for (const notify of listeners) notify({ payload: savedRevision });
      return { root: saved, revision: savedRevision };
    }
  });
  const windows = Array.from({ length: 2 }, () => {
    const host = document.createElement("div");
    document.body.append(host);
    return { host, root: createRoot(host) };
  });
  try {
    await act(async () => windows.forEach(({ root }) => root.render(<AiTab />)));
    const [source, peer] = windows.map(({ host }) => {
      const section = host.querySelector('section[aria-label="AI ログの全文の控え"]')!;
      const input = section.querySelector("input")!;
      return {
        input,
        type: (value: string) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        },
        status: section.querySelector('[role="status"]')!,
        save: section.querySelector<HTMLButtonElement>('button[type="submit"]')!,
        off: section.querySelector<HTMLButtonElement>('button[type="button"]')!,
      };
    });
    expect(peer.off.disabled).toBe(true);
    await act(async () => {
      source.type("/tmp/selected-mirror");
      peer.type("/tmp/unsaved-peer-input");
    });
    await act(async () => source.save.click());
    expect(peer.status.textContent).toBe("/tmp/selected-mirror");
    expect(peer.off.disabled).toBe(false);
    expect(peer.input.value).toBe("/tmp/unsaved-peer-input");
    await act(async () => source.off.click());
    expect(peer.status.textContent).toBe("控えない");
    expect(peer.off.disabled).toBe(true);
    expect(peer.input.value).toBe("/tmp/unsaved-peer-input");
  } finally {
    await act(async () => windows.forEach(({ root }) => root.unmount()));
    windows.forEach(({ host }) => host.remove());
    listen.mockReset();
    vi.unstubAllGlobals();
  }
  expect(listeners.size).toBe(0);
});

it.each(["peer refresh", "own response", "newer peer save"] as const)(
  "keeps the full-text state truthful after %s when the settings read fails",
  async (scenario) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let notify!: (event: { payload: number }) => void;
    listen.mockImplementation(async (event, callback) => {
      if (event === "ailog-mirror-full-text-root-changed") notify = callback;
      return () => {};
    });
    const savedPath = "/tmp/confirmed-mirror";
    let storedPath: string | null = null;
    let failRead = false;
    let readFailures = 0;
    let replyToSave!: (saved: { root: string; revision: number }) => void;
    invoke.mockImplementation(async (command: string) => {
      if (command === "get_app_settings") {
        if (failRead) {
          readFailures++;
          throw new Error("synthetic settings read failure");
        }
        return { ailog_mirror_full_text_root: storedPath };
      }
      if (command === "set_ailog_mirror_full_text_root") {
        return new Promise<{ root: string; revision: number }>(resolve => { replyToSave = resolve; });
      }
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<AiTab />));
      const section = host.querySelector('section[aria-label="AI ログの全文の控え"]')!;
      const input = section.querySelector("input")!;
      const status = section.querySelector('[role="status"]')!;
      const save = section.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const stop = section.querySelector<HTMLButtonElement>('button[type="button"]')!;
      expect(status.textContent).toBe("控えない");
      expect(stop.disabled).toBe(true);
      const typed = " /tmp/unsaved-path ";
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, typed);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

      if (scenario !== "peer refresh") await act(async () => save.click());
      storedPath = savedPath;
      failRead = true;
      const noticedRevision = scenario === "newer peer save" ? 2 : 1;
      await act(async () => notify({ payload: noticedRevision }));
      expect(readFailures).toBe(1);
      if (scenario === "own response") {
        await act(async () => replyToSave({ root: savedPath, revision: 1 }));
        expect(status.textContent).toBe(savedPath);
        expect(section.querySelector('[role="alert"]')).toBeNull();
        expect(stop.disabled).toBe(false);
        expect(input.value).toBe(savedPath);
      } else {
        if (scenario === "newer peer save") {
          await act(async () => replyToSave({ root: savedPath, revision: 1 }));
          // The old reply and its delayed notice do not verify the new save.
          await act(async () => notify({ payload: 1 }));
          expect(readFailures).toBe(1);
        }
        expect(status.textContent).toContain("確認できません");
        expect(section.querySelector('[role="alert"]')?.textContent).toContain("読み直せません");
        expect(stop.disabled).toBe(false);
        expect(input.value).toBe(typed);
        storedPath = "/tmp/later-mirror";
        failRead = false;
        await act(async () => notify({ payload: noticedRevision + 1 }));
        expect(status.textContent).toBe(storedPath);
        expect(section.querySelector('[role="alert"]')).toBeNull();
        expect(input.value).toBe(typed);
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      listen.mockReset();
      vi.unstubAllGlobals();
    }
  },
);
