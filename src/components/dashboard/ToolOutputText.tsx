import { useMemo } from "react";
import { tidyToolOutput } from "../../lib/toolOutputTidy";
import { DashboardLinkedText, type DashboardLinkContext } from "./DashboardLinkedText";
import { dashboardStrings } from "./dashboardStrings";
import "./ToolOutputText.css";

export function ToolOutputNote() {
  return <div className="cmux-tool-output-note" role="note">{dashboardStrings.toolOutputEncodingNote}</div>;
}

export function ToolOutputText({ text, context = null }: { text: string; context?: DashboardLinkContext | null }) {
  const output = useMemo(() => tidyToolOutput(text), [text]);
  return <>
    {output.lossy ? <ToolOutputNote /> : null}
    <DashboardLinkedText text={output.text} context={context} />
  </>;
}
