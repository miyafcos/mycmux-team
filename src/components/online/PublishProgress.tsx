import type { PublishSavepointResult, SavepointPublishStage } from "../../lib/ipc";
import { onlineStrings } from "./onlineStrings";

const PUBLISH_STEPS = [
  { stage: "digest", label: onlineStrings.publishStepDigest },
  { stage: "handoff", label: onlineStrings.publishStepHandoff },
  { stage: "bundle", label: onlineStrings.publishStepBundle },
  { stage: "register", label: onlineStrings.publishStepRegister },
] as const;

export function completedPublishStepCount(stage: SavepointPublishStage | null): number {
  if (!stage) return 0;
  if (stage === "done") return PUBLISH_STEPS.length;
  const index = PUBLISH_STEPS.findIndex((step) => step.stage === stage);
  return index < 0 ? 0 : index + 1;
}

export function PublishProgress({
  publishing,
  stage,
  result,
}: {
  publishing: boolean;
  stage: SavepointPublishStage | null;
  result: PublishSavepointResult | null;
}) {
  if (!publishing && !result) return null;

  const completedSteps = completedPublishStepCount(stage);

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--cmux-border)" }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>
        {result ? onlineStrings.publishStepDone : onlineStrings.publishProgressTitle}
      </div>
      {!result && (
        <div style={{ marginTop: 2, fontSize: 11, color: "var(--cmux-text-tertiary)" }}>
          {onlineStrings.publishProgressHint}
        </div>
      )}
      <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
        {PUBLISH_STEPS.map((step, index) => {
          const complete = index < completedSteps;
          return (
            <div
              key={step.stage}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontSize: 11,
                color: complete ? "var(--cmux-text)" : "var(--cmux-text-tertiary)",
              }}
            >
              <span style={{ width: 12, color: complete ? "var(--cmux-accent-text)" : undefined }}>
                {complete ? "✓" : "○"}
              </span>
              <span>{step.label}</span>
            </div>
          );
        })}
      </div>
      {result && (
        <div style={{ display: "grid", gap: 5, marginTop: 9, fontSize: 11 }}>
          <strong>
            {result.record_kind === "final"
              ? onlineStrings.publishResultModeFinal
              : (result.updated ? onlineStrings.publishResultModeUpdate : onlineStrings.publishResultModeNew)}
          </strong>
          <div style={{ color: "var(--cmux-text-secondary)", overflowWrap: "anywhere" }}>
            {onlineStrings.publishResultLocationLabel}: {result.bundle_dir}
          </div>
          <div style={{ color: result.warnings.length > 0 ? "var(--cmux-yellow)" : "var(--cmux-text-secondary)" }}>
            {onlineStrings.warningBadge}: {result.warnings.length}
          </div>
        </div>
      )}
    </div>
  );
}
