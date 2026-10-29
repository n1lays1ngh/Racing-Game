// Touch controls for phones and tablets (only loaded there: src/mobile/index.js).
//
// Three ways to steer (the setting is remembered, and is on the start screen and in the pause menu's Settings):
//   slide    put your left thumb anywhere on the left of the screen and slide it sideways: analogue steering, the
//            further from where you put it down, the more lock (the default: smooth, and the physics likes it)
//   buttons  two buttons, left and right: digital, eased in and out like the keyboard
//   tilt     tilt the phone like a steering wheel (its motion sensor). Level is wherever you hold it when the lights
//            come on (or press Recenter in Settings); the brake moves to the left thumb
// The pedals are on the right (throttle, brake; the boost button above them on a car with ERS on a button), and the small
// buttons along the top press the same keys as the keyboard: pause, camera, look back (held), reset, box.
//
//   const touch = new TouchControls()
//   touch.input(dt)          → { throttle, brake, steer, boost }   (input.js readInput adds it to the keyboard's)
//   touch.setMode(mode)      'slide' | 'buttons' | 'tilt'
//   touch.show(on, race)     shown only while you're racing (not paused, no results)
//   touch.recenter()         tilt: level is how you're holding it now
export const TOUCH = {
  slideRange: 0.11,     // slide: share of the screen's width for full lock (from where your thumb went down)
  slideDead: 0.05,      // … dead zone in the middle (share of full lock)
  slideCurve: 1.35,     // 1 = straight; higher = gentler near the centre, full lock at the edge
  tiltMax: 28,          // tilt: degrees for full lock
  tiltDead: 2,          // … degrees of dead zone in the middle
  tiltSmooth: 0.08,     // … seconds of smoothing (the sensor is jittery)
  buttonRate: [2.4, 6], // buttons: how fast the steering comes in / goes back to the middle (as the keyboard's)
  release: 9,           // slide and tilt: how fast the steering goes back to the middle when you let go
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const KEYS = [ // the small buttons along the top: [label, key, held?, extra class]
  ['❚❚', 'Escape', false, 't-pause', 'Pause'],
  ['Cam', 'KeyC', false, '', 'Camera'],
  ['Look', 'KeyQ', true, '', 'Look behind (hold)'],
  ['Reset', 'KeyR', false, '', 'Back onto the track'],
  ['Box', 'KeyB', false, 't-box', 'Box: pit this lap'],
];
function key(type, code) { window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true })); }
const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* no vibration (iPhone) */ } };

export class TouchControls {
  constructor() {
    const el = this.el = document.createElement('div');
    el.id = 'touch';
    el.innerHTML =
      `<div class="t-top">${KEYS.map(([label, code, hold, cls, title]) =>
        `<div class="t-mini ${cls}" role="button" aria-label="${title}" data-key="${code}"${hold ? ' data-hold="1"' : ''}>${label}</div>`).join('')}</div>` +
      '<div class="t-steer" data-act="slide"><i class="t-base"></i><i class="t-knob"></i></div>' +
      '<div class="t-arrow t-left" data-act="left" role="button" aria-label="Steer left"><i></i></div>' +
      '<div class="t-arrow t-right" data-act="right" role="button" aria-label="Steer right"><i></i></div>' +
      '<div class="t-pedal t-brake" data-act="brake" role="button" aria-label="Brake"><span>Brake</span></div>' +
      '<div class="t-pedal t-gas" data-act="gas" role="button" aria-label="Throttle"><span>Throttle</span></div>' +
      '<div class="t-boost" data-act="boost" role="button" aria-label="Boost"><span>Boost</span></div>';
    document.body.appendChild(el);
    this.base = el.querySelector('.t-base'); this.knob = el.querySelector('.t-knob');
    this.ptr = new Map(); // pointer id → { act, el, x0, x }
    this.mode = 'slide'; this.steer = 0; this.visible = false;
    this.tilt = { raw: null, smooth: 0, neutral: null, invert: false, seen: false };
    this.onMotion = (e) => this.motion(e);
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, (e) => this.up(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setMode(mode) {
    this.mode = ['slide', 'buttons', 'tilt'].includes(mode) ? mode : 'slide';
    this.el.dataset.mode = this.mode;
    if (this.mode === 'tilt') window.addEventListener('devicemotion', this.onMotion);
    else window.removeEventListener('devicemotion', this.onMotion);
    this.tilt.neutral = null;
  }
  setInvert(on) { this.tilt.invert = !!on; }

  // shown while racing; race: which extra buttons (boost on a car with ERS on a button, box when there are pit stops)
  show(on, race) {
    if (on !== this.visible) {
      this.visible = on; this.el.classList.toggle('on', on);
      if (!on) this.releaseAll();
    }
    if (on && race) {
      const ers = race.carDef?.ers;
      this.el.classList.toggle('has-boost', !!ers && !ers.auto);
      this.el.classList.toggle('has-box', !!race.pits);
    }
  }

  releaseAll() {
    for (const p of this.ptr.values()) if (p.hold) key('keyup', p.hold);
    this.ptr.clear();
    for (const b of this.el.querySelectorAll('.down')) b.classList.remove('down');
    this.base.classList.remove('on'); this.knob.classList.remove('on');
  }

  down(e) {
    e.preventDefault();
    const target = e.target.closest('[data-act], [data-key]');
    if (!target) return;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* fine */ }
    if (target.dataset.key) { // a top button: press its key (held ones until you let go)
      const code = target.dataset.key, hold = target.dataset.hold ? code : null;
      key('keydown', code); if (!hold) key('keyup', code);
      target.classList.add('down'); buzz(8);
      this.ptr.set(e.pointerId, { act: 'key', el: target, hold });
      return;
    }
    const act = target.dataset.act;
    this.ptr.set(e.pointerId, { act, el: target, x0: e.clientX, x: e.clientX });
    target.classList.add('down');
    if (act === 'slide') { this.place(this.base, e.clientX, e.clientY); this.place(this.knob, e.clientX, e.clientY); this.base.classList.add('on'); this.knob.classList.add('on'); }
    else buzz(6);
  }
  move(e) {
    const p = this.ptr.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    p.x = e.clientX;
    if (p.act === 'slide') {
      const range = TOUCH.slideRange * window.innerWidth, dx = clamp(p.x - p.x0, -range, range);
      this.knob.style.transform = `translate(${p.x0 + dx}px, ${parseFloat(this.knob.dataset.y)}px) translate(-50%, -50%)`;
    }
  }
  up(e) {
    const p = this.ptr.get(e.pointerId);
    if (!p) return;
    this.ptr.delete(e.pointerId);
    if (p.hold) key('keyup', p.hold);
    if (![...this.ptr.values()].some((q) => q.el === p.el)) p.el.classList.remove('down');
    if (p.act === 'slide') { this.base.classList.remove('on'); this.knob.classList.remove('on'); }
  }
  place(dot, x, y) { dot.dataset.y = y; dot.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`; }

  // tilt: the angle of gravity across the screen, from the motion sensor. Only the change from level counts, so it
  // doesn't matter which way up the phone is or which way round the browser reports gravity
  motion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null) return;
    if (Math.hypot(g.x, g.y) < 3) return; // lying flat: no steering angle to read
    this.tilt.raw = Math.atan2(g.y, g.x) * 180 / Math.PI; this.tilt.seen = true;
  }
  recenter() { this.tilt.neutral = this.tilt.raw; }

  input(dt) {
    let throttle = 0, brake = 0, boost = false, slide = null, left = false, right = false;
    for (const p of this.ptr.values()) {
      if (p.act === 'gas') throttle = 1;
      else if (p.act === 'brake') brake = 1;
      else if (p.act === 'boost') { boost = true; throttle = 1; } // (boost is on the throttle: it needs it)
      else if (p.act === 'left') left = true;
      else if (p.act === 'right') right = true;
      else if (p.act === 'slide') slide = p;
    }
    let target = 0, rate = TOUCH.release;
    if (this.mode === 'slide' && slide) {
      const x = clamp((slide.x - slide.x0) / (TOUCH.slideRange * window.innerWidth), -1, 1), a = Math.abs(x);
      const m = a <= TOUCH.slideDead ? 0 : Math.pow((a - TOUCH.slideDead) / (1 - TOUCH.slideDead), TOUCH.slideCurve);
      target = -Math.sign(x) * m; rate = 30; // (+ = left, as physics.js; follows your thumb almost at once)
    } else if (this.mode === 'buttons') {
      const k = (left ? 1 : 0) - (right ? 1 : 0);
      target = k;
      rate = k === 0 ? TOUCH.buttonRate[1] : Math.sign(k) !== Math.sign(this.steer) ? TOUCH.buttonRate[1] : TOUCH.buttonRate[0];
    } else if (this.mode === 'tilt' && this.tilt.raw != null) {
      if (this.tilt.neutral == null) this.tilt.neutral = this.tilt.raw;
      let d = this.tilt.raw - this.tilt.neutral; d = ((d + 540) % 360) - 180;          // −180 … 180
      const k = Math.min(1, dt / TOUCH.tiltSmooth); this.tilt.smooth += (d - this.tilt.smooth) * k;
      const a = Math.abs(this.tilt.smooth);
      const m = a <= TOUCH.tiltDead ? 0 : Math.min(1, (a - TOUCH.tiltDead) / (TOUCH.tiltMax - TOUCH.tiltDead));
      // turning the phone clockwise (steering right) turns gravity anticlockwise across the screen: the angle grows
      target = -Math.sign(this.tilt.smooth) * m * (this.tilt.invert ? -1 : 1); rate = 30;
    }
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);
    if (Math.abs(this.steer) < 1e-3 && target === 0) this.steer = 0;
    return { throttle, brake, steer: this.steer, boost };
  }
}