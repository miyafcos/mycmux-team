import { describe, expect, it } from "vitest";
import "../../src-tauri/src/remote/client/app.js";

const RemoteTransport = (globalThis as { RemoteTransport: {
  applyControlMessage: (state: unknown, msg: unknown) => {
    lastEnd: number | undefined;
    epoch: number | undefined;
    dropLastEnd: boolean;
    shouldReset: boolean;
    acceptsResize: boolean;
    hasAcceptsResize: boolean;
    mode: string | undefined;
    cols: number | undefined;
    rows: number | undefined;
  };
  applyBinaryFrame: (state: unknown, frameEnd: number) => { lastEnd: number };
  sinceForReconnect: (lastEnd?: number, epoch?: number) => { since?: number; epoch?: number };
  discardDisplay: (state: unknown) => {
    lastEnd: number | undefined;
    dropLastEnd: boolean;
    shouldClear: boolean;
    epoch: number | undefined;
  };
  defaultFontSize: (isTouch: boolean) => number;
  fontSizeForFit: (isTouch: boolean) => number;
  freshSessionSurface: () => {
    acceptsResize: boolean;
    serverCols: number;
    serverRows: number;
  };
  fontSizeToFit: (
    containerW: number,
    containerH: number,
    cols: number,
    rows: number,
    cellW: number,
    cellH: number,
    sampleSize: number,
    minSize: number,
    maxSize: number
  ) => number;
} }).RemoteTransport;

describe("RemoteTransport.applyControlMessage", () => {
  it("does not advance lastEnd from a connected or resync JSON frame", () => {
    const fromEmpty = RemoteTransport.applyControlMessage(
      { lastEnd: undefined, epoch: 7 },
      { type: "connected", end: 4096, resync: true, session_epoch: 7 }
    );
    expect(fromEmpty.lastEnd).toBeUndefined();
    expect(fromEmpty.shouldReset).toBe(true);
    expect(fromEmpty.dropLastEnd).toBe(true);

    const fromPartial = RemoteTransport.applyControlMessage(
      { lastEnd: 128, epoch: 7 },
      { type: "resync", end: 4096, resync: false, session_epoch: 7 }
    );
    expect(fromPartial.lastEnd).toBe(128);
    expect(fromPartial.dropLastEnd).toBe(false);
  });

  it("drops the saved offset when session_epoch changes", () => {
    const next = RemoteTransport.applyControlMessage(
      { lastEnd: 2048, epoch: 11 },
      { type: "connected", end: 64, resync: true, session_epoch: 99 }
    );
    expect(next.dropLastEnd).toBe(true);
    expect(next.lastEnd).toBeUndefined();
    expect(next.epoch).toBe(99);
  });

  it("keeps the saved offset when session_epoch is unchanged", () => {
    const next = RemoteTransport.applyControlMessage(
      { lastEnd: 2048, epoch: 11 },
      { type: "connected", end: 4096, resync: false, session_epoch: 11 }
    );
    expect(next.dropLastEnd).toBe(false);
    expect(next.lastEnd).toBe(2048);
    expect(next.epoch).toBe(11);
  });

  it("drops the saved offset when the display will be reset", () => {
    const next = RemoteTransport.applyControlMessage(
      { lastEnd: 2048, epoch: 11 },
      { type: "resync", end: 4096, resync: true, session_epoch: 11 }
    );
    expect(next.shouldReset).toBe(true);
    expect(next.dropLastEnd).toBe(true);
    expect(next.lastEnd).toBeUndefined();
  });
});

describe("RemoteTransport.discardDisplay", () => {
  it("pairs a display clear with dropping the receive cursor", () => {
    const next = RemoteTransport.discardDisplay({ lastEnd: 4096, epoch: 7 });
    expect(next.shouldClear).toBe(true);
    expect(next.dropLastEnd).toBe(true);
    expect(next.lastEnd).toBeUndefined();
    expect(next.epoch).toBe(7);
  });

  it("never returns a cleared display that still has a receive cursor", () => {
    const next = RemoteTransport.discardDisplay({ lastEnd: 1, epoch: 1 });
    expect(next.shouldClear && next.dropLastEnd && next.lastEnd === undefined).toBe(true);
  });
});

describe("RemoteTransport.fontSizeForFit", () => {
  it("restores the default size before FitAddon on a resizable session", () => {
    expect(RemoteTransport.fontSizeForFit(true)).toBe(13);
    expect(RemoteTransport.fontSizeForFit(false)).toBe(16);
    expect(RemoteTransport.fontSizeForFit(false)).toBe(RemoteTransport.defaultFontSize(false));
    expect(RemoteTransport.fontSizeForFit(false)).toBeGreaterThan(6);
  });
});

describe("RemoteTransport.freshSessionSurface", () => {
  it("resets acceptsResize so a previous view-mode shrink cannot leak", () => {
    const surface = RemoteTransport.freshSessionSurface();
    expect(surface.acceptsResize).toBe(false);
    expect(surface.serverCols).toBe(0);
    expect(surface.serverRows).toBe(0);
  });
});

describe("RemoteTransport.applyBinaryFrame", () => {
  it("advances lastEnd only from a received binary end offset", () => {
    const next = RemoteTransport.applyBinaryFrame(
      { lastEnd: 128, epoch: 7 },
      256
    );
    expect(next.lastEnd).toBe(256);
  });
});

describe("RemoteTransport.sinceForReconnect", () => {
  it("omits since until a binary frame has been recorded", () => {
    expect(RemoteTransport.sinceForReconnect(undefined, 7)).toEqual({ epoch: 7 });
    expect(RemoteTransport.sinceForReconnect(90, 7)).toEqual({ since: 90, epoch: 7 });
  });
});

describe("RemoteTransport.fontSizeToFit", () => {
  it("stays inside the min/max band and shrinks for a narrow viewport", () => {
    const wide = RemoteTransport.fontSizeToFit(800, 600, 80, 24, 9.6, 19.2, 16, 6, 20);
    const narrow = RemoteTransport.fontSizeToFit(200, 400, 80, 24, 9.6, 19.2, 16, 6, 20);
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThanOrEqual(6);
    expect(wide).toBeLessThanOrEqual(20);
  });
});
