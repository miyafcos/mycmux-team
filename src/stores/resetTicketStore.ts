import { create } from "zustand";
import { confirm } from "../lib/appConfirmation";
import { claimResetTicket, type ProfileUsage } from "../lib/ipc";
import {
  resetTicketBlockedMessage, resetTicketConfirm, resetTicketInvokeErrorMessage,
  resetTicketOutcomeMessage, type ResetTicketMessage, type ResetTicketOutcome, type ResetTickets,
} from "../lib/resetTickets";
import { useUsageStore } from "./usageStore";

type Effects = {
  confirm: typeof confirm;
  claim: (profileId: string, requestId: string, expectedEmail: string | null) => Promise<ResetTicketOutcome>;
  uuid: () => string;
  refresh: () => Promise<void>;
};

type ResetTicketState = {
  inFlight: Record<string, true>;
  message: ({ profileId: string } & ResetTicketMessage) | null;
  useTicket: (row: ProfileUsage, tickets: ResetTickets) => Promise<void>;
  dismiss: () => void;
};

const defaultEffects: Effects = {
  confirm,
  claim: claimResetTicket,
  uuid: () => crypto.randomUUID(),
  refresh: () => useUsageStore.getState().fetch(),
};

export function createResetTicketStore(effects: Effects = defaultEffects) {
  return create<ResetTicketState>((set, get) => ({
    inFlight: {}, message: null,
    dismiss: () => set({ message: null }),
    useTicket: async (row, tickets) => {
      const profileId = row.profile_id;
      if (get().inFlight[profileId]) return;
      if (!tickets.usable_now) {
        set({ message: { profileId, ...resetTicketBlockedMessage(row, tickets) } });
        return;
      }
      set((state) => ({ inFlight: { ...state.inFlight, [profileId]: true } }));
      try {
        const copy = resetTicketConfirm(row, tickets);
        const accepted = await effects.confirm(copy.message, {
          title: copy.title, kind: "warning", okLabel: copy.okLabel, cancelLabel: copy.cancelLabel,
        }).catch(() => false);
        if (!accepted) return;
        const requestId = effects.uuid();
        try {
          const outcome = await effects.claim(profileId, requestId, row.email ?? null);
          set({ message: { profileId, ...resetTicketOutcomeMessage(row, tickets, outcome) } });
        } catch (error) {
          set({ message: { profileId, ...resetTicketInvokeErrorMessage(row, error) } });
        } finally {
          await effects.refresh().catch(() => {});
        }
      } finally {
        set((state) => {
          const inFlight = { ...state.inFlight };
          delete inFlight[profileId];
          return { inFlight };
        });
      }
    },
  }));
}

export const useResetTicketStore = createResetTicketStore();
