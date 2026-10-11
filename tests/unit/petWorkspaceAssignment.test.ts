import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledPet, type PetCandidate } from "../../src/lib/pets";
import { petDefaultsForGrouping, type GroupingGroup } from "../../src/components/layout/tabGrouping";
import { petAssignmentSettings, usePetSettingsStore } from "../../src/stores/petSettingsStore";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import { useUiStore } from "../../src/stores/uiStore";
import { runLayoutTransition } from "../../src/stores/groupingRuntimeStore";
import { workspaceGroupingMutationCapability } from "../../src/stores/workspaceGroupingMutationCapability.internal";
import { petRandomFromSeed, planPetAssignments } from "../../src/lib/petAssignment";

const pet = (id: string): PetCandidate => ({ ...bundledPet, id: `external:${id}`, name: id, source: "external", folder: id });
const pets = [bundledPet, pet("a"), pet("b")];
const ids = pets.map((candidate) => candidate.id);

function create(options?: { pet?: string; restorePet?: boolean; id?: string }) {
  const index = useWorkspaceListStore.getState().workspaces.length;
  const tab = { id: `t${index}`, sessionId: `s${index}`, agentId: "shell", type: "terminal" as const };
  const pane = { id: `p${index}`, sessionId: tab.sessionId, agentId: "shell", tabs: [tab], activeTabId: tab.id };
  return useWorkspaceListStore.getState().createWorkspace(`Workspace ${index}`, "1x1", [pane], [[pane.id]], { activate: false, ...options });
}

beforeEach(() => {
  useWorkspaceListStore.setState(useWorkspaceListStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  usePetSettingsStore.setState(usePetSettingsStore.getInitialState(), true);
  usePetSettingsStore.getState().setPets(pets);
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  useWorkspaceListStore.setState(useWorkspaceListStore.getInitialState(), true);
  usePetSettingsStore.setState(usePetSettingsStore.getInitialState(), true);
  vi.restoreAllMocks();
});

describe("pet workspace assignment", () => {
  it("defaults to random without repeats while keeping display opt-in", () => {
    expect(usePetSettingsStore.getState().petNewWorkspaceMode).toBe("random");
    expect(usePetSettingsStore.getState().petDisplayMode).toBe("none");
    expect([create().pet, create().pet, create().pet]).toEqual(ids);
    expect(usePetSettingsStore.getState().petRandomBag?.remaining).toEqual([]);
  });

  it("keeps every full cycle distinct after the candidate set is used up", () => {
    const picked = Array.from({ length: 9 }, () => create().pet);
    for (let index = 0; index < picked.length; index += 3) expect(new Set(picked.slice(index, index + 3))).toEqual(new Set(ids));
  });

  it("counts manual, choose and fixed assignments in the next random draw", () => {
    create({ pet: "clawd" });
    usePetSettingsStore.getState().setPetNewWorkspaceMode("choose");
    const chosen = create();
    expect(chosen.pet).toBeUndefined();
    useWorkspaceListStore.getState().setWorkspacePet(chosen.id, "external:a");
    usePetSettingsStore.getState().setPetNewWorkspaceMode("random");
    expect(create().pet).toBe("external:b");
    usePetSettingsStore.getState().setPetNewWorkspaceMode("fixed");
    usePetSettingsStore.getState().setPetFixedId("external:a");
    expect(create().pet).toBe("external:a");
  });

  it("returns a deleted assignment to the bag without changing surviving pets", () => {
    const workspaces = [create(), create(), create()];
    useWorkspaceListStore.getState().removeWorkspace(workspaces[1].id);
    expect(create().pet).toBe("external:a");
    expect(useWorkspaceListStore.getState().getWorkspace(workspaces[0].id)?.pet).toBe("clawd");
    expect(useWorkspaceListStore.getState().getWorkspace(workspaces[2].id)?.pet).toBe("external:b");
  });

  it("does not free an assignment while another workspace still uses it", () => {
    const first = create({ pet: "clawd" });
    create({ pet: "clawd" });
    useWorkspaceListStore.getState().removeWorkspace(first.id);
    expect(create().pet).toBe("external:a");
  });

  it("preserves an explicit undefined assignment without spending randomness", () => {
    const saved = structuredClone(usePetSettingsStore.getState().petRandomBag);
    const workspace = create({ pet: undefined, restorePet: true });
    expect(workspace.pet).toBeUndefined();
    expect(Math.random).not.toHaveBeenCalled();
    expect(usePetSettingsStore.getState().petRandomBag).toEqual(saved);
  });

  it("hydrates and restores saved IDs without consuming the saved cycle again", () => {
    const savedWorkspaces = [create(), create(), create(), create()];
    const settings = usePetSettingsStore.getState();
    const saved = JSON.parse(JSON.stringify({ petRandomBag: settings.petRandomBag, petNewWorkspaceMode: settings.petNewWorkspaceMode }));
    useWorkspaceListStore.setState({ workspaces: [], activeWorkspaceId: null });
    settings.hydratePetSettings(saved);
    const before = structuredClone(usePetSettingsStore.getState().petRandomBag);
    vi.mocked(Math.random).mockClear();
    for (const workspace of savedWorkspaces) create({ pet: workspace.pet, id: workspace.id, restorePet: true });
    expect(useWorkspaceListStore.getState().workspaces.map((workspace) => workspace.pet)).toEqual(savedWorkspaces.map((workspace) => workspace.pet));
    expect(usePetSettingsStore.getState().petRandomBag).toEqual(before);
    expect(Math.random).not.toHaveBeenCalled();
    expect(create().pet).toBe("external:a");
  });

  it("does not replace a saved external pet while the startup catalog is partial", () => {
    usePetSettingsStore.setState({ pets: [bundledPet], petCatalogLoaded: false });
    const workspace = create({ pet: "external:a", restorePet: true });
    expect(workspace.pet).toBe("external:a");
    usePetSettingsStore.getState().setPets(pets);
    expect(useWorkspaceListStore.getState().getWorkspace(workspace.id)?.pet).toBe("external:a");
    expect(Math.random).not.toHaveBeenCalled();
  });

  it("draws a replacement only after the external catalog confirms a missing ID", () => {
    const existing = create({ pet: "external:a", restorePet: true });
    const unchanged = create({ pet: "clawd", restorePet: true });
    usePetSettingsStore.getState().setPets([bundledPet, pet("b")]);
    expect(useWorkspaceListStore.getState().getWorkspace(existing.id)?.pet).toBe("external:b");
    expect(useWorkspaceListStore.getState().getWorkspace(unchanged.id)?.pet).toBe("clawd");
    expect(usePetSettingsStore.getState().petRandomBag?.candidates).not.toContain("external:a");
  });

  it("repairs a missing restored pet when the catalog is already loaded", () => {
    create({ pet: "clawd" });
    expect(create({ pet: "external:missing", restorePet: true }).pet).toBe("external:a");
  });

  it("keeps existing disabled choices but excludes them from new draws", () => {
    const existing = create({ pet: "external:a" });
    usePetSettingsStore.getState().setPetDisabled(["external:a"]);
    expect(useWorkspaceListStore.getState().getWorkspace(existing.id)?.pet).toBe("external:a");
    expect(new Set([create().pet, create().pet])).toEqual(new Set(["clawd", "external:b"]));
  });

  it("adds a new external candidate without rerolling existing workspaces", () => {
    const existing = [create(), create(), create()];
    usePetSettingsStore.getState().setPets([...pets, pet("new")]);
    expect(create().pet).toBe("external:new");
    expect(existing.map((workspace) => useWorkspaceListStore.getState().getWorkspace(workspace.id)?.pet)).toEqual(ids);
  });

  it("rerolls from unused alternatives and releases the old choice", () => {
    const first = create(); create();
    useWorkspaceListStore.getState().rerollWorkspacePet(first.id);
    expect(useWorkspaceListStore.getState().getWorkspace(first.id)?.pet).toBe("external:b");
    expect(create().pet).toBe("clawd");
  });

  it("restores the legacy random mode through settings", () => {
    usePetSettingsStore.getState().hydratePetSettings({ petNewWorkspaceMode: "random-repeat" });
    expect([create().pet, create().pet]).toEqual(["clawd", "clawd"]);
  });

  it("uses cached candidate IDs while off without requiring external atlases", () => {
    usePetSettingsStore.setState(usePetSettingsStore.getInitialState(), true);
    usePetSettingsStore.getState().hydratePetSettings({
      petDisabled: ["clawd"], petRandomBag: { version: 1, candidates: ["clawd", "external:a"], remaining: ["external:a"] },
    });
    expect(usePetSettingsStore.getState().petDisplayMode).toBe("none");
    expect(usePetSettingsStore.getState().pets).toEqual([bundledPet]);
    expect(create().pet).toBe("external:a");
  });

  it("plans multiple new grouping workspaces without consuming the live bag", () => {
    create({ pet: "clawd" });
    const groups = ["g1", "g2"].map((groupId): GroupingGroup => ({
      groupId, title: groupId, disposition: "reorganize", destination: { kind: "new_workspace", proposedName: groupId },
      layout: null, tabIds: [], adopted: true,
    }));
    const state = petAssignmentSettings();
    const saved = structuredClone(state.bag);
    const defaults = petDefaultsForGrouping(groups, useWorkspaceListStore.getState().workspaces, state, "group-seed");
    expect(new Set(Object.values(defaults).map((value) => value.pet))).toEqual(new Set(["external:a", "external:b"]));
    expect(petDefaultsForGrouping(groups, useWorkspaceListStore.getState().workspaces, state, "group-seed")).toEqual(defaults);
    expect(usePetSettingsStore.getState().petRandomBag).toEqual(saved);
  });

  it("records a committed batch across exhaustion without losing the last partial cycle", () => {
    const existing = [create(), create(), create()];
    const state = petAssignmentSettings();
    const keys = ["new1", "new2", "new3", "new4"];
    const plan = planPetAssignments(state, existing.map((workspace) => workspace.pet), keys, petRandomFromSeed("batch-seed"));
    const generated = keys.map((id) => ({ ...existing[0], id, name: id, pet: plan.pets[id], panes: [] }));
    runLayoutTransition("grouping-commit", () => useWorkspaceListStore.getState()._replaceWorkspaces([...existing, ...generated], "grouping-commit", workspaceGroupingMutationCapability));
    expect(usePetSettingsStore.getState().petRandomBag).toEqual(plan.bag);
    expect(usePetSettingsStore.getState().petRandomBag?.remaining).toHaveLength(2);
  });
});
