// Keyboard + gamepad input, merged into { throttle, brake, steer }.
// steer: +1 = left, -1 = right (matches physics.js).
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

  // Gamepad: left stick steers, RT = throttle, LT = brake.
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (!pad) continue;
    const x = pad.axes[0] ?? 0;
    if (Math.abs(x) > 0.08) steer = -Math.sign(x) * Math.pow(Math.abs(x), 1.5);
    const rt = pad.buttons[7]?.value ?? 0, lt = pad.buttons[6]?.value ?? 0;
    if (rt > 0.05) throttle = Math.max(throttle, rt);
    if (lt > 0.05) brake = Math.max(brake, lt);
    if (pad.buttons[0]?.pressed) throttle = 1;
    if (pad.buttons[2]?.pressed) brake = 1;
    break;
  }
  return { throttle, brake, steer };
}

// True once per key press (for toggles like camera and pause).
export function wasPressed(code) {
  if (pressedOnce.has(code)) { pressedOnce.delete(code); return true; }
  return false;
}
export function clearPressed() { pressedOnce.clear(); }
