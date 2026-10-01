// Engine and car sounds, synthesised live with the Web Audio API (no sound files).
//
// The engine is built the way a real one makes noise: a stream of exhaust pulses, one per
// cylinder firing (a V10 at 18,000 rpm fires 1,500 times a second), each cylinder slightly
// different, shaped by exhaust-pipe resonances and a little distortion. On top of that:
// turbo whistle and hybrid (MGU-K) whine on the V6, gearshift cuts and clunks, the rev limiter, pops and
// crackles when you lift off, tyre squeal, kerb rumble, gravel, wind and impacts.
// The three nearest AI cars have their own engines, panned left/right with the Doppler
// effect, so you hear them come past.
//
// Browsers only allow sound after a click, so start() is called from the Start button.
import { gearbox } from './physics.js';

// Engine sounds. Pick one with SOUND.engineType; tweak a preset to taste.
//   rpmScale: multiplies the gearbox revs (the V8/V10 era revved to 18–19,000)
//   bank:     loudness of alternate firings (below 1 = the two cylinder banks sound different → deeper, richer)
//   pulse:    length of each exhaust pulse (smaller = buzzier, larger = smoother)
//   noise:    combustion rasp;  body: low crank rumble;  drive: distortion [idle, full throttle]
//   cutoff:   top-end filter in Hz [idle, full throttle] (lower = less shrill)
//   res:      exhaust resonances [Hz, Q, gain] (low Q = broad and warm, high Q = whistly)
export const ENGINES = {
  v6: { cylinders: 6, rpmScale: 1, bank: 1, pulse: 0.28, noise: 0.5, body: 0.1, drive: [0.9, 1.6], cutoff: [2500, 6000],
        res: [[155, 1.6, 1], [430, 2.4, 0.7], [1150, 3.2, 0.42], [2700, 4, 0.22]] },
  v8: { cylinders: 8, rpmScale: 1.38, bank: 0.5, pulse: 0.08, noise: 0.25, body: 0.28, drive: [1.1, 2.0], cutoff: [4200, 7500],
        res: [[260, 0.7, 0.6], [640, 0.9, 0.9], [1400, 1.5, 0.2], [3300, 1, 0.5], [5000, 1.4, 0.3]] },
  v10: { cylinders: 10, rpmScale: 1.4, bank: 0.5, pulse: 0.07, noise: 0.25, body: 0.28, drive: [1.1, 2.0], cutoff: [4500, 8000],
         res: [[280, 0.7, 0.6], [720, 0.9, 0.9], [1500, 1.5, 0.2], [3600, 1, 0.5], [5400, 1.4, 0.3]] },
};

export const SOUND = {
  engineType: 'v10',   // 'v6' turbo hybrid (today), 'v8' (2006–13), 'v10' (2000–05 scream)
  volume: 0.8,
  engine: 0.55,        // your engine
  traffic: 0.7,        // other cars
  turbo: 0.018,        // turbo whistle (only on the V6)
  hybrid: 0.012,       // electric whine (only on the V6)
  tyres: 0.22,
  kerbs: 1.0,          // kerb rumble (it's mixed to be heard over the engine; lower it if it's too much)
  wind: 0.12,
  aiVoices: 3,         // how many AI engines you can hear at once
};
const PRESET = () => ENGINES[SOUND.engineType] ?? ENGINES.v6;

// ---------- engine synthesiser (runs on the audio thread) ----------
const WORKLET = `
class EngineVoice extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 4000, minValue: 0, maxValue: 30000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 1, minValue: 0.3, maxValue: 3, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.cyl = o.cylinders || 6; this.o = o;
    // every cylinder is a little different: that's what gives an engine its growl
    this.amp = Array.from({ length: this.cyl }, () => 0.75 + Math.random() * 0.5);
    this.phase = 0; this.n = 0;
    this.pulse = 0; this.crack = 0; this.pop = 0; this.popLp = 0;
    this.lp = 0; this.dcX = 0; this.dcY = 0;
    // exhaust resonances: [Hz, Q, gain]
    this.res = (o.res || [[155, 1.6, 1], [430, 2.4, 0.7], [1150, 3.2, 0.42], [2700, 4, 0.22]])
      .map(([f, q, g]) => ({ f, q, g, x1: 0, x2: 0, y1: 0, y2: 0 }));
    this.crank = 0;
  }
  process(inputs, outputs, p) {
    const out = outputs[0][0], sr = sampleRate;
    const pitch = p.pitch[0], rpm = Math.max(p.rpm[0], 600) * pitch, load = p.load[0], cut = p.cut[0];
    const fireHz = (rpm / 60) * (this.cyl / 2);                   // firings per second
    const dPhase = fireHz / sr;
    const o = this.o, pulseDecay = Math.exp(-1 / (sr * Math.max((o.pulse ?? 0.28) / fireHz, 0.00012)));
    const crackDecay = Math.exp(-1 / (sr * 0.0006));
    const popDecay = Math.exp(-1 / (sr * 0.012));
    const overrun = load < 0.08 && rpm > 7000 * pitch;
    // band-pass resonator coefficients (RBJ, constant 0 dB peak)
    for (const r of this.res) {
      const w = 2 * Math.PI * Math.min(r.f * pitch, sr * 0.45) / sr, al = Math.sin(w) / (2 * r.q), a0 = 1 + al;
      r.b0 = al / a0; r.b2 = -al / a0; r.a1 = -2 * Math.cos(w) / a0; r.a2 = (1 - al) / a0;
    }
    const dr = o.drive || [0.9, 1.6], co = o.cutoff || [2500, 6000];
    const drive = dr[0] + load * (dr[1] - dr[0]), lpA = Math.exp(-2 * Math.PI * (co[0] + load * (co[1] - co[0])) / sr);
    const dCrank = (rpm / 60) / sr, body = (o.body ?? 0) * (0.4 + 0.6 * load) * (1 - cut);
    for (let i = 0; i < out.length; i++) {
      this.phase += dPhase * (1 + (Math.random() - 0.5) * 0.02);  // tiny timing jitter
      if (this.phase >= 1) {
        this.phase -= 1;
        const c = this.n++ % this.cyl;
        const bank = c % 2 ? (o.bank ?? 1) : 1;                           // alternate banks sound different
        const a = this.amp[c] * bank * (1 - cut) * (0.3 + 0.7 * load) * (0.92 + Math.random() * 0.16);
        this.pulse += a; this.crack += a * (o.noise ?? 0.5) * (0.5 + load);
        if (overrun && Math.random() < 0.035) this.pop = 1.2 + Math.random();   // crackle on the overrun
        if (cut > 0.5 && Math.random() < 0.08) this.pop = 0.8;                  // pops on shifts / limiter
      }
      this.pulse *= pulseDecay; this.crack *= crackDecay; this.pop *= popDecay;
      const noise = Math.random() * 2 - 1;
      const x = this.pulse + this.crack * noise;
      this.crank = (this.crank + dCrank) % 1;                            // crankshaft rumble
      let y = x * 0.35 + body * Math.sin(2 * Math.PI * this.crank) * (1 + 0.3 * Math.sin(4 * Math.PI * this.crank));
      for (const r of this.res) {
        const v = r.b0 * x + r.b2 * r.x2 - r.a1 * r.y1 - r.a2 * r.y2;
        r.x2 = r.x1; r.x1 = x; r.y2 = r.y1; r.y1 = v; y += v * r.g * 3;
      }
      this.popLp += (noise * this.pop - this.popLp) * 0.35; y += this.popLp * 1.4;
      y = Math.tanh(y * drive) / Math.tanh(drive);                  // rasp, more under load
      this.lp = y + (this.lp - y) * lpA;                            // tame the fizz
      const dc = this.lp - this.dcX + 0.995 * this.dcY; this.dcX = this.lp; this.dcY = dc; // remove DC
      out[i] = dc * 0.5;
    }
    return true;
  }
}
registerProcessor('engine-voice', EngineVoice);
`;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class EngineAudio {
  constructor() { this.ctx = null; this.muted = false; this.ready = false; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Started from a controller? Browsers only unlock sound on a click or key press, so resume on the next one.
    if (ctx.state === 'suspended') for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => ctx.resume(), { once: true });
    // master: gentle compressor so everything sits together without clipping
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16; this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : SOUND.volume;
    this.comp.connect(this.master).connect(ctx.destination);
    this.noiseBuf = this.makeNoise();
    this.buildLayers();
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      ctx.audioWorklet.addModule(url).then(() => this.buildEngines()).catch((e) => console.warn('Engine sound unavailable', e));
    }
  }

  makeNoise() {
    const ctx = this.ctx, buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  noise() { const n = this.ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; n.start(); return n; }
  filter(type, f, q = 1) { const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }

  // Everything except the engines themselves
  buildLayers() {
    const ctx = this.ctx, out = this.comp;
    // turbo whistle and hybrid whine: pure tones
    this.turbo = ctx.createOscillator(); this.turbo.type = 'sine'; this.turboGain = this.gain();
    this.turbo.connect(this.turboGain).connect(out); this.turbo.start();
    this.whine = ctx.createOscillator(); this.whine.type = 'triangle'; this.whineGain = this.gain();
    this.whine.connect(this.filter('lowpass', 5000)).connect(this.whineGain).connect(out); this.whine.start();
    // intake / turbo air rush
    this.airGain = this.gain(); this.airFilter = this.filter('bandpass', 1200, 0.8);
    this.noise().connect(this.airFilter).connect(this.airGain).connect(out);
    // tyre squeal: two resonant bands with a wobble
    this.squealGain = this.gain();
    const sq = this.noise(), b1 = this.filter('bandpass', 1050, 12), b2 = this.filter('bandpass', 2300, 9);
    sq.connect(b1).connect(this.squealGain); sq.connect(b2).connect(this.squealGain);
    const wob = ctx.createOscillator(); wob.frequency.value = 7; const wobG = this.gain(120);
    wob.connect(wobG).connect(b1.frequency); wob.start();
    this.squealGain.connect(out);
    // kerbs: a deep rumble chopped at the stripe rate, plus a rasping buzz from the ridges in the kerb
    // (in the mid range, so you hear it on laptop speakers too, not just headphones)
    this.kerbGain = this.gain(); this.kerbChop = this.gain(0.5);
    this.kerbLfo = ctx.createOscillator(); this.kerbLfo.type = 'square'; const lfoAmt = this.gain(0.5);
    this.kerbLfo.connect(lfoAmt).connect(this.kerbChop.gain); this.kerbLfo.start();
    this.noise().connect(this.filter('lowpass', 320, 1.5)).connect(this.gain(1.6)).connect(this.kerbChop);
    this.kerbBuzz = ctx.createOscillator(); this.kerbBuzz.type = 'sawtooth';
    this.kerbBuzz.connect(this.filter('bandpass', 420, 0.9)).connect(this.gain(0.9)).connect(this.kerbChop); this.kerbBuzz.start();
    this.noise().connect(this.filter('bandpass', 900, 1.2)).connect(this.gain(0.8)).connect(this.kerbChop);
    this.kerbChop.connect(this.kerbGain).connect(out);
    // grass and gravel: crunchy noise
    this.offGain = this.gain(); this.offFilter = this.filter('bandpass', 700, 0.7);
    this.noise().connect(this.offFilter).connect(this.offGain).connect(out);
    // wind
    this.windGain = this.gain(); this.windFilter = this.filter('lowpass', 500, 0.5);
    this.noise().connect(this.windFilter).connect(this.windGain).connect(out);
    this.lastGear = 'N'; this.lastHit = 0;
  }

  voice(pan = false) {
    const node = new AudioWorkletNode(this.ctx, 'engine-voice', { outputChannelCount: [1], processorOptions: PRESET() });
    const lp = this.filter('lowpass', 18000, 0.5), g = this.gain();
    node.connect(lp).connect(g);
    let p = null;
    if (pan && this.ctx.createStereoPanner) { p = this.ctx.createStereoPanner(); g.connect(p).connect(this.comp); } else g.connect(this.comp);
    return { node, lp, g, p, car: null, rpm: node.parameters.get('rpm'), load: node.parameters.get('load'), pitch: node.parameters.get('pitch'), cut: node.parameters.get('cut') };
  }
  buildEngines() {
    this.me = this.voice(false);
    // your engine: a touch more body in the low end
    const shelf = this.filter('lowshelf', 220); shelf.gain.value = 5;
    this.me.g.disconnect(); this.me.g.connect(shelf).connect(this.comp);
    this.others = Array.from({ length: SOUND.aiVoices }, () => this.voice(true));
    this.ready = true;
  }

  // Your car. Called every frame.
  update({ rpm, throttle, slip, surface, speed, hit, gear = 'N', brake = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, r = rpm * PRESET().rpmScale, hybrid = SOUND.engineType === 'v6' ? 1 : 0;
    if (this.ready) {
      const m = this.me;
      m.rpm.setTargetAtTime(r, t, 0.02);
      m.load.setTargetAtTime(throttle, t, 0.03);
      // gearshifts: a short ignition cut on the way up, a blip on the way down
      if (gear !== this.lastGear && gear !== 'N' && this.lastGear !== 'N') {
        const up = Number(gear) > Number(this.lastGear);
        m.cut.cancelScheduledValues(t); m.cut.setValueAtTime(up ? 1 : 0.6, t); m.cut.setValueAtTime(0, t + (up ? 0.05 : 0.09));
        this.clunk(up ? 0.22 : 0.14);
      }
      // rev limiter bouncing
      if (rpm > 12900 && throttle > 0.6) m.cut.setValueAtTime(Math.floor(t * 26) % 2, t);
      m.g.gain.setTargetAtTime(SOUND.engine * (0.55 + throttle * 0.45), t, 0.05);
    }
    this.lastGear = gear;
    const revs = smooth(5000, 13000, rpm), boost = revs * (0.3 + 0.7 * throttle);
    this.turbo.frequency.setTargetAtTime(1800 + boost * 5200, t, 0.25);
    this.turboGain.gain.setTargetAtTime(SOUND.turbo * boost * hybrid, t, 0.3);
    this.whine.frequency.setTargetAtTime(160 + speed * 30, t, 0.05);
    this.whineGain.gain.setTargetAtTime(SOUND.hybrid * hybrid * (0.4 + brake * 1.6) * smooth(2, 20, speed), t, 0.1);
    this.airFilter.frequency.setTargetAtTime(700 + revs * 2400, t, 0.1);
    this.airGain.gain.setTargetAtTime(0.03 * throttle * revs, t, 0.08);

    const squeal = smooth(1.3, 5, slip) * (speed > 5 ? 1 : 0);
    this.squealGain.gain.setTargetAtTime(SOUND.tyres * squeal, t, 0.05);
    this.kerbLfo.frequency.setTargetAtTime(Math.max(speed / 1.75, 1), t, 0.02);
    this.kerbBuzz.frequency.setTargetAtTime(Math.min(60 + speed * 5, 480), t, 0.02); // ridges go by faster
    this.kerbGain.gain.setTargetAtTime(surface === 'kerb' && speed > 3 ? SOUND.kerbs * (0.9 + 0.8 * smooth(5, 60, speed)) : 0, t, 0.02);
    const off = surface === 'grass' || surface === 'gravel' || surface === 'runoff';
    this.offFilter.frequency.setTargetAtTime(surface === 'gravel' ? 2600 : 500, t, 0.05);
    this.offGain.gain.setTargetAtTime(off && speed > 2 ? Math.min(0.5, speed * 0.012) : 0, t, 0.05);
    this.windFilter.frequency.setTargetAtTime(300 + speed * 12, t, 0.2);
    this.windGain.gain.setTargetAtTime(SOUND.wind * smooth(10, 90, speed), t, 0.2);
    if (hit > 0.25 && this.lastHit <= 0.25) this.thump(hit);
    this.lastHit = hit;
  }

  // Other cars, heard from the camera: louder when close, panned, Doppler-shifted.
  updateTraffic(cars, player, camera) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, e = camera.matrixWorld.elements;
    const lx = e[12], ly = e[13], lz = e[14], rx = e[0], rz = e[2];       // listener position, right vector
    const lvx = player ? player.state.vx : 0, lvz = player ? player.state.vz : 0;
    const near = cars.filter((c) => c !== player).map((c) => {
      const dx = c.state.x - lx, dz = c.state.z - lz, dy = (c.state.y ?? 0) - ly;
      return { c, d: Math.hypot(dx, dy, dz), dx, dz };
    }).filter((o) => o.d < 220).sort((a, b) => a.d - b.d).slice(0, this.others.length);
    const keep = new Set(near.map((o) => o.c));
    for (const v of this.others) if (v.car && !keep.has(v.car)) { v.car = null; v.g.gain.setTargetAtTime(0, t, 0.08); }
    for (const o of near) {
      let v = this.others.find((x) => x.car === o.c) ?? this.others.find((x) => !x.car);
      if (!v) continue;
      v.car = o.c;
      const s = o.c.state, gb = gearbox(Math.abs(s.vf));
      const inv = 1 / Math.max(o.d, 0.001), ux = o.dx * inv, uz = o.dz * inv;
      const away = (s.vx - lvx) * ux + (s.vz - lvz) * uz;                 // + = moving away
      const doppler = Math.min(1.6, Math.max(0.6, 343 / (343 + away)));
      v.rpm.setTargetAtTime(gb.rpm * PRESET().rpmScale, t, 0.03);
      v.load.setTargetAtTime(s.throttle ?? 0.8, t, 0.05);
      v.pitch.setTargetAtTime(doppler, t, 0.05);
      v.g.gain.setTargetAtTime(SOUND.traffic / (1 + (o.d / 14) ** 2), t, 0.05);
      v.lp.frequency.setTargetAtTime(Math.max(900, 16000 / (1 + o.d / 35)), t, 0.05);   // distant cars sound duller
      if (v.p) v.p.pan.setTargetAtTime(Math.max(-1, Math.min(1, (ux * rx + uz * rz) * 0.9)), t, 0.05);
    }
  }

  // one-shot sounds
  clunk(level) {
    const ctx = this.ctx, t = ctx.currentTime, n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const f = this.filter('bandpass', 2400, 3), g = this.gain();
    g.gain.setValueAtTime(level * 0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(f).connect(g).connect(this.comp); n.start(t, Math.random()); n.stop(t + 0.06);
  }
  thump(level) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
    const g = this.gain(); g.gain.setValueAtTime(Math.min(1, level) * 0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.comp); o.start(t); o.stop(t + 0.32);
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const f = this.filter('lowpass', 900), g2 = this.gain();
    g2.gain.setValueAtTime(Math.min(1, level) * 0.6, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(f).connect(g2).connect(this.comp); n.start(t, Math.random()); n.stop(t + 0.2);
  }

  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : SOUND.volume; }
  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }
}