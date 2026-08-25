import { handleSocketCommand, readPaneTail } from "../layout/socketCommands";
import { getSessionInputRevision } from "../../lib/ipc";
import { scanAskQuestion, type AskOption, type AskScreen } from "../../lib/askQuestionScan";
import { useSessionAttentionStore, type SessionAttention } from "../../stores/sessionAttentionStore";
import {
  ASK_QUESTION_TAIL_LINES,
  checkedOptionIndexes,
  getAskQuestionSession,
  ingestAskQuestionLines,
  questionKey,
  screenContentKey,
  screenStateKey,
  useAskQuestionStore,
  type AskStopReason,
} from "../../stores/askQuestionStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";

export type AskSentKey =
  | { kind: "text"; text: string }
  | { kind: "key"; key: string };

export interface AskSubmitResult {
  ok: boolean;
  stopReason: AskStopReason | null;
  keysSent: AskSentKey[];
}

export interface AskQuestionDeps {
  readTail: (sessionId: string, lines: number) => Promise<string[]>;
  readInputRevision: (sessionId: string) => Promise<number>;
  send: (args: Record<string, unknown>) => Promise<unknown>;
  attentionFor: (sessionId: string) => SessionAttention | undefined;
  sessionExists: (sessionId: string) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitTimeoutMs: number;
  pollMs: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 1_500;
const DEFAULT_POLL_MS = 50;

function defaultDeps(): AskQuestionDeps {
  return {
    readTail: (sessionId, lines) => readPaneTail(sessionId, lines, true),
    readInputRevision: (sessionId) => getSessionInputRevision(sessionId),
    send: (args) => handleSocketCommand("pane.send_text", args),
    attentionFor: (sessionId) => useSessionAttentionStore.getState().attentionBySession[sessionId],
    sessionExists: (sessionId) => useWorkspaceListStore.getState().workspaces.some((workspace) => (
      workspace.panes.some((pane) => pane.tabs.some((tab) => tab.sessionId === sessionId))
    )),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
  };
}

function mergeDeps(overrides?: Partial<AskQuestionDeps>): AskQuestionDeps {
  return { ...defaultDeps(), ...overrides };
}

function emptyResult(stopReason: AskStopReason | null, keysSent: AskSentKey[] = []): AskSubmitResult {
  return { ok: false, stopReason, keysSent };
}

function okResult(keysSent: AskSentKey[]): AskSubmitResult {
  return { ok: true, stopReason: null, keysSent };
}

function sendRejected(result: unknown): result is { sent: false; reason?: string } {
  return Boolean(result && typeof result === "object" && "sent" in result && (result as { sent: unknown }).sent === false);
}

function sendUnconfirmed(result: unknown): boolean {
  return Boolean(
    result
    && typeof result === "object"
    && "ok" in result
    && (result as { ok: unknown }).ok === false,
  );
}

function lockStopReason(result: { sent: false; reason?: string }): AskStopReason {
  if (result.reason === "attention_id") return "attention_mismatch";
  if (
    result.reason === "session_revision"
    || result.reason === "session_epoch"
    || result.reason === "input_revision"
    || result.reason === "incomplete_expectations"
  ) {
    return "session_revision_mismatch";
  }
  if (result.reason === "unknown_session") return "target_disappeared";
  return "ambiguous";
}

export function findNumberedOption(screen: AskScreen, index: number): AskOption | undefined {
  if (!Number.isInteger(index) || index < 1 || index > 9) return undefined;
  return screen.options.find((option) => option.index === index && option.role === "option");
}

export function findSubmitOption(screen: AskScreen): AskOption | undefined {
  return screen.options.find((option) => option.role === "submit" && option.index === null);
}

export function currentOptionIndex(screen: AskScreen): number {
  return screen.options.findIndex((option) => option.current);
}

interface AskInputLock {
  expectedAttentionId: string;
  expectedSessionEpoch: number;
  expectedSessionRevision: number;
  expectedInputRevision: number;
}

function captureLock(
  attention: SessionAttention | undefined,
  expectedInputRevision: number | null,
): AskInputLock | null {
  if (
    !attention?.attentionId
    || attention.kind !== "input"
    || !Number.isInteger(attention.sessionEpoch)
    || attention.sessionEpoch! < 0
    || !Number.isInteger(expectedInputRevision)
    || expectedInputRevision! < 0
  ) {
    return null;
  }
  return {
    expectedAttentionId: attention.attentionId,
    expectedSessionEpoch: attention.sessionEpoch!,
    expectedSessionRevision: attention.sessionRevision,
    expectedInputRevision: expectedInputRevision!,
  };
}

function lockArgs(
  sessionId: string,
  lock: AskInputLock,
): Record<string, unknown> {
  return {
    sessionId,
    expectedAttentionId: lock.expectedAttentionId,
    expectedSessionEpoch: lock.expectedSessionEpoch,
    expectedSessionRevision: lock.expectedSessionRevision,
    expectedInputRevision: lock.expectedInputRevision,
  };
}

interface Preflight {
  screen: AskScreen;
  lock: AskInputLock;
  screenRevision: number;
}

async function preflight(
  sessionId: string,
  expected: {
    contentKey: string;
    activeTab?: string;
    checked?: number[];
    screenRevision: number;
    expectedAttentionId: string;
    expectedSessionEpoch: number;
    expectedSessionRevision: number;
    expectedInputRevision: number;
  },
  deps: AskQuestionDeps,
  keysSent: AskSentKey[],
): Promise<Preflight | AskSubmitResult> {
  if (!deps.sessionExists(sessionId)) {
    useAskQuestionStore.getState().clearScreen(sessionId, "target_disappeared");
    return emptyResult("target_disappeared", keysSent);
  }

  const attention = deps.attentionFor(sessionId);
  if (!attention?.attentionId || attention.kind !== "input") {
    useAskQuestionStore.getState().setStopReason(sessionId, "attention_mismatch");
    return emptyResult("attention_mismatch", keysSent);
  }
  if (attention.attentionId !== expected.expectedAttentionId) {
    useAskQuestionStore.getState().setStopReason(sessionId, "attention_mismatch");
    return emptyResult("attention_mismatch", keysSent);
  }
  if (attention.sessionEpoch !== expected.expectedSessionEpoch) {
    useAskQuestionStore.getState().setStopReason(sessionId, "session_revision_mismatch");
    return emptyResult("session_revision_mismatch", keysSent);
  }
  if (expected.expectedSessionRevision !== attention.sessionRevision) {
    useAskQuestionStore.getState().setStopReason(sessionId, "session_revision_mismatch");
    return emptyResult("session_revision_mismatch", keysSent);
  }

  let lines: string[];
  let observedInputRevision: number;
  try {
    observedInputRevision = await deps.readInputRevision(sessionId);
    lines = await deps.readTail(sessionId, ASK_QUESTION_TAIL_LINES);
  } catch {
    useAskQuestionStore.getState().clearScreen(sessionId, "read_failure");
    return emptyResult("read_failure", keysSent);
  }

  const screen = ingestAskQuestionLines(sessionId, lines, deps.now(), observedInputRevision);
  if (!screen) {
    useAskQuestionStore.getState().clearScreen(sessionId, "null_scan");
    return emptyResult("null_scan", keysSent);
  }

  const storeRevision = getAskQuestionSession(sessionId).revision;
  if (storeRevision !== expected.screenRevision && screenContentKey(screen) !== expected.contentKey) {
    useAskQuestionStore.getState().setStopReason(sessionId, "stale_question");
    return emptyResult("stale_question", keysSent);
  }
  if (screenContentKey(screen) !== expected.contentKey) {
    useAskQuestionStore.getState().setStopReason(sessionId, "stale_question");
    return emptyResult("stale_question", keysSent);
  }
  if (expected.activeTab !== undefined) {
    const active = screen.tabs.find((tab) => tab.active)?.label;
    if (active !== expected.activeTab) {
      useAskQuestionStore.getState().setStopReason(sessionId, "stale_question");
      return emptyResult("stale_question", keysSent);
    }
  }
  if (expected.checked) {
    const actual = checkedOptionIndexes(screen);
    if (actual.length !== expected.checked.length || actual.some((value, index) => value !== expected.checked![index])) {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }
  }

  const lock = captureLock(
    deps.attentionFor(sessionId),
    getAskQuestionSession(sessionId).expectedInputRevision,
  );
  if (!lock || lock.expectedAttentionId !== expected.expectedAttentionId) {
    useAskQuestionStore.getState().setStopReason(sessionId, "attention_mismatch");
    return emptyResult("attention_mismatch", keysSent);
  }
  if (
    expected.expectedSessionRevision !== lock.expectedSessionRevision
    || expected.expectedInputRevision !== lock.expectedInputRevision
  ) {
    useAskQuestionStore.getState().setStopReason(sessionId, "session_revision_mismatch");
    return emptyResult("session_revision_mismatch", keysSent);
  }

  return { screen, lock, screenRevision: getAskQuestionSession(sessionId).revision };
}

async function sendOnce(
  sessionId: string,
  key: AskSentKey,
  lock: AskInputLock,
  deps: AskQuestionDeps,
  keysSent: AskSentKey[],
): Promise<AskSubmitResult | null> {
  try {
    const result = await deps.send({
      ...lockArgs(sessionId, lock),
      ...(key.kind === "text" ? { text: key.text } : { text: "", key: key.key }),
    });
    if (sendRejected(result)) {
      const reason = lockStopReason(result);
      useAskQuestionStore.getState().setStopReason(sessionId, reason);
      return emptyResult(reason, keysSent);
    }
    if (sendUnconfirmed(result)) {
      keysSent.push(key);
      useAskQuestionStore.getState().setStopReason(sessionId, "unchanged_screen");
      return emptyResult("unchanged_screen", keysSent);
    }
    useAskQuestionStore.getState().advanceInputRevision(
      sessionId,
      lock.expectedInputRevision,
    );
    keysSent.push(key);
    return null;
  } catch {
    useAskQuestionStore.getState().setStopReason(sessionId, "transport");
    return emptyResult("transport", keysSent);
  }
}

type WaitOutcome =
  | { kind: "screen"; screen: AskScreen }
  | { kind: "gone" }
  | { kind: "stop"; result: AskSubmitResult };

async function waitForScreenChange(
  sessionId: string,
  before: AskScreen,
  deps: AskQuestionDeps,
  keysSent: AskSentKey[],
): Promise<WaitOutcome> {
  const beforeState = screenStateKey(before);
  const polls = Math.max(1, Math.ceil(deps.waitTimeoutMs / deps.pollMs));
  for (let poll = 0; poll < polls; poll += 1) {
    await deps.sleep(deps.pollMs);
    if (!deps.sessionExists(sessionId)) {
      useAskQuestionStore.getState().clearScreen(sessionId, "target_disappeared");
      return { kind: "stop", result: emptyResult("target_disappeared", keysSent) };
    }
    let lines: string[];
    let observedInputRevision: number;
    try {
      observedInputRevision = await deps.readInputRevision(sessionId);
      lines = await deps.readTail(sessionId, ASK_QUESTION_TAIL_LINES);
    } catch {
      useAskQuestionStore.getState().clearScreen(sessionId, "read_failure");
      return { kind: "stop", result: emptyResult("read_failure", keysSent) };
    }
    const screen = scanAskQuestion(lines);
    if (!screen) {
      if (poll + 1 < polls) continue;
      ingestAskQuestionLines(sessionId, lines, deps.now(), observedInputRevision);
      return { kind: "gone" };
    }
    if (screenStateKey(screen) !== beforeState) {
      ingestAskQuestionLines(sessionId, lines, deps.now(), observedInputRevision);
      return { kind: "screen", screen };
    }
  }
  useAskQuestionStore.getState().setStopReason(sessionId, "unchanged_screen");
  return { kind: "stop", result: emptyResult("unchanged_screen", keysSent) };
}

function beginSubmit(sessionId: string): AskSubmitResult | null {
  const store = useAskQuestionStore.getState();
  if (getAskQuestionSession(sessionId).inFlight) {
    store.setStopReason(sessionId, "busy");
    return emptyResult("busy");
  }
  store.setInFlight(sessionId, true);
  store.setStopReason(sessionId, null);
  return null;
}

function expectedFromStore(sessionId: string, deps: AskQuestionDeps): {
  contentKey: string;
  activeTab?: string;
  screenRevision: number;
  expectedAttentionId: string;
  expectedSessionEpoch: number;
  expectedSessionRevision: number;
  expectedInputRevision: number;
} | AskSubmitResult {
  const session = getAskQuestionSession(sessionId);
  if (!session.screen) return emptyResult("null_scan");
  if (session.expectedInputRevision === null) return emptyResult("session_revision_mismatch");
  const lock = captureLock(deps.attentionFor(sessionId), session.expectedInputRevision);
  if (!lock) return emptyResult("attention_mismatch");
  const activeTab = session.screen.tabs.find((tab) => tab.active)?.label;
  return {
    contentKey: screenContentKey(session.screen),
    ...(activeTab !== undefined ? { activeTab } : {}),
    screenRevision: session.revision,
    expectedAttentionId: lock.expectedAttentionId,
    expectedSessionEpoch: lock.expectedSessionEpoch,
    expectedSessionRevision: lock.expectedSessionRevision,
    expectedInputRevision: lock.expectedInputRevision,
  };
}

function pauseForUndiscovered(
  sessionId: string,
  next: AskScreen,
  keysSent: AskSentKey[],
): AskSubmitResult {
  const key = questionKey(next);
  const confirmed = getAskQuestionSession(sessionId).confirmedKeys;
  if (next.kind === "review" || confirmed.includes(key) || confirmed.includes("review")) {
    return okResult(keysSent);
  }
  useAskQuestionStore.getState().setStopReason(sessionId, "needs_confirmation");
  useAskQuestionStore.getState().setConfirmedStage(sessionId, "awaiting_confirmation");
  return {
    ok: false,
    stopReason: "needs_confirmation",
    keysSent,
  };
}

async function sendNumberedKey(
  sessionId: string,
  screen: AskScreen,
  lock: AskInputLock,
  index: number,
  deps: AskQuestionDeps,
  keysSent: AskSentKey[],
): Promise<WaitOutcome | AskSubmitResult> {
  const option = findNumberedOption(screen, index);
  if (!option || option.index === null) {
    useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
    return emptyResult("ambiguous", keysSent);
  }
  const failed = await sendOnce(sessionId, { kind: "text", text: String(index) }, lock, deps, keysSent);
  if (failed) return failed;
  return waitForScreenChange(sessionId, screen, deps, keysSent);
}

/**
 * Send one numbered choice for the currently visible question. Never invents
 * answers for tabs that have not been shown, and never retries a key.
 */
export async function submitAskQuestionChoice(
  sessionId: string,
  optionIndex: number,
  overrides?: Partial<AskQuestionDeps>,
): Promise<AskSubmitResult> {
  const deps = mergeDeps(overrides);
  const busy = beginSubmit(sessionId);
  if (busy) return busy;
  const keysSent: AskSentKey[] = [];
  try {
    const session = getAskQuestionSession(sessionId);
    if (!session.screen) return emptyResult("null_scan", keysSent);
    if (session.screen.kind === "review") {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }
    const key = questionKey(session.screen);
    useAskQuestionStore.getState().setDraft(sessionId, key, optionIndex);
    useAskQuestionStore.getState().confirmQuestion(sessionId, key);

    const expected = expectedFromStore(sessionId, deps);
    if ("ok" in expected) return expected;
    const ready = await preflight(sessionId, expected, deps, keysSent);
    if ("ok" in ready) return ready;

    if (!findNumberedOption(ready.screen, optionIndex)) {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }

    const wait = await sendNumberedKey(sessionId, ready.screen, ready.lock, optionIndex, deps, keysSent);
    if ("ok" in wait) return wait;
    if (wait.kind === "gone") {
      const reason = ready.screen.kind === "single" ? null : "ambiguous";
      useAskQuestionStore.getState().clearScreen(sessionId, reason);
      return reason ? emptyResult(reason, keysSent) : okResult(keysSent);
    }
    if (wait.kind === "stop") return wait.result;
    if (wait.screen.kind === "review") {
      useAskQuestionStore.getState().setConfirmedStage(sessionId, "review");
      return okResult(keysSent);
    }
    if (screenContentKey(wait.screen) === expected.contentKey) {
      useAskQuestionStore.getState().setStopReason(sessionId, "unchanged_screen");
      return emptyResult("unchanged_screen", keysSent);
    }
    const nextKey = questionKey(wait.screen);
    if (!session.confirmedKeys.includes(nextKey) && nextKey !== key) {
      return pauseForUndiscovered(sessionId, wait.screen, keysSent);
    }
    return okResult(keysSent);
  } finally {
    useAskQuestionStore.getState().setInFlight(sessionId, false);
  }
}

async function toggleUntilChecked(
  sessionId: string,
  desired: number[],
  start: Preflight,
  deps: AskQuestionDeps,
  keysSent: AskSentKey[],
): Promise<Preflight | AskSubmitResult> {
  let current = start;
  const wanted = [...desired].sort((left, right) => left - right);
  for (;;) {
    const actual = checkedOptionIndexes(current.screen);
    const extra = actual.filter((index) => !wanted.includes(index));
    const missing = wanted.filter((index) => !actual.includes(index));
    const nextIndex = [...extra, ...missing].sort((left, right) => left - right)[0];
    if (nextIndex === undefined) return current;

    const expectedChecked = [...actual].sort((left, right) => left - right);
    const expected = expectedFromStore(sessionId, deps);
    if ("ok" in expected) return expected;
    const ready = await preflight(sessionId, {
      ...expected,
      contentKey: screenContentKey(current.screen),
      checked: expectedChecked,
      screenRevision: getAskQuestionSession(sessionId).revision,
    }, deps, keysSent);
    if ("ok" in ready) return ready;

    const beforeChecked = new Set(checkedOptionIndexes(ready.screen));
    const wait = await sendNumberedKey(sessionId, ready.screen, ready.lock, nextIndex, deps, keysSent);
    if ("ok" in wait) return wait;
    if (wait.kind === "gone") {
      useAskQuestionStore.getState().clearScreen(sessionId, "target_disappeared");
      return emptyResult("target_disappeared", keysSent);
    }
    if (wait.kind === "stop") return wait.result;
    if (wait.screen.kind !== ready.screen.kind || screenContentKey(wait.screen) !== screenContentKey(ready.screen)) {
      useAskQuestionStore.getState().setStopReason(sessionId, "stale_question");
      return emptyResult("stale_question", keysSent);
    }
    const afterChecked = new Set(checkedOptionIndexes(wait.screen));
    const flipped = afterChecked.has(nextIndex) !== beforeChecked.has(nextIndex);
    if (!flipped) {
      useAskQuestionStore.getState().setStopReason(sessionId, "unchanged_screen");
      return emptyResult("unchanged_screen", keysSent);
    }
    current = {
      screen: wait.screen,
      lock: captureLock(
        deps.attentionFor(sessionId),
        getAskQuestionSession(sessionId).expectedInputRevision,
      ) ?? ready.lock,
      screenRevision: getAskQuestionSession(sessionId).revision,
    };
  }
}

async function moveToSubmitRow(
  sessionId: string,
  start: Preflight,
  deps: AskQuestionDeps,
  keysSent: AskSentKey[],
): Promise<Preflight | AskSubmitResult> {
  let current = start;
  for (;;) {
    const submit = findSubmitOption(current.screen);
    if (!submit) {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }
    if (submit.current) return current;

    const cursor = currentOptionIndex(current.screen);
    if (cursor < 0) {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }
    const submitIndex = current.screen.options.indexOf(submit);
    if (submitIndex < cursor) {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }

    const expected = expectedFromStore(sessionId, deps);
    if ("ok" in expected) return expected;
    const ready = await preflight(sessionId, {
      ...expected,
      contentKey: screenContentKey(current.screen),
      screenRevision: getAskQuestionSession(sessionId).revision,
    }, deps, keysSent);
    if ("ok" in ready) return ready;
    if (findSubmitOption(ready.screen)?.current) {
      current = ready;
      continue;
    }

    const failed = await sendOnce(sessionId, { kind: "key", key: "down" }, ready.lock, deps, keysSent);
    if (failed) return failed;
    const wait = await waitForScreenChange(sessionId, ready.screen, deps, keysSent);
    if (wait.kind === "gone") {
      useAskQuestionStore.getState().clearScreen(sessionId, "target_disappeared");
      return emptyResult("target_disappeared", keysSent);
    }
    if (wait.kind === "stop") return wait.result;
    if (screenContentKey(wait.screen) !== screenContentKey(ready.screen)) {
      useAskQuestionStore.getState().setStopReason(sessionId, "stale_question");
      return emptyResult("stale_question", keysSent);
    }
    const previousCursor = currentOptionIndex(ready.screen);
    const nextCursor = currentOptionIndex(wait.screen);
    if (nextCursor !== previousCursor + 1) {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }
    current = {
      screen: wait.screen,
      lock: captureLock(
        deps.attentionFor(sessionId),
        getAskQuestionSession(sessionId).expectedInputRevision,
      ) ?? ready.lock,
      screenRevision: getAskQuestionSession(sessionId).revision,
    };
  }
}

/**
 * Apply the operator's multiSelect draft: toggle the symmetric difference,
 * walk down to the unnumbered Submit row, press Enter once, then confirm
 * review with "1" only after the review screen is actually present.
 */
export async function submitAskQuestionMultiSelect(
  sessionId: string,
  overrides?: Partial<AskQuestionDeps>,
): Promise<AskSubmitResult> {
  const deps = mergeDeps(overrides);
  const busy = beginSubmit(sessionId);
  if (busy) return busy;
  const keysSent: AskSentKey[] = [];
  try {
    const session = getAskQuestionSession(sessionId);
    if (!session.screen) return emptyResult("null_scan", keysSent);
    if (!session.screen.multiSelect) {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }
    const key = questionKey(session.screen);
    const desired = session.draftChecked[key] ?? checkedOptionIndexes(session.screen);
    useAskQuestionStore.getState().confirmQuestion(sessionId, key);

    const expected = expectedFromStore(sessionId, deps);
    if ("ok" in expected) return expected;
    const ready = await preflight(sessionId, {
      ...expected,
      checked: checkedOptionIndexes(session.screen),
    }, deps, keysSent);
    if ("ok" in ready) return ready;

    const toggled = await toggleUntilChecked(sessionId, desired, ready, deps, keysSent);
    if ("ok" in toggled) return toggled;

    const onSubmit = await moveToSubmitRow(sessionId, toggled, deps, keysSent);
    if ("ok" in onSubmit) return onSubmit;
    if (!findSubmitOption(onSubmit.screen)?.current) {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }

    const expectedEnter = expectedFromStore(sessionId, deps);
    if ("ok" in expectedEnter) return expectedEnter;
    const enterReady = await preflight(sessionId, {
      ...expectedEnter,
      contentKey: screenContentKey(onSubmit.screen),
      screenRevision: getAskQuestionSession(sessionId).revision,
    }, deps, keysSent);
    if ("ok" in enterReady) return enterReady;
    if (!findSubmitOption(enterReady.screen)?.current) {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }

    const failed = await sendOnce(sessionId, { kind: "key", key: "enter" }, enterReady.lock, deps, keysSent);
    if (failed) return failed;
    const afterEnter = await waitForScreenChange(sessionId, enterReady.screen, deps, keysSent);
    if (afterEnter.kind === "gone") {
      useAskQuestionStore.getState().clearScreen(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }
    if (afterEnter.kind === "stop") return afterEnter.result;
    if (afterEnter.screen.kind !== "review") {
      useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
      return emptyResult("ambiguous", keysSent);
    }

    return submitReviewFromScreen(sessionId, afterEnter.screen, deps, keysSent);
  } finally {
    useAskQuestionStore.getState().setInFlight(sessionId, false);
  }
}

async function submitReviewFromScreen(
  sessionId: string,
  screen: AskScreen,
  deps: AskQuestionDeps,
  keysSent: AskSentKey[],
): Promise<AskSubmitResult> {
  if (screen.kind !== "review") {
    useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
    return emptyResult("ambiguous", keysSent);
  }
  const submit = screen.options.find((option) => option.index === 1 && option.role === "submit");
  if (!submit) {
    useAskQuestionStore.getState().setStopReason(sessionId, "ambiguous");
    return emptyResult("ambiguous", keysSent);
  }

  const expected = expectedFromStore(sessionId, deps);
  if ("ok" in expected) return expected;
  const ready = await preflight(sessionId, {
    ...expected,
    contentKey: screenContentKey(screen),
    screenRevision: getAskQuestionSession(sessionId).revision,
  }, deps, keysSent);
  if ("ok" in ready) return ready;
  if (ready.screen.kind !== "review") {
    useAskQuestionStore.getState().setStopReason(sessionId, "stale_question");
    return emptyResult("stale_question", keysSent);
  }

  const failed = await sendOnce(sessionId, { kind: "text", text: "1" }, ready.lock, deps, keysSent);
  if (failed) return failed;
  const wait = await waitForScreenChange(sessionId, ready.screen, deps, keysSent);
  if (wait.kind === "gone") {
    useAskQuestionStore.getState().clearScreen(sessionId);
    return okResult(keysSent);
  }
  if (wait.kind === "stop") return wait.result;
  if (wait.screen.kind === "review" && screenContentKey(wait.screen) === screenContentKey(ready.screen)) {
    useAskQuestionStore.getState().setStopReason(sessionId, "unchanged_screen");
    return emptyResult("unchanged_screen", keysSent);
  }
  return okResult(keysSent);
}

export async function submitAskQuestionReview(
  sessionId: string,
  overrides?: Partial<AskQuestionDeps>,
): Promise<AskSubmitResult> {
  const deps = mergeDeps(overrides);
  const busy = beginSubmit(sessionId);
  if (busy) return busy;
  const keysSent: AskSentKey[] = [];
  try {
    const session = getAskQuestionSession(sessionId);
    if (!session.screen) return emptyResult("null_scan", keysSent);
    useAskQuestionStore.getState().confirmQuestion(sessionId, "review");
    return submitReviewFromScreen(sessionId, session.screen, deps, keysSent);
  } finally {
    useAskQuestionStore.getState().setInFlight(sessionId, false);
  }
}

export function toggleAskQuestionDraft(sessionId: string, optionIndex: number): void {
  const session = getAskQuestionSession(sessionId);
  if (!session.screen) return;
  const key = questionKey(session.screen);
  const current = session.draftChecked[key] ?? checkedOptionIndexes(session.screen);
  const next = current.includes(optionIndex)
    ? current.filter((value) => value !== optionIndex)
    : [...current, optionIndex].sort((left, right) => left - right);
  useAskQuestionStore.getState().setDraftChecked(sessionId, key, next);
}

export function isAskQuestionBusy(sessionId: string): boolean {
  return getAskQuestionSession(sessionId).inFlight;
}
