import type { Ref } from "react";
import { installAvailableUpdate } from "../../lib/forcedAutoUpdater";
import { useUpdateAvailabilityStore } from "../../stores/updateAvailabilityStore";
import { updateStrings } from "./updateStrings";

export function UpdateConfirmation({ onLater, laterButtonRef }: { onLater?: () => void; laterButtonRef?: Ref<HTMLButtonElement> }) {
  const update = useUpdateAvailabilityStore();
  if (update.state === "none") return null;
  const busy = update.state === "installing" || update.state === "restarting";
  return (
    <div style={{ display: "grid", gap: 12, fontSize: "var(--cmux-font-size-sm)", color: "var(--cmux-text)" }}>
      <h2 style={{ margin: 0, fontSize: "var(--cmux-font-size-md)" }}>{updateStrings.heading}</h2>
      <div>{updateStrings.versions(update.currentVersion, update.version)}</div>
      <div style={{ lineHeight: 1.6 }}>{updateStrings.warning}</div>
      {busy && <div role="status">{update.state === "restarting"
        ? updateStrings.restarting(update.version) : updateStrings.downloading(update.version)}</div>}
      {update.state === "error" && (
        <div role="alert" style={{ color: "var(--cmux-red)" }}>{update.message}</div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => { void installAvailableUpdate(); }}
          disabled={busy}
          style={{
            padding: "6px 10px", fontSize: "var(--cmux-font-size-sm)",
            border: "1px solid var(--cmux-accent)", borderRadius: "var(--cmux-radius-sm)",
            background: "var(--cmux-accent)", color: "var(--cmux-on-accent)",
            cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1,
          }}
        >{updateStrings.install}</button>
        {onLater && (
          <button
            ref={laterButtonRef}
            type="button"
            onClick={onLater}
            style={{
              padding: "6px 10px", fontSize: "var(--cmux-font-size-sm)",
              border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-sm)",
              background: "none", color: "var(--cmux-text)", cursor: "pointer",
            }}
          >{updateStrings.later}</button>
        )}
      </div>
    </div>
  );
}
