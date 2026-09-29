import { useEffect, useRef, useState } from "react";

export function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  return { ref, width };
}
