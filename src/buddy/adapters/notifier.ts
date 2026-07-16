export interface Notifier {
  notifySpeak(): void;
}

export class WebAudioNotifier implements Notifier {
  private audioCtx: AudioContext | null = null;
  private enabled = true;

  setNotificationEnabled(value: boolean): void {
    this.enabled = value;
  }

  isNotificationEnabled(): boolean {
    return this.enabled;
  }

  notifySpeak(): void {
    if (!this.enabled) return;

    try {
      this.audioCtx ??= new AudioContext();
      if (this.audioCtx.state === "suspended") {
        void this.audioCtx.resume();
      }

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      osc.frequency.value = 880;

      const gain = this.audioCtx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

      osc.connect(gain).connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.09);
    } catch (error) {
      console.warn("[buddy] notification sound failed:", error);
    }
  }
}
