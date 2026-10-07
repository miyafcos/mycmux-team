import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPaneNode } from "../../src/components/workspace/webPaneApi";
import type { ReviewFrame } from "../../src/lib/htmlReviewDraft";

const mocks = vi.hoisted(() => ({ evalWebPane: vi.fn(), findWebPane: vi.fn(), screenshotWebPane: vi.fn() }));
vi.mock("../../src/components/workspace/webPaneApi", () => mocks);
import { captureHtmlReviewTarget, searchHtmlReviewTargets, validateHtmlReviewCapture } from "../../src/lib/htmlReviewCapture";

const frame: ReviewFrame = {
  url: "http://asset.localhost/fixture.html", documentId: "doc-1", generation: 10, mutationRevision: 0,
  ref: "r1", fingerprint: "button-1", selector: "#pay", rect: { x: 20, y: 40, width: 150, height: 30 },
  scrollX: 0, scrollY: 1040, dpr: 1.5, cssZoom: 1.25, viewport: { width: 800, height: 600 },
};
const node: WebPaneNode = { ref: "r1", tag: "button", role: "button", name: "Pay", rect: frame.rect, inViewport: true };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.evalWebPane.mockImplementation(async (_tabId: string, script: string) => ({ tabId: "preview", value: script.includes('"kind":"search"') ? { page: frame, nodes: [node] } : frame }));
  mocks.findWebPane.mockResolvedValue({ tabId: "preview", nodes: [node] });
  mocks.screenshotWebPane.mockResolvedValue({ tabId: "preview", path: "C:/review/shot.png", width: 150, height: 30, dpr: 1.5 });
});
describe("capture transaction", () => {
  it("binds search, image and source to one finding and rechecks immediately after capture", async () => {
    const found = await searchHtmlReviewTargets("preview", frame.url, "Pay");
    const capture = await captureHtmlReviewTarget("preview", frame.url, "C:/fixture.html", found.page, found.nodes[0]);
    expect(capture.id).toBeTruthy();
    expect(capture.sourcePath).toBe("C:/fixture.html");
    expect(capture.coordinateSpace).toBe("document-css");
    expect(mocks.screenshotWebPane).toHaveBeenCalledExactlyOnceWith("preview", { clip: { x: 20, y: 1080, width: 150, height: 30 } });
    expect(mocks.evalWebPane).toHaveBeenCalledTimes(4);
    await expect(validateHtmlReviewCapture(capture, frame.url)).resolves.toBeUndefined();
  });
  it("refuses a page update while searching", async () => {
    mocks.evalWebPane.mockResolvedValueOnce({ tabId: "preview", value: { page: frame, nodes: [node] } })
      .mockResolvedValueOnce({ tabId: "preview", value: { ...frame, mutationRevision: 1 } });
    await expect(searchHtmlReviewTargets("preview", frame.url, "Pay")).rejects.toThrow();
  });
  it("refuses a reload between choosing and capture without taking a screenshot", async () => {
    mocks.evalWebPane.mockResolvedValue({ tabId: "preview", value: { ...frame, documentId: "new-doc" } });
    await expect(captureHtmlReviewTarget("preview", frame.url, "C:/fixture.html", frame, node)).rejects.toThrow();
    expect(mocks.screenshotWebPane).not.toHaveBeenCalled();
  });
  it.each([{ mutationRevision: 1 }, { scrollY: 1136 }, { fingerprint: "replaced" }, { generation: 20 }])
  ("refuses a change during screenshot %o", async (change) => {
    mocks.evalWebPane.mockResolvedValueOnce({ tabId: "preview", value: frame })
      .mockResolvedValueOnce({ tabId: "preview", value: { ...frame, ...change } });
    await expect(captureHtmlReviewTarget("preview", frame.url, "C:/fixture.html", frame, node)).rejects.toThrow();
  });
  it("refuses stale evidence before copy", async () => {
    const capture = await captureHtmlReviewTarget("preview", frame.url, "C:/fixture.html", frame, node);
    mocks.evalWebPane.mockResolvedValue({ tabId: "preview", value: { ...frame, mutationRevision: 1 } });
    await expect(validateHtmlReviewCapture(capture, frame.url)).rejects.toThrow();
  });
  it.each([
    { tabId: "other", path: "C:/shot.png", width: 150, height: 30 },
    { tabId: "preview", path: "", width: 150, height: 30 },
    { tabId: "preview", path: "C:/shot.png", width: 0, height: 30 },
  ])("refuses malformed or wrong-tab image receipts %o", async (reply) => {
    mocks.screenshotWebPane.mockResolvedValue(reply);
    await expect(captureHtmlReviewTarget("preview", frame.url, "C:/fixture.html", frame, node)).rejects.toThrow();
  });
  it("propagates native capture failure without returning a successful draft", async () => {
    mocks.screenshotWebPane.mockRejectedValue(new Error("native budget exhausted"));
    await expect(captureHtmlReviewTarget("preview", frame.url, "C:/fixture.html", frame, node)).rejects.toThrow("budget");
  });
  it("refuses a page reply belonging to another tab", async () => {
    mocks.evalWebPane.mockResolvedValue({ tabId: "other", value: frame });
    await expect(searchHtmlReviewTargets("preview", frame.url, "Pay")).rejects.toThrow();
  });
});
