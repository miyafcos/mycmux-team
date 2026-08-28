export * from "../../../src/components/layout/tabGroupingEngine";

export async function loadGroupingInternalsForTests() {
  const engine = await import("../../../src/components/layout/tabGroupingEngine");
  const grouping = await import("../../../src/components/layout/tabGrouping");
  const adapter = await import("../../../src/components/layout/groupingStoreAdapter");
  const runtime = await import("../../../src/stores/groupingRuntimeStore");
  const workspaceStore = await import("../../../src/stores/workspaceListStore");
  const uiStore = await import("../../../src/stores/uiStore");
  const persistence = await import("../../../src/lib/workspacePersistenceCoordinator");
  return { engine, grouping, adapter, runtime, workspaceStore, uiStore, persistence };
}
