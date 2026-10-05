/** A frontend IPC reply can be lost even when its backend HTTP timeout ran. */
export function boundedGroupingWait<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      run();
    };
    const cancel = () => finish(() => reject(new Error("cancelled")));
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
