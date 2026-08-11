import { describe, expect, it } from "vitest";
import { deriveRowsFromNatural, spriteAtlasStyle } from "../../src/components/workspace/PetSprite";

describe("pet sprite atlas dimensions", () => {
  it("accepts both supported atlas formats", () => {
    expect(deriveRowsFromNatural(1536, 1872)).toBe(9);
    expect(deriveRowsFromNatural(1536, 2288)).toBe(11);
  });

  it("rejects nonstandard atlas dimensions", () => {
    expect(deriveRowsFromNatural(2504, 1878)).toBeNull();
    expect(deriveRowsFromNatural(1252, 939)).toBeNull();
  });

  it("uses the selected row count for background geometry", () => {
    expect(spriteAtlasStyle(208, 11, 7)).toEqual({
      backgroundSize: "1536px 2288px",
      backgroundPosition: "0 -1456px",
    });
  });
});
