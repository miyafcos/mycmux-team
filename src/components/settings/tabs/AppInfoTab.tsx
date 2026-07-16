import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useToastStore } from "../../../stores/toastStore";
import { runUpdateCheck, type UpdatePhase } from "../../../lib/forcedAutoUpdater";
import { dialogButtonStyle, sectionHeadingStyle } from "../tabStyles";

type UpdateStatus = "idle" | "checking" | "latest" | "downloading" | "ready" | "error";

function toSettingsUpdateStatus(phase: UpdatePhase): UpdateStatus {
  return phase === "skipped" ? "latest" : phase;
}

// Ported from SettingsMenu.tsx: current version display + manual update check.
export function AppInfoTab() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateMsg, setUpdateMsg] = useState<string>("");
  const [currentVersion, setCurrentVersion] = useState<string>("読み込み中…");

  useEffect(() => {
    let cancelled = false;

    getVersion()
      .then((version) => {
        if (!cancelled) {
          setCurrentVersion(`v${version}`);
        }
      })
      .catch((e) => {
        console.error("Failed to load app version", e);
        if (!cancelled) {
          setCurrentVersion("不明");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheckUpdate = async () => {
    await runUpdateCheck({
      source: "manual",
      force: true,
      onStatus: (status) => {
        setUpdateStatus(toSettingsUpdateStatus(status.phase));
        setUpdateMsg(status.message);
        if (status.phase === "error") {
          useToastStore.getState().pushToast("Update check failed", "error");
        }
      },
    });
  };

  const checking = updateStatus === "checking" || updateStatus === "downloading";

  return (
    <div>
      <div style={sectionHeadingStyle}>アプリ情報</div>
      <div style={{ fontSize: 12, color: "var(--cmux-text)", marginBottom: 14 }}>
        現在のバージョン: {currentVersion}
      </div>

      <button
        onClick={handleCheckUpdate}
        disabled={checking}
        style={{
          ...dialogButtonStyle,
          opacity: checking ? 0.5 : 1,
          cursor: checking ? "wait" : "pointer",
        }}
      >
        更新を確認
      </button>
      {updateMsg && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: updateStatus === "error" ? "var(--cmux-red)" : "var(--cmux-text-dim)",
          }}
        >
          {updateMsg}
        </div>
      )}
    </div>
  );
}
