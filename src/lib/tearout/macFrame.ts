import { isMacTearoutPlatform } from "./feature";

/** WKWebView stops rAF in hidden/occluded windows. Bound only the Mac wait;
 * Windows keeps its existing frame batching and paint acknowledgement. */
export function afterTearoutFrame(callback: () => void,
  platform = typeof navigator === "undefined" ? "" : navigator.platform): () => void {
  let done = false;
  let timer: number | null = null;
  let frame = 0;
  const finish = () => {
    if (done) return;
    done = true;
    if (timer !== null) window.clearTimeout(timer);
    if (frame) window.cancelAnimationFrame(frame);
    callback();
  };
  frame = window.requestAnimationFrame(finish);
  if (isMacTearoutPlatform(platform)) timer = window.setTimeout(finish, 40);
  return () => {
    done = true;
    if (timer !== null) window.clearTimeout(timer);
    if (frame) window.cancelAnimationFrame(frame);
  };
}
