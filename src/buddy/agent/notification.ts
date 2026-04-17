let audioCtx: AudioContext | null = null;
let enabled = true;

export function setNotificationEnabled(value: boolean): void {
  enabled = value;
}

export function isNotificationEnabled(): boolean {
  return enabled;
}

export function playNotificationSound(): void {
  if (!enabled) return;

  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") {
      void audioCtx.resume();
    }

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    osc.frequency.value = 880;

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  } catch (error) {
    console.warn("[buddy] notification sound failed:", error);
  }
}
