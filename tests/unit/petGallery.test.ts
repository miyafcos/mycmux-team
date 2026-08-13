import { describe, expect, it } from "vitest";
import { atlasSizeBadge, isGalleryInstalled, normalizeGalleryResponse } from "../../src/components/settings/tabs/PetGallerySection";

describe("pet gallery helpers", () => {
  it("normalizes missing API fields", () => {
    expect(normalizeGalleryResponse({ pets: [{ id: "kurisu", tags: ["anime", 3] }] })).toEqual({
      total: 0,
      pets: [{ id: "kurisu", displayName: "", description: "", tags: ["anime"], likeCount: 0, downloadCount: 0, previewUrl: "", atlasSize: "", statesDetected: 0 }],
    });
  });

  it("keeps the numeric state count the gallery API returns", () => {
    const page = normalizeGalleryResponse({ total: 3029, pets: [{ id: "twix-snickers", atlasSize: "1536x2288", statesDetected: 11 }] });
    expect(page.total).toBe(3029);
    expect(page.pets[0].statesDetected).toBe(11);
  });

  it("derives supported atlas badges", () => {
    expect(atlasSizeBadge("1536x1872")).toBe("8×9");
    expect(atlasSizeBadge("1536x2080")).toBe("8×10");
    expect(atlasSizeBadge("1536x2288")).toBe("8×11");
    expect(atlasSizeBadge("2504x1878")).toBe("");
  });

  it("recognizes a locally installed gallery pet", () => {
    expect(isGalleryInstalled("kurisu", ["clawd", "external:kurisu"])).toBe(true);
    expect(isGalleryInstalled("kurisu", ["clawd"])).toBe(false);
  });
});
