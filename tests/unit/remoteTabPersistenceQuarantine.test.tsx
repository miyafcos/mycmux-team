// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remoteMocks = vi.hoisted(() => ({
  getRemoteBindAll: vi.fn(),
  getRemoteEnabled: vi.fn(),
  getRemoteInfo: vi.fn(),
  rotateRemoteToken: vi.fn(),
  setRemoteBindAll: vi.fn(),
  setRemoteEnabled: vi.fn(),
}));

vi.mock("../../src/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ipc")>()),
  ...remoteMocks,
}));

import { RemoteTab } from "../../src/components/settings/tabs/RemoteTab";
import {
  __resetPersistenceCoordinatorForTests,
  getPersistentSchemaState,
  markPersistentSchemaSupported,
} from "../../src/lib/workspacePersistenceCoordinator";

describe("RemoteTab persistent storage quarantine", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetPersistenceCoordinatorForTests();
    markPersistentSchemaSupported(1);
    remoteMocks.getRemoteBindAll.mockResolvedValue(false);
    remoteMocks.getRemoteEnabled.mockResolvedValue(false);
    remoteMocks.getRemoteInfo.mockResolvedValue({
      url: null,
      qr_svg: "",
      token_suffix: "----",
      connected_clients: [],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetPersistenceCoordinatorForTests();
  });

  it.each([
    {
      label: "remote enabled",
      inputIndex: 0,
      setup: () => remoteMocks.setRemoteEnabled.mockRejectedValue({
        kind: "unsupportedPlatform",
        message: "unsupported platform",
      }),
      reason: "unsupportedPlatform",
      diagnostic: "この環境では data.json を安全に保存できないため、この起動中は保存を停止しました。元の data.json は変更していません。",
    },
    {
      label: "remote bind-all",
      inputIndex: 1,
      setup: () => {
        remoteMocks.getRemoteEnabled.mockResolvedValue(true);
        remoteMocks.setRemoteBindAll.mockRejectedValue({
          kind: "invalidPayloadSchema",
          schemaVersion: 999,
          message: "payload mismatch",
        });
      },
      reason: "invalidPayloadSchema",
      diagnostic: "保存しようとした data.json の schema 999 が現在の形式と一致しないため、この起動中は保存を停止しました。元の data.json は変更していません。",
    },
  ])("projects a typed $label failure into quarantine", async ({ inputIndex, setup, reason, diagnostic }) => {
    setup();
    await act(async () => {
      root.render(<RemoteTab />);
      await Promise.resolve();
    });
    const input = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[inputIndex];
    expect(input.disabled).toBe(false);

    await act(async () => {
      input.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(getPersistentSchemaState()).toMatchObject({
      status: "quarantined",
      reason,
      requiresUnsavedConfirmation: true,
    }));
    expect(container.textContent).toContain(diagnostic);
    expect(container.textContent).not.toContain("設定の保存に失敗しました");
    expect(container.textContent).not.toContain("リモート接続の切り替えに失敗しました");
  });
});
