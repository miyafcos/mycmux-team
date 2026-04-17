import { useCallback, useEffect, useRef, useState } from "react";
import { PersonaAgent } from "./agent/PersonaAgent";
import type { BuddyViewModel } from "./agent/types";
import { BuddyAvatar } from "./BuddyAvatar";
import { SpeechBubble } from "./SpeechBubble";
import "./BuddyWidget.css";

const ICON_SIZE = 64;

export function BuddyWidget() {
  const [vm, setVm] = useState<BuddyViewModel>({
    mood: "idle",
    speech: null,
    status: "起動中",
    silentUntil: null,
    lastSpokenAt: null,
    loading: false,
  });

  const agentRef = useRef<PersonaAgent | null>(null);

  const handleChange = useCallback((state: BuddyViewModel) => {
    setVm(state);
  }, []);

  useEffect(() => {
    const agent = new PersonaAgent(handleChange);
    agentRef.current = agent;
    void agent.start();

    return () => {
      agent.stop();
      agentRef.current = null;
    };
  }, [handleChange]);

  const handleAvatarClick = () => {
    agentRef.current?.toggleSilence();
  };

  const handleDismiss = () => {
    agentRef.current?.dismissSpeech();
  };

  return (
    <div className="buddy-widget">
      <SpeechBubble speech={vm.speech} loading={vm.loading} onDismiss={handleDismiss} />
      <div className="buddy-widget__avatar-row">
        <div className="buddy-widget__avatar" onClick={handleAvatarClick} title={vm.status}>
          <BuddyAvatar mood={vm.mood} size={ICON_SIZE} />
        </div>
      </div>
      {vm.loading && <div className="buddy-widget__loading-bar" />}
    </div>
  );
}
