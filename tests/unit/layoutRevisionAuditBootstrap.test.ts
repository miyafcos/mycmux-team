import { afterEach, describe, expect, it } from "vitest";

import {
  __resetLayoutRevisionAuditBootstrapForTests,
  initializeLayoutRevisionAudit,
} from "../../src/lib/layoutRevisionAuditBootstrap";
import { useWorkspaceListStore } from "../../src/stores/workspaceListStore";
import type { Workspace } from "../../src/types";

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    gridTemplateId: "1x1",
    status: "running",
    createdAt: 1,
    pet: "clawd",
    panes: [],
    splitColumns: [],
  };
}

afterEach(() => __resetLayoutRevisionAuditBootstrapForTests());

describe("layout revision audit bootstrap", () => {
  it("installs once, cleans up idempotently for HMR, and can install again", () => {
    __resetLayoutRevisionAuditBootstrapForTests();
    useWorkspaceListStore.setState({ workspaces: [], layoutRevision: 0 });
    const violations: string[] = [];
    const onViolation = (message: string) => violations.push(message);
    const first = initializeLayoutRevisionAudit({ onViolation });
    const second = initializeLayoutRevisionAudit({ onViolation });
    expect(second).toBe(first);

    useWorkspaceListStore.setState({
      workspaces: [workspace("bypass")],
    });
    expect(violations).toHaveLength(1);
    first();
    second();
    useWorkspaceListStore.setState({ workspaces: [] });
    expect(violations).toHaveLength(1);

    initializeLayoutRevisionAudit({ onViolation });
    useWorkspaceListStore.setState({ workspaces: [workspace("again")] });
    expect(violations).toHaveLength(2);
  });
});
