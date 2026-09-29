import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  attentionListCards,
  attentionResolveCard,
  attentionSetTracked,
  type AttentionCard,
  type AttentionCardsChanged,
} from "../lib/attentionBridge";

interface AttentionState {
  cardsById: Record<string, AttentionCard | undefined>;
  cardIds: string[];
  loading: boolean;
  error: string | null;
  replaceCards: (cards: readonly AttentionCard[]) => void;
  hydrate: () => Promise<void>;
  resolveCard: (id: string) => Promise<void>;
  setTracked: (ptySessionId: string, tracked: boolean) => Promise<void>;
  resetForTests: () => void;
}

function sameCards(state: Pick<AttentionState, "cardsById" | "cardIds">, cards: readonly AttentionCard[]): boolean {
  if (state.cardIds.length !== cards.length) return false;
  for (let index = 0; index < cards.length; index += 1) {
    const next = cards[index];
    if (!next || state.cardIds[index] !== next.id) return false;
    const previous = state.cardsById[next.id];
    if (!previous || previous.revision !== next.revision || previous.state !== next.state
      || previous.lastSeenAt !== next.lastSeenAt || previous.evidence.length !== next.evidence.length) return false;
  }
  return true;
}

let eventGeneration = 0;
let subscriberCount = 0;
let unlisten: UnlistenFn | undefined;
let listenPending: Promise<UnlistenFn> | undefined;

function applyEvent(payload: AttentionCardsChanged): void {
  eventGeneration += 1;
  useAttentionStore.getState().replaceCards(payload.cards);
}

async function ensureSubscription(): Promise<void> {
  if (unlisten) return;
  if (!listenPending) {
    listenPending = listen<AttentionCardsChanged>("attention://cards-changed", (event) => applyEvent(event.payload));
  }
  const dispose = await listenPending;
  if (subscriberCount === 0) {
    dispose();
    listenPending = undefined;
    return;
  }
  unlisten = dispose;
}

export const useAttentionStore = create<AttentionState>((set, get) => ({
  cardsById: {},
  cardIds: [],
  loading: false,
  error: null,
  replaceCards: (cards) => set((state) => {
    if (sameCards(state, cards)) return state;
    const cardsById: Record<string, AttentionCard> = {};
    for (const card of cards) cardsById[card.id] = card;
    return { cardsById, cardIds: cards.map((card) => card.id), loading: false, error: null };
  }),
  hydrate: async () => {
    const startGeneration = eventGeneration;
    set((state) => state.loading ? state : { loading: true, error: null });
    try {
      const cards = await attentionListCards();
      if (eventGeneration === startGeneration) get().replaceCards(cards);
      else set({ loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  resolveCard: async (id) => {
    await attentionResolveCard(id);
  },
  setTracked: async (ptySessionId, tracked) => {
    await attentionSetTracked(ptySessionId, tracked);
  },
  resetForTests: () => set({ cardsById: {}, cardIds: [], loading: false, error: null }),
}));

/** One listener is shared by all mounted consumers; this is event-driven, not polling. */
export async function connectAttentionStore(): Promise<() => void> {
  subscriberCount += 1;
  try {
    await ensureSubscription();
    void useAttentionStore.getState().hydrate();
  } catch (error) {
    listenPending = undefined;
    useAttentionStore.setState({ error: error instanceof Error ? error.message : String(error) });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount !== 0) return;
    unlisten?.();
    unlisten = undefined;
    listenPending = undefined;
  };
}

export function __resetAttentionStoreForTests(): void {
  unlisten?.();
  unlisten = undefined;
  listenPending = undefined;
  subscriberCount = 0;
  eventGeneration = 0;
  useAttentionStore.getState().resetForTests();
}
