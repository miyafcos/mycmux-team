import { create } from "zustand";
import { bundledPet, type PetCandidate } from "../lib/pets";

export type PetDisplayMode = "ws" | "both" | "none";
export type PetNewWorkspaceMode = "random" | "choose" | "fixed";

export interface PersistedPetSettings {
  petDisplayMode: PetDisplayMode;
  petNewWorkspaceMode: PetNewWorkspaceMode;
  petDisabled: string[];
  petFixedId?: string;
}

interface PetSettingsState extends PersistedPetSettings {
  pets: PetCandidate[];
  hydratePetSettings: (settings: Partial<PersistedPetSettings>) => void;
  setPetDisplayMode: (mode: PetDisplayMode) => void;
  setPetNewWorkspaceMode: (mode: PetNewWorkspaceMode) => void;
  setPetDisabled: (ids: string[]) => void;
  setPetFixedId: (id: string | undefined) => void;
  setPets: (pets: PetCandidate[]) => void;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function keepOneEnabled(disabled: string[], pets: readonly PetCandidate[]): string[] {
  const unique = uniqueIds(disabled);
  if (pets.length > 0 && pets.every((pet) => unique.includes(pet.id))) {
    return unique.filter((id) => id !== pets[0].id);
  }
  return unique;
}

export const usePetSettingsStore = create<PetSettingsState>((set) => ({
  petDisplayMode: "ws",
  petNewWorkspaceMode: "random",
  petDisabled: [],
  petFixedId: undefined,
  pets: [bundledPet],
  hydratePetSettings: (settings) => set((state) => ({
    petDisplayMode: settings.petDisplayMode ?? "ws",
    petNewWorkspaceMode: settings.petNewWorkspaceMode ?? "random",
    petDisabled: keepOneEnabled(settings.petDisabled ?? [], state.pets),
    petFixedId: settings.petFixedId,
  })),
  setPetDisplayMode: (petDisplayMode) => set({ petDisplayMode }),
  setPetNewWorkspaceMode: (petNewWorkspaceMode) => set({ petNewWorkspaceMode }),
  setPetDisabled: (petDisabled) => set((state) => ({
    petDisabled: keepOneEnabled(petDisabled, state.pets),
  })),
  setPetFixedId: (petFixedId) => set({ petFixedId }),
  setPets: (pets) => set((state) => {
    const nextPets = pets.length > 0 ? pets : [bundledPet];
    return { pets: nextPets, petDisabled: keepOneEnabled(state.petDisabled, nextPets) };
  }),
}));
