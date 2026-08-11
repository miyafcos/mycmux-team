import clawdAtlasUrl from "../assets/pets/clawd/spritesheet.webp";

export type PetSource = "bundled" | "external";

export interface PetCandidate {
  id: string;
  name: string;
  source: PetSource;
  atlasUrl: string;
}

export interface ListedPet {
  id: string;
  name: string;
  source: PetSource;
  atlas_b64?: string | null;
}

export const bundledPet: PetCandidate = {
  id: "clawd",
  name: "Clawd",
  source: "bundled",
  atlasUrl: clawdAtlasUrl,
};

export function candidatesFromListedPets(pets: ListedPet[]): PetCandidate[] {
  const external = pets
    .filter((pet) => pet.source === "external" && pet.atlas_b64)
    .map((pet) => ({
      id: pet.id,
      name: pet.name,
      source: "external" as const,
      atlasUrl: `data:image/webp;base64,${pet.atlas_b64}`,
    }));
  return [bundledPet, ...external];
}

export function resolvePet(pets: readonly PetCandidate[], id: string | undefined): PetCandidate {
  return pets.find((pet) => pet.id === id) ?? bundledPet;
}
