import { useCallback, useEffect, useRef, useState } from "react";

export function getVirtualRowRange(count: number, rowHeight: number, scrollTop: number, viewportHeight: number, overscan = 4) {
  if (count <= 0) return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
  const visibleStart = Math.min(count - 1, Math.floor(scrollTop / rowHeight));
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end, paddingTop: start * rowHeight, paddingBottom: (count - end) * rowHeight };
}

export function useVirtualRows(count: number, rowHeight: number, overscan = 4) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ scrollTop: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setState({ scrollTop: node.scrollTop, height: node.clientHeight });
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  const onScroll = useCallback(() => {
    const node = ref.current;
    if (node) setState({ scrollTop: node.scrollTop, height: node.clientHeight });
  }, []);
  const range = getVirtualRowRange(count, rowHeight, state.scrollTop, state.height || rowHeight * (overscan * 2 + 1), overscan);
  return { ref, onScroll, ...range };
}
