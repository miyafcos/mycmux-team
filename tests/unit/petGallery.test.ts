import { describe, expect, it } from "vitest";
import { atlasSizeBadge, isGalleryInstalled, normalizeGalleryResponse, thumbnailUrl } from "../../src/components/settings/tabs/PetGallerySection";

describe("pet gallery helpers", () => {
  it("normalizes missing API fields", () => {
    expect(normalizeGalleryResponse({ pets: [{ id: "kurisu", tags: ["anime", 3] }] })).toEqual({
      total: 0,
      pets: [{ id: "kurisu", displayName: "", description: "", tags: ["anime"], likeCount: 0, downloadCount: 0, previewUrl: "", posterUrl: "", atlasSize: "", statesDetected: 0 }],
    });
  });

  it("thumbnails the single frame, not the filmstrip", () => {
    // previewUrl is 7008x104 for an eleven-row pet: rendered in a card it is a hairline.
    expect(thumbnailUrl({ posterUrl: "poster.webp", previewUrl: "preview.webp" })).toBe("poster.webp");
    expect(thumbnailUrl({ posterUrl: "", previewUrl: "preview.webp" })).toBe("preview.webp");
  });

  it("keeps a preview-only pet when posterUrl is null", () => {
    const page = normalizeGalleryResponse({ pets: [{ id: "preview-only", previewUrl: "preview.webp", posterUrl: null }] });
    expect(page.pets).toHaveLength(1);
    expect(thumbnailUrl(page.pets[0])).toBe("preview.webp");
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
