import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getTabAccountEvidence, type TabAccountEvidence } from "../../lib/ipc";

/** Read on mount, PTY-ready notification and explicit rechecks, including from another window. */
export function useTabAccountEvidence(sessionId?: string, accountId?: string) {
  const [state, setState] = useState<{ evidence: TabAccountEvidence | null; failed: boolean }>({ evidence: null, failed: false });
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!sessionId || accountId === undefined) return;
    const version = ++request.current;
    try {
      const evidence = await getTabAccountEvidence(sessionId);
      if (request.current === version) setState({ evidence: evidence ?? null, failed: false });
    } catch {
      if (request.current === version) setState(current => ({ ...current, failed: true }));
    }
  }, [sessionId, accountId]);
  const accept = useCallback((evidence: TabAccountEvidence | null) => {
    request.current += 1;
    setState({ evidence, failed: false });
  }, []);
  useEffect(() => {
    setState({ evidence: null, failed: false });
    if (!sessionId || accountId === undefined) return;
    let active = true;
    const unlisten = listen<{ profile_id: string }>("tab-account-evidence-updated", event => {
      if (active && event.payload.profile_id === accountId) void refresh();
    }).catch(() => () => {});
    // Subscribe before the first read: a PTY can finish starting while this badge mounts.
    void unlisten.then(() => { if (active) void refresh(); });
    return () => {
      active = false;
      request.current += 1;
      void unlisten.then(stop => stop());
    };
  }, [sessionId, accountId, refresh]);
  return { ...state, refresh, accept };
}
