// The loading screen: up while something heavy is being made ready, so you see progress instead of a frozen picture.
// A race starting (the circuit built a piece at a time, the cars, the shaders compiled before the lights come on),
// a graphics change that rebuilds the scenery. main.js decides when; this is just the screen.
//
//   const loader = new Loader()
//   loader.show({ title, sub })     up at once (a circuit's name, say, and what you're racing there)
//   loader.step(0.4, 'Scenery')     how far along (0–1, never goes back) and what it's doing now
//   await loader.hide()             away (a short fade), but not before it's been up for LOADING.minMs: no flash
//   loader.active                   up (or going)
//
//   await nextFrame()               after the next frame has been drawn (so the screen is up before heavy work starts)
//   await within(promise, ms)       a promise, but no longer than ms (shader compiling can take a while on some GPUs)
import { IS_MOBILE } from './mobile/detect.js';

export const LOADING = {
  minMs: 650,   // up at least this long (shorter looks like a glitch)
  fadeMs: 260,  // fade out
  tipMs: 4200,  // a new tip after this long
};

const TIPS_KEYS = [
  'Steering and brake assists: pause → Settings, or the race setup. Low, Medium or High.',
  'Brake assist on High: keep the throttle down, it brakes and lifts for you.',
  'Steering assist on High drives the racing line for you: steer yourself to overtake.',
  'Racing line on the track: pause → Settings. Green: throttle. Red: brake.',
  'C changes the camera, Q looks behind, Z zooms the minimap.',
  'R puts you back on the track (that lap won’t count).',
  'With pit stops on: 1 2 3 picks your tyres, B to box.',
  'G changes the graphics (Low, Medium, High) during a race.',
];
const TIPS_TOUCH = [
  'Steering and brake assists: pause → Settings, or the race setup. Low, Medium or High.',
  'Brake assist on High: keep the throttle down, it brakes and lifts for you.',
  'Steering assist on High drives the racing line for you: steer yourself to overtake.',
  'Edit HUD layout (pause → Settings) to move and size every button.',
  'Slide steering: put your thumb down anywhere on the left and slide it sideways.',
  'Cam changes the camera, Look looks behind, Reset puts you back on the track.',
];

export class Loader {
  constructor() {
    const el = this.el = document.createElement('div');
    el.id = 'loading';
    el.className = 'hidden';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<div class="ld-box">' +
      '<div class="ld-kicker"><span class="ld-slash"></span>Loading</div>' +
      '<div class="ld-title"></div><div class="ld-sub"></div>' +
      '<div class="ld-bar"><i></i></div>' +
      '<div class="ld-row"><span class="ld-stage"></span><span class="ld-pct"></span></div>' +
      '<p class="ld-tip"></p>' +
      '</div>';
    document.body.appendChild(el);
    this.$ = (s) => el.querySelector(s);
    this.bar = this.$('.ld-bar i');
    this.active = false; this.f = 0; this.shownAt = 0; this.tipTimer = 0; this.hiding = null;
    this.tips = IS_MOBILE ? TIPS_TOUCH : TIPS_KEYS;
    this.tip = Math.floor(Math.random() * this.tips.length);
  }

  show({ title = '', sub = '' } = {}) {
    clearTimeout(this.hideTimer); this.hiding = null;
    this.$('.ld-title').textContent = title;
    this.$('.ld-sub').textContent = sub;
    this.f = 0; this.bar.style.transform = 'scaleX(0)';
    this.$('.ld-stage').textContent = ''; this.$('.ld-pct').textContent = '';
    if (!this.active) { this.shownAt = performance.now(); this.nextTip(); }
    this.active = true;
    this.el.classList.remove('hidden', 'out');
    clearInterval(this.tipTimer);
    this.tipTimer = setInterval(() => this.nextTip(), LOADING.tipMs);
  }

  step(f, stage) {
    if (!this.active) return;
    this.f = Math.max(this.f, Math.min(1, f));
    this.bar.style.transform = `scaleX(${this.f})`;
    this.$('.ld-pct').textContent = `${Math.round(this.f * 100)}%`;
    if (stage) this.$('.ld-stage').textContent = stage;
  }

  nextTip() { this.tip = (this.tip + 1) % this.tips.length; this.$('.ld-tip').textContent = this.tips[this.tip]; }

  hide() {
    if (!this.active) return Promise.resolve();
    if (this.hiding) return this.hiding;
    this.step(1);
    const wait = Math.max(0, LOADING.minMs - (performance.now() - this.shownAt));
    this.hiding = new Promise((done) => {
      this.hideTimer = setTimeout(() => {
        this.el.classList.add('out');
        this.hideTimer = setTimeout(() => {
          this.el.classList.add('hidden'); this.el.classList.remove('out');
          clearInterval(this.tipTimer);
          this.active = false; this.hiding = null;
          done();
        }, LOADING.fadeMs);
      }, wait);
    });
    return this.hiding;
  }

  // gone at once (the race it was loading was called off)
  cancel() {
    clearTimeout(this.hideTimer); clearInterval(this.tipTimer);
    this.el.classList.add('hidden'); this.el.classList.remove('out');
    this.active = false; this.hiding = null;
  }
}

// After the next frame has been drawn. (A hidden tab draws no frames: then it goes on after a moment anyway.)
export function nextFrame() {
  return new Promise((go) => {
    let done = false;
    const fin = () => { if (!done) { done = true; go(); } };
    if (!document.hidden) requestAnimationFrame(() => setTimeout(fin, 0));
    setTimeout(fin, document.hidden ? 0 : 150);
  });
}

// A promise, but given up on (resolves anyway) after ms
export function within(promise, ms) {
  return Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((go) => setTimeout(go, ms))]);
}