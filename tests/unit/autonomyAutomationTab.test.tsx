// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({
  autonomyGetSettings: vi.fn(),
  autonomySetSettings: vi.fn(),
}));

vi.mock("../../src/lib/autonomyBridge", () => bridgeMocks);

import { AutomationTab } from "../../src/components/settings/tabs/AutomationTab";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  bridgeMocks.autonomyGetSettings.mockResolvedValue({ autoAdvance: true, attentionCards: true });
  bridgeMocks.autonomySetSettings.mockResolvedValue({ autoAdvance: false, attentionCards: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("自律モード", () => {
  it("writes one changed toggle and renders the returned setting", async () => {
    await act(async () => {
      root.render(<AutomationTab />);
      await Promise.resolve();
    });
    const autoAdvance = container.querySelector<HTMLInputElement>("[data-autonomy-toggle='autoAdvance']");
    expect(autoAdvance?.checked).toBe(true);

    await act(async () => {
      autoAdvance?.click();
      await Promise.resolve();
    });

    expect(bridgeMocks.autonomySetSettings).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.autonomySetSettings).toHaveBeenCalledWith({ autoAdvance: false });
    expect(autoAdvance?.checked).toBe(false);
  });
});
