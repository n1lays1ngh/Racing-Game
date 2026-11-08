// Haptics: what you feel through your hands. Phone vibration (the touch controls, the car on the road) and controller
// rumble (input.js padFeedback), on one setting: Off, Low, Medium or High (pause → Settings, or the main menu's).
//
//   Low     only the big moments: crashes, contact, locking the wheels
//   Medium  + the road: kerbs stripe by stripe, grass and gravel, gear changes, the lights going out, buttons
//   High    + everything: the engine through the revs, braking load, wheelspin and slides, every bump and touch, the
//           boost, each lap; and the controller's rumble at its strongest
//
// A phone's vibration motor is only on or off (no strength), so a strength here is how much of the time it's on: short
// pulses in quick succession (PHONE.period). Android phones vibrate (navigator.vibrate); an iPhone has no vibration
// for web pages, but Safari (iOS 18 and later) gives a light tap when a switch is flipped, so taps use that (short
// ones only, and Safari may only allow them just after you've touched the screen).
//
//   haptic(level)                 the setting (or the current one: haptic())
//   padScale()                    controller rumble × this (input.js)
//   tap(kind)                     a button under your finger (touch.js): 'press' | 'light'
//   phoneFeedback(info, dt)       every frame of a race (main.js): what the car's doing → vibration
//   preview(level)                a taste of a level (when you pick it in Settings)
import { OPTIONS } from './options.js';

export const HAPTIC_LEVELS = ['off', 'low', 'medium', 'high'];
export const HAPTIC_NAMES = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High' };
export const HAPTIC_NOTES = {
  off: 'No vibration or rumble',
  low: 'Crashes, contact and lock-ups only',
  medium: 'The road too: kerbs, grass, gear changes',
  high: 'Everything: engine, braking, slides, every bump',
};
// how strong each level is: the controller's rumble (× input.js PAD.rumble), its engine buzz, and the phone's pulses
export const HAPTICS = {
  pad: { off: 0, low: 0.5, medium: 1, high: 1.9 },
  padEngine: { off: 0, low: 0, medium: 0.5, high: 1.4 },
  phone: { off: 0, low: 0.8, medium: 1, high: 1.35 }, // (× every pulse's length)
};
export const PHONE = {
  period: 70,      // ms between pulses of a continuous feel (engine, gravel …): each one is on for strength × this
  min: 0.06,       // weaker than this: not felt (not sent)
  stripe: 1.75,    // m: a kerb's red and white stripes
};

const level = () => (HAPTIC_LEVELS.includes(OPTIONS.haptics) ? OPTIONS.haptics : 'medium');
export const haptic = level;
const at = (min) => HAPTIC_LEVELS.indexOf(level()) >= HAPTIC_LEVELS.indexOf(min); // this level or more
export const padScale = () => HAPTICS.pad[level()];
export const padEngine = () => HAPTICS.padEngine[level()];

// ---------- the motor ----------
const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
// iPhone (Safari 18+): flipping a switch taps. A hidden one, flipped by its label
let iosSwitch = null;
function iosTap() {
  if (canVibrate || typeof document === 'undefined') return;
  if (!iosSwitch) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.setAttribute('switch', ''); input.tabIndex = -1;
    label.append(input);
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
    document.body.append(label);
    iosSwitch = label;
  }
  try { iosSwitch.click(); } catch { /* not here */ }
}
let busyUntil = 0, lastIos = 0;
// one vibration: ms long (or a pattern [on, off, on …]); it holds off the continuous feel while it plays
function vibrate(p, now = performance.now()) {
  const k = HAPTICS.phone[level()];
  if (!k) return;
  const pattern = (Array.isArray(p) ? p : [p]).map((v, i) => Math.max(1, Math.round(i % 2 ? v : v * k)));
  if (canVibrate) { try { navigator.vibrate(pattern); } catch { /* not allowed now */ } }
  else if (now - lastIos > 60) { lastIos = now; iosTap(); }
  busyUntil = now + pattern.reduce((a, b) => a + b, 0);
}

// a button under your finger
export function tap(kind = 'press') {
  if (!at('medium') && kind === 'light') return;
  if (!at('low')) return;
  vibrate(kind === 'light' ? 6 : at('high') ? 14 : 9);
}

// a taste of a level, when you pick it
export function preview(lv = level()) {
  if (lv === 'off') return;
  const k = HAPTICS.phone[lv];
  const pattern = lv === 'low' ? [40] : lv === 'medium' ? [25, 60, 25] : [60, 40, 25, 40, 25, 40, 90];
  if (canVibrate) { try { navigator.vibrate(pattern.map((v, i) => (i % 2 ? v : Math.round(v * k)))); } catch { /* none */ } }
  else iosTap();
}

// ---------- the car on the road (phone) ----------
let kerbPhase = 0, lastGear = null, hitWas = 0, nextPulse = 0, lastState = null, lastLap = null, lockOn = false, lastBoost = false;
export function resetFeedback() { kerbPhase = 0; lastGear = null; hitWas = 0; lastState = null; lastLap = null; lockOn = false; lastBoost = false; nextPulse = 0; busyUntil = 0; }

// info: { state ('countdown' | 'racing' …), speed (m/s), throttle, brake, lock, slip, surface, hit, gear, rpm, maxRpm,
//         boost, lap }
export function phoneFeedback(info, dt) {
  if (level() === 'off') return;
  const now = performance.now(), { speed = 0, surface = 'road' } = info;
  // ---- moments: one vibration each ----
  if (info.state !== lastState) {
    if (info.state === 'racing' && lastState === 'countdown' && at('medium')) vibrate([70, 50, 40], now); // lights out
    lastState = info.state;
  }
  const hit = info.hit ?? 0;
  if (hit > 0.25 && hit > hitWas + 0.15) { // a crash or a touch: as hard as the hit
    const big = Math.min(1, hit);
    vibrate(at('high') ? [Math.round(60 + big * 140), 40, Math.round(30 + big * 60)] : [Math.round(30 + big * 90)], now);
  } else if (at('high') && hit > 0.08 && hit > hitWas + 0.05) vibrate(18, now); // a brush
  hitWas = hit;
  if (info.gear !== lastGear) {
    if (lastGear != null && info.gear !== 'N' && at('medium')) vibrate(at('high') ? 22 : 12, now); // a gear change
    lastGear = info.gear;
  }
  if (info.lap != null && lastLap != null && info.lap > lastLap && at('high')) vibrate([30, 60, 30], now); // a lap done
  lastLap = info.lap;
  if (info.boost && !lastBoost && at('high')) vibrate(35, now); // the boost kicks in
  lastBoost = !!info.boost;
  const lock = !!info.lock && speed > 8;
  if (lock && !lockOn) vibrate(at('high') ? 60 : 35, now); // the wheels lock
  lockOn = lock;

  // ---- what you feel all the time (a strength 0–1 → pulses) ----
  kerbPhase += (speed * dt) / PHONE.stripe;
  let s = 0;
  if (surface === 'kerb' && speed > 4 && at('medium')) {
    if (kerbPhase >= 1) { kerbPhase %= 1; if (now >= busyUntil) { vibrate(at('high') ? 16 : 9, now); } }
    return; // (the stripes are the feel: one pulse each)
  }
  kerbPhase %= 1;
  if (surface === 'gravel' && speed > 2 && at('medium')) s = Math.max(s, (at('high') ? 0.75 : 0.5) * Math.min(1, 0.4 + speed / 30));
  else if (surface !== 'road' && surface !== 'kerb' && speed > 2 && at('medium')) s = Math.max(s, (at('high') ? 0.5 : 0.3) * Math.min(1, 0.4 + speed / 40));
  if (lock) s = Math.max(s, at('high') ? 0.9 : at('medium') ? 0.6 : 0.45); // locked: a hard buzz
  if (at('high')) {
    const revs = info.maxRpm ? Math.min(1, (info.rpm ?? 0) / info.maxRpm) : 0.5;
    s = Math.max(s, 0.08 + 0.22 * (info.throttle ?? 0) * revs);                                 // the engine
    if ((info.brake ?? 0) > 0.2 && speed > 15) s = Math.max(s, 0.15 + 0.35 * info.brake * Math.min(1, speed / 60)); // braking load
    if ((info.slip ?? 0) > 1.5 && speed > 6) s = Math.max(s, Math.min(0.7, 0.2 + (info.slip - 1.5) * 0.08)); // sliding, wheelspin
    if (info.boost) s = Math.max(s, 0.3);
  }
  if (s < PHONE.min || now < busyUntil || now < nextPulse) return;
  nextPulse = now + PHONE.period;
  const on = Math.max(4, Math.round(PHONE.period * Math.min(0.95, s)));
  const k = HAPTICS.phone[level()];
  if (canVibrate) { try { navigator.vibrate(Math.round(on * k)); } catch { /* none */ } }
  else if (s > 0.45 && now - lastIos > 120) { lastIos = now; iosTap(); } // (an iPhone: only taps, for the strong ones)
}