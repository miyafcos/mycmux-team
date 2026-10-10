// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PetTab } from "../../src/components/settings/tabs/PetTab";
import { loadPetCatalog } from "../../src/lib/petCatalog";
import { listPets, listQuarantinedPets } from "../../src/lib/ipc";
import { bundledPet, candidatesFromListedPets, type ListedPet } from "../../src/lib/pets";
import { usePetSettingsStore } from "../../src/stores/petSettingsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { petSettingsStrings } from "../../src/components/settings/settingsStrings";

vi.mock("../../src/lib/ipc", () => ({
  listPets: vi.fn(),
  listQuarantinedPets: vi.fn(),
  quarantinePet: vi.fn(),
  restorePet: vi.fn(),
}));
vi.mock("../../src/components/settings/tabs/PetGallerySection", () => ({
  PetGallerySection: () => createElement("div", { "data-testid": "pet-gallery" }),
}));

const external: ListedPet = {
  id: "external:test", name: "Test", source: "external", valid: true,
  atlas_b64: "dGVzdA==", atlas_width: 1536, atlas_height: 1872,
  rows: 9, folder: "test",
};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceListStore.setState(useWorkspaceListStore.getInitialState(), true);
  usePetSettingsStore.setState(usePetSettingsStore.getInitialState(), true);
  vi.mocked(listPets).mockResolvedValue([external]);
  vi.mocked(listQuarantinedPets).mockResolvedValue([]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  useWorkspaceListStore.setState(useWorkspaceListStore.getInitialState(), true);
  vi.unstubAllGlobals();
});

describe("pet display opt-in", () => {
  it("defaults new and missing settings to off and keeps clawd", () => {
    expect(usePetSettingsStore.getState().petDisplayMode).toBe("none");
    expect(usePetSettingsStore.getState().pets).toEqual([bundledPet]);
    usePetSettingsStore.getState().setPetDisplayMode("ws");
    usePetSettingsStore.getState().hydratePetSettings({});
    expect(usePetSettingsStore.getState().petDisplayMode).toBe("none");
  });
  it.each(["ws", "both", "none"] as const)("preserves saved %s", (petDisplayMode) => {
    usePetSettingsStore.getState().hydratePetSettings({ petDisplayMode });
    expect(usePetSettingsStore.getState().petDisplayMode).toBe(petDisplayMode);
  });
  it("does not read external atlases at startup while off", async () => {
    await loadPetCatalog();
    expect(listPets).not.toHaveBeenCalled();
    expect(usePetSettingsStore.getState().pets).toEqual([bundledPet]);
  });
  it.each(["ws", "both"] as const)("loads external atlases for saved %s", async (petDisplayMode) => {
    usePetSettingsStore.getState().hydratePetSettings({ petDisplayMode });
    await loadPetCatalog();
    expect(listPets).toHaveBeenCalledOnce();
    expect(usePetSettingsStore.getState().pets.map((pet) => pet.source)).toEqual(["bundled", "external"]);
  });
  it("does not apply an atlas that arrives after display is disabled", async () => {
    let resolve!: (pets: ListedPet[]) => void;
    vi.mocked(listPets).mockReturnValue(new Promise((done) => { resolve = done; }));
    usePetSettingsStore.getState().setPetDisplayMode("ws");
    const pending = loadPetCatalog();
    usePetSettingsStore.getState().setPetDisplayMode("none");
    resolve([external]);
    await pending;
    expect(usePetSettingsStore.getState().pets).toEqual([bundledPet]);
  });
  it("does not let an older catalog remove a newly installed workspace pet", async () => {
    let resolve!: (pets: ListedPet[]) => void;
    vi.mocked(listPets).mockReturnValue(new Promise((done) => { resolve = done; }));
    usePetSettingsStore.getState().setPetDisplayMode("ws");
    const pending = loadPetCatalog();
    usePetSettingsStore.getState().setPets(candidatesFromListedPets([external]).candidates);
    const workspace = useWorkspaceListStore.getState().createWorkspace("Saved", "1x1", [], [], { pet: external.id, activate: false });
    resolve([]);
    await pending;
    expect(usePetSettingsStore.getState().pets.map((pet) => pet.id)).toContain(external.id);
    expect(useWorkspaceListStore.getState().getWorkspace(workspace.id)?.pet).toBe(external.id);
  });
  it("offers the non-repeating default and the legacy random rollback in settings", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    usePetSettingsStore.getState().setPetDisplayMode("ws");
    try {
      await act(async () => root.render(createElement(PetTab)));
      const radios = container.querySelectorAll<HTMLInputElement>('input[name="pet-new-workspace"]');
      expect(radios).toHaveLength(3);
      expect(radios[0].checked).toBe(true);
      expect(container.textContent).toContain(petSettingsStrings.newWsRandom);
      expect(container.textContent).toContain(petSettingsStrings.newWsRandomRepeat);
      await act(async () => radios[1].click());
      expect(usePetSettingsStore.getState().petNewWorkspaceMode).toBe("random-repeat");
      expect(radios[1].checked).toBe(true);
      expect(container.textContent).not.toContain(petSettingsStrings.newWsRandomHint);
      await act(async () => radios[0].click());
      expect(usePetSettingsStore.getState().petNewWorkspaceMode).toBe("random");
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("opens settings without scanning or showing external pets; opt-in loads them", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(PetTab)));
      const radios = container.querySelectorAll<HTMLInputElement>('input[name="pet-display"]');
      expect(radios[0].checked).toBe(true);
      expect(listPets).not.toHaveBeenCalled();
      expect(listQuarantinedPets).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="pet-gallery"]')).toBeNull();
      await act(async () => radios[1].click());
      expect(listPets).toHaveBeenCalled();
      expect(usePetSettingsStore.getState().pets.some((pet) => pet.source === "external")).toBe(true);
      expect(container.querySelector('[data-testid="pet-gallery"]')).not.toBeNull();
      await act(async () => radios[0].click());
      expect(container.querySelector('[data-testid="pet-gallery"]')).toBeNull();
      expect(container.textContent).not.toContain("Test");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
