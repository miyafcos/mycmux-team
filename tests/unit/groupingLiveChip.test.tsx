// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tabGroupingStrings } from "../../src/components/dashboard/dashboardStrings";
import { GroupingLiveChipBadge } from "../../src/components/layout/GroupingLiveChip";
import { formatLastOutputAgeCompact } from "../../src/components/layout/tabSweep";
import { usePaneMetadataStore } from "../../src/stores/paneMetadataStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-08-27T04:00:00.000Z");
let container: HTMLDivElement;
let root: Root;

function renderBadge(options: {
  attentionCategory?: "waiting" | "error" | "done" | null;
  declared?: boolean;
} = {}) {
  act(() => {
    root.render(
      <GroupingLiveChipBadge
        sessionId="session-target"
        declared={options.declared ?? false}
        attentionCategory={options.attentionCategory ?? null}
        tabAgentKind="codex"
        now={NOW}
      />,
    );
  });
}

function liveBadge(): HTMLElement {
  const badge = container.querySelector<HTMLElement>(".cmux-tab-grouping-live");
  if (!badge) throw new Error("live badge not found");
  return badge;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  usePaneMetadataStore.setState({ metadata: {}, volatileMetadata: {} });
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("GroupingLiveChipBadge", () => {
  it("uses the production display-status inputs and precedence", () => {
    usePaneMetadataStore.setState({
      metadata: { "session-target": { processIsShell: false, agentStatus: "working" } },
      volatileMetadata: { "session-target": { outputActive: true } },
    });
    renderBadge();
    expect(liveBadge().dataset.status).toBe("working");

    act(() => usePaneMetadataStore.setState({ volatileMetadata: {} }));
    expect(liveBadge().dataset.status).toBe("idle");

    act(() => usePaneMetadataStore.setState({
      volatileMetadata: { "session-target": { backendLastOutputAt: NOW - 15_001 } },
    }));
    expect(liveBadge().dataset.status).toBe("idle");

    act(() => usePaneMetadataStore.setState({
      metadata: { "session-target": { processIsShell: false, agentStatus: "waiting" } },
      volatileMetadata: {},
    }));
    expect(liveBadge().dataset.status).toBe("waiting");

    renderBadge({ attentionCategory: "error" });
    expect(liveBadge().dataset.status).toBe("error");
  });

  it("does not treat metadata agentStatus working as production working", () => {
    usePaneMetadataStore.setState({
      metadata: { "session-target": { agentStatus: "working" } },
      volatileMetadata: {},
    });
    renderBadge();
    expect(liveBadge().dataset.status).toBe("idle");
  });

  it("uses volatile last-output time before metadata and updates its compact age", () => {
    const volatileTime = NOW - 2 * 60_000;
    usePaneMetadataStore.setState({
      metadata: {
        "session-target": {
          processIsShell: false,
          backendLastOutputAt: NOW - 60 * 60_000,
        },
      },
      volatileMetadata: {
        "session-target": { outputActive: true, backendLastOutputAt: volatileTime },
      },
    });
    renderBadge();

    const expectedAge = formatLastOutputAgeCompact(volatileTime, NOW);
    expect(container.querySelector(".cmux-tab-grouping-live-age")?.textContent).toBe(expectedAge);

    act(() => usePaneMetadataStore.setState((state) => ({
      metadata: {
        ...state.metadata,
        "session-target": {
          ...state.metadata["session-target"],
          backendLastOutputAt: NOW - 3 * 60 * 60_000,
        },
      },
    })));
    expect(container.querySelector(".cmux-tab-grouping-live-age")?.textContent).toBe(expectedAge);
    expect(liveBadge().getAttribute("aria-label")).toBe(
      tabGroupingStrings.liveChipAriaDescription(tabGroupingStrings.liveStatusWorking, expectedAge),
    );
  });
});
