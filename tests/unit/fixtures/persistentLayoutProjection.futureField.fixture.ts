import "../../../src/lib/persistentLayoutProjection";

declare module "../../../src/types/workspace" {
  interface Workspace {
    __fixtureWorkspacePersistent?: string;
  }

  interface Pane {
    __fixturePanePersistent?: string;
  }

  interface PaneTab {
    __fixtureTabPersistent?: string;
  }
}

export {};
