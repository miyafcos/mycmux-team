import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  loadWebPanePresets,
  startWebPaneSignin,
  WEB_PANE_SIGNIN_EVENT,
  WEB_PANE_URL_EVENT,
  type WebPaneSigninEvent,
  type WebPaneUrlEvent,
} from "./webPaneApi";
import { webPaneStrings } from "./webPaneStrings";

interface WebPaneStatusBarProps {
  tabId: string;
  presetId: string;
}

type SigninState = "idle" | "running" | "reopening";

/**
 * The bar above a web pane. It stays out of the way once the service is signed
 * in -- the old banner was unconditional, so it read as "log in again" on every
 * launch even when nothing was wrong.
 */
export default function WebPaneStatusBar({ tabId, presetId }: WebPaneStatusBarProps) {
  const [label, setLabel] = useState(presetId);
  // null until the pane reports its first navigation: an unknown state is not a
  // reason to tell the operator anything.
  const [signedOut, setSignedOut] = useState<boolean | null>(null);
  const [signin, setSignin] = useState<SigninState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadWebPanePresets()
      .then((presets) => {
        if (cancelled) return;
        setLabel(presets.find((preset) => preset.id === presetId)?.label ?? presetId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [presetId]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<WebPaneUrlEvent>(WEB_PANE_URL_EVENT, (event) => {
      if (event.payload.tabId !== tabId) return;
      setSignedOut(event.payload.signedOut);
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      unlisten?.();
      cancelled = true;
    };
  }, [tabId]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<WebPaneSigninEvent>(WEB_PANE_SIGNIN_EVENT, (event) => {
      const { tabIds, state, error: reported } = event.payload;
      if (!tabIds.includes(tabId)) return;
      if (state === "running") {
        setSignin("running");
        setError(null);
        return;
      }
      setSignin(state === "failed" ? "idle" : "reopening");
      if (reported) setError(reported);
      // The pane comes back through the controller's reconcile, and the next
      // navigation replaces this with the real state.
      setSignedOut(null);
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      unlisten?.();
      cancelled = true;
    };
  }, [tabId]);

  const onSignIn = () => {
    setError(null);
    setSignin("running");
    void startWebPaneSignin(presetId).catch((reason: unknown) => {
      setSignin("idle");
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const message = signin === "running"
    ? webPaneStrings.signInRunning(label)
    : signin === "reopening"
      ? webPaneStrings.reopening
      : signedOut
        ? webPaneStrings.signedOut(label)
        : null;

  if (!message && !error) return null;

  return (
    <div
      data-web-pane-status-bar="true"
      data-web-pane-signed-out={signedOut ? "true" : undefined}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        borderBottom: "1px solid var(--cmux-border)",
        color: error ? "var(--cmux-red)" : "var(--cmux-text-secondary)",
        background: "var(--cmux-surface)",
        fontSize: 11,
      }}
    >
      <span>{error ? `${webPaneStrings.signInFailed}: ${error}` : message}</span>
      {signedOut && signin === "idle" && (
        <>
          <button
            type="button"
            onClick={onSignIn}
            style={{
              flexShrink: 0,
              padding: "1px 8px",
              fontSize: 11,
              color: "var(--cmux-text)",
              background: "var(--cmux-bg)",
              border: "1px solid var(--cmux-border)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            {webPaneStrings.signInButton}
          </button>
          <span style={{ opacity: 0.75 }}>{webPaneStrings.signInHint}</span>
        </>
      )}
    </div>
  );
}
