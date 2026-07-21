export type AudioCue =
  'hover' | 'click' | 'spawn' | 'place' | 'bounce' | 'deliver' | 'error' | 'success' | 'win';

interface AudioSettings {
  muted?: boolean;
  volume?: number;
}

const OUTPUT_GAIN_MULTIPLIER = 4;

/**
 * Tiny dependency-free synthesizer for interface and simulation feedback.
 * It deliberately creates the AudioContext lazily so browsers can unlock it
 * from the first pointer / keyboard gesture.
 */
export class AudioService {
  private context?: AudioContext;
  private master?: GainNode;
  private muted: boolean;
  private volume: number;

  constructor(settings: AudioSettings = {}) {
    this.muted = settings.muted ?? false;
    this.volume = clamp(settings.volume ?? 0.45, 0, 1);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get currentVolume(): number {
    return this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.syncMaster();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.syncMaster();
  }

  async resume(): Promise<void> {
    const context = this.ensureContext();
    if (context?.state === 'suspended') await context.resume();
  }

  play(cue: AudioCue): void {
    if (this.muted || this.volume <= 0) return;

    const context = this.ensureContext();
    const master = this.master;
    if (!context || !master) return;

    if (context.state === 'suspended') {
      void context.resume().catch(() => undefined);
      if (cue === 'hover') return;
    }

    switch (cue) {
      case 'hover':
        this.tone(740, 0.012, 0.028, 'sine', 0);
        break;
      case 'click':
        this.tone(330, 0.022, 0.038, 'triangle', 0);
        this.tone(495, 0.012, 0.032, 'sine', 0.018);
        break;
      case 'spawn':
        this.tone(220, 0.038, 0.055, 'square', 0);
        this.sweep(360, 620, 0.075, 0.032, 'triangle');
        break;
      case 'place':
        this.tone(392, 0.045, 0.055, 'sine', 0);
        this.tone(523.25, 0.035, 0.045, 'sine', 0.035);
        break;
      case 'bounce':
        this.sweep(155, 330, 0.11, 0.075, 'triangle');
        break;
      case 'deliver':
        this.tone(659.25, 0.055, 0.08, 'sine', 0);
        this.tone(880, 0.045, 0.09, 'sine', 0.055);
        break;
      case 'error':
        this.sweep(185, 105, 0.16, 0.07, 'sawtooth');
        break;
      case 'success':
      case 'win':
        [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
          this.tone(frequency, 0.075, 0.15, 'sine', index * 0.075);
        });
        break;
    }
  }

  destroy(): void {
    if (this.context && this.context.state !== 'closed') void this.context.close();
    this.context = undefined;
    this.master = undefined;
  }

  private ensureContext(): AudioContext | undefined {
    if (typeof window === 'undefined') return undefined;
    if (this.context) return this.context;

    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return undefined;

    this.context = new AudioContextConstructor();
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);
    this.syncMaster();
    return this.context;
  }

  private syncMaster(): void {
    if (!this.context || !this.master) return;
    const gain = this.muted ? 0 : this.volume * OUTPUT_GAIN_MULTIPLIER;
    this.master.gain.cancelScheduledValues(this.context.currentTime);
    this.master.gain.setTargetAtTime(gain, this.context.currentTime, 0.012);
  }

  private tone(
    frequency: number,
    delay: number,
    duration: number,
    type: OscillatorType,
    offset: number,
  ): void {
    if (!this.context || !this.master) return;
    const start = this.context.currentTime + offset;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(delay, start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.015);
  }

  private sweep(
    from: number,
    to: number,
    duration: number,
    peak: number,
    type: OscillatorType,
  ): void {
    if (!this.context || !this.master) return;
    const start = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(peak, start + 0.014);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.015);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
