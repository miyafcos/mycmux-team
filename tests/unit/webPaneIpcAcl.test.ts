import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHmac } from "node:crypto";
import { TextEncoder } from "node:util";
import { describe, expect, it, vi } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const rust = read("src-tauri/src/commands/webpane.rs");
const shortcutMacSource = read("src-tauri/src/commands/webpane_hmac.js").trim();
const testKey = "test-only-shortcut-key";
const pressedAt = 1_800_000_000_000;

function expectedProof(key = "Tab", code = "Tab", shiftKey = false, proofKey = testKey) {
  const document = "0c".repeat(16);
  const fields = [document, 1, pressedAt, "tab_1", key, code, 0, true, false, shiftKey, false, false, false];
  const mac = createHmac("sha256", proofKey).update(fields.join("\n")).digest("hex");
  return { document, sequence: 1, pressedAt, mac };
}
const manifests = JSON.parse(read("src-tauri/gen/schemas/acl-manifests.json"));
// Complete registration is checked by the independent Rust compiler oracle in
// app_ipc_acl.rs; this JS check reconciles every generated individual grant.
const registered = Object.values(manifests["__app-acl__"].permissions)
  .flatMap((permission) => (permission as { commands: { allow: string[] } }).commands.allow);
const generatedCapabilities = JSON.parse(read("src-tauri/gen/schemas/capabilities.json"));
const defaultCapability = JSON.parse(read("src-tauri/capabilities/default.json"));
const childCapability = JSON.parse(read("src-tauri/capabilities/web-pane.json"));

function key(overrides: Partial<ReturnType<typeof baseKey>> = {}) {
  return { ...baseKey(), ...overrides };
}
function baseKey() {
  return {
    isTrusted: true, defaultPrevented: false, isComposing: false, keyCode: 9,
    key: "Tab", code: "Tab", location: 0, ctrlKey: true, altKey: false,
    shiftKey: false, metaKey: false, repeat: false,
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
  };
}
function injectedShortcutHandler(shortcuts: string[], nonceByte = 0x0c, proofKey = testKey) {
  const functionSource = rust.slice(rust.indexOf("fn shortcut_initialization_script("),
    rust.indexOf("fn shortcut_update_script("));
  const raw = /r#"([\s\S]*?)"#/.exec(functionSource)![1]!;
  const script = raw.replaceAll("{state_name}", JSON.stringify("__MYCMUX_WEB_PANE_SHORTCUT_STATE__"))
    .replaceAll("{shortcuts}", JSON.stringify(shortcuts))
    .replaceAll("{tab_id}", JSON.stringify("tab_1"))
    .replaceAll("{{", "{").replaceAll("}}", "}")
    .replace("{hmac}", () => shortcutMacSource)
    .replace("{proof_key}", JSON.stringify(proofKey));
  const invoke = vi.fn().mockResolvedValue(undefined);
  let handle: (event: ReturnType<typeof key>) => void = () => { throw new Error("handler missing"); };
  const window: {
    __TAURI_INTERNALS__: { invoke: typeof invoke };
    __MYCMUX_WEB_PANE_SHORTCUT_STATE__?: { shortcuts: Set<string> };
  } = { __TAURI_INTERNALS__: { invoke } };
  class TestKeyboardEvent {}
  for (const field of ["key", "code", "location", "ctrlKey", "altKey", "shiftKey", "metaKey", "repeat", "isComposing", "keyCode"] as const) {
    Object.defineProperty(TestKeyboardEvent.prototype, field, {
      configurable: true, get(this: ReturnType<typeof key>) { return this[field]; },
    });
  }
  class TestEvent {
    get defaultPrevented() { return false; }
    preventDefault(this: ReturnType<typeof key>) { this.preventDefault(); }
    stopImmediatePropagation(this: ReturnType<typeof key>) { this.stopImmediatePropagation(); }
  }
  Object.defineProperty(TestEvent.prototype, "defaultPrevented", {
    get(this: ReturnType<typeof key>) { return this.defaultPrevented; },
  });
  const context = vm.createContext({
    window, Event: TestEvent, KeyboardEvent: TestKeyboardEvent, TextEncoder,
    Date: { now: () => pressedAt },
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(nonceByte) },
    document: { addEventListener: (name: string, handler: typeof handle, capture: boolean) => {
      expect(name).toBe("keydown"); expect(capture).toBe(true); handle = handler;
    } },
  });
  vm.runInContext(script, context);
  return { handle, invoke, window, context };
}

describe("C59-01 generated app policy", () => {
  it("includes every generated per-command allow in the local set without extras", () => {
    const app = manifests["__app-acl__"];
    expect(app).toBeDefined();
    expect(new Set(registered).size).toBe(registered.length);
    const grants = app.permission_sets["app-local"].permissions as string[];
    expect(new Set(grants)).toEqual(new Set(registered.map((command) => `allow-${command.replaceAll("_", "-")}`)));
    for (const command of registered) {
      const permission = app.permissions[`allow-${command.replaceAll("_", "-")}`];
      expect(permission.commands.allow).toEqual([command]);
      expect(permission.commands.deny).toEqual([]);
    }
    expect(defaultCapability.permissions).toContain("app-local");
  });

  it("keeps privileged local grants on primary webview labels without a window selector", () => {
    expect(defaultCapability.windows).toBeUndefined();
    expect(defaultCapability.webviews).toEqual(["main", "mycmux-w*"]);
    expect(defaultCapability.remote).toBeUndefined();
    expect(defaultCapability.local).toBe(true);
    expect(generatedCapabilities.default).toEqual(defaultCapability);
  });

  it("gives children exactly three replies and the dedicated shortcut command", () => {
    expect(childCapability.windows).toBeUndefined();
    expect(childCapability.webviews).toEqual(["web-pane-*"]);
    expect(childCapability.permissions).toEqual([
      "allow-webpane-read-result", "allow-webpane-push-result", "allow-webpane-eval-result",
      "allow-webpane-forward-shortcut",
    ]);
    expect(generatedCapabilities["web-pane"]).toEqual(childCapability);
  });
});

describe("actual injected Web pane shortcut script", () => {
  it("sends a registered trusted key only through the dedicated app command", () => {
    const { handle, invoke } = injectedShortcutHandler(["ctrl+tab"]);
    const event = key(); handle(event);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("webpane_forward_shortcut", {
      payload: {
        tabId: "tab_1", key: "Tab", code: "Tab", location: 0, ctrlKey: true,
        altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false,
        proof: expectedProof(),
      },
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("produces the same authenticated payload as the Rust fixture without subtle crypto", () => {
    const { handle, invoke } = injectedShortcutHandler(["ctrl+tab"]);
    handle(key());
    const proof = invoke.mock.calls[0]?.[1].payload.proof;
    expect(proof?.mac === "b8b51c94446f11bb8642e96c63b0a88ef10e091aec18445325bf433f52f6305c").toBe(true);
  });

  it("uses the captured time, key getters, synchronous invoke and Set membership", () => {
    const { handle, invoke, context } = injectedShortcutHandler(["ctrl+tab"]);
    vm.runInContext('Date.now = () => 7; Set.prototype.has = () => false;' +
      'Object.defineProperty(KeyboardEvent.prototype, "key", { get: () => "modified" });' +
      'window.__TAURI_INTERNALS__.invoke = () => { throw new Error("late invoke"); };', context);
    handle(key());
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[1].payload.proof).toEqual(expectedProof());
  });

  it.each([
    ["0123456789abcdef".repeat(4), "4774fa48cba1f5cd7a834ec45374dff04a0ea4e51d8886c35b927c2bd33cf675"],
    ["0123456789abcdef".repeat(4) + "0", "27065cd772a1a43822e4cec365a3b06d01f972912589061b80e8b4b411a756ec"],
  ])("matches the Node and fixed HMAC vectors at the SHA-256 block boundary", (proofKey, expected) => {
    const { handle, invoke } = injectedShortcutHandler(["ctrl+tab"], 0x0c, proofKey);
    handle(key());
    expect(invoke).toHaveBeenCalledOnce();
    const proof = invoke.mock.calls[0]?.[1].payload.proof;
    expect(proof).toEqual(expectedProof("Tab", "Tab", false, proofKey));
    expect(proof.mac).toBe(expected);
  });

  it("uses its captured Promise handler for both outcomes when the page replaces then and catch", async () => {
    const { handle, invoke, context } = injectedShortcutHandler(["ctrl+tab"]);
    const observed = vm.runInContext(
      'const observed = []; const originalThen = Promise.prototype.then;' +
      'Promise.prototype.then = function (...args) { observed.push("then"); return originalThen.apply(this, args); };' +
      'Promise.prototype.catch = function (error) { observed.push("catch"); return originalThen.call(this, undefined, error); };' +
      'observed;', context,
    );
    invoke.mockImplementationOnce(() => vm.runInContext("Promise.resolve()", context));
    invoke.mockImplementationOnce(() => vm.runInContext("Promise.reject(new Error('fixture reply'))", context));
    handle(key());
    handle(key());
    expect(invoke).toHaveBeenCalledTimes(2);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(observed).toEqual([]);
  });

  it("restarts its sequence with a fresh nonce in a new document", () => {
    const first = injectedShortcutHandler(["ctrl+tab"]);
    const second = injectedShortcutHandler(["ctrl+tab"], 0x0d);
    first.handle(key());
    first.handle(key());
    second.handle(key());
    expect(first.invoke.mock.calls.map(([, call]) => call.payload.proof?.sequence)).toEqual([1, 2]);
    expect(second.invoke.mock.calls[0]?.[1].payload.proof?.sequence).toBe(1);
    expect(second.invoke.mock.calls[0]?.[1].payload.proof?.document).toBe("0d".repeat(16));
  });

  it("matches the RFC 4231 Jefe vector", () => {
    const signer = vm.runInNewContext("(" + shortcutMacSource + ')("Jefe")', { TextEncoder });
    expect(signer("what do ya want for nothing?") ===
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843").toBe(true);
  });

  it("drops unregistered, synthetic, already-handled and composing key events", () => {
    const { handle, invoke } = injectedShortcutHandler(["ctrl+tab"]);
    for (const event of [key({ key: "r", code: "KeyR" }), key({ isTrusted: false }),
      key({ defaultPrevented: true }), key({ isComposing: true }), key({ keyCode: 229 })]) {
      handle(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the refreshed registration and preserves the Control+Shift+Tab payload", () => {
    const { handle, invoke, window } = injectedShortcutHandler(["ctrl+tab"]);
    window.__MYCMUX_WEB_PANE_SHORTCUT_STATE__!.shortcuts = new Set(["ctrl+shift+tab"]);
    handle(key()); expect(invoke).not.toHaveBeenCalled();
    handle(key({ shiftKey: true }));
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![1].payload.shiftKey).toBe(true);
  });
});


it("F5 reapplies current registration after remap, navigation and reload", () => {
  const pageLoad = rust.slice(rust.indexOf(".on_page_load("), rust.indexOf(".on_new_window("));
  expect(pageLoad).toMatch(/PageLoadEvent::Finished[\s\S]*restore_shortcut_registration/);
  const updateFunction = rust.slice(rust.indexOf("fn shortcut_update_script("), rust.indexOf("fn composer_push_script("));
  const rawUpdate = /r#"([\s\S]*?)"#/.exec(updateFunction)![1]!;
  const update = rawUpdate.replaceAll("{state_name}", JSON.stringify("__MYCMUX_WEB_PANE_SHORTCUT_STATE__"))
    .replaceAll("{shortcuts}", JSON.stringify(["ctrl+shift+pageup"]))
    .replaceAll("{{", "{").replaceAll("}}", "}");
  const oldDocument = injectedShortcutHandler(["ctrl+tab"]);
  vm.runInNewContext(update, { window: oldDocument.window });
  for (const document of [oldDocument, injectedShortcutHandler(["ctrl+tab"]), injectedShortcutHandler(["ctrl+tab"])]) {
    // New documents still run the creation-time initialization; load must apply current registration.
    vm.runInNewContext(update, { window: document.window });
    document.handle(key()); expect(document.invoke).not.toHaveBeenCalled();
    document.handle(key({ key: "PageUp", code: "PageUp", shiftKey: true }));
    expect(document.invoke).toHaveBeenCalledExactlyOnceWith("webpane_forward_shortcut", {
      payload: {
        tabId: "tab_1", key: "PageUp", code: "PageUp", location: 0, ctrlKey: true,
        altKey: false, shiftKey: true, metaKey: false, repeat: false, isComposing: false,
        proof: expectedProof("PageUp", "PageUp", true),
      },
    });
  }
});
