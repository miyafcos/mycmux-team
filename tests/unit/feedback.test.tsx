// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(), status: vi.fn(), save: vi.fn(), remove: vi.fn(), send: vi.fn(),
  normalize: vi.fn(), toast: vi.fn(),
}));
vi.mock("../../src/components/feedback/feedbackApi", () => ({
  captureFeedbackMain: mocks.capture, getFeedbackDestinationStatus: mocks.status,
  saveFeedbackDestination: mocks.save, removeFeedbackDestination: mocks.remove, sendFeedback: mocks.send,
}));
vi.mock("../../src/components/feedback/feedbackImages", () => ({ normalizeFeedbackImage: mocks.normalize }));
vi.mock("../../src/stores/toastStore", () => ({ useToastStore: { getState: () => ({ pushToast: mocks.toast }) } }));
import { FeedbackButton } from "../../src/components/feedback/FeedbackButton";
import { FeedbackDialog } from "../../src/components/feedback/FeedbackDialog";
import { feedbackStrings } from "../../src/components/feedback/feedbackStrings";
import { confirmFeedbackWindowClose } from "../../src/components/feedback/feedbackWindowClose";
import { FeedbackDestinationSection } from "../../src/components/feedback/FeedbackDestinationSection";

let host: HTMLDivElement;
let root: Root;
const image = { mime: "image/png" as const, data: "aW1hZ2U=" };
const unset = "送り先が設定されていません。設定 → アプリ情報の『改善の要望の送り先』で設定してください。";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function button(text: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text);
  expect(found, text).toBeDefined();
  return found!;
}
function field(label: string, scope: ParentNode = document) {
  const found = scope.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`);
  expect(found, label).not.toBeNull();
  return found!;
}
async function setField(label: string, value: string, scope: ParentNode = document) {
  const element = field(label, scope);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  await act(async () => { element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function click(text: string, scope: ParentNode = document) { await act(async () => { button(text, scope).click(); }); }
async function open() {
  await act(async () => { root.render(createElement(FeedbackButton)); });
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="改善の要望を送る"]')!.click(); });
}
async function fill(omit = "", scope: ParentNode = document) {
  if (omit !== "種類") await click("不具合", scope);
  if (omit !== "どの機能か") await setField("どの機能か", "dashboard", scope);
  if (omit !== "困っていること") await setField("困っていること", "表示が重なって読めません。", scope);
  await setField("こうしてほしい", "文字を読めるようにしてほしい。", scope);
  if (omit !== "急ぎ度") await click("できれば", scope);
  if (omit !== "送った人") await setField("送った人", "北斗 太郎", scope);
}
async function paste(files: File[], target: Element = document.querySelector('[role="dialog"]')!, types: string[] = []) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files, types, getData: () => "plain text", items: files.map(file => ({
    kind: "file", type: file.type, getAsFile: () => file,
  })) } });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}
function previews() { return document.querySelectorAll('button[aria-label$="を大きく見る"]'); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  mocks.capture.mockResolvedValue(image.data);
  mocks.status.mockResolvedValue({ configured: true });
  mocks.save.mockResolvedValue({ configured: true });
  mocks.remove.mockResolvedValue({ configured: false });
  mocks.send.mockResolvedValue(undefined);
  mocks.normalize.mockResolvedValue(image);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

describe("feedback entry and draft", () => {
  it.each(["cancel", "send separately"])("recovers the first window's failed request after the second window chooses to %s", async action => {
    await open();
    const first = document.querySelector('[role="dialog"]')!;
    const secondWindow = createRoot(document.createElement("div"));
    try {
      await act(async () => {
        secondWindow.render(createElement(FeedbackDialog, {
          initialImages: [], captureMessage: "", onClose: () => secondWindow.render(null),
        }));
      });
      const second = [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog !== first)!;
      expect(field("困っていること", second).value).toBe("");
      mocks.send.mockRejectedValueOnce(new Error("synthetic send failure"));
      await fill("", first);
      await click("送る", first);
      await click("取消", first);

      if (action === "cancel") await click("取消", second);
      else {
        await fill("", second);
        await setField("困っていること", "別の要望です。", second);
        await click("送る", second);
        expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({ problem: "別の要望です。" }));
      }
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await open();
      expect(field("困っていること").value).toBe("表示が重なって読めません。");
      expect(field("こうしてほしい").value).toBe("文字を読めるようにしてほしい。");
    } finally {
      await act(async () => { secondWindow.unmount(); });
    }
  });

  it("places the mail button immediately before settings with the existing icon scale", () => {
    const source = readFileSync("src/components/layout/TitleBar.tsx", "utf8");
    const mail = source.indexOf("<FeedbackButton");
    const settings = source.indexOf("title={titleBarStrings.settings}");
    expect(mail).toBeGreaterThan(source.indexOf("<DashboardButton"));
    expect(settings).toBeGreaterThan(mail);
    expect(source.slice(mail, settings).match(/<button/g)).toHaveLength(1);
    const appInfo = readFileSync("src/components/settings/tabs/AppInfoTab.tsx", "utf8");
    expect(appInfo).toContain("<FeedbackDestinationSection");
  });
  it("captures before mounting the dialog and prevents repeated opening", async () => {
    const capture = deferred<string>();
    mocks.capture.mockReturnValue(capture.promise);
    await act(async () => { root.render(createElement(FeedbackButton)); });
    const entry = document.querySelector<HTMLButtonElement>('button[aria-label="改善の要望を送る"]')!;
    expect(entry.title).toBe("改善の要望を送る");
    const icon = entry.querySelector("svg")!;
    expect(icon.getAttribute("width")).toBe("12");
    expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(icon.getAttribute("stroke-width")).toBe("2");
    expect(icon.getAttribute("stroke-linecap")).toBe("round");
    expect(icon.getAttribute("stroke-linejoin")).toBe("round");
    await act(async () => { entry.click(); entry.click(); });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { capture.resolve(image.data); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(previews()).toHaveLength(1);
    expect(document.body.textContent).toContain("取引先の情報が写っていないか確かめてから送ってください。");
    expect(document.body.textContent).toContain("一緒に送る物: mycmux の版・OS・送る時刻");
  });
  it.each(["unavailable", "この OS では撮れません"])("opens without an image when capture fails: %s", async reason => {
    mocks.capture.mockRejectedValue(reason);
    await open();
    expect(previews()).toHaveLength(0);
    expect(document.body.textContent).toContain(reason === "unavailable" ? "画面を撮れませんでした" : reason);
  });
  it.each(["種類", "どの機能か", "困っていること", "急ぎ度", "送った人"])("cannot send without %s and explains what is missing", async label => {
    await open();
    await fill(label);
    expect(button("送る").disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(label);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("allows writing while unconfigured but does not send", async () => {
    mocks.status.mockResolvedValue({ configured: false });
    await open(); await fill();
    expect(document.body.textContent).toContain(unset);
    expect(field("困っていること").value).toBe("表示が重なって読めません。");
    expect(button("送る").disabled).toBe(true);
  });
  it("limits images to three, supports file choice and paste, removes and enlarges them", async () => {
    await open();
    const file = new File(["fake"], "sample.png", { type: "image/png" });
    await paste([file]);
    expect(previews()).toHaveLength(2);
    const chooser = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(chooser, "files", { configurable: true, value: [file, file] });
    await act(async () => { chooser.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(previews()).toHaveLength(3);
    expect(document.body.textContent).toContain("画像は3枚までです。");
    await paste([file]);
    expect(previews()).toHaveLength(3);
    await act(async () => { (previews()[0] as HTMLButtonElement).click(); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await click("閉じる");
    await click("外す");
    expect(previews()).toHaveLength(2);
  });
  it("keeps the text and images after failure, and restores only text after reopening", async () => {
    mocks.send.mockRejectedValue("送れませんでした。ネットにつながっているか確かめてください。");
    await open(); await fill();
    await paste([new File(["fake"], "sample.png", { type: "image/png" })]);
    await click("送る");
    expect(document.body.textContent).toContain("ネットにつながっているか確かめてください。");
    expect(previews()).toHaveLength(2);
    expect(field("困っていること").value).toBe("表示が重なって読めません。");
    await click("取消");
    await open();
    expect(field("困っていること").value).toBe("表示が重なって読めません。");
    expect(field("こうしてほしい").value).toBe("文字を読めるようにしてほしい。");
    expect(field("送った人").value).toBe("北斗 太郎");
    expect(previews()).toHaveLength(1);
    const persisted = Object.values(localStorage).join("");
    expect(persisted).not.toContain(image.data);
    expect(persisted).not.toContain("images");
  });
  it.each([false, true])("keeps the latest failed feedback on quota exhaustion (existing draft: %s)", async hadDraft => {
    mocks.send.mockRejectedValue(new Error("synthetic send failure"));
    await open();
    await fill();
    if (hadDraft) await click("送る");
    const originalSetItem = Storage.prototype.setItem;
    const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("mycmux.feedback.draft.")) throw new DOMException("Storage is full", "QuotaExceededError");
      originalSetItem.call(this, key, value);
    });
    try {
      await setField("困っていること", "保存できていない最新の本文です。");
      if (!hadDraft) await click("送る");
      await click("取消");

      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(field("困っていること").value).toBe("保存できていない最新の本文です。");
      expect(document.body.textContent).toContain("控えを保存できませんでした");
      const clipboard = vi.fn(async (_text: string) => {});
      vi.stubGlobal("navigator", { platform: navigator.platform, clipboard: { writeText: clipboard } });
      await click("本文をコピー");
      expect(clipboard).toHaveBeenCalledWith("保存できていない最新の本文です。\n\n文字を読めるようにしてほしい。");
      expect(field("困っていること").value).toBe("保存できていない最新の本文です。");
      await click("未保存の本文を破棄して閉じる");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(mocks.send).toHaveBeenCalledTimes(1);
      await open();
      expect(field("困っていること").value).toBe(hadDraft ? "表示が重なって読めません。" : "");
    } finally {
      quota.mockRestore();
    }
  });

  it.each([false, true])("opens an older failed request by key and keeps both on cancel (clock rolled back: %s)", async clockRolledBack => {
    const firstKey = "mycmux.feedback.draft.v2.first-id";
    const secondKey = "mycmux.feedback.draft.v2.second-id";
    const first = JSON.stringify({ problem: "先に書いた要望", failed: true, savedAt: clockRolledBack ? 900 : 100 });
    const second = JSON.stringify({ problem: "後に書いた要望", failed: true, savedAt: clockRolledBack ? 100 : 900 });
    localStorage.setItem(firstKey, first);
    localStorage.setItem(secondKey, second);

    await open();
    const picker = field("送れなかった要望") as HTMLSelectElement;
    expect([...picker.options].map(option => option.value)).toEqual(clockRolledBack ? [firstKey, secondKey] : [secondKey, firstKey]);
    const chosen = clockRolledBack ? secondKey : firstKey;
    await setField("送れなかった要望", chosen);
    expect(field("困っていること").value).toBe(clockRolledBack ? "後に書いた要望" : "先に書いた要望");
    await click("取消");

    expect(localStorage.getItem(firstKey)).toBe(first);
    expect(localStorage.getItem(secondKey)).toBe(second);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sends once, disables controls in flight, closes on success and remembers the sender", async () => {
    const sending = deferred<void>();
    mocks.send.mockReturnValue(sending.promise);
    await open(); await fill();
    await act(async () => { button("送る").click(); button("送る").click(); });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(button("送信中…").disabled).toBe(true);
    expect(button("取消").disabled).toBe(true);
    expect(mocks.send.mock.calls[0][0]).toEqual({
      category: "bug", feature: "dashboard", problem: "表示が重なって読めません。",
      want: "文字を読めるようにしてほしい。", urgency: "soon", sender: "北斗 太郎", images: [image],
    });
    await act(async () => { sending.resolve(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith("送りました", "info");
    await open();
    expect(field("困っていること").value).toBe("");
    expect(field("送った人").value).toBe("北斗 太郎");
  });
  it("discards an unfailed draft on cancel and rejects damaged or unexpected persisted fields", async () => {
    localStorage.setItem("mycmux.feedback.draft.v1", JSON.stringify({
      category: "unknown", feature: "unknown", urgency: "unknown", sender: "北斗 太郎",
      problem: "前の下書き", want: "", token: "xoxb-test-never-load", images: [image],
    }));
    await open();
    expect(field("困っていること").value).toBe("前の下書き");
    expect(field("どの機能か").value).toBe("");
    expect(button("送る").disabled).toBe(true);
    await click("取消");
    expect(Object.values(localStorage).join("")).not.toContain("xoxb-test-never-load");
    expect(localStorage.getItem("mycmux.feedback.draft.v1")).toBeNull();
    await open();
    expect(field("困っていること").value).toBe("");
  });
  it("does not display raw rejected errors and keeps the draft", async () => {
    mocks.send.mockRejectedValue(new Error("private-server-detail"));
    await open(); await fill(); await click("送る");
    expect(document.body.textContent).toContain("送れませんでした。");
    expect(document.body.textContent).not.toContain("private-server-detail");
    expect(field("困っていること").value).toBe("表示が重なって読めません。");
  });
  it("has the specified text limits and accepts blank optional text", async () => {
    await open(); await fill(); await setField("こうしてほしい", "");
    expect(field("困っていること").getAttribute("maxlength")).toBe("4000");
    expect(field("こうしてほしい").getAttribute("maxlength")).toBe("2000");
    expect(button("送る").disabled).toBe(false);
  });
});


function saveRequest(key: string, problem: string, savedAt: number) {
  localStorage.setItem(key, JSON.stringify({
    category: "bug", feature: "dashboard", problem, want: "", urgency: "soon", sender: "北斗 太郎", failed: true, savedAt,
  }));
}
const savedA = "mycmux.feedback.draft.v2.request-a";
const savedB = "mycmux.feedback.draft.v2.request-b";

it.each([true, false])("switches to another window's saved request only after keeping a new body (edited: %s)", async edited => {
  await open();
  expect(document.querySelector('[aria-label="送れなかった要望"]')).toBeNull();
  const problem = "書きかけの要望\nまだ入力しています。";
  const want = "本文を残してほしい。";
  if (edited) {
    await setField("困っていること", problem);
    await setField("こうしてほしい", want);
  }
  for (const [key, text] of [[savedA, "要望 A"], [savedB, "要望 B"]]) {
    saveRequest(key, text, key === savedA ? 100 : 200);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: localStorage.getItem(key), storageArea: localStorage }));
    });
  }
  const picker = field("送れなかった要望") as HTMLSelectElement;
  const savedRequests = () => Object.keys(localStorage).filter(key => key.startsWith("mycmux.feedback.draft.v2."));
  await setField("送れなかった要望", savedA);
  if (edited) {
    expect(field("困っていること").value).toBe(problem);
    expect(field("こうしてほしい").value).toBe(want);
    expect(picker.value).toBe("");
    expect(document.body.textContent).toContain("書きかけ");
    expect(savedRequests().sort()).toEqual([savedA, savedB]);

    const clipboard = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { platform: navigator.platform, clipboard: { writeText: clipboard } });
    await click("本文をコピー");
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(problem + "\n\n" + want);
    expect(field("困っていること").value).toBe(problem);
    expect(savedRequests().sort()).toEqual([savedA, savedB]);

    await click("別の要望として控えを残す");
    const newKey = savedRequests().find(key => key !== savedA && key !== savedB);
    expect(newKey).toBeDefined();
    expect(JSON.parse(localStorage.getItem(newKey!)!)).toMatchObject({ problem, want });
    const entry = [...picker.options].find(option => option.value === newKey);
    expect(entry?.textContent).toContain("書きかけの要望");
    await setField("送れなかった要望", savedA);
  }
  expect(field("困っていること").value).toBe("要望 A");
  expect(field("こうしてほしい").value).toBe("");
  expect(picker.value).toBe(savedA);
  expect(mocks.send).not.toHaveBeenCalled();
});

async function announcePeerFeedbackRequests() {
  saveRequest(savedA, "要望 A", 100);
  saveRequest(savedB, "要望 B", 200);
  await act(async () => {
    for (const key of [savedA, savedB]) {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: localStorage.getItem(key), storageArea: localStorage }));
    }
  });
}

it.each([
  { origin: "legacy unsent", legacy: true, edited: true },
  { origin: "new", legacy: false, edited: true },
  { origin: "legacy untouched", legacy: true, edited: false },
])("G2-003 treats a $origin request as unselected until a failed draft is kept", async ({ legacy, edited }) => {
  const legacyKey = "mycmux.feedback.draft.v1";
  const legacyDraft = JSON.stringify({ problem: "", want: "", failed: false });
  if (legacy) localStorage.setItem(legacyKey, legacyDraft);
  await open();
  const problem = "控えを選ぶ前に書いた本文";
  const want = "こちらにも入力した文";
  if (edited) {
    await setField("困っていること", problem);
    await setField("こうしてほしい", want);
  }

  await announcePeerFeedbackRequests();
  const picker = field("送れなかった要望") as HTMLSelectElement;
  await setField("送れなかった要望", savedA);
  if (edited) {
    expect.soft(field("困っていること").value).toBe(problem);
    expect.soft(field("こうしてほしい").value).toBe(want);
    expect.soft(picker.value).toBe("");
    expect.soft(picker.options[0]?.value).toBe("");
    expect(document.body.textContent).toContain(feedbackStrings.draftSwitchBlocked);
    expect(button(feedbackStrings.copyDraft)).toBeDefined();
    await click(feedbackStrings.keepAsSeparateRequest);
    const kept = Object.entries(localStorage).filter(([key]) =>
      key.startsWith("mycmux.feedback.draft.v2.") && key !== savedA && key !== savedB);
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0][1])).toMatchObject({ problem, want, failed: true });
    await setField("送れなかった要望", savedA);
  }
  expect(field("困っていること").value).toBe("要望 A");
  expect(picker.value).toBe(savedA);
  if (legacy) expect(localStorage.getItem(legacyKey)).toBe(legacyDraft);
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each([true, false])("G2-011 switches a legacy failed draft only after its edited body is kept (temporary read failure: %s)", async unavailable => {
  const legacyKey = "mycmux.feedback.draft.v1";
  saveRequest(legacyKey, "最初に保存された要望", 300);
  saveRequest(savedA, "要望 A", 100);
  saveRequest(savedB, "要望 B", 200);
  const stored = localStorage.getItem(legacyKey);
  await open();
  const picker = field("送れなかった要望") as HTMLSelectElement;
  expect(picker.value).toBe(legacyKey);

  const problem = "保存の照合が済んでいない編集";
  const want = "続けて入力した本文";
  const originalRead = Storage.prototype.getItem;
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
    if (unavailable && key === legacyKey) throw new Error("synthetic temporary read failure");
    return originalRead.call(this, key);
  });
  try {
    await setField("困っていること", problem);
    await setField("こうしてほしい", want);
  } finally {
    read.mockRestore();
  }
  await announcePeerFeedbackRequests();
  expect(picker.disabled).toBe(false);

  const keptEdits = () => Object.entries(localStorage).filter(([key]) =>
    key.startsWith("mycmux.feedback.draft.v2.") && key !== savedA && key !== savedB);
  await setField("送れなかった要望", savedA);
  if (unavailable) {
    expect.soft(field("困っていること").value).toBe(problem);
    expect.soft(field("こうしてほしい").value).toBe(want);
    expect.soft(picker.value).toBe(legacyKey);
    expect(keptEdits()).toHaveLength(0);
    expect(localStorage.getItem(legacyKey)).toBe(stored);
    expect(document.body.textContent).toContain(feedbackStrings.draftSwitchBlocked);
    const clipboard = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { platform: navigator.platform, clipboard: { writeText: clipboard } });
    await click(feedbackStrings.copyDraft);
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(problem + "\n\n" + want);
    expect(keptEdits()).toHaveLength(0);
    await click(feedbackStrings.keepAsSeparateRequest);
    expect(localStorage.getItem(legacyKey)).toBe(stored);
    await setField("送れなかった要望", savedA);
  }
  expect(keptEdits()).toHaveLength(1);
  expect(JSON.parse(keptEdits()[0][1])).toMatchObject({ problem, want });
  expect(field("困っていること").value).toBe("要望 A");
  expect(picker.value).toBe(savedA);
  expect(mocks.send).not.toHaveBeenCalled();
});

it("G2-007 hides the switch advice only while window close is being confirmed", async () => {
  await open();
  await setField("困っていること", "切り替えずに残す本文");
  await announcePeerFeedbackRequests();
  await setField("送れなかった要望", savedA);
  expect(document.body.textContent).toContain(feedbackStrings.draftSwitchBlocked);

  let close!: Promise<boolean>;
  await act(async () => { close = confirmFeedbackWindowClose(); });
  expect.soft(document.body.textContent).not.toContain(feedbackStrings.draftSwitchBlocked);
  expect(document.body.textContent).toContain(feedbackStrings.keepUnsavedDraft);
  expect([...document.querySelectorAll("button")].some(item => item.textContent === feedbackStrings.keepAsSeparateRequest))
    .toBe(false);
  await click("取消");
  await expect(close).resolves.toBe(false);
  expect(document.body.textContent).toContain(feedbackStrings.draftSwitchBlocked);
  expect(document.body.textContent).not.toContain(feedbackStrings.keepUnsavedDraft);
  expect(button(feedbackStrings.copyDraft)).toBeDefined();
  expect(button(feedbackStrings.keepAsSeparateRequest)).toBeDefined();
  expect(field("困っていること").value).toBe("切り替えずに残す本文");
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each([false, true])("never carries B's image to A when the selected request changes (normalizing: %s)", async normalizing => {
  saveRequest(savedA, "要望 A", 100);
  saveRequest(savedB, "要望 B", 200);
  mocks.capture.mockRejectedValue("unavailable");
  await open();
  expect(field("困っていること").value).toBe("要望 B");
  const conversion = deferred<typeof image>();
  if (normalizing) mocks.normalize.mockReturnValueOnce(conversion.promise);
  await paste([new File(["synthetic"], "request-b.png", { type: "image/png" })]);
  expect(previews()).toHaveLength(normalizing ? 0 : 1);

  await setField("送れなかった要望", savedA);
  expect(field("困っていること").value).toBe("要望 A");
  expect(document.body.textContent).toContain("要望を切り替えたため、前の画像を外しました。");
  await act(async () => { conversion.resolve(image); });
  await click("送る");

  expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ problem: "要望 A", images: [] }));
});

it.each(["select", "submit"])("does not send an already sent saved revision after a second window tries to %s it", async action => {
  saveRequest(savedA, "要望 A", 100);
  saveRequest(savedB, "要望 B", 200);
  await open();
  const first = document.querySelector('[role="dialog"]')!;
  await setField("送れなかった要望", savedA, first);
  const secondRoot = createRoot(document.createElement("div"));
  try {
    await act(async () => { secondRoot.render(createElement(FeedbackDialog, {
      initialImages: [], captureMessage: "", onClose: () => secondRoot.render(null),
    })); });
    const second = [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog !== first)!;
    expect(field("困っていること", second).value).toBe("要望 B");
    if (action === "submit") await setField("送れなかった要望", savedA, second);
    await click("送る", first);
    expect(localStorage.getItem(savedA)).toBeNull();
    if (action === "select") {
      // Model the interval before the other window's storage event is delivered.
      await setField("送れなかった要望", savedA, second);
      expect(field("困っていること", second).value).toBe("要望 B");
    } else {
      await click("送る", second);
      expect(field("困っていること", second).value).toBe("要望 A");
      expect(button("本文をコピー", second)).toBeDefined();
      await setField("困っていること", "要望 A の編集を保つ", second);
      expect(Object.keys(localStorage).filter(key => key.startsWith("mycmux.feedback.draft.v2."))).toEqual([savedB]);
      await click("別の要望として控えを残す", second);
      const otherKey = Object.keys(localStorage).find(key => key !== savedA && key !== savedB
        && key.startsWith("mycmux.feedback.draft.v2."));
      expect(otherKey).toBeDefined();
      expect(JSON.parse(localStorage.getItem(otherKey!)!).problem).toBe("要望 A の編集を保つ");
    }
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(savedB)).not.toBeNull();
  } finally {
    await act(async () => secondRoot.unmount());
  }
});

describe("feedback review regressions", () => {
  it.each(["困っていること", "こうしてほしい", "送った人"])("preserves mixed clipboard text in %s without adding an image", async label => {
    await open();
    const event = await paste([new File(["fake"], "sample.png", { type: "image/png" })], field(label), ["text/plain", "Files"]);
    expect(event.defaultPrevented).toBe(false);
    expect(previews()).toHaveLength(1);
    expect(mocks.normalize).toHaveBeenCalledTimes(1);
  });
  it("adds mixed clipboard images outside text fields and image-only paste inside a textarea", async () => {
    await open();
    const file = new File(["fake"], "sample.png", { type: "image/png" });
    expect((await paste([file], undefined, ["text/plain", "Files"])).defaultPrevented).toBe(true);
    expect((await paste([file], field("困っていること"), ["Files"])).defaultPrevented).toBe(true);
    expect(previews()).toHaveLength(3);
  });
  it.each(["cancel", "escape"])("discards a never-failed draft on %s while remembering the sender", async action => {
    await open(); await fill();
    expect(localStorage.getItem("mycmux.feedback.draft.v1")).toBeNull();
    if (action === "cancel") await click("取消");
    else await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(localStorage.getItem("mycmux.feedback.draft.v1")).toBeNull();
    await open();
    expect(field("困っていること").value).toBe("");
    expect(field("送った人").value).toBe("北斗 太郎");
  });
  it("retains an edited failed draft across repeated cancellation and clears it after success", async () => {
    mocks.send.mockRejectedValueOnce("送れませんでした。");
    await open(); await fill(); await click("送る"); await click("取消"); await open();
    await setField("困っていること", "revised failed request");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await open();
    expect(field("困っていること").value).toBe("revised failed request");
    await click("送る");
    expect(localStorage.getItem("mycmux.feedback.draft.v1")).toBeNull();
    await open();
    expect(field("困っていること").value).toBe("");
  });
  it("trims the destination and key before client validation and sending", async () => {
    await act(async () => { root.render(createElement(FeedbackDestinationSection)); });
    await click("設定する");
    await setField("Slack の鍵", "  xoxb-test-fake  ");
    await setField("届け先", "  U000TEST1  ");
    await click("保存");
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith("xoxb-test-fake", "U000TEST1");
  });
  it("allows replacement after a failed status lookup and keeps recovery after cancelling", async () => {
    mocks.status.mockRejectedValue(new Error("unreadable"));
    await act(async () => { root.render(createElement(FeedbackDestinationSection)); });
    expect(button("外す").disabled).toBe(false);
    await click("設定する"); await click("取消");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("送り先を確かめられませんでした。");
    await click("設定する");
    await setField("Slack の鍵", "xoxb-test-fake"); await setField("届け先", "C000TEST1"); await click("保存");
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith("xoxb-test-fake", "C000TEST1");
    expect(document.body.textContent).toContain("設定済み");
  });
  it("allows confirmed removal after a failed status lookup", async () => {
    mocks.status.mockRejectedValue(new Error("unreadable"));
    await act(async () => { root.render(createElement(FeedbackDestinationSection)); });
    await click("外す");
    expect(mocks.remove).not.toHaveBeenCalled();
    await click("送り先を外す");
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("未設定");
  });
});

describe("feedback destination settings", () => {
  it("offers no writes while status is pending and recovery actions when it is unknown", async () => {
    const status = deferred<unknown>();
    mocks.status.mockReturnValue(status.promise);
    await act(async () => { root.render(createElement(FeedbackDestinationSection)); });
    expect([...document.querySelectorAll("button")]).toHaveLength(0);
    await act(async () => { status.resolve(null); });
    expect(document.body.textContent).toContain("送り先を確かめられませんでした。");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(button("設定する").disabled).toBe(false);
    expect(button("外す").disabled).toBe(false);
  });
  it("shows status only, accepts a masked key, saves and clears both input fields", async () => {
    mocks.status.mockResolvedValue({ configured: false });
    await act(async () => { root.render(createElement(FeedbackDestinationSection)); });
    expect(document.body.textContent).toContain("改善の要望の送り先");
    expect(document.body.textContent).toContain("未設定");
    await click("設定する");
    expect(field("Slack の鍵").getAttribute("type")).toBe("password");
    await setField("Slack の鍵", "xoxb-test-fake");
    await setField("届け先", "C000TEST1");
    await click("保存");
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith("xoxb-test-fake", "C000TEST1");
    expect(document.body.textContent).toContain("設定済み");
    expect(document.body.innerHTML).not.toContain("xoxb-test-fake");
    expect(document.body.innerHTML).not.toContain("C000TEST1");
    expect(Object.values(localStorage).join("")).not.toContain("xoxb-test-fake");
    await click("設定する");
    expect(field("Slack の鍵").value).toBe("");
    expect(field("届け先").value).toBe("");
  });
  it("validates key and destination locally and never sends them to status", async () => {
    await act(async () => { root.render(createElement(FeedbackDestinationSection)); });
    await click("設定する");
    await setField("Slack の鍵", "xoxp-test-wrong"); await setField("届け先", "C000TEST1"); await click("保存");
    expect(mocks.save).not.toHaveBeenCalled();
    await setField("Slack の鍵", "xoxb-test-fake"); await setField("届け先", "https://example.test"); await click("保存");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("鍵と届け先の形を確かめてください。");
    expect(mocks.status.mock.calls.every(call => call.length === 0)).toBe(true);
  });
  it("requires confirmation before removal and restores unset status", async () => {
    await act(async () => { root.render(createElement(FeedbackDestinationSection)); });
    expect(document.body.textContent).toContain("設定済み");
    await click("外す");
    expect(document.body.textContent).toContain("改善の要望の送り先を外しますか。");
    expect(mocks.remove).not.toHaveBeenCalled();
    await click("戻る");
    expect(mocks.remove).not.toHaveBeenCalled();
    await click("外す"); await click("送り先を外す");
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("未設定");
  });
});
