import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getSavepointStorageSettings,
  type SavepointStorageSettings,
} from "../../../lib/ipc";
import { onlineStrings } from "../../online/onlineStrings";
import { dialogButtonStyle, sectionHeadingStyle } from "../tabStyles";

interface SavepointsTabProps {
  onOpen: () => void;
}

const saveMethods = [
  [onlineStrings.settingsStepCurrent, onlineStrings.settingsStepCurrentDescription],
  [onlineStrings.settingsStepFinal, onlineStrings.settingsStepFinalDescription],
] as const;

export function SavepointsTab({ onOpen }: SavepointsTabProps) {
  const [storageSettings, setStorageSettings] = useState<SavepointStorageSettings | null>(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageLoadError, setStorageLoadError] = useState(false);

  useEffect(() => {
    let mounted = true;
    getSavepointStorageSettings()
      .then((settings) => {
        if (!mounted) return;
        setStorageSettings(settings);
      })
      .catch((error) => {
        console.error("Failed to load savepoint storage settings", error);
        if (!mounted) return;
        setStorageLoadError(true);
      })
      .finally(() => {
        if (mounted) setStorageLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const currentDirectory = storageSettings?.directory;
  const currentStatus = storageLoading
    ? onlineStrings.settingsStorageLoading
    : storageLoadError
      ? onlineStrings.settingsStorageUnknown
      : storageSettings?.directory_exists
        ? onlineStrings.settingsStorageConfigured
        : onlineStrings.settingsStorageReadyOnFirstSave;
  const currentStatusColor =
    storageLoadError ? "var(--cmux-red)" : "var(--cmux-accent)";
  // Same status, read as text rather than painted as the status dot.
  const currentStatusTextColor =
    storageLoadError ? "var(--cmux-red)" : "var(--cmux-accent-text)";

  return (
    <div>
      <div style={sectionHeadingStyle}>{onlineStrings.settingsHeading}</div>
      <p
        style={{
          maxWidth: "min(900px, 100%)",
          margin: "0 0 22px",
          color: "var(--cmux-text-secondary)",
          fontSize: 12,
          lineHeight: 1.75,
        }}
      >
        {onlineStrings.settingsDescription}
      </p>

      <section
        aria-labelledby="savepoint-storage-heading"
        style={{
          marginBottom: 22,
          paddingBottom: 22,
          borderBottom: "1px solid var(--cmux-border)",
        }}
      >
        <div
          id="savepoint-storage-heading"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          <FolderOpen size={15} strokeWidth={1.7} aria-hidden="true" />
          {onlineStrings.settingsStorageHeading}
        </div>
        <p
          style={{
            margin: "0 0 6px",
            color: "var(--cmux-text-secondary)",
            fontSize: 11,
            lineHeight: 1.7,
          }}
        >
          {onlineStrings.settingsStorageDescription}
        </p>
        <p
          style={{
            margin: "0 0 14px",
            color: "var(--cmux-text-dim)",
            fontSize: 11,
            lineHeight: 1.7,
          }}
        >
          {onlineStrings.settingsStorageSyncHint}
        </p>

        <div style={{ marginBottom: 7, color: "var(--cmux-text-dim)", fontSize: 11 }}>
          {onlineStrings.settingsStorageCurrentLabel}
        </div>
        <div
          style={{
            marginBottom: 12,
            padding: "10px 11px",
            border: "1px solid var(--cmux-border)",
            borderRadius: 6,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              marginBottom: currentDirectory ? 7 : 0,
              color: currentStatusTextColor,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                flex: "0 0 auto",
                borderRadius: "50%",
                background: currentStatusColor,
              }}
            />
            {currentStatus}
          </div>
          {currentDirectory && (
            <code
              title={currentDirectory}
              style={{
                display: "block",
                color: "var(--cmux-text)",
                fontFamily: "Menlo, Consolas, monospace",
                fontSize: 11,
                lineHeight: 1.6,
                overflowWrap: "anywhere",
              }}
            >
              {currentDirectory}
            </code>
          )}
        </div>

        {storageSettings?.legacy_directory && (
          <div
            style={{
              marginTop: 14,
              padding: "2px 0 2px 12px",
              borderLeft: "2px solid var(--cmux-border)",
            }}
          >
            <div
              style={{
                marginBottom: 6,
                color: "var(--cmux-text-secondary)",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {onlineStrings.settingsLegacyStorageLabel}
            </div>
            <code
              title={storageSettings.legacy_directory}
              style={{
                display: "block",
                marginBottom: 7,
                color: "var(--cmux-text)",
                fontFamily: "Menlo, Consolas, monospace",
                fontSize: 11,
                lineHeight: 1.6,
                overflowWrap: "anywhere",
              }}
            >
              {storageSettings.legacy_directory}
            </code>
            <div
              style={{
                color: "var(--cmux-text-dim)",
                fontSize: 11,
                lineHeight: 1.7,
              }}
            >
              {onlineStrings.settingsLegacyStorageNote}
            </div>
          </div>
        )}

        <div
          style={{
            marginTop: 14,
            color: "var(--cmux-text-dim)",
            fontSize: 11,
            lineHeight: 1.7,
          }}
        >
          <div>{onlineStrings.settingsStorageMoveNote}</div>
          <div>{onlineStrings.settingsStorageScopeNote}</div>
        </div>

      </section>

      <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 700 }}>
        {onlineStrings.settingsSaveHeading}
      </div>
      <ul
        aria-label={onlineStrings.settingsSaveMethodsAriaLabel}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(240px, 100%), 1fr))",
          gap: 18,
          margin: "0 0 18px",
          padding: 0,
          listStyle: "none",
        }}
      >
        {saveMethods.map(([title, description]) => (
          <li
            key={title}
            style={{
              minWidth: 0,
              borderTop: "2px solid var(--cmux-accent)",
              paddingTop: 10,
            }}
          >
            <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700 }}>{title}</div>
            <div style={{ color: "var(--cmux-text-secondary)", fontSize: 11, lineHeight: 1.65 }}>
              {description}
            </div>
          </li>
        ))}
      </ul>

      <div
        style={{
          marginBottom: 18,
          paddingTop: 12,
          borderTop: "1px solid var(--cmux-border)",
        }}
      >
        <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700 }}>
          {onlineStrings.settingsStepResume}
        </div>
        <div style={{ color: "var(--cmux-text-secondary)", fontSize: 11, lineHeight: 1.65 }}>
          {onlineStrings.settingsStepResumeDescription}
        </div>
      </div>

      <div
        style={{
          marginBottom: 18,
          padding: "10px 12px",
          borderLeft: "2px solid var(--cmux-border)",
          color: "var(--cmux-text-dim)",
          fontSize: 11,
          lineHeight: 1.65,
        }}
      >
        {onlineStrings.settingsSeparationNote}
      </div>

      <button
        type="button"
        onClick={onOpen}
        style={{
          ...dialogButtonStyle,
          borderColor: "var(--cmux-accent)",
          color: "var(--cmux-accent-text)",
          fontWeight: 700,
          padding: "8px 12px",
          maxWidth: "100%",
          whiteSpace: "normal",
          lineHeight: 1.5,
        }}
      >
        {onlineStrings.openPanelLabel}
      </button>
    </div>
  );
}
