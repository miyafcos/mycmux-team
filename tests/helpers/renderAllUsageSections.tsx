import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageView } from "../../src/components/ailog/UsageView";
import { useAilogStore, type AilogSection } from "../../src/stores/ailogStore";

type Props = ComponentProps<typeof UsageView>;

/** Snapshot each real tab separately, then retain a single copy of each report.
 * This tests report failure/data contracts without pretending all tabs are visible together. */
export function renderAllUsageSections(props: Props): string {
  const saved = useAilogStore.getState();
  const initial = useAilogStore.getInitialState();
  const initialSection = initial.activeSection, initialAxis = initial.breakdownAxis;
  const draw = (section: AilogSection, axis = "usage") => {
    const selection = { activeSection: section, breakdownAxis: axis as typeof saved.breakdownAxis };
    useAilogStore.setState(selection);
    // Zustand's server snapshot intentionally uses its initial object.
    Object.assign(initial, selection);
    return renderToStaticMarkup(<UsageView {...props} />);
  };
  const take = (html: string, id: string) => new DOMParser().parseFromString(html, "text/html").querySelector("#" + id)?.outerHTML ?? "";
  try {
    let html = draw("breakdown");
    html += take(draw("breakdown", props.breakdownDimension), "ailog-projects");
    html += take(draw("breakdown", "work"), "ailog-purpose");
    for (const [section, id] of [["comparison", "ailog-cross"], ["sessions", "ailog-sessions"], ["rework", "ailog-learning"], ["handoffs", "ailog-handoffs"], ["activity", "ailog-activity"]] as const) html += take(draw(section), id);
    return html;
  } finally {
    useAilogStore.setState({ activeSection: saved.activeSection, breakdownAxis: saved.breakdownAxis });
    Object.assign(initial, { activeSection: initialSection, breakdownAxis: initialAxis });
  }
}

export function selectUsageSection(id: string, props: Props): void {
  const section: AilogSection = id === "ailog-sessions" ? "sessions" : id === "ailog-cross" ? "comparison" : id === "ailog-learning" ? "rework" : id === "ailog-handoffs" ? "handoffs" : id === "ailog-activity" ? "activity" : "breakdown";
  useAilogStore.setState({ activeSection: section, breakdownAxis: id === "ailog-purpose" ? "work" : id === "ailog-projects" ? props.breakdownDimension : "usage" });
}
