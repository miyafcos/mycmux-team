import { create } from "zustand";
import type { WindowTabIndex } from "../../lib/ipc";

interface PeerWindowTabsState {
  index: WindowTabIndex[];
  completedReads: number;
  reading: boolean;
  pollers: number;
  requestSequence: number;
  handledRequestSequence: number;
  acceptIndex: (index: WindowTabIndex[]) => void;
  finishRead: () => void;
  requestRefresh: () => void;
}

/** Shared synchronously by cards, pending requests, column guards and answers. */
export const usePeerWindowTabsStore = create<PeerWindowTabsState>((set) => ({
  index: [], completedReads: 0, reading: false, pollers: 0, requestSequence: 0, handledRequestSequence: 0,
  acceptIndex: (index) => set(state => JSON.stringify(state.index) === JSON.stringify(index) ? state : { index }),
  finishRead: () => set(state => ({ completedReads: state.completedReads + 1, reading: false })),
  requestRefresh: () => set(state => ({ requestSequence: state.requestSequence + 1 })),
}));
