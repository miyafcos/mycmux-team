import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useToastStore } from "../../../stores/toastStore";
import { runUpdateCheck, type UpdatePhase } from "../../../lib/forcedAutoUpdater";
import { isMainWindow } from "../../../lib/windowContext";
import { invoke } from "@tauri-apps/api/core";
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
  const [testProfile, setTestProfile] = useState<string | null | undefined>(undefined);

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
    void invoke<string | null>("get_test_profile").then(setTestProfile).catch(() => {});

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
  // Multi-window (Phase 3a): the updater relaunches the whole process after
  // installing, so it must run from exactly one window. Main owns it; child
  // windows only show the version.
  const canCheckForUpdates = isMainWindow() && testProfile === null;

  return (
    <div>
      <div style={sectionHeadingStyle}>アプリ情報</div>
      <div style={{ fontSize: 12, color: "var(--cmux-text)", marginBottom: 14 }}>
        現在のバージョン: {currentVersion}
      </div>

      {!canCheckForUpdates && (
        <div style={{ fontSize: 11, color: "var(--cmux-text-dim)" }}>
          {testProfile ? "TEST モードでは更新を無効化しています。" : "更新の確認はメインウィンドウから行ってください。"}
        </div>
      )}

      {canCheckForUpdates && (
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
      )}
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
