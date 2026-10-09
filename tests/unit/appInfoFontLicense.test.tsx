// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.87.0") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../../src/lib/forcedAutoUpdater", () => ({ runUpdateCheck: vi.fn() }));
vi.mock("../../src/lib/windowContext", () => ({
  hasWindowRole: () => true,
  useWindowRole: () => true,
}));

import { AppInfoTab } from "../../src/components/settings/tabs/AppInfoTab";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("bundled font licence in App Info", () => {
  it("renders both families and the complete shared OFL notice", async () => {
    await act(async () => root.render(<AppInfoTab />));

    const details = container.querySelector("details");
    expect(container.textContent).toContain("同梱フォントのライセンス");
    expect(details?.querySelector("summary")?.textContent?.trim()).toBe(
      "UDEV Gothic NF / HackGen Console NF (SIL Open Font License 1.1)",
    );
    const body = details?.querySelector("pre")?.textContent;
    const licensePath = resolve(process.cwd(), "src/assets/fonts/OFL.txt");
    expect(body).toBe(readFileSync(licensePath, "utf8"));
    expect(body).toContain("UDEV Gothic NF");
    expect(body).toContain("HackGen Console NF");
    expect(body).toContain("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
  });
});
