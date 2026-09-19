// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pocketMocks = vi.hoisted(() => ({
  getPocketEntry: vi.fn(),
}));

vi.mock("../../src/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ipc")>()),
  ...pocketMocks,
}));

import { PocketTab } from "../../src/components/settings/tabs/PocketTab";
import { settingsStrings } from "../../src/components/settings/settingsStrings";

const POCKET_URL = "https://miyazaki.tail3c3d6a.ts.net/pocket/";
const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" /></svg>';

describe("PocketTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(<PocketTab />);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the QR and the URL when the phone app is published", async () => {
    pocketMocks.getPocketEntry.mockResolvedValue({
      url: POCKET_URL,
      qr_svg: QR_SVG,
      reachable: true,
    });

    await render();

    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toContain(POCKET_URL);
    // A reachable entry carries no warning.
    expect(container.textContent).not.toContain(settingsStrings.pocketUnreachableNote);
  });

  it("warns when the route is published but nothing answers", async () => {
    pocketMocks.getPocketEntry.mockResolvedValue({
      url: POCKET_URL,
      qr_svg: QR_SVG,
      reachable: false,
    });

    await render();

    // The QR still shows: the address is right, the server is down.
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toContain(settingsStrings.pocketUnreachableNote);
  });

  it("explains itself instead of showing an empty QR box when nothing is served", async () => {
    pocketMocks.getPocketEntry.mockResolvedValue({
      url: "",
      qr_svg: "",
      reachable: false,
    });

    await render();

    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain(settingsStrings.pocketMissingHeading);
  });

  it("keeps the panel usable when the entry cannot be read", async () => {
    pocketMocks.getPocketEntry.mockRejectedValue(new Error("tailscale is not installed"));

    await render();

    expect(container.textContent).toContain("入口を確認できませんでした");
    // The failure must not leave the panel blank: the guidance stays.
    expect(container.textContent).toContain(settingsStrings.pocketMissingHeading);
  });
});
