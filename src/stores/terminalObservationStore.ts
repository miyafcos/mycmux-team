import { create } from "zustand";

interface TerminalObservationState {
  observed: ReadonlySet<string>;
  markObserved: (id: string) => void;
  markUnobserved: (id: string) => void;
}

export const useTerminalObservationStore = create<TerminalObservationState>((set) => ({
  observed: new Set<string>(),
  markObserved: (id) => set((state) => {
    if (state.observed.has(id)) return state;
    return { observed: new Set(state.observed).add(id) };
  }),
  markUnobserved: (id) => set((state) => {
    if (!state.observed.has(id)) return state;
    const observed = new Set(state.observed);
    observed.delete(id);
    return { observed };
  }),
}));
