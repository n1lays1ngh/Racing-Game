// Options you switch in the pause menu's Settings (and the map with Z / the controller's Menu button),
// kept in this browser.
//   racingLine  the line round the lap on the track: green where you're on the throttle, red where you brake (racingLine.js)
//   ghost       in practice: your best lap ever at this circuit in this car, as a see-through car to race (ghost.js)
//   mapZoom     the minimap: false = the whole circuit with every car, true = a close-up of the road ahead (hud.js)
const KEY = 'apex-circuit:options';
export const OPTIONS = { racingLine: false, ghost: true, mapZoom: false };

try { Object.assign(OPTIONS, JSON.parse(localStorage.getItem(KEY)) ?? {}); } catch { /* nothing saved, or private mode */ }

const listeners = new Set();
export function setOption(key, value) {
  if (OPTIONS[key] === value) return;
  OPTIONS[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(OPTIONS)); } catch { /* not kept, that's all */ }
  for (const fn of listeners) fn(key, value);
}
// fn(key, value) whenever an option changes
export function onOption(fn) { listeners.add(fn); return () => listeners.delete(fn); }