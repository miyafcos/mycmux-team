import { beforeEach, describe, expect, it, vi } from "vitest";

const label = vi.fn(() => "main");

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    get label() {
      return label();
    },
  }),
}));

import {
  isChildWindow,
  isMainWindow,
  resetWindowContextCacheForTests,
  windowLabel,
} from "../../src/lib/windowContext";

describe("windowContext", () => {
  beforeEach(() => {
    resetWindowContextCacheForTests();
    label.mockReset();
    label.mockReturnValue("main");
  });

  it("reports the main window", () => {
    expect(windowLabel()).toBe("main");
    expect(isMainWindow()).toBe(true);
    expect(isChildWindow()).toBe(false);
  });

  it("reports child windows", () => {
    label.mockReturnValue("mycmux-w1");
    expect(windowLabel()).toBe("mycmux-w1");
    expect(isMainWindow()).toBe(false);
    expect(isChildWindow()).toBe(true);
  });

  it("resolves the label exactly once", () => {
    windowLabel();
    windowLabel();
    isMainWindow();
    expect(label).toHaveBeenCalledTimes(1);
  });

  it("falls back to main outside a Tauri webview", () => {
    label.mockImplementation(() => {
      throw new Error("no __TAURI_INTERNALS__");
    });
    expect(windowLabel()).toBe("main");
    expect(isMainWindow()).toBe(true);
  });
});
