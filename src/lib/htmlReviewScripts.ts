/** Review-only DOM operations. The shared automation scan and refs are untouched. */
export type ReviewScriptOperation = { kind: "read"; ref?: string } | { kind: "search"; text: string } | { kind: "selection" }
  | { kind: "picker-start" | "picker-poll" | "picker-stop"; token: string };

export function reviewScript(expectedUrl: string, operation: ReviewScriptOperation): string {
  return String.raw`return (() => {
    const expectedUrl = ${JSON.stringify(expectedUrl)};
    const operation = ${JSON.stringify(operation)};
    const ref = ${JSON.stringify(operation.kind === "read" ? operation.ref ?? null : null)};
    const normalizeUrl = value => new URL(value).href;
    let state = window.__mycmuxReviewDraftV1;
    if (operation.kind === 'picker-stop') {
      if (state?.picker?.token === operation.token) { state.picker.finish('cancelled'); state.picker = null; }
      return null;
    }
    if (normalizeUrl(location.href) !== normalizeUrl(expectedUrl) || !window.__mycmux) {
      state?.picker?.finish('cancelled'); throw new Error('review-stale');
    }
    if (!state) {
      state = { id: String(Date.now()) + '-' + String(Math.random()), revision: 0, targets: new Map(), nextRef: 0, observer: null };
      const relevant = record => {
        if (record.type === 'attributes' && record.attributeName === 'data-mycmux-ref') return false;
        if (state.overlay && (record.target === state.overlay || state.overlay.contains(record.target))) return false;
        if (record.type === 'childList' && state.overlay && [...record.addedNodes, ...record.removedNodes].every(node => node === state.overlay)) return false;
        return true;
      };
      state.relevant = relevant;
      state.observer = new MutationObserver(records => { if (records.some(relevant)) state.revision++; });
      state.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      Object.defineProperty(window, '__mycmuxReviewDraftV1', { value: state });
    }
    const page = () => {
      if (state.observer.takeRecords().some(state.relevant)) state.revision++;
      return { url: normalizeUrl(location.href), documentId: state.id, generation: window.__mycmux.generation,
        mutationRevision: state.revision, view: { scrollX, scrollY, dpr: devicePixelRatio,
          cssZoom: [document.documentElement, document.body].reduce((zoom, el) => {
            const value = el ? getComputedStyle(el).zoom || '1' : '1';
            return zoom * (value.endsWith('%') ? parseFloat(value) / 100 : Number(value) || 1);
          }, 1), width: innerWidth, height: innerHeight } };
    };
    const privateSelector = 'input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
    const excludedSelector = privateSelector + ',script,style,noscript,template';
    const paintCache = new WeakMap();
    const painted = el => {
      if (!(el instanceof Element) || !el.isConnected) return false;
      if (paintCache.has(el)) return paintCache.get(el);
      const style = getComputedStyle(el);
      const ok = !el.hidden && style.display !== 'none' && style.visibility !== 'hidden'
        && style.visibility !== 'collapse' && style.opacity !== '0'
        && (!el.parentElement || painted(el.parentElement));
      paintCache.set(el, ok); return ok;
    };
    const renderedCache = new WeakMap();
    const rendered = el => {
      if (!(el instanceof Element) || !el.isConnected) return false;
      if (renderedCache.has(el)) return renderedCache.get(el);
      const style = getComputedStyle(el);
      const ok = !el.matches(excludedSelector) && !el.hidden && style.display !== 'none'
        && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0'
        && (!el.parentElement || rendered(el.parentElement));
      renderedCache.set(el, ok);
      return ok;
    };
    const bounds = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    const visible = el => {
      if (!painted(el)) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    // Only DOM text is read. Values, selected options and editable text are excluded at every depth.
    const textCache = new WeakMap();
    const collectText = root => {
      if (textCache.has(root)) return textCache.get(root);
      let text = '';
      const segments = [];
      const walk = node => {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!rendered(node.parentElement)) return;
          const start = text.length; text += node.nodeValue || '';
          segments.push({ node, start, end: text.length });
          return;
        }
        if (!(node instanceof Element) || !rendered(node)) return;
        if (node.tagName === 'BR') { text += '\n'; return; }
        const block = node !== root && /^(block|flex|grid|table|list-item)/.test(getComputedStyle(node).display);
        if (block && text && !/\s$/.test(text)) text += '\n';
        for (const child of node.childNodes) walk(child);
        if (block && text && !/\s$/.test(text)) text += '\n';
      };
      walk(root);
      const result = { text, segments }; textCache.set(root, result); return result;
    };
    // Graphemes keep NFKC expansions and half-width voiced kana mapped to the original DOM text.
    const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
    const normalizeText = text => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
    const normalizedText = text => {
      let value = '';
      const starts = [], ends = [];
      for (const part of segmenter.segment(text)) {
        const normalized = part.segment.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
        value += normalized;
        for (let i = 0; i < normalized.length; i++) { starts.push(part.index); ends.push(part.index + part.segment.length); }
      }
      return { value, starts, ends };
    };
    const contextRoot = el => el.closest('p,li,td,th,figcaption,pre,article,section,main,body') || el;
    const headingBefore = el => {
      let heading = '';
      for (const node of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
        if (node !== el && !node.contains(el) && visible(node)
          && (node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) heading = collectText(node).text.trim().slice(0, 200);
      }
      return heading;
    };
    const surrounding = (text, start, end) => ({
      before: Array.from(text.slice(0, start)).slice(-30).join(''),
      after: Array.from(text.slice(end)).slice(0, 30).join(''),
    });
    const anchorForMatch = (el, own, start, end) => {
      const context = collectText(contextRoot(el));
      const segment = own.segments.find(part => part.end > start);
      const inContext = segment && context.segments.find(part => part.node === segment.node);
      const following = context.segments.find(part => el.compareDocumentPosition(part.node) & Node.DOCUMENT_POSITION_FOLLOWING);
      const offset = inContext ? inContext.start + Math.max(0, start - segment.start) : following?.start ?? context.text.length;
      return { text: own.text.slice(start, end), ...surrounding(context.text, offset, offset + end - start), heading: headingBefore(el) };
    };
    const read = key => {
      const target = state.targets.get(key);
      const el = target?.element || window.__mycmux.refs.get(key);
      if (!(el instanceof Element) || !el.isConnected) throw new Error('review-stale');
      let box = el.getBoundingClientRect(), rects;
      if (target?.range) {
        const range = target.range;
        if (!range.startContainer.isConnected || !range.endContainer.isConnected || range.toString() !== target.anchor.text) throw new Error('review-stale');
        rects = [...range.getClientRects()].map(bounds).filter(rect => rect.width > 0 && rect.height > 0);
        const visibleRects = rects.map(rect => ({ x: Math.max(0, rect.x), y: Math.max(0, rect.y),
          right: Math.min(innerWidth, rect.x + rect.width), bottom: Math.min(innerHeight, rect.y + rect.height) }))
          .filter(rect => rect.right > rect.x && rect.bottom > rect.y);
        if (!visibleRects.length) throw new Error('review-outside');
        const x = Math.min(...visibleRects.map(rect => rect.x)), y = Math.min(...visibleRects.map(rect => rect.y));
        box = { x, y, width: Math.max(...visibleRects.map(rect => rect.right)) - x, height: Math.max(...visibleRects.map(rect => rect.bottom)) - y };
      }
      const bounded = value => (value || '').slice(0, 256);
      const fingerprint = JSON.stringify([el.tagName, bounded(el.id), bounded(el.getAttribute('role')), bounded(el.getAttribute('aria-label')),
        collectText(el).text.slice(0, 240), bounded(el.getAttribute('href'))]);
      const parts = [];
      let zoom = 1;
      for (let node = el; node; node = node.parentElement) {
        const ownZoom = getComputedStyle(node).zoom || '1';
        zoom *= ownZoom.endsWith('%') ? parseFloat(ownZoom) / 100 : Number(ownZoom) || 1;
        if (node === document.documentElement) break;
        const siblings = [...node.parentElement.children].filter(child => child.tagName === node.tagName);
        parts.unshift(CSS.escape(node.tagName.toLowerCase()) + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
        if (parts.length > 64) throw new Error('review-stale');
      }
      return { ...page(), ref: key, fingerprint, selector: 'html' + (parts.length ? ' > ' + parts.join(' > ') : ''),
        rect: bounds(box), ...(rects ? { rects } : {}), scrollX, scrollY, dpr: devicePixelRatio, cssZoom: zoom,
        viewport: { width: innerWidth, height: innerHeight }, ...(target ? { anchor: target.anchor, mode: target.mode } : {}) };
    };
    const describe = (el, anchor, mode, range) => {
      const key = 'hr-' + state.id + '-' + (++state.nextRef);
      state.targets.set(key, { element: el, anchor, mode, range });
      const frame = read(key);
      return { ref: key, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || 'generic',
        name: (anchor.before + anchor.text + anchor.after).trim().slice(0, 200), anchor, frame,
        rect: frame.rect, inViewport: frame.rect.x < innerWidth && frame.rect.y < innerHeight
          && frame.rect.x + frame.rect.width > 0 && frame.rect.y + frame.rect.height > 0 };
    };
    if (operation.kind === 'read') return ref ? read(ref) : page();
    if (operation.kind === 'search') {
      const before = page();
      state.targets.clear();
      const needle = normalizeText(operation.text);
      if (!needle) return { page: before, nodes: [] };
      const matches = [];
      for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
        if (!visible(el)) continue;
        const own = collectText(el);
        const position = normalizeText(own.text).indexOf(needle);
        if (position >= 0) matches.push({ el, own, position, box: el.getBoundingClientRect() });
      }
      const matching = new Set(matches.map(match => match.el)), outer = new Set();
      for (const match of matches) for (let parent = match.el.parentElement; parent; parent = parent.parentElement) {
        if (matching.has(parent)) outer.add(parent);
      }
      const nodes = matches.filter(match => !outer.has(match.el)).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
        .slice(0, 30).map(match => {
          const normalized = normalizedText(match.own.text);
          return describe(match.el, anchorForMatch(match.el, match.own, normalized.starts[match.position], normalized.ends[match.position + needle.length - 1]), 'text');
        });
      const after = page();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('review-stale');
      return { page: after, nodes };
    }
    if (operation.kind === 'selection') {
      const selection = getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return { page: page(), node: null };
      const range = selection.getRangeAt(0).cloneRange();
      const common = range.commonAncestorContainer;
      const el = common instanceof Element ? common : common.parentElement;
      if (!el || !el.isConnected || !range.toString().trim()) return { page: page(), node: null };
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (range.intersectsNode(node) && !rendered(node.parentElement)) return { page: page(), node: null };
      }
      if (el.closest(privateSelector)) return { page: page(), node: null };
      const context = collectText(contextRoot(el));
      const offsetAt = (container, offset) => {
        const edge = document.createRange(); edge.setStart(container, offset); edge.collapse(true);
        for (const part of context.segments) {
          if (part.node === container) return part.start + offset;
          if (edge.comparePoint(part.node, 0) >= 0) return part.start;
        }
        return context.text.length;
      };
      const start = offsetAt(range.startContainer, range.startOffset);
      const end = offsetAt(range.endContainer, range.endOffset);
      const headingNode = context.segments.find(part => part.end > start)?.node || el;
      const anchor = { text: range.toString(), ...surrounding(context.text, start, end), heading: headingBefore(headingNode) };
      const node = describe(el, anchor, 'selection', range);
      return { page: page(), node };
    }
    if (operation.kind === 'picker-start') {
      state.picker?.finish('cancelled');
      page(); // Drain the previous overlay removal before replacing its identity.
      const overlay = document.createElement('div'), outline = document.createElement('div');
      state.overlay = overlay;
      overlay.setAttribute('data-mycmux-review-overlay', '');
      overlay.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent;';
      const rootZoom = getComputedStyle(document.documentElement).zoom || '1';
      overlay.style.zoom = String(1 / (rootZoom.endsWith('%') ? parseFloat(rootZoom) / 100 : Number(rootZoom) || 1));
      outline.style.cssText = 'all:initial;position:absolute;box-sizing:border-box;border:2px solid #468dff;pointer-events:none;display:none;';
      overlay.append(outline); document.documentElement.append(overlay);
      const picker = { token: operation.token, phase: 'pending', result: null, finish: null };
      state.picker = picker;
      const listeners = [];
      const on = (name, handler) => { window.addEventListener(name, handler, true); listeners.push([name, handler]); };
      picker.finish = (phase, result = null) => {
        if (picker.phase !== 'pending') return;
        picker.phase = phase; picker.result = result;
        for (const [name, handler] of listeners) window.removeEventListener(name, handler, true);
        listeners.length = 0; overlay.remove();
      };
      const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
      const hit = event => {
        const candidates = document.elementsFromPoint?.(event.clientX, event.clientY) || [event.target];
        let el = candidates.find(node => node instanceof Element && node !== overlay && !overlay.contains(node));
        while (el?.getRootNode() instanceof ShadowRoot) el = el.getRootNode().host;
        return el && painted(el) && visible(el) ? el : null;
      };
      const move = event => {
        block(event);
        const el = hit(event);
        if (!el) { outline.style.display = 'none'; return; }
        const box = el.getBoundingClientRect();
        Object.assign(outline.style, { display: 'block', left: box.x + 'px', top: box.y + 'px', width: box.width + 'px', height: box.height + 'px' });
      };
      for (const name of ['pointermove', 'mousemove']) on(name, move);
      for (const name of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick', 'dblclick', 'contextmenu', 'touchstart', 'touchend']) on(name, block);
      on('click', event => {
        block(event);
        const el = hit(event);
        if (!el) return;
        picker.finish('selected');
        try {
          const own = collectText(el);
          const anchor = anchorForMatch(el, own, 0, own.text.length);
          if (!anchor.text) anchor.text = (el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 256);
          const node = describe(el, anchor, 'element');
          picker.result = { page: node.frame, node };
        } catch { picker.phase = 'cancelled'; }
      });
      on('keydown', event => {
        block(event);
        if (event.key === 'Escape') picker.finish('cancelled');
      });
      const cancel = () => picker.finish('cancelled');
      for (const name of ['pagehide', 'beforeunload', 'popstate', 'hashchange']) on(name, cancel);
      return { phase: 'pending' };
    }
    if (operation.kind === 'picker-poll') {
      const picker = state.picker;
      if (!picker || picker.token !== operation.token) return { phase: 'cancelled' };
      page();
      return { phase: picker.phase, ...(picker.result || {}) };
    }
    throw new Error('review-stale');
  })();`;
}
