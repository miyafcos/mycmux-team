import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionScrollback } from "../../src/lib/ipc";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));

function wire(version: 1 | 2, start = 0): ArrayBuffer {
  const header = version === 1 ? 24 : 48;
  const result = new ArrayBuffer(header + 1);
  const bytes = new Uint8Array(result);
  bytes.set([0x4d, 0x43, 0x53, 0x30 + version]);
  const view = new DataView(result);
  view.setBigUint64(8, BigInt(start), true);
  view.setBigUint64(16, BigInt(start + 1), true);
  if (version === 2) {
    view.setUint32(4, start > 0 ? 1 : 0, true);
    view.setBigUint64(24, 17n, true);
    view.setBigUint64(32, 2n, true);
    view.setUint16(40, 120, true); view.setUint16(42, 40, true);
  }
  bytes[header] = 65;
  return result;
}

beforeEach(() => vi.clearAllMocks());

describe("scrollback IPC requests", () => {
  it("keeps full reads argument-compatible and decodes backend geometry", async () => {
    mocks.invoke.mockResolvedValue(wire(2));
    await expect(getSessionScrollback("fixture")).resolves.toMatchObject({
      cols: 120, rows: 40, sessionEpoch: 17, sizeRevision: 2, isDelta: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("get_session_scrollback", { sessionId: "fixture" });
  });

  it("passes the absolute cursor with both generations to the existing async command", async () => {
    mocks.invoke.mockResolvedValue(wire(2, 100));
    const since = { endOffset: 100, sessionEpoch: 17, sizeRevision: 2 };
    await expect(getSessionScrollback("fixture", since)).resolves.toMatchObject({ startOffset: 100, endOffset: 101, isDelta: true });
    expect(mocks.invoke).toHaveBeenCalledWith("get_session_scrollback", { sessionId: "fixture", since });
  });

  it("continues to decode a restored legacy MCS1 response", async () => {
    mocks.invoke.mockResolvedValue(wire(1));
    await expect(getSessionScrollback("fixture")).resolves.toEqual({ data: new Uint8Array([65]), startOffset: 0, endOffset: 1 });
  });
});
