// Keyboard + gamepad input.
//   readInput() → { throttle, brake, steer, boost } for driving (steer: +1 = left, −1 = right, like
//                 physics.js; boost: the ERS button is held, see ers.js)
//   pollPad(dt) → call every frame: in a race, controller buttons press the same keys as the keyboard's shortcuts;
//                 in the menus and the pause menu the controller moves round the buttons (D-pad / left stick, A, B).
//   padFeedback() → controller rumble: engine, braking and lock-ups, kerbs, grass and gravel, slides,
//                   gear changes and crashes (plus trigger resistance on a DualSense: dualsense.js).
//
// Controller layout (Xbox names; PlayStation: A = ✕, B = ○, X = □, Y = △, LB = L1, RT = R2, LT = L2, Menu = Options,
// View = Create). The full list is on the Controls screen (index.html #controls).
//   Driving:  left stick steer · RT throttle · LT brake · LB (hold) ERS boost · right stick down (hold) look back
//   Race:     X reset · Y camera · B pause · R3 mirror · Menu map (whole circuit / road ahead) · View mute
//             D-pad left headlights · D-pad up tower gaps
//   Menus:    D-pad or left stick move · A choose · B back · LB / RB a slider by 10 · X time of day (race setup)
//             start screen: Y multiplayer, X your stats
// Works with any controller the browser reports with the "standard" layout (Xbox, PlayStation,
// Switch Pro and most others in Chrome, Edge, Firefox and Safari).
import { triggerFeedback } from './dualsense.js';

export const PAD = {
  deadzone: 0.08,     // ignore tiny stick movements
  steerCurve: 1.5,    // 1 = linear; higher = gentler around the centre, full lock at the edge
  // Triggers: how far you press (0–1) → how much throttle or brake (0–1).
  //   deadzone: pressure ignored at the start (stops a resting finger creeping on the throttle)
  //   full:     pressure that already gives 100% (so you don't have to crush the trigger)
  //   curve:    1 = straight; above 1 = finer control in the first half of the travel (more room
  //             for 20–60%), the last part of the travel does the most; below 1 = more sensitive
  //   max:      most it can ever ask for (0.8 = never more than 80%)
  throttle: { deadzone: 0.04, full: 0.97, curve: 1.35, max: 1 },
  // The brake is "heavier": a little more travel before it bites and a steeper curve, so it firms up
  // towards the end of the travel like a real brake pedal (real resistance on a DualSense: dualsense.js).
  brake: { deadzone: 0.07, full: 0.93, curve: 1.8, max: 1 },
  rumble: 1.3,        // vibration strength: 0 = off, 1 = normal, 2 = very strong
  engineRumble: 0.5,  // the engine's buzz under throttle (part of rumble; 0 = none)
  triggerRumble: true, // Xbox controllers in Chrome/Edge on Windows: rumble inside the triggers too
};

// trigger pressure → pedal, with the settings above
function pedal(raw, P) {
  const v = Math.min(1, Math.max(0, (raw - P.deadzone) / (P.full - P.deadzone)));
  return Math.pow(v, P.curve) * P.max;
}

const keys = new Set();
const pressedOnce = new Set();

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
  if (!keys.has(e.code)) pressedOnce.add(e.code);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

let steerSmooth = 0;

function activePad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) if (p && p.connected) return p;
  return null;
}

export function readInput(dt) {
  let throttle = keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0;
  let brake = keys.has('KeyS') || keys.has('ArrowDown') || keys.has('Space') ? 1 : 0;
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');
  const keySteer = (left ? 1 : 0) - (right ? 1 : 0);
  let boost = keys.has('ShiftLeft') || keys.has('ShiftRight');          // ERS (ers.js)

  // Keyboards are digital, so ramp steering in/out for smoother lines.
  const rate = keySteer === 0 ? 4 : Math.sign(keySteer) !== Math.sign(steerSmooth) ? 6 : 2.2;
  steerSmooth += Math.max(-rate * dt, Math.min(rate * dt, keySteer - steerSmooth));
  let steer = steerSmooth;

  // Controller: analogue steering and pedals
  const pad = activePad();
  if (pad) {
    const x = pad.axes[0] ?? 0;
    if (Math.abs(x) > PAD.deadzone) {
      const m = (Math.abs(x) - PAD.deadzone) / (1 - PAD.deadzone);   // no jump at the edge of the deadzone
      steer = -Math.sign(x) * Math.pow(m, PAD.steerCurve);
    }
    const rt = pedal(pad.buttons[7]?.value ?? 0, PAD.throttle), lt = pedal(pad.buttons[6]?.value ?? 0, PAD.brake);
    throttle = Math.max(throttle, rt);
    brake = Math.max(brake, lt);
    if (pad.buttons[4]?.pressed) boost = true;                                    // LB / L1: ERS boost
  }
  return { throttle, brake, steer, boost };
}

// ---------- controller buttons ----------
// Button numbers in the browser's standard layout (Xbox names; PlayStation in brackets)
export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
// In a race: button → the key it presses (the keyboard shortcut does the same). RT / LT / LB and the left stick are
// read in readInput(); the right stick pushed down holds Q (look back).
export const RACE_BUTTONS = {
  [BTN.X]: 'KeyR',      // reset onto the track
  [BTN.Y]: 'KeyC',      // camera
  [BTN.B]: 'Escape',    // pause
  [BTN.R3]: 'KeyV',     // mirror
  [BTN.MENU]: 'KeyZ',   // map: whole circuit / road ahead
  [BTN.VIEW]: 'KeyM',   // mute
  [BTN.LEFT]: 'KeyH',   // headlights
  [BTN.UP]: 'KeyT',     // timing tower: interval / gap to leader
};
export const LOOK_BACK = { key: 'KeyQ', on: 0.55, off: 0.35 }; // right stick down past `on` (let go below `off`)

// Menus and pause: the D-pad or the left stick moves the focus between the buttons on screen, A presses the one
// with the focus, B goes back. On a screen:
//   root:    the element whose buttons the controller moves between
//   arrows:  instead, the D-pad sends the arrow keys (the car and circuit steps pick with them: menu.js)
//   a:       what A does when nothing on the screen has the focus; b: what B does
//   buttons: other buttons. Actions are a key code, or 'click:<button id>'.
const SCREENS = {
  home:     { root: 'menu', a: 'Enter', buttons: { [BTN.MENU]: 'Enter', [BTN.Y]: 'click:btn-mp', [BTN.X]: 'click:btn-stats' } },
  steps:    { arrows: true, a: 'Enter', b: 'Escape', buttons: { [BTN.MENU]: 'Enter', [BTN.X]: 'KeyN', [BTN.LB]: 'PageDown', [BTN.RB]: 'PageUp' } },
  setup:    { root: 'menu', a: 'Enter', b: 'Escape', buttons: { [BTN.MENU]: 'Enter', [BTN.X]: 'KeyN' } },
  pause:    { root: 'pause', b: 'Escape', buttons: { [BTN.MENU]: 'Escape' } },
  results:  { root: 'results', b: 'click:btn-menu', buttons: { [BTN.MENU]: 'click:btn-again' } },
  stats:    { root: 'stats', b: 'click:st-back', buttons: { [BTN.MENU]: 'click:st-back' } },
  lobby:    { root: 'lobby', b: 'click:lb-back', buttons: { [BTN.MENU]: 'click:lb-go' } },
  controls: { root: 'controls', b: 'click:ctl-back', buttons: { [BTN.MENU]: 'click:ctl-back' } },
};
const NAV = { stick: 0.55, delay: 0.38, repeat: 0.11 }; // stick push that counts as a direction; held: first repeat, then every

const $ = (id) => document.getElementById(id);
const visible = (id) => { const el = $(id); return el && !el.classList.contains('hidden'); };
function screen() {
  if (visible('controls')) return 'controls';
  if (visible('pause')) return 'pause';
  if (visible('results')) return 'results';
  if (visible('stats')) return 'stats';
  if (visible('lobby')) return 'lobby';
  if (visible('menu')) { const step = $('menu').dataset.step; return step === 'home' ? 'home' : step === 'setup' ? 'setup' : 'steps'; }
  return 'race';
}

let prevButtons = [];
const held = new Map(); // button → key it is holding down (released on button up, whatever the screen)
let lookBack = false, navDir = null, navNext = 0, lastScreen = null;

function sendKey(type, code) { window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true })); }
function act(action) {
  if (!action) return;
  if (action.startsWith('click:')) $(action.slice(6))?.click();
  else { sendKey('keydown', action); sendKey('keyup', action); }
}

// ---- moving the focus ----
function candidates(root) {
  return [...root.querySelectorAll('button, input[type="range"], a[href], [tabindex]:not([tabindex="-1"])')].filter((el) =>
    !el.disabled && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.hidden, [inert]'));
}
function focusEl(el, pad = true) {
  if (pad) document.body.classList.add('pad-nav');
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
// the nearest button in that direction (dx, dy: −1 / 0 / 1)
function move(root, dx, dy, pad = true) {
  const items = candidates(root), cur = items.includes(document.activeElement) ? document.activeElement : null;
  if (!cur) { if (items[0]) focusEl(items[0], pad); return; }
  const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, score = Infinity;
  for (const el of items) {
    if (el === cur || el.contains(cur) || cur.contains(el)) continue;
    const q = el.getBoundingClientRect(), ex = q.left + q.width / 2, ey = q.top + q.height / 2;
    const beyond = dx > 0 ? q.left >= r.right - 6 : dx < 0 ? q.right <= r.left + 6 : dy > 0 ? q.top >= r.bottom - 6 : q.bottom <= r.top + 6;
    if (!beyond) continue;
    const along = dx ? (ex - cx) * dx : (ey - cy) * dy;
    const gap = dx ? Math.max(0, q.top - r.bottom, r.top - q.bottom) : Math.max(0, q.left - r.right, r.left - q.right); // off to the side
    const s = along + gap * 3 + Math.abs(dx ? ey - cy : ex - cx) * 0.3;
    if (s < score) { score = s; best = el; }
  }
  if (best) focusEl(best, pad);
}
// a slider with the focus: ← → move it (by 10 with LB / RB)
function nudge(el, by) {
  const step = Number(el.step) || 1, v = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) + by * step));
  if (String(v) === el.value) return;
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function navigate(S, dir) {
  if (S.arrows) { act({ '-1,0': 'ArrowLeft', '1,0': 'ArrowRight', '0,-1': 'ArrowUp', '0,1': 'ArrowDown' }[dir.join()]); return; }
  const root = $(S.root), el = document.activeElement;
  if (dir[0] && el?.type === 'range' && root.contains(el)) { document.body.classList.add('pad-nav'); nudge(el, dir[0]); return; }
  move(root, dir[0], dir[1]);
}

export function pollPad(dt = 1 / 60) {
  const pad = activePad();
  if (!pad) { prevButtons = []; return; }
  const name = screen(), S = SCREENS[name];
  const down = (i) => !!pad.buttons[i]?.pressed && !prevButtons[i];
  pad.buttons.forEach((b, i) => { // let go of a held key
    if (!b.pressed && prevButtons[i] && held.has(i)) { sendKey('keyup', held.get(i)); held.delete(i); }
  });
  // right stick down: look back while it's held (only while driving)
  const rs = pad.axes[3] ?? 0, wantBack = name === 'race' && (lookBack ? rs > LOOK_BACK.off : rs > LOOK_BACK.on);
  if (wantBack !== lookBack) { lookBack = wantBack; sendKey(wantBack ? 'keydown' : 'keyup', LOOK_BACK.key); }

  if (!S) { // driving
    pad.buttons.forEach((b, i) => { const key = RACE_BUTTONS[i]; if (key && down(i)) { sendKey('keydown', key); held.set(i, key); } });
    navDir = null;
  } else {
    // direction: D-pad or left stick, repeating while held
    const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0, B = pad.buttons;
    const dx = B[BTN.LEFT]?.pressed || ax < -NAV.stick ? -1 : B[BTN.RIGHT]?.pressed || ax > NAV.stick ? 1 : 0;
    const dy = dx ? 0 : B[BTN.UP]?.pressed || ay < -NAV.stick ? -1 : B[BTN.DOWN]?.pressed || ay > NAV.stick ? 1 : 0;
    const dir = dx || dy ? [dx, dy] : null, key = dir?.join() ?? null;
    if (name !== lastScreen) { navDir = dir; navNext = NAV.delay; } // just got here (still steering, say): wait for a new push
    else if (key !== (navDir?.join() ?? null)) { navDir = dir; if (dir) { navigate(S, dir); navNext = NAV.delay; } }
    else if (dir && (navNext -= dt) <= 0) { navigate(S, dir); navNext = NAV.repeat; }

    if (down(BTN.A)) {
      const root = S.root && $(S.root), el = document.activeElement;
      if (root && el && el !== document.body && root.contains(el) && candidates(root).includes(el)) { if (el.type !== 'range') el.click(); }
      else act(S.a);
    }
    if (down(BTN.B)) act(S.b);
    for (const [i, action] of Object.entries(S.buttons ?? {})) if (down(Number(i))) act(action);
    if (S.root && (down(BTN.LB) || down(BTN.RB))) { // a slider with the focus: by 10
      const el = document.activeElement;
      if (el?.type === 'range' && $(S.root).contains(el)) nudge(el, down(BTN.RB) ? 10 : -10);
    }
    if (B.some((b, i) => b.pressed && !prevButtons[i])) document.body.classList.add('pad-nav');
  }
  lastScreen = name;
  prevButtons = pad.buttons.map((b) => b.pressed);
}
// the controller's focus ring goes away as soon as you use the mouse or the keyboard
window.addEventListener('mousemove', (e) => { if (e.movementX || e.movementY) document.body.classList.remove('pad-nav'); });
// The arrow keys move between the buttons too, on the screens where they don't already do something
// (the car, circuit and race setup steps use them to pick: menu.js)
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
window.addEventListener('keydown', (e) => {
  if (!e.isTrusted) return;
  document.body.classList.remove('pad-nav');
  const name = screen(), d = ARROWS[e.code];
  if (!d || !['home', 'pause', 'results', 'controls'].includes(name)) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
  if (document.activeElement?.type === 'range' && d[0]) return; // a slider: the arrows move it
  move($(SCREENS[name].root), d[0], d[1], false);
});

// ---------- rumble ----------
// Two motors: "strong" (low, heavy) and "weak" (high, buzzy). Each frame the effects below are added up:
//   engine   – a light buzz that grows with throttle and revs
//   braking  – heavy rumble with brake pressure at speed; a hard pulsing when the wheels lock
//   kerbs    – pulses at the rate the red and white stripes go under the car
//   off track – grass judders, gravel shakes hard
//   slides   – buzz that grows with how sideways the car is
//   gears    – a short kick on each change
//   crashes  – a big hit, held a little longer
let nextRumble = 0, lastT = performance.now(), kerbPhase = 0, lastGear = null, kick = 0, hitHold = 0;
export function padFeedback({ hit = 0, surface = 'road', speed = 0, slip = 0, throttle = 0, brake = 0, lock = false, rpm = 0, gear = null }) {
  const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  kerbPhase = (kerbPhase + (speed * dt) / 1.75) % 2;                 // one stripe every 1.75 m
  if (gear !== lastGear && lastGear !== null && gear !== 'N') kick = 0.07; // seconds
  lastGear = gear; kick = Math.max(0, kick - dt);
  hitHold = Math.max(hit, hitHold - dt * 2.5);
  triggerFeedback({ brake, lock, throttle, speed });                // DualSense trigger resistance (if connected)

  const pad = activePad(), act = pad?.vibrationActuator;
  if (!PAD.rumble || !act || now < nextRumble) return;
  const fast = Math.min(1, speed / 60);
  let strong = 0, weak = PAD.engineRumble * (0.04 + 0.16 * throttle * Math.min(1, rpm / 13000));
  strong += brake * 0.35 * fast;                                        // braking load
  if (lock && speed > 8) strong += (Math.floor(now / 45) % 2) * 0.7;    // locked wheels: hard pulsing
  if (surface === 'kerb' && speed > 4) { const on = kerbPhase < 1 ? 1 : 0.45; strong += 0.35 * on; weak += 0.6 * on; }
  else if (surface === 'gravel' && speed > 2) { strong += 0.55 + Math.random() * 0.25; weak += 0.5; }
  else if (surface !== 'road' && speed > 2) { strong += 0.2 + Math.random() * 0.15; weak += 0.55; }
  if (slip > 1.5 && speed > 8) weak += Math.min(0.6, (slip - 1.5) * 0.12);
  if (kick > 0) strong += 0.45;
  strong += Math.min(1, hitHold * 1.4);
  strong = Math.min(1, strong * PAD.rumble); weak = Math.min(1, weak * PAD.rumble);
  if (strong < 0.02 && weak < 0.02) return;
  const opts = { duration: 80, strongMagnitude: strong, weakMagnitude: weak };
  if (PAD.triggerRumble && act.effects?.includes('trigger-rumble')) {   // the triggers themselves (Xbox, Windows)
    act.playEffect('trigger-rumble', { ...opts,
      leftTrigger: Math.min(1, (brake * 0.25 * fast + (lock ? (Math.floor(now / 45) % 2) * 0.9 : 0)) * PAD.rumble),
      rightTrigger: Math.min(1, (slip > 2 && throttle > 0.5 && speed < 40 ? 0.5 : throttle * 0.08) * PAD.rumble) }).catch(() => {});
  } else act.playEffect('dual-rumble', opts).catch(() => {});
  nextRumble = now + 50;
}

// "Controller connected" note on the start screen
function showPad(e) {
  const k = document.querySelector('#menu .keys');
  if (!k) return;
  let tag = k.querySelector('.pad-tag');
  if (!tag) { tag = document.createElement('span'); tag.className = 'pad-tag'; k.appendChild(tag); }
  tag.textContent = e.type === 'gamepadconnected' ? 'Controller connected: A to race, Y multiplayer, X your stats' : '';
}
window.addEventListener('gamepadconnected', showPad);
window.addEventListener('gamepaddisconnected', showPad);

// True once per key press (for toggles like camera and pause).
export function wasPressed(code) {
  if (pressedOnce.has(code)) { pressedOnce.delete(code); return true; }
  return false;
}
export function clearPressed() { pressedOnce.clear(); }