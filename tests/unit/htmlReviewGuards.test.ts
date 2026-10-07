import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewFrame, ReviewTarget } from "../../src/lib/htmlReviewDraft";
const mocks = vi.hoisted(() => ({ evalWebPane: vi.fn(), screenshotWebPane: vi.fn() }));
vi.mock("../../src/components/workspace/webPaneApi", () => mocks);
import { captureHtmlReviewTarget, validateHtmlReviewCapture } from "../../src/lib/htmlReviewCapture";
const base: ReviewFrame = { url: "http://asset.localhost/fixture.html", documentId: "doc", generation: 10, mutationRevision: 0,
  ref: "review-owned", fingerprint: "target", selector: "html > body:nth-of-type(1) > p:nth-of-type(1)",
  rect: { x: 20, y: 40, width: 100, height: 30 }, scrollX: 0, scrollY: 1040, dpr: 1.5, cssZoom: 1.25,
  viewport: { width: 800, height: 600 }, anchor: { text: "Selected text", before: "before", after: "after", heading: "Heading" } };
const changes: Partial<ReviewFrame>[] = [{ documentId: "new-doc" }, { generation: 11 }, { mutationRevision: 1 },
  { url: "http://asset.localhost/other.html" }, { scrollX: 10 }, { scrollY: 1100 }, { dpr: 2 }, { cssZoom: 1 },
  { viewport: { width: 801, height: 600 } }, { viewport: { width: 800, height: 601 } }, { fingerprint: "changed" },
  { selector: "#different" }, { rect: { ...base.rect, x: 21 } },
  { anchor: { ...base.anchor!, text: "Changed" } }];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.screenshotWebPane.mockResolvedValue({ tabId: "preview", path: "C:/review/shot.png", width: 100, height: 30, dpr: 1.5 });
});
describe.each(["text", "selection", "element"] as const)("RV-T5 guards for %s", mode => {
  const frame = { ...base, mode };
  const node: ReviewTarget = { ref: base.ref, tag: "p", name: "Selected text", role: "generic",
    rect: base.rect, inViewport: true, frame };
  it.each(changes)("refuses a search/choice-time frame change before taking an image: %o", async change => {
    mocks.evalWebPane.mockResolvedValue({ tabId: "preview", value: { ...frame, ...change } });
    await expect(captureHtmlReviewTarget("preview", base.url, "C:/fixture.html", frame, node)).rejects.toThrow();
    expect(mocks.screenshotWebPane).not.toHaveBeenCalled();
  });
  it.each(changes)("refuses a frame change during capture and before copying: %o", async change => {
    mocks.evalWebPane.mockResolvedValueOnce({ tabId: "preview", value: frame })
      .mockResolvedValueOnce({ tabId: "preview", value: { ...frame, ...change } });
    await expect(captureHtmlReviewTarget("preview", base.url, "C:/fixture.html", frame, node)).rejects.toThrow();
    mocks.evalWebPane.mockResolvedValue({ tabId: "preview", value: frame });
    const captured = await captureHtmlReviewTarget("preview", base.url, "C:/fixture.html", frame, node);
    mocks.evalWebPane.mockResolvedValue({ tabId: "preview", value: { ...frame, ...change } });
    await expect(validateHtmlReviewCapture(captured, base.url)).rejects.toThrow();
  });
});
