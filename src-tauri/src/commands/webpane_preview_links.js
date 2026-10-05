// Runs before document scripts. Neither the capability nor the native methods
// are put on a global that the document could call, read, or replace.
(() => {
  if (window !== window.top) return;
  const token = "__MYCMUX_PREVIEW_TOKEN__";
  const doc = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const assign = location.assign.bind(location);
  const encode = encodeURIComponent;
  const composedPath = Event.prototype.composedPath;
  const preventDefault = Event.prototype.preventDefault;
  const stopImmediatePropagation = Event.prototype.stopImmediatePropagation;
  const getAttribute = Element.prototype.getAttribute;
  const now = performance.now.bind(performance);
  const URLConstructor = URL;
  const hrefGetter = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "href").get;
  let sequence = 0;
  let lastAt = -Infinity;
  const activate = event => {
    if (event.type === "auxclick" ? event.button !== 1 : event.button !== 0) return;
    const path = composedPath.call(event);
    const anchor = path.find(node => node instanceof HTMLAnchorElement);
    if (!anchor) return;
    const raw = getAttribute.call(anchor, "href") || "";
    if (raw.startsWith("#")) return;
    const href = hrefGetter.call(anchor);
    let localAsset = false;
    try {
      const url = new URLConstructor(href);
      localAsset = url.protocol === "http:" && url.hostname === "asset.localhost"
        || url.protocol === "asset:" && url.hostname === "localhost";
    } catch { /* Unsupported URLs are swallowed. */ }
    // Preserve the preview's existing local-file navigation contract.
    if (localAsset && !getAttribute.call(anchor, "target")) return;
    preventDefault.call(event);
    stopImmediatePropagation.call(event);
    if (!event.isTrusted || event.defaultPrevented === false) return;
    if (!/^(?:mzopen:|https?:\/\/)/.test(href)) return;
    const at = now();
    if (at - lastAt < 500 || href.length > 16384) return;
    lastAt = at;
    // The native handler always cancels this navigation. Ordinary navigation
    // and window.open never carry the capability and cannot open OS windows.
    assign("https://mycmux-preview-link.invalid/" + token + "/" + doc + "/" + (++sequence) + "?url=" + encode(href));
  };
  window.addEventListener("click", activate, true);
  window.addEventListener("auxclick", activate, true);
})();
