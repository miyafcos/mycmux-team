import { invoke } from "@tauri-apps/api/core";
import { checkForUpdateAvailability, type UpdateSource } from "./forcedAutoUpdater";
import { hasWindowRole, subscribeWindowRole } from "./windowContext";

const STARTUP_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 60 * 60_000;

export function startAutomaticUpdateChecks(): () => void {
  if (import.meta.env.DEV) return () => {};
  let disposed = false;
  let generation = 0;
  let stopSchedule = () => {};

  const followRole = () => {
    const current = ++generation;
    stopSchedule();
    stopSchedule = () => {};
    if (!hasWindowRole()) return;
    void invoke<string | null>("get_test_profile").then((profile) => {
      if (disposed || current !== generation || !hasWindowRole() || profile !== null) return;
      const discover = (source: UpdateSource) => { void checkForUpdateAvailability({ source }); };
      let interval: ReturnType<typeof setInterval> | undefined;
      let subscribed = false;
      const online = () => discover("online");
      const resume = () => { if (document.visibilityState === "visible") discover("resume"); };
      const startup = setTimeout(() => {
        discover("startup");
        interval = setInterval(() => discover("interval"), CHECK_INTERVAL_MS);
        window.addEventListener("online", online);
        document.addEventListener("visibilitychange", resume);
        subscribed = true;
      }, STARTUP_DELAY_MS);
      stopSchedule = () => {
        clearTimeout(startup);
        if (interval !== undefined) clearInterval(interval);
        if (subscribed) {
          window.removeEventListener("online", online);
          document.removeEventListener("visibilitychange", resume);
          subscribed = false;
        }
      };
    }).catch(() => {});
  };
  const unsubscribe = subscribeWindowRole(followRole);
  followRole();
  return () => {
    disposed = true;
    generation++;
    unsubscribe();
    stopSchedule();
  };
}
