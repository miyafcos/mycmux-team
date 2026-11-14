import { create } from "zustand";
import {
  startClaudeSetupToken, submitClaudeSetupCode, cancelClaudeSetupToken, getClaudeSetupTokenState,
  onClaudeSetupToken, type ClaudeSetupTokenEvent,
} from "../lib/ipc";

const rank = { starting: 0, waiting_browser: 1, code_available: 2, checking_owner: 3,
  saved: 4, mismatch: 4, failed: 4, cancelled: 4, timeout: 4 } as const;
export function isSetupTokenActive(event: ClaudeSetupTokenEvent | null): boolean {
  return event !== null && rank[event.state] < 4;
}
export interface RegistrationOrigin {
  surface: "launcher" | "settings" | "new-workspace";
  provider: "claude" | "codex" | "grok";
  profileId: string;
  ownerKey: string;
  loginId?: string;
}
function sameOrigin(left: RegistrationOrigin | null, right: RegistrationOrigin): boolean {
  return left?.surface === right.surface && left.provider === right.provider && left.profileId === right.profileId && left.ownerKey === right.ownerKey;
}
interface SetupState {
  event: ClaudeSetupTokenEvent | null;
  endedEvents: ClaudeSetupTokenEvent[];
  registrationOrigins: Record<"claude" | "codex" | "grok", RegistrationOrigin | null>;
  completionOrigin: { loginId: string; origin: RegistrationOrigin } | null;
  resultFocus: { ownerKey: string; loginId: string } | null;
  homeStartPending: Record<"claude" | "codex" | "grok", boolean>;
  completedLoginIds: string[];
  startRegistration(origin: RegistrationOrigin): void;
  finishHomeStart(origin: RegistrationOrigin): void;
  clearRegistrationOrigin(origin: RegistrationOrigin): void;
  claimCompletion(loginId: string): boolean;
  retiredLoginIds: string[];
  pendingProfileId: string | null;
  failure: string | null;
  failureProfileId: string | null;
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
/** Non-persisted public progress only. Codes pass directly from the DOM to IPC. */
export const useClaudeSetupTokenStore = create<SetupState>((set, get) => ({
  event: null, endedEvents: [], retiredLoginIds: [], pendingProfileId: null, failure: null, failureProfileId: null,
  registrationOrigins: { claude: null, codex: null, grok: null }, completionOrigin: null, resultFocus: null,
  homeStartPending: { claude: false, codex: false, grok: false }, completedLoginIds: [],
  startRegistration: origin => set(state => ({
    registrationOrigins: { ...state.registrationOrigins, [origin.provider]: origin },
    homeStartPending: { ...state.homeStartPending, [origin.provider]: origin.provider !== "claude" },
    ...(origin.provider === "claude" ? { completionOrigin: null } : {}),
    ...(state.resultFocus?.ownerKey === origin.ownerKey ? { resultFocus: null } : {}),
  })),
  finishHomeStart: origin => {
    if (sameOrigin(get().registrationOrigins[origin.provider], origin))
      set(state => ({ homeStartPending: { ...state.homeStartPending, [origin.provider]: false } }));
  },
  clearRegistrationOrigin: origin => {
    if (sameOrigin(get().registrationOrigins[origin.provider], origin)) set(state => ({
      registrationOrigins: { ...state.registrationOrigins, [origin.provider]: null },
      homeStartPending: { ...state.homeStartPending, [origin.provider]: false },
    }));
  },
  claimCompletion: loginId => {
    if (get().completedLoginIds.includes(loginId)) return false;
    set({ completedLoginIds: [...get().completedLoginIds, loginId].slice(-16),
      ...(get().completionOrigin?.loginId === loginId ? { completionOrigin: null } : {}) });
    return true;
  },
  handleEvent: incoming => {
    const current = get().event;
    if (get().retiredLoginIds.includes(incoming.login_id)) return;
    const retiredLoginIds = current && current.login_id !== incoming.login_id
      ? [...get().retiredLoginIds, current.login_id].slice(-16) : get().retiredLoginIds;
    if (current?.login_id === incoming.login_id && rank[incoming.state] < rank[current.state]) return;
    revision += 1;
    // Copy a whitelist rather than retaining an arbitrary IPC object.
    const event: ClaudeSetupTokenEvent = {
      login_id: incoming.login_id, profile_id: incoming.profile_id, state: incoming.state,
      ...(incoming.url?.startsWith("https://") && !incoming.url.includes("sk-ant-oat") ? { url: incoming.url } : {}),
      ...(incoming.reason ? { reason: incoming.reason } : {}),
      ...(incoming.status ? { status: publicStatus(incoming.status) } : {}),
    };
    // Completion routing survives a closed surface; the active origin ends with the event.
    const origin = get().registrationOrigins.claude;
    const finishedHere = origin?.provider === "claude" && origin.profileId === event.profile_id && origin.loginId === event.login_id && !isSetupTokenActive(event);
    set({ event, retiredLoginIds, failure: null, failureProfileId: null,
      endedEvents: !isSetupTokenActive(event) ? [...get().endedEvents, event].slice(-16) : get().endedEvents,
      ...(finishedHere ? { registrationOrigins: { ...get().registrationOrigins, claude: null },
        completionOrigin: event.state === "saved" || event.state === "mismatch" ? { loginId: event.login_id, origin } : null } : {}) });
  },
  connect: async () => {
    if (!listening) {
      listening = onClaudeSetupToken(event => get().handleEvent(event)).then(() => {});
      listening.catch(() => { listening = null; });
    }
    await listening;
    const before = revision;
    const current = await getClaudeSetupTokenState();
    if (current && before === revision) get().handleEvent(current);
  },
  begin: async profileId => {
    const current = get().event;
    if (get().pendingProfileId || isSetupTokenActive(current)) return;
    const retiredLoginIds = current && !isSetupTokenActive(current)
      ? [...get().retiredLoginIds, current.login_id].slice(-16) : get().retiredLoginIds;
    set({ pendingProfileId: profileId, failure: null, failureProfileId: null, event: null, retiredLoginIds });
    try {
      if (!listening) {
        listening = onClaudeSetupToken(event => get().handleEvent(event)).then(() => {});
        listening.catch(() => { listening = null; });
      }
      await listening;
      const before = revision;
      const snapshot = await getClaudeSetupTokenState();
      if (snapshot && !isSetupTokenActive(snapshot)) {
        set({ retiredLoginIds: [...get().retiredLoginIds, snapshot.login_id].slice(-16) });
      } else if (snapshot && before === revision) get().handleEvent(snapshot);
      const result = await startClaudeSetupToken(profileId);
      const origin = get().registrationOrigins.claude;
      if (origin?.profileId === profileId && !origin.loginId) {
        const boundOrigin = { ...origin, loginId: result.login_id };
        const event = get().event;
        const endedEvent = event?.login_id === result.login_id && !isSetupTokenActive(event)
          ? event : get().endedEvents.find(ended => ended.login_id === result.login_id);
        set({ registrationOrigins: { ...get().registrationOrigins, claude: endedEvent ? null : boundOrigin },
          ...(endedEvent ? { completionOrigin: endedEvent.state === "saved" || endedEvent.state === "mismatch"
            ? { loginId: endedEvent.login_id, origin: boundOrigin } : null } : {}) });
      }
      get().handleEvent(result);
    } catch {
      set({ failure: "start_failed", failureProfileId: profileId });
      const origin = get().registrationOrigins.claude;
      if (origin?.provider === "claude" && origin.profileId === profileId) get().clearRegistrationOrigin(origin);
    } finally { set({ pendingProfileId: null }); }
  },
  submit: async (loginId, code) => {
    const profileId = get().event?.profile_id ?? null;
    if (!/^[!-~]{1,4096}$/.test(code) || !/^.+#.+$/.test(code)) {
      set({ failure: "invalid_code", failureProfileId: profileId }); return false;
    }
    try {
      await submitClaudeSetupCode(loginId, code);
      set({ failure: null, failureProfileId: null }); return true;
    } catch {
      set({ failure: "code_failed", failureProfileId: profileId }); return false;
    }
  },
  cancel: async loginId => {
    try { await cancelClaudeSetupToken(loginId); }
    catch {
      if (isSetupTokenActive(get().event)) set({ failure: "cancel_failed", failureProfileId: get().event?.profile_id ?? null });
    }
  },
}));
