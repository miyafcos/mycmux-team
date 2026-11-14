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
function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text);
  expect(found, text).toBeDefined();
  return found!;
}
function field(label: string) {
  const found = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`);
  expect(found, label).not.toBeNull();
  return found!;
}
async function setField(label: string, value: string) {
  const element = field(label);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  await act(async () => { element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function click(text: string) { await act(async () => { button(text).click(); }); }
async function open() {
  await act(async () => { root.render(createElement(FeedbackButton)); });
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="改善の要望を送る"]')!.click(); });
}
async function fill(omit = "") {
  if (omit !== "種類") await click("不具合");
  if (omit !== "どの機能か") await setField("どの機能か", "dashboard");
  if (omit !== "困っていること") await setField("困っていること", "表示が重なって読めません。");
  await setField("こうしてほしい", "文字を読めるようにしてほしい。");
  if (omit !== "急ぎ度") await click("できれば");
  if (omit !== "送った人") await setField("送った人", "北斗 太郎");
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
