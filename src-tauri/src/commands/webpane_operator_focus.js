(() => {
  if (window !== window.top) return;

  const doc = document;
  const location = window.location;
  const ParseURL = URL;
  const call = (method) => Function.prototype.call.bind(method);
  const getter = (prototype, name) => call(Object.getOwnPropertyDescriptor(prototype, name).get);
  const urlProtocol = getter(ParseURL.prototype, "protocol");
  const urlHostname = getter(ParseURL.prototype, "hostname");
  function allowedOrigin() {
    const origin = location.origin;
    try {
      const url = new ParseURL(origin);
      const host = urlHostname(url);
      return urlProtocol(url) === "http:" && (host === "127.0.0.1" || host === "localhost")
        ? origin : null;
    } catch {
      return null;
    }
  }
  if (!allowedOrigin()) return;

  const assign = location.assign.bind(location);
  const dateNow = Date.now;
  const monotonicNow = performance.now.bind(performance);
  const random = crypto.getRandomValues.bind(crypto);
  const encodeUrl = encodeURIComponent;
  const composedPath = call(Event.prototype.composedPath);
  const preventDefault = call(Event.prototype.preventDefault);
  const stopImmediately = call(Event.prototype.stopImmediatePropagation);
  const getAttribute = call(Element.prototype.getAttribute);
  const hasAttribute = call(Element.prototype.hasAttribute);
  const setAttribute = call(Element.prototype.setAttribute);
  const matches = call(Element.prototype.matches);
  const root = getter(Document.prototype, "documentElement");
  const localName = getter(Element.prototype, "localName");
  const namespace = getter(Element.prototype, "namespaceURI");
  const disabled = getter(HTMLButtonElement.prototype, "disabled");
  const nodeType = getter(Node.prototype, "nodeType");
  const button = getter(MouseEvent.prototype, "button");
  const detail = getter(UIEvent.prototype, "detail");
  const Observer = MutationObserver;
  const observe = call(Observer.prototype.observe);
  const disconnect = call(Observer.prototype.disconnect);
  const charCodeAt = call(String.prototype.charCodeAt);
  function validTarget(target) {
    for (let i = 0; i < target.length; i++) {
      const code = charCodeAt(target, i);
      if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
        || code === 95 || code === 46 || code === 58 || code === 45) continue;
      return false;
    }
    return true;
  }
  const attribute = "data-mycmux-focus-tab";

  const sign = (__MYCMUX_HMAC_SHA256__)("__MYCMUX_OPERATOR_FOCUS_KEY__");
  const bytes = random(new Uint8Array(16));
  const digits = "0123456789abcdef";
  let nonce = "";
  for (let i = 0; i < 16; i++) {
    nonce += digits[bytes[i] >>> 4] + digits[bytes[i] & 15];
  }

  function mark() {
    const element = root(doc);
    if (!element) return false;
    setAttribute(element, "data-mycmux-operator-focus", "1");
    return true;
  }
  if (!mark()) {
    const observer = new Observer(() => {
      if (mark()) disconnect(observer);
    });
    observe(observer, doc, { childList: true, subtree: true });
  }

  let sequence = 0;
  let last = -Infinity;
  let busy = false;
  doc.addEventListener("click", (event) => {
    if (!event.isTrusted || button(event) !== 0 || !(detail(event) >= 1)) return;
    const pressed = dateNow();
    const origin = allowedOrigin();
    if (!origin) return;
    const path = composedPath(event);
    let target;
    for (let i = 0; i < path.length; i++) {
      const element = path[i];
      if (element === window) break;
      if (nodeType(element) !== 1 || !hasAttribute(element, attribute)) continue;
      if (localName(element) !== "button" || namespace(element) !== "http://www.w3.org/1999/xhtml"
        || disabled(element) || matches(element, ":disabled")) return;
      target = getAttribute(element, attribute);
      break;
    }
    if (!target || target.length > 128 || !validTarget(target)) return;
    const now = monotonicNow();
    if (busy || now - last < 500) return;
    busy = true;
    last = now;
    try {
      preventDefault(event);
      stopImmediately(event);
      sequence += 1;
      const message = `${nonce}\n${sequence}\n${pressed}\n${origin}\n${target}`;
      const mac = sign(message);
      assign(`https://mycmux-operator-focus.invalid/${nonce}/${sequence}/${pressed}/${mac}?origin=${encodeUrl(origin)}&tab=${encodeUrl(target)}`);
    } finally {
      busy = false;
    }
  }, true);
})();
