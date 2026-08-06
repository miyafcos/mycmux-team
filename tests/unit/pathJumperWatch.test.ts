import { describe, expect, it, vi } from "vitest";

import { PathJumperWatchController } from "../../src/components/layout/pathJumperWatch";

describe("PathJumperWatchController", () => {
  it("watches opened paths once and releases all paths when closed", async () => {
    const watchRoot = vi.fn().mockResolvedValue(undefined);
    const unwatchRoot = vi.fn().mockResolvedValue(undefined);
    const controller = new PathJumperWatchController({ watchRoot, unwatchRoot });

    await controller.sync(true, ["C:\\root"]);
    await controller.sync(true, ["C:\\root", "C:\\root\\child"]);
    await controller.sync(false, []);

    expect(watchRoot).toHaveBeenCalledTimes(2);
    expect(unwatchRoot).toHaveBeenCalledTimes(2);
    expect(unwatchRoot).toHaveBeenCalledWith("C:\\root");
    expect(unwatchRoot).toHaveBeenCalledWith("C:\\root\\child");
  });

  it("releases a completed watch queued before close", async () => {
    let resolveWatch: (() => void) | undefined;
    const watchRoot = vi.fn(
      () => new Promise<void>((resolve) => { resolveWatch = resolve; }),
    );
    const unwatchRoot = vi.fn().mockResolvedValue(undefined);
    const controller = new PathJumperWatchController({ watchRoot, unwatchRoot });

    const opening = controller.sync(true, ["C:\\root"]);
    await Promise.resolve();
    await Promise.resolve();
    const closing = controller.sync(false, []);
    resolveWatch?.();
    await Promise.all([opening, closing]);

    expect(unwatchRoot).toHaveBeenCalledWith("C:\\root");
  });

  it("keeps the palette usable when watch IPC fails", async () => {
    const watchRoot = vi.fn().mockRejectedValue(new Error("watch failed"));
    const unwatchRoot = vi.fn().mockRejectedValue(new Error("unwatch failed"));
    const controller = new PathJumperWatchController({ watchRoot, unwatchRoot });

    await expect(controller.sync(true, ["C:\\root"])).resolves.toBeUndefined();
    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(watchRoot).toHaveBeenCalledWith("C:\\root");
  });
});
