// Keyboard + gamepad input.
//   readInput() → { throttle, brake, steer } for driving (steer: +1 = left, −1 = right, like physics.js)
//   pollPad()   → call every frame: turns controller buttons into the same key presses the
//                 keyboard makes, so every menu and shortcut works with a controller too.
//   padFeedback() → controller rumble for kerbs, grass and crashes.
//
// Controller layout (Xbox names; PlayStation: A = ✕, B = ○, X = □, Y = △):
//   Driving:  left stick steer · RT throttle · LT brake · A throttle · X brake
//   Race:     Y camera · B (hold) look back · LB mirror · RB tower gaps · View/Share reset · Menu/Options pause
//   Pause:    A resume · Y restart · B quit
//   Menus:    D-pad or LB/RB change circuit · A start · B back
// Works with any controller the browser reports with the "standard" layout (Xbox, PlayStation,
// Switch Pro and most others in Chrome, Edge, Firefox and Safari).
export const PAD = {
  deadzone: 0.08,     // ignore tiny stick movements
  steerCurve: 1.5,    // 1 = linear; higher = gentler around the centre, full lock at the edge
  rumble: true,
};

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
    const rt = pad.buttons[7]?.value ?? 0, lt = pad.buttons[6]?.value ?? 0;
    if (rt > 0.03) throttle = Math.max(throttle, rt);
    if (lt > 0.03) brake = Math.max(brake, lt);
    if (pad.buttons[0]?.pressed) throttle = 1;
    if (pad.buttons[2]?.pressed) brake = 1;
  }
  return { throttle, brake, steer };
}

// ---------- controller buttons → key presses ----------
const $ = (id) => document.getElementById(id);
const visible = (id) => { const el = $(id); return el && !el.classList.contains('hidden'); };
function screen() {
  if (visible('menu')) return 'menu';
  if (visible('results')) return 'results';
  if (visible('pause')) return 'pause';
  return 'race';
}
// button index (standard layout) → what it does on each screen: a key code, or 'click:<button id>'
const MAP = {
  menu:    { 0: 'Enter', 9: 'Enter', 14: 'ArrowLeft', 15: 'ArrowRight', 4: 'ArrowLeft', 5: 'ArrowRight' },
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
let nextRumble = 0;
export function padFeedback({ hit = 0, surface = 'road', speed = 0, slip = 0 }) {
  const pad = activePad(), act = pad?.vibrationActuator;
  if (!PAD.rumble || !act || performance.now() < nextRumble) return;
  let strong = Math.min(1, hit * 1.2), weak = 0;
  if (surface === 'kerb' && speed > 5) weak = 0.35;
  else if (surface !== 'road' && speed > 3) { weak = 0.5; strong = Math.max(strong, 0.25); }
  if (slip > 2 && speed > 8) weak = Math.max(weak, Math.min(0.4, slip * 0.06));
  if (strong < 0.02 && weak < 0.02) return;
  act.playEffect('dual-rumble', { duration: 90, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  nextRumble = performance.now() + 70;
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