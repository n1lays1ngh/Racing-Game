// Engine and car sounds, synthesised live with the Web Audio API (no sound files).
//
// The engine is built the way a real one makes noise: a stream of exhaust pulses, one per cylinder
// firing, each cylinder slightly different, shaped by exhaust-pipe resonances. The default engine is
// 'smooth': a low, warm, steady hum that only rises a little with the revs: no scream, no rasp, no pops.
// The old screaming engines ('v10', 'v8', 'v6') are still here: set SOUND.engineType to use one.
// That's the F1 car's engine. The other cars have their own (`sound` in their file in src/cars/): the
// Hypercar's 'hypercar' (the Ferrari 499P's twin-turbo V6) and the GT3's 'gt3' (the AMG's 6.2 V8).
//
// Everything else (tyre squeal, kerb rumble, grass and gravel, wind, impacts, gearshift clicks, pops and
// crackles when you lift off or brake) is off by default, so you only hear the engine. Each one has its own
// volume in SOUND below: set it above 0 to bring it back.
// The nearest AI cars have their own (quieter) engines, panned left/right as they pass you.
//
// Browsers only allow sound after a click, so start() is called from the Start button.
import { gearbox } from './physics.js';

// Engine sounds. Pick one with SOUND.engineType; tweak a preset to taste.
//   fire:     (smooth only) the engine's note in Hz at idle and at the redline: { rpm: [idle, redline], hz: [low, high] }.
//             The closer the two hz numbers, the more steady (monotone) it sounds; lower numbers = deeper.
//   rpmScale: (the others) multiplies the gearbox revs (the V8/V10 era revved to 18–19,000)
//   bank:     loudness of alternate firings (below 1 = the two cylinder banks sound different → deeper, richer)
//   pulse:    length of each exhaust pulse (smaller = buzzier, larger = smoother)
//   noise:    combustion rasp;  body: low hum under it all;  drive: distortion [idle, full throttle]
//   cutoff:   top-end filter in Hz [idle, full throttle] (lower = softer, less shrill)
//   res:      exhaust resonances [Hz, Q, gain] (low Q = broad and warm, high Q = whistly)
//   pops:     crackles and pops when you lift off / brake and on gearshifts
//   rough:    how uneven the firings are (0 = perfectly even, 0.16 = lumpy)
export const ENGINES = {
  smooth: { cylinders: 8, fire: { rpm: [4000, 13000], hz: [54, 92] }, bank: 0.88, pulse: 0.6, noise: 0.03, body: 0.55,
            crankRatio: 1, drive: [0.5, 0.75], cutoff: [600, 950], pops: false, rough: 0.05, jitter: 0.004,
            res: [[92, 0.7, 0.5], [185, 0.9, 0.42], [370, 1.1, 0.16]] },
  v6: { cylinders: 6, rpmScale: 1, bank: 1, pulse: 0.28, noise: 0.5, body: 0.1, drive: [0.9, 1.6], cutoff: [2500, 6000],
        pops: false, res: [[155, 1.6, 1], [430, 2.4, 0.7], [1150, 3.2, 0.42], [2700, 4, 0.22]] },
  v8: { cylinders: 8, rpmScale: 1.38, bank: 0.5, pulse: 0.08, noise: 0.25, body: 0.28, drive: [1.1, 2.0], cutoff: [4200, 7500],
        res: [[260, 0.7, 0.6], [640, 0.9, 0.9], [1400, 1.5, 0.2], [3300, 1, 0.5], [5000, 1.4, 0.3]] },
  v10: { cylinders: 10, rpmScale: 1.4, bank: 0.5, pulse: 0.07, noise: 0.25, body: 0.28, drive: [1.1, 2.0], cutoff: [4500, 8000],
         res: [[280, 0.7, 0.6], [720, 0.9, 0.9], [1500, 1.5, 0.2], [3600, 1, 0.5], [5400, 1.4, 0.3]] },
  // ---- the other cars' engines (src/cars/: `sound`). Besides the settings above:
  //   gain:   loudness compared with the F1 car's engine (1 = the same)
  //   firing: which bank each cylinder in the firing order is on (0 / 1): the uneven pattern of a cross-plane V8
  //           is its burble (without it, the banks just alternate)
  //   turbo:  turbo whistle { level (× SOUND.turbo), hz: [off boost, full boost], revs: [no boost, full boost] }
  //   hybrid: electric motor whine { level (× SOUND.hybrid), hz: [at rest, + per m/s], deploy: true = only while the
  //           motor drives the car (and, quieter, while braking charges it) }
  // The Hypercar: the Ferrari 499P's 3.0 twin-turbo V6, built on the 'v6' above but revving to 8,800, not 13,000:
  // deeper and rougher, more turbo, and the front motor's whine when it deploys above 190 km/h.
  hypercar: { cylinders: 6, rpmScale: 1, bank: 0.94, pulse: 0.3, noise: 0.6, body: 0.16, drive: [1.0, 1.8], cutoff: [2200, 5400],
              pops: false, res: [[128, 1.5, 1], [350, 2.2, 0.72], [930, 3.0, 0.42], [2200, 3.8, 0.2]], gain: 0.9,
              turbo: { level: 1.6, hz: [1300, 4200], revs: [4000, 8800] }, hybrid: { level: 1.4, hz: [120, 24], deploy: true } },
  // The GT3: the Mercedes-AMG's 6.2 V8, no turbos, revving to 7,600: deep, loud and lumpy, with the burble of its
  // cross-plane crank (firing order 1-5-4-8-6-3-7-2: banks R L R L L R L R)
  gt3: { cylinders: 8, rpmScale: 1, bank: 0.62, firing: [0, 1, 0, 1, 1, 0, 1, 0], pulse: 0.22, noise: 0.4, body: 0.32,
         drive: [1.2, 2.1], cutoff: [1600, 4600], rough: 0.1, jitter: 0.008, pops: false,
         res: [[100, 0.9, 0.9], [240, 1.2, 0.85], [560, 1.7, 0.5], [1350, 2.4, 0.24], [3000, 3, 0.1]], gain: 1 },
};

export const SOUND = {
  engineType: 'v6', // the F1 car: 'smooth' (low, calm hum), or the originals: 'v10' (2000–05 scream), 'v8' (2006–13), 'v6' turbo hybrid
  volume: 0.8,
  engine: 0.7,          // your engine
  idleLevel: 0.75,      // how loud the engine is off the throttle compared with flat out (1 = the same: steadiest)
  glide: 0.14,          // seconds the note takes to follow the revs (higher = smoother slides between gears)
  traffic: 0.35,        // other cars' engines (0 = off)
  doppler: [0.88, 1.15],// how much other cars' pitch may rise / fall as they pass (1, 1 = not at all)
  aiVoices: 3,          // how many AI engines you can hear at once
  // Everything below is off (0 / false): only the engine. Turn any of them back on here.
  liftLoad: 0.45,       // off the throttle at speed, the engine still sounds this strong (0 = thin and quiet, 1 = like flat out)
  shiftSnap: 0.015,     // gearshifts: seconds the revs take to jump to the new gear (small = you hear each shift as it happens)
  snapTime: 0.12,       // …for this long after the shift; then the revs follow with `glide` again
  downshiftLoud: 1.35,  // downshifts: the engine is this much louder as the revs jump (1 = no louder)
  loudTime: 0.3,        // …fading back to normal over this many seconds
  shiftCut: false,      // the engine cutting out for a moment on each gearshift
  shiftClick: 0,        // gearshift click (was 1)
  limiter: false,       // rev limiter stutter
  tyres: 0,             // tyre squeal when sliding or locking the brakes (was 0.22)
  kerbs: 1.0,             // kerb rumble (was 1.0)
  offTrack: 1.0,          // grass and gravel crunch (was 1.0)
  wind: 0.3,              // wind at speed (was 0.12)
  air: 0,               // intake air rush (was 1.0)
  impacts: 0,           // thud when you hit something (was 1.0)
  turbo: 0.018,         // turbo whistle (the 'v6'; the Hypercar's is louder, ENGINES.hypercar.turbo)
  hybrid: 0.012,        // electric whine (the 'v6'; the Hypercar's front motor, ENGINES.hypercar.hybrid)
};
// Which engine a car has: its `sound` (src/cars/), or SOUND.engineType (the F1 car)
const presetName = (car) => (car?.sound && ENGINES[car.sound] ? car.sound : SOUND.engineType);
const presetOf = (car) => ENGINES[presetName(car)] ?? ENGINES.smooth;
const rpmScaleOf = (P) => (P.fire ? 1 : P.rpmScale ?? 1); // 'smooth' sets its note directly from the revs
// The turbo whistle and hybrid whine: the 'v6' has them as they always were; other engines set their own
const V6_EXTRAS = { turbo: { level: 1, hz: [1800, 7000], revs: [5000, 13000] }, hybrid: { level: 1, hz: [160, 30], deploy: false } };
const extrasOf = (car) => {
  const P = presetOf(car);
  if (P.turbo || P.hybrid) return { turbo: P.turbo ?? null, hybrid: P.hybrid ?? null };
  return presetName(car) === 'v6' ? V6_EXTRAS : { turbo: null, hybrid: null };
};

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
    // every cylinder is a little different: that's what gives an engine its character
    this.amp = Array.from({ length: this.cyl }, () => 0.75 + Math.random() * 0.5 * Math.min(1, (o.rough ?? 0.16) / 0.16));
    this.phase = 0; this.n = 0;
    this.pulse = 0; this.crack = 0; this.pop = 0; this.popLp = 0;
    this.lp = 0; this.dcX = 0; this.dcY = 0;
    // exhaust resonances: [Hz, Q, gain]
    this.res = (o.res || [[155, 1.6, 1], [430, 2.4, 0.7], [1150, 3.2, 0.42], [2700, 4, 0.22]])
      .map(([f, q, g]) => ({ f, q, g, x1: 0, x2: 0, y1: 0, y2: 0 }));
    this.crank = 0;
    this.alive = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; }; // (another car's engine now)
  }
  process(inputs, outputs, p) {
    const out = outputs[0][0], sr = sampleRate, o = this.o;
    const pitch = p.pitch[0], rpm = Math.max(p.rpm[0], 600) * pitch, load = p.load[0], cut = p.cut[0];
    let fireHz;                                                     // firings per second
    if (o.fire) {                                                   // 'smooth': a set range of notes
      const f = o.fire, u = (Math.max(p.rpm[0], 600) - f.rpm[0]) / (f.rpm[1] - f.rpm[0]);
      fireHz = (f.hz[0] + (f.hz[1] - f.hz[0]) * Math.max(-0.3, Math.min(1.1, u))) * pitch;
    } else fireHz = (rpm / 60) * (this.cyl / 2);
    const dPhase = fireHz / sr;
    const pulseDecay = Math.exp(-1 / (sr * Math.max((o.pulse ?? 0.28) / fireHz, 0.00012)));
    const crackDecay = Math.exp(-1 / (sr * 0.0006));
    const popDecay = Math.exp(-1 / (sr * 0.012));
    const pops = o.pops !== false, overrun = pops && load < 0.08 && rpm > 7000 * pitch;
    const jitter = o.jitter ?? 0.02, rough = o.rough ?? 0.16;
    // band-pass resonator coefficients (RBJ, constant 0 dB peak)
    for (const r of this.res) {
      const w = 2 * Math.PI * Math.min(r.f * pitch, sr * 0.45) / sr, al = Math.sin(w) / (2 * r.q), a0 = 1 + al;
      r.b0 = al / a0; r.b2 = -al / a0; r.a1 = -2 * Math.cos(w) / a0; r.a2 = (1 - al) / a0;
    }
    const dr = o.drive || [0.9, 1.6], co = o.cutoff || [2500, 6000];
    const drive = dr[0] + load * (dr[1] - dr[0]), lpA = Math.exp(-2 * Math.PI * (co[0] + load * (co[1] - co[0])) / sr);
    const dCrank = (o.crankRatio ? fireHz * o.crankRatio : rpm / 60) / sr, body = (o.body ?? 0) * (0.4 + 0.6 * load) * (1 - cut);
    for (let i = 0; i < out.length; i++) {
      this.phase += dPhase * (1 + (Math.random() - 0.5) * jitter);  // tiny timing jitter
      if (this.phase >= 1) {
        this.phase -= 1;
        const c = this.n++ % this.cyl;
        const bank = (o.firing ? o.firing[c % o.firing.length] : c % 2) ? (o.bank ?? 1) : 1; // the two banks sound different
        const a = this.amp[c] * bank * (1 - cut) * (0.3 + 0.7 * load) * (1 - rough / 2 + Math.random() * rough);
        this.pulse += a; this.crack += a * (o.noise ?? 0.5) * (0.5 + load);
        if (overrun && Math.random() < 0.035) this.pop = 1.2 + Math.random();   // crackle on the overrun
        if (pops && cut > 0.5 && Math.random() < 0.08) this.pop = 0.8;          // pops on shifts / limiter
      }
      this.pulse *= pulseDecay; this.crack *= crackDecay; this.pop *= popDecay;
      const noise = Math.random() * 2 - 1;
      const x = this.pulse + this.crack * noise;
      this.crank = (this.crank + dCrank) % 1;                            // the low hum underneath
      let y = x * 0.35 + body * Math.sin(2 * Math.PI * this.crank) * (1 + 0.3 * Math.sin(4 * Math.PI * this.crank));
      for (const r of this.res) {
        const v = r.b0 * x + r.b2 * r.x2 - r.a1 * r.y1 - r.a2 * r.y2;
        r.x2 = r.x1; r.x1 = x; r.y2 = r.y1; r.y1 = v; y += v * r.g * 3;
      }
      this.popLp += (noise * this.pop - this.popLp) * 0.35; y += this.popLp * 1.4;
      y = Math.tanh(y * drive) / Math.tanh(drive);                  // rasp, more under load (little on 'smooth')
      this.lp = y + (this.lp - y) * lpA;                            // soften the top end
      const dc = this.lp - this.dcX + 0.995 * this.dcY; this.dcX = this.lp; this.dcY = dc; // remove DC
      out[i] = dc * 0.5;
    }
    return this.alive;
  }
}
registerProcessor('engine-voice', EngineVoice);
`;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class EngineAudio {
  constructor() { this.ctx = null; this.muted = false; this.ready = false; this.car = null; }

  // The car you're racing (its file in src/cars/): its engine, for you and the cars around you
  setCar(car) {
    this.car = car;
    if (this.ready && presetName(car) !== this.engine) this.buildEngines(); // a different engine: new voices
  }

  // given: a context to play into instead of the speakers (an OfflineAudioContext: cinema.js renders a replay's sound).
  // this.loaded: resolves once the engine voices are ready
  start(given = null) {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = this.ctx = given ?? new (window.AudioContext || window.webkitAudioContext)();
    // Started from a controller? Browsers only unlock sound on a click or key press, so resume on the next one.
    if (!given && ctx.state === 'suspended') for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => ctx.resume(), { once: true });
    // master: gentle compressor so everything sits together without clipping
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16; this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : SOUND.volume;
    this.comp.connect(this.master).connect(ctx.destination);
    this.noiseBuf = this.makeNoise();
    this.buildLayers();
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      this.loaded = ctx.audioWorklet.addModule(url).then(() => this.buildEngines()).catch((e) => console.warn('Engine sound unavailable', e));
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

  // Everything except the engines themselves. Each layer is only built if it's switched on in SOUND.
  buildLayers() {
    const ctx = this.ctx, out = this.comp;
    { // turbo whistle and hybrid whine: pure tones (silent on an engine without them)
      this.turbo = ctx.createOscillator(); this.turbo.type = 'sine'; this.turboGain = this.gain();
      this.turbo.connect(this.turboGain).connect(out); this.turbo.start();
      this.whine = ctx.createOscillator(); this.whine.type = 'triangle'; this.whineGain = this.gain();
      this.whine.connect(this.filter('lowpass', 5000)).connect(this.whineGain).connect(out); this.whine.start();
    }
    if (SOUND.air > 0) { // intake / turbo air rush
      this.airGain = this.gain(); this.airFilter = this.filter('bandpass', 1200, 0.8);
      this.noise().connect(this.airFilter).connect(this.airGain).connect(out);
    }
    if (SOUND.tyres > 0) { // tyre squeal: two resonant bands with a wobble
      this.squealGain = this.gain();
      const sq = this.noise(), b1 = this.filter('bandpass', 1050, 12), b2 = this.filter('bandpass', 2300, 9);
      sq.connect(b1).connect(this.squealGain); sq.connect(b2).connect(this.squealGain);
      const wob = ctx.createOscillator(); wob.frequency.value = 7; const wobG = this.gain(120);
      wob.connect(wobG).connect(b1.frequency); wob.start();
      this.squealGain.connect(out);
    }
    if (SOUND.kerbs > 0) {
      // kerbs: a deep rumble chopped at the stripe rate, plus a rasping buzz from the ridges in the kerb
      this.kerbGain = this.gain(); this.kerbChop = this.gain(0.5);
      this.kerbLfo = ctx.createOscillator(); this.kerbLfo.type = 'square'; const lfoAmt = this.gain(0.5);
      this.kerbLfo.connect(lfoAmt).connect(this.kerbChop.gain); this.kerbLfo.start();
      this.noise().connect(this.filter('lowpass', 320, 1.5)).connect(this.gain(1.6)).connect(this.kerbChop);
      this.kerbBuzz = ctx.createOscillator(); this.kerbBuzz.type = 'sawtooth';
      this.kerbBuzz.connect(this.filter('bandpass', 420, 0.9)).connect(this.gain(0.9)).connect(this.kerbChop); this.kerbBuzz.start();
      this.noise().connect(this.filter('bandpass', 900, 1.2)).connect(this.gain(0.8)).connect(this.kerbChop);
      this.kerbChop.connect(this.kerbGain).connect(out);
    }
    if (SOUND.offTrack > 0) { // grass and gravel: crunchy noise
      this.offGain = this.gain(); this.offFilter = this.filter('bandpass', 700, 0.7);
      this.noise().connect(this.offFilter).connect(this.offGain).connect(out);
    }
    if (SOUND.wind > 0) {
      this.windGain = this.gain(); this.windFilter = this.filter('lowpass', 500, 0.5);
      this.noise().connect(this.windFilter).connect(this.windGain).connect(out);
    }
    this.lastGear = 'N'; this.lastHit = 0;
    this.snapUntil = 0; this.loudAt = -10; this.lastUp = -10; // gearshifts
  }

  voice(pan = false) {
    const node = new AudioWorkletNode(this.ctx, 'engine-voice', { outputChannelCount: [1], processorOptions: presetOf(this.car) });
    const lp = this.filter('lowpass', 18000, 0.5), g = this.gain();
    node.connect(lp).connect(g);
    let p = null;
    if (pan && this.ctx.createStereoPanner) { p = this.ctx.createStereoPanner(); g.connect(p).connect(this.comp); } else g.connect(this.comp);
    return { node, lp, g, p, car: null, rpm: node.parameters.get('rpm'), load: node.parameters.get('load'), pitch: node.parameters.get('pitch'), cut: node.parameters.get('cut') };
  }
  buildEngines() {
    for (const v of [this.me, ...(this.others ?? [])]) { // the last car's engines, if any
      if (!v) continue;
      v.node.port.postMessage('stop'); v.node.disconnect(); v.g.disconnect();
    }
    this.engine = presetName(this.car); this.P = presetOf(this.car); this.extras = extrasOf(this.car);
    this.me = this.voice(false);
    // your engine: a touch more body in the low end
    const shelf = this.filter('lowshelf', 220); shelf.gain.value = 5;
    this.me.g.disconnect(); this.me.g.connect(shelf).connect(this.comp);
    this.others = SOUND.traffic > 0 ? Array.from({ length: SOUND.aiVoices }, () => this.voice(true)) : [];
    this.ready = true;
  }

  // Your car. Called every frame.
  // ers: what the hybrid is doing ('deploy' | 'harvest' | '', ers.js)
  update({ rpm, throttle, slip, surface, speed, hit, gear = 'N', brake = 0, ers = '' }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, P = this.P ?? presetOf(this.car), r = rpm * rpmScaleOf(P);
    if (this.ready) {
      const m = this.me;
      // gearshifts: the revs jump to the new gear straight away, so you hear each shift as it happens
      if (gear !== this.lastGear && gear !== 'N' && this.lastGear !== 'N') {
        const up = Number(gear) > Number(this.lastGear);
        if (SOUND.shiftCut) { m.cut.cancelScheduledValues(t); m.cut.setValueAtTime(up ? 1 : 0.6, t); m.cut.setValueAtTime(0, t + (up ? 0.05 : 0.09)); }
        if (SOUND.shiftClick > 0) this.clunk((up ? 0.22 : 0.14) * SOUND.shiftClick);
        this.snapUntil = t + SOUND.snapTime;
        if (up) this.lastUp = t;
        else if (t - this.lastUp > 0.3) this.loudAt = t; // louder on a real downshift (not the gear flickering at a gear's top speed)
      }
      m.rpm.setTargetAtTime(r, t, t < this.snapUntil ? SOUND.shiftSnap : SOUND.glide); // snap on shifts, glide otherwise
      const load = speed > 3 ? Math.max(throttle, SOUND.liftLoad) : throttle; // engine braking still sounds strong
      m.load.setTargetAtTime(load, t, 0.08);
      // rev limiter bouncing
      if (SOUND.limiter && rpm > (this.car?.gearbox.rpm[1] ?? 13000) - 100 && throttle > 0.6) m.cut.setValueAtTime(Math.floor(t * 26) % 2, t);
      const idle = Math.min(1, Math.max(0, SOUND.idleLevel));
      const since = t - this.loudAt, loud = since < SOUND.loudTime ? 1 + (SOUND.downshiftLoud - 1) * (1 - since / SOUND.loudTime) : 1;
      m.g.gain.setTargetAtTime(SOUND.engine * (P.gain ?? 1) * (idle + throttle * (1 - idle)) * loud, t, loud > 1 ? 0.02 : 0.15);
    }
    this.lastGear = gear;
    const X = this.extras ?? extrasOf(this.car), T = X.turbo, H = X.hybrid;
    const revs = smooth(...(T?.revs ?? [5000, 13000]), rpm), boost = revs * (0.3 + 0.7 * throttle);
    if (this.turbo) {
      this.turbo.frequency.setTargetAtTime(T ? T.hz[0] + boost * (T.hz[1] - T.hz[0]) : 1800, t, 0.25);
      this.turboGain.gain.setTargetAtTime(T ? SOUND.turbo * T.level * boost : 0, t, 0.3);
      this.whine.frequency.setTargetAtTime(H ? H.hz[0] + speed * H.hz[1] : 160, t, 0.05);
      // the F1 car's MGU-K hums all the time, louder under braking; the Hypercar's front motor only when it's working
      const motor = !H ? 0 : !H.deploy ? 0.4 + brake * 1.6 : ers === 'deploy' ? 1 : ers === 'harvest' ? 0.5 * brake : 0;
      this.whineGain.gain.setTargetAtTime(H ? SOUND.hybrid * H.level * motor * smooth(2, 20, speed) : 0, t, 0.1);
    }
    if (this.airGain) {
      this.airFilter.frequency.setTargetAtTime(700 + revs * 2400, t, 0.1);
      this.airGain.gain.setTargetAtTime(0.03 * SOUND.air * throttle * revs, t, 0.08);
    }
    if (this.squealGain) this.squealGain.gain.setTargetAtTime(SOUND.tyres * smooth(1.3, 5, slip) * (speed > 5 ? 1 : 0), t, 0.05);
    if (this.kerbGain) {
      this.kerbLfo.frequency.setTargetAtTime(Math.max(speed / 1.75, 1), t, 0.02);
      this.kerbBuzz.frequency.setTargetAtTime(Math.min(60 + speed * 5, 480), t, 0.02); // ridges go by faster
      this.kerbGain.gain.setTargetAtTime(surface === 'kerb' && speed > 3 ? SOUND.kerbs * (0.9 + 0.8 * smooth(5, 60, speed)) : 0, t, 0.02);
    }
    if (this.offGain) {
      const off = surface === 'grass' || surface === 'gravel' || surface === 'runoff';
      this.offFilter.frequency.setTargetAtTime(surface === 'gravel' ? 2600 : 500, t, 0.05);
      this.offGain.gain.setTargetAtTime(off && speed > 2 ? SOUND.offTrack * Math.min(0.5, speed * 0.012) : 0, t, 0.05);
    }
    if (this.windGain) {
      this.windFilter.frequency.setTargetAtTime(300 + speed * 12, t, 0.2);
      this.windGain.gain.setTargetAtTime(SOUND.wind * smooth(10, 90, speed), t, 0.2);
    }
    if (SOUND.impacts > 0 && hit > 0.25 && this.lastHit <= 0.25) this.thump(hit * SOUND.impacts);
    this.lastHit = hit;
  }

  // Other cars, heard from the camera: louder when close, panned, a little Doppler as they pass.
  updateTraffic(cars, player, camera) {
    if (!this.ready || !this.others.length) return;
    const t = this.ctx.currentTime, e = camera.matrixWorld.elements;
    const lx = e[12], ly = e[13], lz = e[14], rx = e[0], rz = e[2];       // listener position, right vector
    const lvx = player ? player.state.vx : 0, lvz = player ? player.state.vz : 0;
    const near = cars.filter((c) => c !== player).map((c) => {
      const dx = c.state.x - lx, dz = c.state.z - lz, dy = (c.state.y ?? 0) - ly;
      return { c, d: Math.hypot(dx, dy, dz), dx, dz };
    }).filter((o) => o.d < 220).sort((a, b) => a.d - b.d).slice(0, this.others.length);
    const keep = new Set(near.map((o) => o.c));
    for (const v of this.others) if (v.car && !keep.has(v.car)) { v.car = null; v.g.gain.setTargetAtTime(0, t, 0.15); }
    const [dLo, dHi] = SOUND.doppler;
    for (const o of near) {
      let v = this.others.find((x) => x.car === o.c) ?? this.others.find((x) => !x.car);
      if (!v) continue;
      v.car = o.c;
      const s = o.c.state, gb = gearbox(Math.abs(s.vf), s.spec?.gearbox);
      const inv = 1 / Math.max(o.d, 0.001), ux = o.dx * inv, uz = o.dz * inv;
      const away = (s.vx - lvx) * ux + (s.vz - lvz) * uz;                 // + = moving away
      const doppler = Math.min(dHi, Math.max(dLo, 343 / (343 + away)));
      v.rpm.setTargetAtTime(gb.rpm * rpmScaleOf(this.P), t, SOUND.glide);
      v.load.setTargetAtTime(s.throttle ?? 0.8, t, 0.08);
      v.pitch.setTargetAtTime(doppler, t, 0.1);
      v.g.gain.setTargetAtTime(SOUND.traffic * (this.P.gain ?? 1) / (1 + (o.d / 14) ** 2), t, 0.1);
      v.lp.frequency.setTargetAtTime(Math.max(900, 16000 / (1 + o.d / 35)), t, 0.05);   // distant cars sound duller
      if (v.p) v.p.pan.setTargetAtTime(Math.max(-1, Math.min(1, (ux * rx + uz * rz) * 0.9)), t, 0.08);
    }
  }

  // one-shot sounds (off by default: SOUND.shiftClick, SOUND.impacts)
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