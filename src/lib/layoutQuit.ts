// This state belongs to one webview, including the window that saves data.json.
let preparingToQuit = false;
const pending = new Set<Promise<void>>();

export function isPreparingLayoutQuit(): boolean {
  return preparingToQuit;
}

/** Acquire before starting async layout work; release after commit or rollback. */
export function beginLayoutOperation(): (() => void) | undefined {
  if (preparingToQuit) return;
  let resolve!: () => void;
  const done = new Promise<void>((finish) => { resolve = finish; });
  pending.add(done);
  return () => {
    pending.delete(done);
    resolve();
  };
}

export function stopNewLayoutOperations(): Promise<void[]> {
  preparingToQuit = true;
  return Promise.all(pending);
}

export function resetLayoutQuitForTests(): void {
  preparingToQuit = false;
  pending.clear();
}
