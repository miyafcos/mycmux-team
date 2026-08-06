import { describe, expect, it } from "vitest";

import {
  SEARCH_INDEX_TTL_MS,
  shouldRefreshSearchIndex,
} from "../../src/components/layout/PathJumper";

describe("PathJumper search index freshness", () => {
  it("does not rebuild a ready index within the five-minute TTL", () => {
    expect(shouldRefreshSearchIndex("ready", 1_000, 1_000 + SEARCH_INDEX_TTL_MS)).toBe(false);
  });

  it("rebuilds an expired ready index without treating a build in progress as stale", () => {
    expect(shouldRefreshSearchIndex("ready", 1_000, 1_001 + SEARCH_INDEX_TTL_MS)).toBe(true);
    expect(shouldRefreshSearchIndex("building", 1_000, 1_001 + SEARCH_INDEX_TTL_MS)).toBe(false);
  });
});
