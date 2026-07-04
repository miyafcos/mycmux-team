#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "true");
  }
}

const name = args.get("name") ?? "mycmux";
const port = Number(args.get("port"));
const allowText = args.get("allow-text") === "true";
const setupIfNeeded = args.get("setup-if-needed") === "true";

if (!Number.isFinite(port) || port <= 0) {
  throw new Error("Usage: node scripts/verify-focus-stability-cdp.mjs --name <name> --port <port> [--allow-text] [--setup-if-needed]");
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function findPageTarget(portNumber) {
  const targets = await fetchJson(`http://127.0.0.1:${portNumber}/json/list`);
  const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)
    ?? targets.find((entry) => entry.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No CDP page target found on port ${portNumber}`);
  }
  return target;
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    if (message.error) {
      callbacks.reject(new Error(`${callbacks.method} failed: ${JSON.stringify(message.error)}`));
    } else {
      callbacks.resolve(message.result ?? {});
    }
  });

  function send(method, params = {}) {
    const id = nextId;
    nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      socket.send(payload);
    });
  }

  return {
    send,
    close: () => socket.close(),
  };
}

function assertCondition(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`Runtime evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

const snapshotExpression = String.raw`
(() => {
  const activeEl = document.activeElement;
  const panes = [...document.querySelectorAll(".terminal-pane-border[data-dnd-pane-id]")].map((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const xterm = el.querySelector(".xterm");
    const helper = el.querySelector(".xterm-helper-textarea");
    const rows = el.querySelector(".xterm-rows");
    const xrect = xterm?.getBoundingClientRect();
    const hidden = style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
    return {
      paneId: el.getAttribute("data-dnd-pane-id"),
      primarySessionId: el.getAttribute("data-session-id"),
      sessions: (el.getAttribute("data-pane-session-ids") || "").split(/\s+/).filter(Boolean),
      active: el.getAttribute("data-active-pane") === "true",
      focused: el.contains(activeEl),
      helperFocused: activeEl === helper,
      hidden,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      xtermRect: xrect ? { x: xrect.x, y: xrect.y, width: xrect.width, height: xrect.height } : null,
      rowsTextLen: rows?.textContent?.trim().length ?? 0,
      rowCount: rows?.children?.length ?? 0,
    };
  }).filter((pane) => !pane.hidden && pane.rect.width > 0 && pane.rect.height > 0);
  const activePanes = panes.filter((pane) => pane.active);
  const focusedPane = panes.find((pane) => pane.focused) ?? null;
  return {
    activeCount: activePanes.length,
    activePane: activePanes[0] ?? null,
    focusedPane,
    panes,
    probe: window.__mycmuxFocusProbe ?? null,
  };
})()
`;

const installProbeExpression = String.raw`
(() => {
  const probe = {
    keystrokes: [],
    focusEvents: [],
    wheelEvents: [],
    activeMutations: [],
  };
  const paneFor = (target) => target?.closest?.(".terminal-pane-border[data-dnd-pane-id]") ?? null;
  window.__mycmuxFocusProbe = probe;
  window.addEventListener("mycmux:keystroke", (event) => {
    probe.keystrokes.push(event.detail);
  });
  document.addEventListener("focusin", (event) => {
    const pane = paneFor(event.target);
    probe.focusEvents.push({
      paneId: pane?.getAttribute("data-dnd-pane-id") ?? null,
      sessionId: pane?.getAttribute("data-session-id") ?? null,
      target: event.target?.className?.toString?.() ?? event.target?.tagName ?? "",
    });
  }, true);
  document.addEventListener("wheel", (event) => {
    const pane = paneFor(event.target);
    probe.wheelEvents.push({
      paneId: pane?.getAttribute("data-dnd-pane-id") ?? null,
      sessionId: pane?.getAttribute("data-session-id") ?? null,
      deltaY: event.deltaY,
    });
  }, true);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.attributeName === "data-active-pane") {
        const pane = record.target;
        probe.activeMutations.push({
          paneId: pane.getAttribute("data-dnd-pane-id"),
          sessionId: pane.getAttribute("data-session-id"),
          active: pane.getAttribute("data-active-pane") === "true",
        });
      }
    }
  });
  for (const pane of document.querySelectorAll(".terminal-pane-border[data-dnd-pane-id]")) {
    observer.observe(pane, { attributes: true, attributeFilter: ["data-active-pane"] });
  }
  return true;
})()
`;

async function snapshot(cdp) {
  return evaluate(cdp, snapshotExpression);
}

async function clickLaunchButton(cdp) {
  const point = await evaluate(cdp, String.raw`
    (() => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const button = [...document.querySelectorAll("button")]
        .find((el) => el.textContent?.trim() === "Launch" && isVisible(el));
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  if (!point) return false;
  await dispatchMouse(cdp, "mouseMoved", point, { button: "none" });
  await dispatchMouse(cdp, "mousePressed", point);
  await dispatchMouse(cdp, "mouseReleased", point);
  await delay(1200);
  return true;
}

async function clickNewWorkspaceButton(cdp) {
  const point = await evaluate(cdp, String.raw`
    (() => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const button = [...document.querySelectorAll("button")]
        .find((el) => {
          const text = el.textContent?.trim() ?? "";
          const title = el.getAttribute("title") ?? "";
          const aria = el.getAttribute("aria-label") ?? "";
          return isVisible(el) && /new workspace/i.test(text + " " + title + " " + aria);
        });
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  if (!point) return false;
  await dispatchMouse(cdp, "mouseMoved", point, { button: "none" });
  await dispatchMouse(cdp, "mousePressed", point);
  await dispatchMouse(cdp, "mouseReleased", point);
  await delay(500);
  return true;
}

async function clickSplitRightButton(cdp) {
  const point = await evaluate(cdp, String.raw`
    (() => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const button = [...document.querySelectorAll("button")]
        .find((el) => el.getAttribute("title") === "Split right" && isVisible(el));
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  if (!point) return false;
  await dispatchMouse(cdp, "mouseMoved", point, { button: "none" });
  await dispatchMouse(cdp, "mousePressed", point);
  await dispatchMouse(cdp, "mouseReleased", point);
  await delay(1200);
  return true;
}

async function ensureMinimumPaneCount(cdp, current) {
  if (!setupIfNeeded) return false;
  if (current.panes.length === 0) {
    if (await clickLaunchButton(cdp)) return true;
    if (await clickNewWorkspaceButton(cdp)) {
      return clickLaunchButton(cdp);
    }
    return false;
  }
  if (current.panes.length === 1) {
    return clickSplitRightButton(cdp);
  }
  return false;
}

async function waitForPanes(cdp) {
  const deadline = Date.now() + 30000;
  let last = null;
  let lastSetupAttemptAt = 0;
  while (Date.now() < deadline) {
    last = await snapshot(cdp);
    if (last.panes.length >= 2 && last.activeCount <= 1) {
      return last;
    }
    if (setupIfNeeded && Date.now() - lastSetupAttemptAt > 1500) {
      if (await ensureMinimumPaneCount(cdp, last)) {
        lastSetupAttemptAt = Date.now();
      }
    }
    await delay(250);
  }
  throw new Error(`Expected at least two visible panes for ${name}; last snapshot: ${JSON.stringify(last, null, 2)}`);
}

async function dispatchMouse(cdp, type, point, extra = {}) {
  await cdp.send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    button: extra.button ?? "left",
    buttons: extra.buttons ?? (type === "mousePressed" ? 1 : 0),
    clickCount: extra.clickCount ?? 1,
    deltaX: extra.deltaX ?? 0,
    deltaY: extra.deltaY ?? 0,
  });
}

function interactionPoint(pane) {
  if (!pane.xtermRect) return pane.center;
  return {
    x: pane.xtermRect.x + pane.xtermRect.width / 2,
    y: pane.xtermRect.y + pane.xtermRect.height / 2,
  };
}

async function clickPane(cdp, pane) {
  const current = pane?.paneId ? await snapshot(cdp) : null;
  const clickTarget = current?.panes.find((candidate) => candidate.paneId === pane.paneId) ?? pane;
  const point = interactionPoint(clickTarget);
  await dispatchMouse(cdp, "mouseMoved", point, { button: "none" });
  await dispatchMouse(cdp, "mousePressed", point);
  await dispatchMouse(cdp, "mouseReleased", point);
  await delay(500);
}

async function rightClickPaneWord(cdp, pane, expectedActivePaneId) {
  const target = await evaluate(cdp, String.raw`
    (() => {
      const pane = [...document.querySelectorAll(".terminal-pane-border[data-dnd-pane-id]")]
        .find((el) => el.getAttribute("data-dnd-pane-id") === ${JSON.stringify(pane.paneId)});
      const rows = pane?.querySelector(".xterm-rows");
      if (!pane || !rows) return null;
      const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent ?? "";
        const match = /[A-Za-z0-9_./:-]{3,}/.exec(text);
        if (!match) continue;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = range.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return {
          word: match[0],
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      }
      return null;
    })()
  `);
  assertCondition(target, "right-click selection probe could not find visible terminal word", pane);

  await dispatchMouse(cdp, "mouseMoved", target, { button: "none", buttons: 0 });
  await dispatchMouse(cdp, "mousePressed", target, { button: "right", buttons: 2 });
  await delay(80);
  await dispatchMouse(cdp, "mouseReleased", target, { button: "right", buttons: 0 });
  await delay(600);

  const result = await evaluate(cdp, String.raw`
    (() => {
      const targetPane = [...document.querySelectorAll(".terminal-pane-border[data-dnd-pane-id]")]
        .find((el) => el.getAttribute("data-dnd-pane-id") === ${JSON.stringify(pane.paneId)});
      const helper = targetPane?.querySelector(".xterm-helper-textarea");
      return {
        targetWord: ${JSON.stringify(target.word)},
        activePaneId: document.querySelector(".terminal-pane-border[data-active-pane='true']")?.getAttribute("data-dnd-pane-id") ?? null,
        targetFocused: targetPane?.contains(document.activeElement) ?? false,
        selectionText: window.getSelection?.()?.toString?.() ?? "",
        helperValue: helper?.value ?? "",
        xtermSelectionRects: targetPane?.querySelectorAll(".xterm-selection div").length ?? 0,
        activeClass: document.activeElement?.className?.toString?.() ?? "",
      };
    })()
  `);
  assertCondition(
    result.activePaneId === expectedActivePaneId,
    "right-click word selection changed active pane",
    result,
  );
  assertCondition(
    result.selectionText.trim().length > 0
      || result.helperValue.trim().length > 0
      || result.xtermSelectionRects > 0,
    "right-click word selection did not create terminal selection",
    result,
  );
  await evaluate(cdp, "window.getSelection?.()?.removeAllRanges?.(); true");
  return result;
}
async function clickPaneHelperWithStaleSelection(cdp, pane) {
  const result = await evaluate(cdp, String.raw`
    (() => {
      const pane = [...document.querySelectorAll(".terminal-pane-border[data-dnd-pane-id]")]
        .find((el) => el.getAttribute("data-dnd-pane-id") === ${JSON.stringify(pane.paneId)});
      if (!pane) return { ok: false, reason: "pane not found" };
      const marker = document.createElement("span");
      marker.id = "__mycmux_stale_selection_probe";
      marker.textContent = "stale-selection-probe";
      marker.style.cssText = "position:fixed;left:-10000px;top:-10000px;white-space:pre;";
      document.body.appendChild(marker);

      const range = document.createRange();
      range.selectNodeContents(marker);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const target = pane.querySelector(".xterm-helper-textarea") ?? pane;
      const rect = pane.getBoundingClientRect();
      const eventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 9701,
        pointerType: "mouse",
        isPrimary: true,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
        button: 0,
      };
      target.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, buttons: 1 }));
      target.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));

      const selectionText = selection?.toString() ?? "";
      marker.remove();
      selection?.removeAllRanges();
      return {
        ok: true,
        selectionText,
        targetClass: target.className?.toString?.() ?? "",
        targetTag: target.tagName ?? "",
      };
    })()
  `);
  assertCondition(result?.ok, "stale-selection helper click probe could not dispatch pointer events", result);
  assertCondition(result.targetClass.includes("xterm-helper-textarea"), "stale-selection helper click probe did not target xterm helper textarea", result);
  await delay(700);
}

async function assertActivePane(cdp, expectedPaneId, label) {
  const current = await snapshot(cdp);
  assertCondition(current.activeCount === 1, `${label}: expected exactly one active pane`, current);
  assertCondition(current.activePane?.paneId === expectedPaneId, `${label}: active pane changed unexpectedly`, current);
  return current;
}

async function waitForStableActivePane(cdp, label, stableMs = 1200, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastPaneId = null;
  let stableSince = 0;
  let last = null;
  while (Date.now() < deadline) {
    last = await snapshot(cdp);
    const paneId = last.activeCount === 1 ? last.activePane?.paneId ?? null : null;
    if (paneId && paneId === lastPaneId) {
      if (stableSince && Date.now() - stableSince >= stableMs) {
        return last;
      }
    } else {
      lastPaneId = paneId;
      stableSince = paneId ? Date.now() : 0;
    }
    await delay(200);
  }
  throw new Error(`${label}: active pane did not settle\n${JSON.stringify(last, null, 2)}`);
}

function findInactivePane(current, activePaneId) {
  return current.panes.find((pane) => pane.paneId !== activePaneId && pane.xtermRect);
}

function assertPainted(current, label) {
  for (const pane of current.panes) {
    assertCondition(pane.xtermRect && pane.xtermRect.width > 0 && pane.xtermRect.height > 0, `${label}: pane has no xterm rect`, pane);
    assertCondition(pane.rowCount > 0 || pane.rowsTextLen > 0, `${label}: pane has no rendered xterm rows`, pane);
  }
}

async function run() {
  const target = await findPageTarget(port);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await evaluate(cdp, installProbeExpression);

    let current = await waitForPanes(cdp);
    if (current.activeCount !== 1) {
      await clickPane(cdp, current.panes[0]);
      current = await assertActivePane(cdp, current.panes[0].paneId, "initial click");
    }
    current = await waitForStableActivePane(cdp, "startup active pane settle");

    const firstActive = current.activePane;
    assertCondition(firstActive, "No active pane after startup", current);
    assertPainted(current, "initial paint without resize");

    const firstInactive = findInactivePane(current, firstActive.paneId);
    assertCondition(firstInactive, "No inactive pane available", current);

    await clickPane(cdp, firstActive);
    current = await assertActivePane(cdp, firstActive.paneId, "click active pane");

    const firstInactivePoint = interactionPoint(firstInactive);
    await dispatchMouse(cdp, "mouseMoved", firstInactivePoint, { button: "none" });
    await delay(250);
    current = await assertActivePane(cdp, firstActive.paneId, "hover inactive pane");

    await dispatchMouse(cdp, "mouseWheel", firstInactivePoint, { button: "none", deltaY: 420 });
    await delay(700);
    current = await assertActivePane(cdp, firstActive.paneId, "wheel inactive pane");
    assertCondition(
      !current.focusedPane || current.focusedPane.paneId === firstActive.paneId,
      "wheel inactive pane moved DOM focus away from active pane",
      current,
    );

    await evaluate(cdp, `
      (() => {
        const pane = [...document.querySelectorAll(".terminal-pane-border[data-dnd-pane-id]")]
          .find((el) => el.getAttribute("data-dnd-pane-id") === ${JSON.stringify(firstInactive.paneId)});
        pane?.querySelector(".xterm-helper-textarea")?.focus();
      })()
    `);
    await delay(700);
    current = await assertActivePane(cdp, firstActive.paneId, "programmatic focus inactive pane");
    assertCondition(
      !current.focusedPane || current.focusedPane.paneId === firstActive.paneId,
      "programmatic focus left DOM focus on inactive pane",
      current,
    );

    await rightClickPaneWord(cdp, firstInactive, firstActive.paneId);
    current = await assertActivePane(cdp, firstActive.paneId, "right-click word selection inactive pane preserves active pane");

    await dispatchMouse(cdp, "mouseMoved", firstInactivePoint, { button: "none" });
    await dispatchMouse(cdp, "mousePressed", firstInactivePoint);
    await delay(200);
    current = await assertActivePane(cdp, firstActive.paneId, "pointerdown inactive pane");
    await dispatchMouse(cdp, "mouseMoved", { x: firstInactivePoint.x + 18, y: firstInactivePoint.y + 18 }, { buttons: 1 });
    await dispatchMouse(cdp, "mouseReleased", { x: firstInactivePoint.x + 18, y: firstInactivePoint.y + 18 });
    await delay(500);
    current = await assertActivePane(cdp, firstActive.paneId, "drag-like pointer release inactive pane");

    await clickPaneHelperWithStaleSelection(cdp, firstInactive);
    current = await assertActivePane(cdp, firstInactive.paneId, "stale selection helper click inactive pane");

    await clickPane(cdp, firstActive);
    current = await assertActivePane(cdp, firstActive.paneId, "actual click previously active pane");

    await clickPane(cdp, firstInactive);
    current = await assertActivePane(cdp, firstInactive.paneId, "actual click inactive pane");
    assertCondition(
      !current.focusedPane || current.focusedPane.paneId === firstInactive.paneId,
      "actual click did not move DOM focus to clicked pane",
      current,
    );

    const secondActive = current.activePane;
    const oldActiveNowInactive = current.panes.find((pane) => pane.paneId === firstActive.paneId);
    assertCondition(oldActiveNowInactive, "Could not find previously active pane after click", current);
    await dispatchMouse(cdp, "mouseWheel", interactionPoint(oldActiveNowInactive), { button: "none", deltaY: -420 });
    await delay(700);
    current = await assertActivePane(cdp, secondActive.paneId, "wheel previously active pane after click");

    let textProbe = { skipped: true };
    if (allowText) {
      const before = current.probe?.keystrokes?.length ?? 0;
      await cdp.send("Input.insertText", { text: "x" });
      await delay(100);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
      await delay(300);
      current = await snapshot(cdp);
      const afterKeystrokes = current.probe?.keystrokes?.slice(before) ?? [];
      const activeSessions = new Set(current.activePane?.sessions ?? []);
      assertCondition(afterKeystrokes.length > 0, "text input produced no terminal keystroke events", current);
      assertCondition(
        afterKeystrokes.every((entry) => activeSessions.has(entry.sessionId)),
        "text input routed to a non-active pane",
        { activePane: current.activePane, afterKeystrokes },
      );
      textProbe = { skipped: false, eventCount: afterKeystrokes.length };
    }

    await delay(2000);
    current = await assertActivePane(cdp, secondActive.paneId, "stable paint after idle without resize");
    assertPainted(current, "stable paint after idle without resize");

    return {
      name,
      port,
      result: "PASS",
      panes: current.panes.length,
      activePane: current.activePane?.paneId,
      focusedPane: current.focusedPane?.paneId ?? null,
      setupIfNeeded,
      textProbe,
      focusEvents: current.probe?.focusEvents?.length ?? 0,
      wheelEvents: current.probe?.wheelEvents?.length ?? 0,
      activeMutations: current.probe?.activeMutations?.length ?? 0,
    };
  } finally {
    cdp.close();
  }
}

run()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(JSON.stringify({ name, port, result: "FAIL", error: error.message }, null, 2));
    process.exit(1);
  });
