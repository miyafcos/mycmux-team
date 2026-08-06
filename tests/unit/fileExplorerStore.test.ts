import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  walkTree: vi.fn(),
}));

vi.mock("../../src/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ipc")>()),
  ...ipcMocks,
}));

import { useFileExplorerStore } from "../../src/stores/fileExplorerStore";

const root = { id: "root", path: "C:\\root", name: "Root" };

function resetStore(): void {
  useFileExplorerStore.setState({
    roots: [root],
    activeRootId: root.id,
    searchIndex: {},
    searchIndexStatus: {},
    searchIndexBuiltAt: {},
    entries: {},
    errors: {},
    loadingPaths: new Set(),
    expanded: new Set(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("file explorer search index freshness", () => {
  it("records the successful build time and keeps the old index while refreshing", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123_456);
    let resolveWalk: ((entries: Array<{ name: string; path: string; is_dir: boolean }>) => void) | undefined;
    ipcMocks.walkTree.mockReturnValueOnce(
      new Promise((resolve) => { resolveWalk = resolve; }),
    );

    const building = useFileExplorerStore.getState().buildSearchIndex(root.path);
    expect(useFileExplorerStore.getState().searchIndexStatus[root.path]).toBe("building");
    resolveWalk?.([{ name: "old", path: "C:\\root\\old", is_dir: false }]);
    await building;
    expect(useFileExplorerStore.getState().searchIndexBuiltAt[root.path]).toBe(123_456);

    ipcMocks.walkTree.mockReturnValueOnce(new Promise(() => {}));
    void useFileExplorerStore.getState().buildSearchIndex(root.path);
    expect(useFileExplorerStore.getState().searchIndex[root.path]).toEqual([
      { name: "old", path: "C:\\root\\old", is_dir: false },
    ]);
    now.mockRestore();
  });

  it("removes index freshness data when a root disappears before completion", async () => {
    ipcMocks.walkTree.mockResolvedValue([{ name: "child", path: "C:\\root\\child", is_dir: false }]);
    const building = useFileExplorerStore.getState().buildSearchIndex(root.path);
    useFileExplorerStore.setState({ roots: [] });
    await building;

    const state = useFileExplorerStore.getState();
    expect(state.searchIndex[root.path]).toBeUndefined();
    expect(state.searchIndexStatus[root.path]).toBeUndefined();
    expect(state.searchIndexBuiltAt[root.path]).toBeUndefined();
  });
});
