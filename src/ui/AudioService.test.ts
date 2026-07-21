import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioService } from './AudioService';

class FakeAudioParam {
  targets: number[] = [];

  cancelScheduledValues(): void {}

  setTargetAtTime(value: number): void {
    this.targets.push(value);
  }
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();

  connect(): void {}
}

class FakeAudioContext {
  static latest?: FakeAudioContext;

  readonly currentTime = 0;
  readonly destination = {};
  readonly master = new FakeGainNode();
  state: AudioContextState = 'running';

  constructor() {
    FakeAudioContext.latest = this;
  }

  createGain(): GainNode {
    return this.master as unknown as GainNode;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

describe('AudioService', () => {
  afterEach(() => {
    FakeAudioContext.latest = undefined;
    vi.unstubAllGlobals();
  });

  it('aplica ganho de saída quatro vezes maior sem alterar a escala salva', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const audio = new AudioService({ volume: 1 });

    expect(audio.currentVolume).toBe(1);
    await audio.resume();
    expect(FakeAudioContext.latest?.master.gain.targets.at(-1)).toBe(4);

    audio.setVolume(0.35);
    expect(audio.currentVolume).toBe(0.35);
    expect(FakeAudioContext.latest?.master.gain.targets.at(-1)).toBe(1.4);

    audio.setMuted(true);
    expect(FakeAudioContext.latest?.master.gain.targets.at(-1)).toBe(0);
  });
});
