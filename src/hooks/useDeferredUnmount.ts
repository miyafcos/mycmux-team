import { useEffect, useState } from "react";

export const OVERLAY_EXIT_MS = 120;

export function useDeferredUnmount(
  open: boolean,
  durationMs: number,
): { mounted: boolean; closing: boolean } {
  const [retained, setRetained] = useState(open);

  useEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }

    if (!retained) return;

    const timer = globalThis.setTimeout(() => {
      setRetained(false);
    }, durationMs);

    return () => globalThis.clearTimeout(timer);
  }, [durationMs, open, retained]);

  return {
    mounted: open || retained,
    closing: !open && retained,
  };
}
