import { MessageCircleQuestion } from "lucide-react";
import { DashboardCount } from "./DashboardUi";
import type { AskStripItem } from "./askStripModel";
import { dashboardStrings } from "./dashboardStrings";

export function AskStrip({ items, onSelect }: { items: readonly AskStripItem[]; onSelect: (item: AskStripItem) => void }) {
  return <section aria-label={dashboardStrings.askStripAriaLabel} className="cmux-dashboard-askstrip" hidden={items.length === 0}>
    <DashboardCount icon={MessageCircleQuestion} count={items.length} label={dashboardStrings.askStripAriaLabel} />
    {items.map((item) => <button key={item.tabId} type="button" aria-label={`${item.label} · ${item.prompt}`} title={item.prompt} className="cmux-dashboard-askchip" onClick={() => onSelect(item)}>
      <strong>{item.label}</strong><span>{item.prompt}</span>
    </button>)}
  </section>;
}
