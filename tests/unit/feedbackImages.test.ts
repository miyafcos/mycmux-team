// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeFeedbackImage } from "../../src/components/feedback/feedbackImages";

let broken = false;
let width = 3840;
let height = 2160;
let canvas: HTMLCanvasElement | undefined;
const draw = vi.fn();
const small = "data:image/png;base64,aW1hZ2U=";
class TestImage {
  naturalWidth = width;
  naturalHeight = height;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { queueMicrotask(() => { if (broken) this.onerror?.(); else this.onload?.(); }); }
}
beforeEach(() => {
  broken = false; width = 3840; height = 2160; canvas = undefined;
  vi.stubGlobal("Image", TestImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function(this: HTMLCanvasElement) {
    canvas = this;
    return { drawImage: draw } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(small);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("reduces the long edge to 1920 and returns an in-memory image only", async () => {
  expect(await normalizeFeedbackImage(small)).toEqual({ mime: "image/png", data: "aW1hZ2U=" });
  expect(canvas?.width).toBe(1920);
  expect(canvas?.height).toBe(1080);
});
it("converts oversized PNG to JPEG below two MiB", async () => {
  vi.mocked(HTMLCanvasElement.prototype.toDataURL)
    .mockReturnValueOnce("data:image/png;base64," + "A".repeat(4 * Math.ceil((2 * 1024 * 1024 + 3) / 3)))
    .mockReturnValue("data:image/jpeg;base64,aW1hZ2U=");
  expect(await normalizeFeedbackImage(small)).toEqual({ mime: "image/jpeg", data: "aW1hZ2U=" });
});
it("keeps reducing oversized images and refuses one that cannot fit", async () => {
  vi.mocked(HTMLCanvasElement.prototype.toDataURL)
    .mockImplementation(type => `data:${type};base64,` + "A".repeat(4 * Math.ceil((2 * 1024 * 1024 + 3) / 3)));
  await expect(normalizeFeedbackImage(small)).rejects.toThrow("画像を2MiB以内にできませんでした。");
  expect(canvas!.width).toBeLessThan(1920);
});
it("loads a chosen file and refuses a non-image or damaged image", async () => {
  expect((await normalizeFeedbackImage(new File(["fake"], "sample.png", { type: "image/png" }))).mime).toBe("image/png");
  await expect(normalizeFeedbackImage(new File(["text"], "sample.txt", { type: "text/plain" }))).rejects.toThrow();
  broken = true;
  await expect(normalizeFeedbackImage(small)).rejects.toThrow("画像を読み込めませんでした。別の画像を選んでください。");
});
it("does not enlarge a small image and rejects invalid dimensions", async () => {
  width = 320; height = 180;
  await normalizeFeedbackImage(small);
  expect(canvas?.width).toBe(320); expect(canvas?.height).toBe(180);
  width = 0;
  await expect(normalizeFeedbackImage(small)).rejects.toThrow();
});
