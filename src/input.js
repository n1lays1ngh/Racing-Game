// Keyboard + gamepad input.
//   readInput() → { throttle, brake, steer } for driving (steer: +1 = left, −1 = right, like physics.js)
//   pollPad()   → call every frame: turns controller buttons into the same key presses the
//                 keyboard makes, so every menu and shortcut works with a controller too.
//   padFeedback() → controller rumble: engine, braking and lock-ups, kerbs, grass and gravel, slides,
//                   gear changes and crashes (plus trigger resistance on a DualSense: dualsense.js).
//
// Controller layout (Xbox names; PlayStation: A = ✕, B = ○, X = □, Y = △):
//   Driving:  left stick steer · RT throttle · LT brake · A throttle · X brake
//   Race:     Y camera · B (hold) look back · LB mirror · RB tower gaps · View/Share reset · Menu/Options pause
//   Pause:    A resume · Y restart · B quit
//   Menus:    D-pad or LB/RB change circuit · A start · Y multiplayer · Menu/Options (lobby host) start race
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
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
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
    if (pad.buttons[0]?.pressed) throttle = Math.max(throttle, PAD.throttle.max); // A / ✕: full throttle
    if (pad.buttons[2]?.pressed) brake = Math.max(brake, PAD.brake.max);         // X / □: full brake
  }
  return { throttle, brake, steer };
}

// ---------- controller buttons → key presses ----------
const $ = (id) => document.getElementById(id);
const visible = (id) => { const el = $(id); return el && !el.classList.contains('hidden'); };
function screen() {
  if (visible('menu')) return 'menu';
  if (visible('lobby')) return 'lobby';
  if (visible('results')) return 'results';
  if (visible('pause')) return 'pause';
  return 'race';
}
// button index (standard layout) → what it does on each screen: a key code, or 'click:<button id>'
const MAP = {
  menu:    { 0: 'Enter', 9: 'Enter', 14: 'ArrowLeft', 15: 'ArrowRight', 4: 'ArrowLeft', 5: 'ArrowRight', 3: 'click:btn-mp' },
  lobby:   { 9: 'click:lb-go' },
  race:    { 3: 'KeyC', 1: 'KeyQ', 4: 'KeyV', 5: 'KeyT', 8: 'KeyR', 9: 'Escape', 12: 'KeyM' },
  pause:   { 9: 'Escape', 0: 'click:btn-resume', 3: 'click:btn-restart', 1: 'click:btn-quit' },
  results: { 0: 'click:btn-again', 1: 'click:btn-menu', 9: 'click:btn-again' },
};
let prevButtons = [];
const held = new Map(); // button → key it is holding down (released on button up, whatever the screen)

function sendKey(type, code) { window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true })); }

export function pollPad() {
  const pad = activePad();
  if (!pad) { prevButtons = []; return; }
  const map = MAP[screen()];
  pad.buttons.forEach((b, i) => {
    const was = prevButtons[i] ?? false, now = b.pressed;
    if (now && !was) {
      const action = map[i];
      if (!action) return;
      if (action.startsWith('click:')) $(action.slice(6))?.click();
      else { sendKey('keydown', action); held.set(i, action); }
    } else if (!now && was && held.has(i)) {
      sendKey('keyup', held.get(i)); held.delete(i);
    }
  });
  prevButtons = pad.buttons.map((b) => b.pressed);
}

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

// "Controller connected" note on the menu
function showPad(e) {
  const k = document.querySelector('.keys');
  if (!k) return;
  let tag = k.querySelector('.pad-tag');
  if (!tag) { tag = document.createElement('span'); tag.className = 'pad-tag'; k.appendChild(tag); }
  tag.textContent = e.type === 'gamepadconnected' ? '🎮 Controller connected: A to race' : '';
}
window.addEventListener('gamepadconnected', showPad);
window.addEventListener('gamepaddisconnected', showPad);

// True once per key press (for toggles like camera and pause).
export function wasPressed(code) {
  if (pressedOnce.has(code)) { pressedOnce.delete(code); return true; }
  return false;
}
export function clearPressed() { pressedOnce.clear(); }