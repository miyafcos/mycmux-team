import { listPets } from "./ipc";
import { candidatesFromListedPets } from "./pets";
import { usePetSettingsStore } from "../stores/petSettingsStore";

/** Load external atlases only after display has been enabled. */
export async function loadPetCatalog(): Promise<void> {
  if (usePetSettingsStore.getState().petDisplayMode === "none") return;
  try {
    const listed = await listPets();
    if (usePetSettingsStore.getState().petDisplayMode === "none") return;
    usePetSettingsStore.getState().setPets(candidatesFromListedPets(listed).candidates);
  } catch (error) {
    console.warn("[pets] Failed to load pet catalog:", error);
  }
}
