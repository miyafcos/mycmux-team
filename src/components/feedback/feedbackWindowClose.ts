type WindowCloseGuard = () => Promise<boolean>;
const guards = new Set<WindowCloseGuard>();

export function registerFeedbackWindowCloseGuard(guard: WindowCloseGuard): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}

/** The OS close handler waits for the form's answer before ending any tabs. */
export async function confirmFeedbackWindowClose(): Promise<boolean> {
  for (const guard of guards) {
    if (!await guard()) return false;
  }
  return true;
}
