import { dashboardStrings } from "./dashboardStrings";
import { AttentionCards, type AttentionCardActions } from "./AttentionCards";

export function ReportInbox({
  attentionActions,
}: {
  attentionActions: AttentionCardActions;
}) {
  return <div className="cmux-report-inbox" aria-label={dashboardStrings.reportInboxTitle}>
    <AttentionCards {...attentionActions} />
  </div>;
}
