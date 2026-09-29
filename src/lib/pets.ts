import clawdAtlasUrl from "../assets/pets/clawd/spritesheet.webp";

export type PetSource = "bundled" | "external";

export interface PetCandidate {
  id: string;
  name: string;
  source: PetSource;
  atlasUrl: string;
  rows: number;
  atlasWidth: number;
  atlasHeight: number;
  folder: string;
}

export interface ListedPet {
  id: string;
  name: string;
  source: PetSource;
  atlas_b64?: string | null;
  atlas_width?: number | null;
  atlas_height?: number | null;
  rows?: number | null;
  valid: boolean;
  warning?: string | null;
  folder: string;
}

export const bundledPet: PetCandidate = {
  id: "clawd",
  name: "Clawd",
  source: "bundled",
  atlasUrl: clawdAtlasUrl,
  rows: 9,
  atlasWidth: 1536,
  atlasHeight: 1872,
  folder: "clawd",
};

export function candidatesFromListedPets(pets: ListedPet[]): { candidates: PetCandidate[]; invalid: ListedPet[] } {
  const external = pets
    .filter((pet) => pet.source === "external" && pet.valid && pet.atlas_b64 && pet.rows && pet.atlas_width && pet.atlas_height)
    .map((pet) => ({
      id: pet.id,
      name: pet.name,
      source: "external" as const,
      atlasUrl: `data:image/webp;base64,${pet.atlas_b64}`,
      rows: pet.rows!,
      atlasWidth: pet.atlas_width!,
      atlasHeight: pet.atlas_height!,
      folder: pet.folder,
    }));
  return {
    candidates: [bundledPet, ...external],
    invalid: pets.filter((pet) => pet.source === "external" && !pet.valid),
  };
}

export function resolvePet(pets: readonly PetCandidate[], id: string | undefined): PetCandidate {
  return pets.find((pet) => pet.id === id) ?? bundledPet;
}
