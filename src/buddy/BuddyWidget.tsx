import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { BrowserDomEvents } from "./adapters/dom-events";
import { TauriHostBridge } from "./adapters/host-bridge";
import { WebAudioNotifier } from "./adapters/notifier";
import { BrowserScheduler } from "./adapters/scheduler";
import { PersonaAgent } from "./core/PersonaAgent";
import type { BuddyViewModel } from "./core/types";
import { BuddyAvatar } from "./BuddyAvatar";
import { ChatInput } from "./ChatInput";
import { SpeechBubble } from "./SpeechBubble";
import "./BuddyWidget.css";

const ICON_SIZE = 64;

type TouchMotion = "top" | "right" | "bottom" | "left" | "center";

export function BuddyWidget() {
  const [vm, setVm] = useState<BuddyViewModel>({
    mood: "idle",
    speech: null,
    reaction: null,
    status: "起動中",
    silentUntil: null,
    lastSpokenAt: null,
    loading: false,
  });
  const [chatBusy, setChatBusy] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  const agentRef = useRef<PersonaAgent | null>(null);
  const touchTimerRef = useRef<number | null>(null);
  const [touchMotion, setTouchMotion] = useState<TouchMotion | null>(null);

  const handleChange = useCallback((state: BuddyViewModel) => {
    setVm(state);
  }, []);

  useEffect(() => {
    const host = new TauriHostBridge();
    const scheduler = new BrowserScheduler();
    const notifier = new WebAudioNotifier();
    const domEvents = new BrowserDomEvents();
    const agent = new PersonaAgent(handleChange, { host, scheduler, notifier, domEvents });
    agent.setBusyNotifier((busy) => setChatBusy(busy));
    agentRef.current = agent;

    // Defer agent startup off the app's critical startup path (session restore)
    // so the buddy never competes for disk I/O while the window is revealing.
    let cancelStart: (() => void) | null = null;
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(
        () => {
          cancelStart = null;
          void agent.start();
        },
        { timeout: 3000 },
      );
      cancelStart = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(() => {
        cancelStart = null;
        void agent.start();
      }, 200);
      cancelStart = () => window.clearTimeout(id);
    }

    return () => {
      if (touchTimerRef.current !== null) {
        window.clearTimeout(touchTimerRef.current);
        touchTimerRef.current = null;
      }
      cancelStart?.();
      agent.stop();
      agentRef.current = null;
    };
  }, [handleChange]);

  const pulseAvatar = (motion: TouchMotion): void => {
    if (touchTimerRef.current !== null) {
      window.clearTimeout(touchTimerRef.current);
    }
    setTouchMotion(motion);
    touchTimerRef.current = window.setTimeout(() => {
      setTouchMotion(null);
      touchTimerRef.current = null;
    }, 420);
  };

  const handleAvatarClick = (event: MouseEvent<HTMLDivElement>) => {
    pulseAvatar(getTouchMotionFromEvent(event));
    if (event.ctrlKey || event.metaKey || event.altKey) {
      agentRef.current?.toggleSilence();
      return;
    }

    setChatOpen((open) => !open);
  };

  const handleAvatarKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    pulseAvatar("center");
    if (event.ctrlKey || event.metaKey || event.altKey) {
      agentRef.current?.toggleSilence();
      return;
    }
    setChatOpen((open) => !open);
  };

  const handleDismiss = () => {
    agentRef.current?.dismissSpeech();
  };

  const speaking = vm.speech !== null;
  const avatarTitle = `${vm.status}。クリックでチャット入力、Ctrl/Meta/Alt+クリックでサイレント切替`;

  return (
    <div className="buddy-widget">
      <SpeechBubble speech={vm.speech} loading={vm.loading} onDismiss={handleDismiss} />
      <div className="buddy-widget__avatar-row">
        <div
          className={[
            "buddy-widget__avatar",
            touchMotion ? "buddy-widget__avatar--touched" : "",
            touchMotion ? `buddy-widget__avatar--touch-${touchMotion}` : "",
          ].filter(Boolean).join(" ")}
          onClick={handleAvatarClick}
          onKeyDown={handleAvatarKeyDown}
          role="button"
          tabIndex={0}
          title={avatarTitle}
          aria-label="Claude Buddy"
        >
          <BuddyAvatar mood={vm.mood} reaction={vm.reaction} size={ICON_SIZE} speaking={speaking} />
        </div>
      </div>
      {chatOpen && (
        <ChatInput
          busy={chatBusy}
          onSubmit={(text) => {
            void agentRef.current?.askFromUser(text);
          }}
          onClose={() => setChatOpen(false)}
        />
      )}
      {vm.loading && <div className="buddy-widget__loading-bar" />}
    </div>
  );
}

function getTouchMotionFromEvent(event: MouseEvent<HTMLDivElement>): TouchMotion {
  const rect = event.currentTarget.getBoundingClientRect();
  const xRatio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
  const yRatio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
  return getTouchMotion(xRatio, yRatio);
}

function getTouchMotion(xRatio: number, yRatio: number): TouchMotion {
  if (yRatio < 0.28) return "top";
  if (yRatio > 0.72) return "bottom";
  if (xRatio < 0.32) return "left";
  if (xRatio > 0.68) return "right";
  return "center";
}
