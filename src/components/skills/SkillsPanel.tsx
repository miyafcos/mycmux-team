import { OverlayShell } from "../common/OverlayShell";
import { SkillsView, type SkillsViewProps } from "./SkillsView";
import { skillsStrings as s } from "./skillsStrings";

export interface SkillsPanelProps extends SkillsViewProps {
  open: boolean;
  closing?: boolean;
}

/** The title-bar overlay frame. SkillsView can also be embedded directly. */
export function SkillsPanel({ open, closing = false, ...view }: SkillsPanelProps) {
  return <OverlayShell open={open} closing={closing} onClose={view.onClose}
    size="full" ariaLabel={s.title} id="skills-panel">
    <SkillsView {...view} />
  </OverlayShell>;
}
