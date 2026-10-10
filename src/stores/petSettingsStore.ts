import { create } from "zustand";
import { bundledPet, type PetCandidate } from "../lib/pets";
import { readPetAssignmentBag, type PetAssignmentBag, type PetAssignmentMode, type PetAssignmentSettings } from "../lib/petAssignment";

export type PetDisplayMode = "ws" | "both" | "none";
export type PetNewWorkspaceMode = PetAssignmentMode;

export interface PersistedPetSettings {
  petDisplayMode: PetDisplayMode;
  petNewWorkspaceMode: PetNewWorkspaceMode;
  petDisabled: string[];
  petFixedId?: string;
  petRandomBag?: PetAssignmentBag;
}

interface PetSettingsState extends PersistedPetSettings {
  pets: PetCandidate[];
  petCatalogLoaded: boolean;
  petCatalogRequest: number;
  hydratePetSettings: (settings: Partial<PersistedPetSettings>) => void;
  setPetDisplayMode: (mode: PetDisplayMode) => void;
  setPetNewWorkspaceMode: (mode: PetNewWorkspaceMode) => void;
  setPetDisabled: (ids: string[]) => void;
  setPetFixedId: (id: string | undefined) => void;
  beginPetCatalogLoad: () => number;
  setPets: (pets: PetCandidate[], request?: number) => void;
  setPetRandomBag: (bag: PetAssignmentBag) => void;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function keepOneEnabled(disabled: string[], pets: readonly { id: string }[]): string[] {
  const unique = uniqueIds(disabled);
  if (pets.length > 0 && pets.every((pet) => unique.includes(pet.id))) {
    return unique.filter((id) => id !== pets[0].id);
  }
  return unique;
}

function knownCandidates(state: PetSettingsState, bag = state.petRandomBag): { id: string }[] {
  return state.petCatalogLoaded ? state.pets : [...state.pets, ...(bag?.candidates ?? []).map((id) => ({ id }))];
}

export const usePetSettingsStore = create<PetSettingsState>((set, get) => ({
  petDisplayMode: "none",
  petNewWorkspaceMode: "random",
  petDisabled: [],
  petFixedId: undefined,
  pets: [bundledPet],
  petCatalogLoaded: false,
  petCatalogRequest: 0,
  petRandomBag: undefined,
  hydratePetSettings: (settings) => set((state) => {
    const bag = readPetAssignmentBag(settings.petRandomBag);
    return {
      petDisplayMode: settings.petDisplayMode ?? "none",
      petNewWorkspaceMode: settings.petNewWorkspaceMode ?? "random",
      petDisabled: keepOneEnabled(settings.petDisabled ?? [], knownCandidates(state, bag)),
      petFixedId: settings.petFixedId,
      petRandomBag: bag,
    };
  }),
  setPetDisplayMode: (petDisplayMode) => set({ petDisplayMode }),
  setPetNewWorkspaceMode: (petNewWorkspaceMode) => set({ petNewWorkspaceMode }),
  setPetDisabled: (petDisabled) => set((state) => ({
    petDisabled: keepOneEnabled(petDisabled, knownCandidates(state)),
  })),
  setPetFixedId: (petFixedId) => set({ petFixedId }),
  setPetRandomBag: (petRandomBag) => set((state) => state.petRandomBag === petRandomBag ? state : { petRandomBag }),
  beginPetCatalogLoad: () => {
    const request = get().petCatalogRequest + 1;
    set({ petCatalogRequest: request });
    return request;
  },
  setPets: (pets, request) => set((state) => {
    if (request !== undefined && request !== state.petCatalogRequest) return state;
    const nextPets = pets.length > 0 ? pets : [bundledPet];
    return {
      pets: nextPets, petCatalogLoaded: true,
      petCatalogRequest: request ?? state.petCatalogRequest + 1,
      petDisabled: keepOneEnabled(state.petDisabled, nextPets),
    };
  }),
}));

/** A saved catalog of IDs is usable while display is off, without loading atlases. */
export function petAssignmentSettings(state = usePetSettingsStore.getState()): PetAssignmentSettings {
  const known = knownCandidates(state).map((pet) => pet.id);
  const candidateIds = [...new Set(known)].filter((id) => !state.petDisabled.includes(id));
  return {
    candidateIds: candidateIds.length > 0 ? candidateIds : [bundledPet.id],
    mode: state.petNewWorkspaceMode,
    fixedId: state.petFixedId,
    bag: state.petRandomBag,
  };
}
