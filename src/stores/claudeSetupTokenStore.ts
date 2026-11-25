import { create } from "zustand";
import { open } from "@tauri-apps/plugin-shell";
import {
  startClaudeSetupToken, submitClaudeSetupCode, cancelClaudeSetupToken, getClaudeSetupTokenState,
  onClaudeSetupToken, type ClaudeSetupTokenEvent,
} from "../lib/ipc";

const rank = {
  starting: 0, waiting_browser: 1, code_available: 2, confirming: 3, checking_owner: 4,
  saved: 5, mismatch: 5, failed: 5, cancelled: 5, timeout: 5,
} as const;

export function isSetupTokenActive(event: ClaudeSetupTokenEvent | null): boolean {
  return event !== null && rank[event.state] < rank.saved;
}

const approvalOrigins = new Set([
  "https://claude.ai", "https://claude.com", "https://platform.claude.com", "https://console.anthropic.com",
]);

function approvalUrl(value: string | undefined): string | undefined {
  if (!value || value.includes("sk-ant-oat")) return;
  try {
    const url = new URL(value);
    if (approvalOrigins.has(url.origin) && url.pathname === "/oauth/authorize" && !url.username && !url.password) return value;
  } catch { /* Ignore invalid URLs from the CLI. */ }
}

interface SetupState {
  event: ClaudeSetupTokenEvent | null;
  retiredLoginIds: string[];
  pendingProfileId: string | null;
  codeSubmission: { loginId: string; accepted: boolean } | null;
  failure: string | null;
  failureProfileId: string | null;
  browserOpenFailed: boolean;
  connect(): Promise<void>;
  begin(profileId: string): Promise<void>;
  submit(loginId: string, code: string): Promise<boolean>;
  cancel(loginId: string): Promise<void>;
  handleEvent(event: ClaudeSetupTokenEvent): void;
}

function publicStatus(status: NonNullable<ClaudeSetupTokenEvent["status"]>): NonNullable<ClaudeSetupTokenEvent["status"]> {
  return {
    profile_id: status.profile_id, registered_at: status.registered_at, expires_at: status.expires_at,
    owner_check: status.owner_check, fingerprint: status.fingerprint,
    ...(status.owner_check_status !== undefined ? { owner_check_status: status.owner_check_status } : {}),
    ...(status.owner_checked_at !== undefined ? { owner_checked_at: status.owner_checked_at } : {}),
    ...(status.owner_method !== undefined ? { owner_method: status.owner_method } : {}),
  };
}

let listening: Promise<void> | null = null;
let revision = 0;
let browserApproval: { loginId: string; opened: boolean } | null = null;

/** Management's transient progress. Codes pass directly from the input to IPC. */
export const useClaudeSetupTokenStore = create<SetupState>((set, get) => {
  const ensureListening = () => {
    if (!listening) {
      listening = onClaudeSetupToken(event => get().handleEvent(event)).then(() => {});
      void listening.catch(() => { listening = null; });
    }
    return listening;
  };

  const openApproval = () => {
    const event = get().event;
    const approval = browserApproval;
    if (!approval || approval.opened || !event?.url || event.login_id !== approval.loginId) return;
    if (event.state !== "waiting_browser" && event.state !== "code_available") return;
    approval.opened = true;
    void open(event.url).catch(() => {
      if (get().event?.login_id === approval.loginId) set({ browserOpenFailed: true });
    });
  };

  return {
    event: null, retiredLoginIds: [], pendingProfileId: null, codeSubmission: null,
    failure: null, failureProfileId: null, browserOpenFailed: false,
    handleEvent: incoming => {
      const current = get().event;
      if (get().retiredLoginIds.includes(incoming.login_id)) return;
      const sameLogin = current?.login_id === incoming.login_id;
      const reopened = current?.state === "confirming" && incoming.state === "code_available" && incoming.reason === "code_reopened";
      if (sameLogin && current && !reopened && rank[incoming.state] < rank[current.state]) return;
      const url = approvalUrl(incoming.url);
      const event: ClaudeSetupTokenEvent = {
        login_id: incoming.login_id, profile_id: incoming.profile_id, state: incoming.state,
        ...(url ? { url } : {}),
        ...(incoming.reason ? { reason: incoming.reason } : {}),
        ...(incoming.status ? { status: publicStatus(incoming.status) } : {}),
      };
      revision += 1;
      const retiredLoginIds = current && !sameLogin
        ? [...get().retiredLoginIds, current.login_id].slice(-16) : get().retiredLoginIds;
      set({ event, retiredLoginIds, failure: null, failureProfileId: null,
        ...(!sameLogin ? { browserOpenFailed: false } : {}),
        ...(!sameLogin || !isSetupTokenActive(event) ? { codeSubmission: null } : {}),
      });
      openApproval();
    },
    connect: async () => {
      await ensureListening();
      const before = revision;
      const snapshot = await getClaudeSetupTokenState();
      if (snapshot && before === revision && !get().pendingProfileId) get().handleEvent(snapshot);
    },
    begin: async profileId => {
      const current = get().event;
      if (get().pendingProfileId || isSetupTokenActive(current)) return;
      const retired = current ? [...get().retiredLoginIds, current.login_id].slice(-16) : get().retiredLoginIds;
      browserApproval = null;
      set({ pendingProfileId: profileId, failure: null, failureProfileId: null, event: null,
        codeSubmission: null, retiredLoginIds: retired, browserOpenFailed: false });
      try {
        await ensureListening();
        const before = revision;
        const snapshot = await getClaudeSetupTokenState();
        if (snapshot && !isSetupTokenActive(snapshot)) {
          set({ retiredLoginIds: [...get().retiredLoginIds, snapshot.login_id].slice(-16) });
        } else if (snapshot && before === revision) {
          get().handleEvent(snapshot);
        }
        const observed = get().event;
        if (observed?.profile_id === profileId && isSetupTokenActive(observed)) {
          browserApproval = { loginId: observed.login_id, opened: false };
          openApproval();
          return;
        }
        const result = await startClaudeSetupToken(profileId);
        if (result.profile_id === profileId) browserApproval = { loginId: result.login_id, opened: false };
        get().handleEvent(result);
        openApproval();
      } catch {
        set({ failure: "start_failed", failureProfileId: profileId });
      } finally {
        set({ pendingProfileId: null });
      }
    },
    submit: async (loginId, code) => {
      const current = get().event;
      if (current?.login_id !== loginId || current.state !== "code_available" || get().codeSubmission) return false;
      const profileId = current.profile_id;
      if (!/^[!-~]{1,4096}$/.test(code) || !/^.+#.+$/.test(code)) {
        set({ failure: "invalid_code", failureProfileId: profileId });
        return false;
      }
      const pending = { loginId, accepted: false };
      set({ codeSubmission: pending });
      try {
        await submitClaudeSetupCode(loginId, code);
        if (get().codeSubmission === pending) {
          set({ codeSubmission: { loginId, accepted: true }, failure: null, failureProfileId: null });
        }
        return true;
      } catch {
        if (get().codeSubmission === pending) {
          set({ codeSubmission: null,
            ...(get().event?.state === "code_available" ? { failure: "code_failed", failureProfileId: profileId } : {}),
          });
        }
        return false;
      }
    },
    cancel: async loginId => {
      try { await cancelClaudeSetupToken(loginId); }
      catch {
        if (get().event?.login_id === loginId && isSetupTokenActive(get().event)) {
          set({ failure: "cancel_failed", failureProfileId: get().event?.profile_id ?? null });
        }
      }
    },
  };
});
