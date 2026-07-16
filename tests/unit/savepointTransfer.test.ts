import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../../src/lib/ipc", () => ({
  exportSavepointTransfer: vi.fn(),
  importSavepointTransfer: vi.fn(),
}));

import { save } from "@tauri-apps/plugin-dialog";
import { exportSavepointTransfer } from "../../src/lib/ipc";
import {
  isSavepointTransferPath,
  savepointTransferFileName,
  shareSavepointTransfer,
} from "../../src/lib/savepointTransfer";

describe("savepoint transfer file helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recognizes only the dedicated extension, case-insensitively", () => {
    expect(isSavepointTransferPath("C:/handoff/session.mycmux-transfer")).toBe(true);
    expect(isSavepointTransferPath("C:/handoff/SESSION.MYCMUX-TRANSFER")).toBe(true);
    expect(isSavepointTransferPath("C:/handoff/session.mycmux-transfer.exe")).toBe(false);
    expect(isSavepointTransferPath("C:/handoff/session.zip")).toBe(false);
  });

  it("creates a short Windows-safe filename", () => {
    const filename = savepointTransferFileName('Review: <alpha> / beta?*   ');
    expect(filename).toBe("Review- -alpha- - beta--.mycmux-transfer");
    expect(filename.length).toBeLessThanOrEqual(72 + ".mycmux-transfer".length);
  });

  it("does not invoke the backend when the save dialog is cancelled", async () => {
    vi.mocked(save).mockResolvedValue(null);

    await expect(shareSavepointTransfer("C:/savepoints/one", "One")).resolves.toBeNull();
    expect(exportSavepointTransfer).not.toHaveBeenCalled();
  });
});
