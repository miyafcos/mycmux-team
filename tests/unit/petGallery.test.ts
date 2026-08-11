import { describe, expect, it } from "vitest";
import { atlasSizeBadge, isGalleryInstalled, normalizeGalleryResponse } from "../../src/components/settings/tabs/PetGallerySection";

describe("pet gallery helpers", () => {
  it("normalizes missing API fields", () => {
    expect(normalizeGalleryResponse({ pets: [{ id: "kurisu", tags: ["anime", 3] }] })).toEqual({
      total: 0,
      pets: [{ id: "kurisu", displayName: "", description: "", tags: ["anime"], likeCount: 0, downloadCount: 0, previewUrl: "", atlasSize: "", statesDetected: [] }],
    });
  });

  it("derives supported atlas badges", () => {
    expect(atlasSizeBadge("1536x1872")).toBe("8×9");
    expect(atlasSizeBadge("1536x2288")).toBe("8×11");
    expect(atlasSizeBadge("2504x1878")).toBe("");
  });

  it("recognizes a locally installed gallery pet", () => {
    expect(isGalleryInstalled("kurisu", ["clawd", "external:kurisu"])).toBe(true);
    expect(isGalleryInstalled("kurisu", ["clawd"])).toBe(false);
  });
});
