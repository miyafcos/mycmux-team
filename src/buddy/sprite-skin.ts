import { invoke } from "@tauri-apps/api/core";

export interface CodexPetInfo {
  name: string;
  displayName: string;
  spritesheetPath: string;
}

export interface PetLayout {
  version: number;
  cell: {
    w: number;
    h: number;
  };
  columns: number;
  rows: number;
  count: number;
  expressions: Record<string, number[]>;
  moods: Record<string, string[]>;
  ambient: Record<string, string | string[]>;
  talking: {
    labels: string[];
    smile_labels?: string[];
    sharp_labels?: string[];
    thinking_labels?: string[];
  };
  transitions?: Record<string, string>;
  cells?: Array<{
    i: number;
    label: string;
    sheet: string;
    src: number;
  }>;
}

type RawPetLayout = Omit<PetLayout, "talking"> & {
  talking?: PetLayout["talking"] | string[];
};

let petsPromise: Promise<CodexPetInfo[]> | null = null;

export function listCodexPets(): Promise<CodexPetInfo[]> {
  if (!petsPromise) {
    petsPromise = invoke<CodexPetInfo[]>("list_codex_pets").catch((error) => {
      petsPromise = null;
      throw error;
    });
  }
  return petsPromise;
}

export function refreshCodexPets(): Promise<CodexPetInfo[]> {
  petsPromise = null;
  return listCodexPets();
}

const spritesheetCache = new Map<string, Promise<string>>();
const layoutCache = new Map<string, Promise<PetLayout | null>>();

export function loadPetSpritesheet(petName: string): Promise<string> {
  let cached = spritesheetCache.get(petName);
  if (!cached) {
    cached = invoke<string>("read_codex_pet_spritesheet", { petName })
      .then((base64) => `data:image/webp;base64,${base64}`)
      .catch((error) => {
        spritesheetCache.delete(petName);
        throw error;
      });
    spritesheetCache.set(petName, cached);
  }
  return cached;
}

export function loadPetLayout(petName: string): Promise<PetLayout | null> {
  let cached = layoutCache.get(petName);
  if (!cached) {
    cached = invoke<string>("read_codex_pet_layout", { petName })
      .then((raw) => {
        if (!raw.trim()) {
          return null;
        }
        return normalizePetLayout(JSON.parse(raw) as RawPetLayout);
      })
      .catch(() => {
        layoutCache.delete(petName);
        return null;
      });
    layoutCache.set(petName, cached);
  }
  return cached;
}

function normalizePetLayout(layout: RawPetLayout): PetLayout {
  const talking = Array.isArray(layout.talking)
    ? { labels: layout.talking }
    : {
        labels: layout.talking?.labels ?? [],
        smile_labels: layout.talking?.smile_labels,
        sharp_labels: layout.talking?.sharp_labels,
        thinking_labels: layout.talking?.thinking_labels,
      };
  return { ...layout, talking };
}

export function appendBuddyLog(payload: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({
    timestampMs: Date.now(),
    source: "sprite-skin",
    ...payload,
  });
  return invoke<void>("append_buddy_log", { line }).catch(() => {});
}
