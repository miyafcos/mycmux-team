import type { AskStripItem } from "./askStripModel";
import { dashboardStrings } from "./dashboardStrings";

export function AskStrip({ items, onSelect }: { items: readonly AskStripItem[]; onSelect: (item: AskStripItem) => void }) {
  return <section aria-label={dashboardStrings.askStripAriaLabel} className="cmux-dashboard-askstrip" hidden={items.length === 0}>
    <strong className="cmux-dashboard-askstrip-label">{dashboardStrings.askStripTitle}</strong>
    {items.map((item) => <button key={item.tabId} type="button" title={item.prompt} className="cmux-dashboard-askchip" onClick={() => onSelect(item)}>
      <strong>{item.label}</strong><span>{item.prompt}</span>
    </button>)}
  </section>;
}
