import { describe, expect, it } from "vitest";
import { pickMostRecentLastLog } from "../../src/lib/lastLogRecency";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";

describe("pickMostRecentLastLog", () => {
  it("returns undefined when no candidate has a line", () => {
    expect(pickMostRecentLastLog([])).toBeUndefined();
    expect(pickMostRecentLastLog([
      { line: undefined, at: 10 },
      { line: "", at: 20 },
    ])).toBeUndefined();
  });

  it("picks the newest line, not the last one in iteration order", () => {
    expect(pickMostRecentLastLog([
      { line: "fresh", at: 900 },
      { line: "stale", at: 100 },
    ])).toBe("fresh");
  });

  it("skips sessions with no line at all", () => {
    expect(pickMostRecentLastLog([
      { line: "only", at: 5 },
      { line: undefined, at: 999 },
    ])).toBe("only");
  });

  it("ranks a timestamped line above an untimestamped one in either order", () => {
    expect(pickMostRecentLastLog([
      { line: "timestamped", at: 1 },
      { line: "unknown", at: undefined },
    ])).toBe("timestamped");
    expect(pickMostRecentLastLog([
      { line: "unknown", at: undefined },
      { line: "timestamped", at: 1 },
    ])).toBe("timestamped");
  });

  it("keeps the later candidate on a tie", () => {
    expect(pickMostRecentLastLog([
      { line: "first", at: 400 },
      { line: "second", at: 400 },
    ])).toBe("second");
    expect(pickMostRecentLastLog([
      { line: "first", at: undefined },
      { line: "second", at: undefined },
    ])).toBe("second");
  });
});

describe("paneMetadataStore lastLogAt", () => {
  it("stamps a time whenever a session's last log line changes", () => {
    usePaneMetadataStore.setState({ metadata: {}, lastLog: {}, lastLogAt: {} });
    const store = usePaneMetadataStore.getState();

    store.setMetadata("older", { lastLogLine: "older line" });
    const olderAt = usePaneMetadataStore.getState().lastLogAt.older;
    expect(typeof olderAt).toBe("number");

    store.setMetadata("newer", { lastLogLine: "newer line" });
    const newerAt = usePaneMetadataStore.getState().lastLogAt.newer;
    expect(newerAt).toBeGreaterThanOrEqual(olderAt);

    // An unchanged line must not re-stamp: the sidebar would otherwise treat a
    // silent session as the freshest one on every metadata poll.
    store.setMetadata("older", { lastLogLine: "older line" });
    expect(usePaneMetadataStore.getState().lastLogAt.older).toBe(olderAt);
  });

  it("drops the timestamp with the rest of a session's metadata", () => {
    usePaneMetadataStore.setState({ metadata: {}, lastLog: {}, lastLogAt: {} });
    usePaneMetadataStore.getState().setMetadata("gone", { lastLogLine: "bye" });
    usePaneMetadataStore.getState().removeMetadata("gone");
    expect(usePaneMetadataStore.getState().lastLogAt.gone).toBeUndefined();
    expect(usePaneMetadataStore.getState().lastLog.gone).toBeUndefined();
  });
});
