// Synthesised engine + tyre sounds with the Web Audio API (no sound files).
// Browsers only allow audio after a click, so call start() from the Start button.
export class EngineAudio {
  constructor() { this.ctx = null; this.muted = false; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain(); this.master.gain.value = 0.35;
    this.master.connect(ctx.destination);

    // Engine: a few detuned harmonics through a low-pass filter.
    this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = 4;
    this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0;
    this.filter.connect(this.engineGain).connect(this.master);
    this.oscs = [
      { type: 'sawtooth', mul: 1, gain: 0.5 },
      { type: 'square', mul: 0.5, gain: 0.25 },
      { type: 'sawtooth', mul: 2.01, gain: 0.18 },
      { type: 'triangle', mul: 3, gain: 0.12 },
    ].map(({ type, mul, gain }) => {
      const o = ctx.createOscillator(); o.type = type;
      const g = ctx.createGain(); g.gain.value = gain;
      o.connect(g).connect(this.filter); o.start();
      return { o, mul };
    });

    // Tyre squeal / kerb rumble: filtered noise.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    this.skidFilter = ctx.createBiquadFilter(); this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 1800; this.skidFilter.Q.value = 3;
    this.skidGain = ctx.createGain(); this.skidGain.gain.value = 0;
    noise.connect(this.skidFilter).connect(this.skidGain).connect(this.master);

    this.rumbleFilter = ctx.createBiquadFilter(); this.rumbleFilter.type = 'lowpass'; this.rumbleFilter.frequency.value = 180;
    this.rumbleGain = ctx.createGain(); this.rumbleGain.gain.value = 0;
    noise.connect(this.rumbleFilter).connect(this.rumbleGain).connect(this.master);

    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    const windFilter = ctx.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 600;
    noise.connect(windFilter).connect(this.windGain).connect(this.master);
    noise.start();
  }

  update({ rpm, throttle, slip, surface, speed, hit }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.05;
    const f = rpm / 60 * 1.5; // ~150–325 Hz fundamental
    for (const { o, mul } of this.oscs) o.frequency.setTargetAtTime(f * mul, t, 0.03);
    this.filter.frequency.setTargetAtTime(700 + throttle * 2600 + rpm * 0.08, t, k);
    this.engineGain.gain.setTargetAtTime(0.18 + throttle * 0.32, t, k);
    const squeal = Math.min(1, Math.max(0, (slip - 1.2) / 5)) * (speed > 5 ? 1 : 0);
    this.skidGain.gain.setTargetAtTime(squeal * 0.25, t, 0.05);
    this.rumbleGain.gain.setTargetAtTime((surface !== 'road' && speed > 3 ? 0.6 : 0) + hit * 0.8, t, 0.04);
    this.windGain.gain.setTargetAtTime(Math.min(0.12, speed * speed * 0.000015), t, 0.2);
  }

  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.35; }
  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }
}
