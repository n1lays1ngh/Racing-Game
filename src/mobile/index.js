// The phone and tablet version (main.js loads this only when src/mobile/detect.js says it's one: a computer never
// downloads it). It adds, and changes nothing the desktop game does:
//   • a start screen: tap to start (that one tap unlocks full screen, landscape, the sound and the tilt sensor), and
//     how you'd like to steer (touch.js)
//   • full screen with no browser bars: on Android the page goes full screen and turns to landscape when you tap (and
//     again after you've left it); on iPhone, where a web page can't, it tells you to add it to your Home Screen once
//     (opened from there it has no bars at all). The Home Screen icon and name come from public/mobile/.
//   • touch controls while you race (touch.js), a "turn your phone sideways" screen in portrait
//   • keeping cool: the Mobile graphics preset (settings.js) from the first frame, a frame cap (60 / 45 / 30; the menus
//     at 30), dynamic resolution aimed at the cap, and a heat guard that steps the cap down if the phone can't keep up
//     (it's getting hot); fewer AI cars to start with, fewer engines to hear, no clearcoat on the car paint
//   • Settings in the pause menu: steering, tilt (recenter, invert), the frame rate, and Edit HUD layout: drag the
//     pedals, buttons and HUD panels where you want them and size them (hud.js; kept for each way of steering)
//   • the menus and screens at a size for a phone: zoomed to the screen's height (mobile.css, --m-zoom-*)
//   • the screen stays on while you race; a short buzz when you hit something (Android)
// ?fps at the end of the address shows the frame-rate counter (there's no F key).
import './mobile.css';
import { TouchControls } from './touch.js';
import { HudLayout } from './hud.js';
import { IS_IOS } from './detect.js';
import { setExtraInput } from '../input.js';
import { SOUND } from '../audio.js';

export const MOBILE = {
  caps: [60, 45, 30],   // the frame rates you can pick (Auto starts at the first and steps down when it's too hot)
  menuFps: 30,          // the menus (the live race behind them doesn't need more)
  ai: 9,                // AI cars to start with (the race setup's slider; your own choice is kept after that)
  aiVoices: 2,          // AI engines you can hear at once (3 on a computer)
  heat: { window: 8, over: 1.18, strikes: 2 }, // seconds per check; frames this much slower than the cap, this many checks in a row → step down
  drsMin: 0.6,          // dynamic resolution can go down to this share of the Mobile preset's
};
const KEY = 'apex-circuit:mobile';
function load() { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...v })); } catch { /* private mode */ } }
const $ = (id) => document.getElementById(id);
const standalone = () => !!(navigator.standalone || matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches);
const canFullscreen = () => !!(document.documentElement.requestFullscreen && document.fullscreenEnabled !== false);

export function setupMobile(ctx) {
  document.body.classList.add('mobile');
  if (IS_IOS) document.body.classList.add('ios');
  headTags();
  const prefs = { steer: 'slide', fps: 'auto', invert: false, ...load() };

  // ---- touch controls, fed into input.js ----
  const touch = new TouchControls();
  touch.setMode(prefs.steer); touch.setInvert(prefs.invert);
  setExtraInput((dt) => touch.input(dt));
  const layout = new HudLayout(); // where the touch controls and the HUD panels go (hud.js)

  // ---- the menus and screens: zoomed to fit a phone's height (mobile.css uses these) ----
  const fit = () => {
    const H = innerHeight, root = document.documentElement.style;
    root.setProperty('--m-zoom-menu', String(Math.min(1, Math.max(0.5, H / 600))));
    root.setProperty('--m-zoom-ui', String(Math.min(1, Math.max(0.6, H / 520))));
    layout.apply(touch.mode);
  };
  fit(); window.addEventListener('resize', fit);

  // ---- a few lighter defaults ----
  SOUND.aiVoices = Math.min(SOUND.aiVoices, MOBILE.aiVoices);
  ctx.drs.min = MOBILE.drsMin;
  try { // AI cars: fewer to start with (only if you've never picked how many)
    const setup = JSON.parse(localStorage.getItem('apex-circuit:setup') ?? '{}');
    const ai = $('opt-ai');
    if (setup.ai == null && ai && Number(ai.value) > MOBILE.ai) { ai.value = String(MOBILE.ai); ai.dispatchEvent(new Event('input', { bubbles: true })); }
  } catch { /* fine */ }
  if (new URLSearchParams(location.search).has('fps')) ctx.toggleFps();

  // ---- the start screen (one tap: full screen, landscape, sound, the tilt sensor) and "turn sideways" ----
  const start = document.createElement('div');
  start.id = 'm-start';
  start.innerHTML =
    '<div class="ms-box"><div class="ms-logo"><span class="slash"></span>Apex <b>Circuit</b></div>' +
    '<p class="ms-sub">How do you want to steer?</p>' +
    '<div class="ms-steer">' +
      '<button type="button" data-steer="slide"><b>Slide</b><span>Slide your left thumb sideways</span></button>' +
      '<button type="button" data-steer="buttons"><b>Buttons</b><span>Left and right buttons</span></button>' +
      '<button type="button" data-steer="tilt"><b>Tilt</b><span>Tilt the phone like a wheel</span></button>' +
    '</div>' +
    '<button type="button" class="ms-go" id="ms-go">Tap to start</button>' +
    '<p class="ms-ios" id="ms-ios">For full screen with no bars: tap <b>Share</b> <span class="ms-share" aria-hidden="true"></span>, then <b>Add to Home Screen</b>, and open it from there.</p>' +
    '<p class="ms-fine">You can change the steering any time: pause → Settings.</p></div>';
  document.body.appendChild(start);
  const rotate = document.createElement('div');
  rotate.id = 'm-rotate';
  rotate.innerHTML = '<div class="mr-phone" aria-hidden="true"></div><b>Turn your phone sideways</b><span>Apex Circuit plays in landscape</span>';
  document.body.appendChild(rotate);
  $('ms-ios').hidden = !(IS_IOS && !standalone());
  const markSteer = () => { for (const b of start.querySelectorAll('[data-steer]')) b.classList.toggle('on', b.dataset.steer === prefs.steer); };
  markSteer();
  start.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-steer]');
    if (b) { setSteer(b.dataset.steer); markSteer(); return; }
    if (!e.target.closest('#ms-go')) return;
    await unlock();
    start.classList.add('gone');
    setTimeout(() => start.remove(), 400);
  });

  // full screen and landscape: needs a tap, so on the start screen's, and again on your next tap after leaving it
  async function goFullscreen() {
    if (standalone() || !canFullscreen() || document.fullscreenElement) return;
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* refused: carry on */ }
    try { await screen.orientation?.lock?.('landscape'); } catch { /* not every browser locks */ }
  }
  async function unlock() {
    await goFullscreen();
    if (prefs.steer === 'tilt') await motionPermission();
    try { // the sound can only start after a tap (it starts properly with the race: main.js)
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { const ac = new AC(); await ac.resume(); ac.close(); }
    } catch { /* fine */ }
  }
  let lastAsk = 0;
  document.addEventListener('pointerdown', () => {
    if (start.isConnected || document.fullscreenElement || standalone() || !canFullscreen()) return;
    const now = performance.now(); if (now - lastAsk < 1500) return; lastAsk = now;
    goFullscreen();
  }, true);

  // iPhone: the tilt sensor needs your permission (asked on a tap)
  async function motionPermission() {
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') {
      try { if ((await DME.requestPermission()) !== 'granted') return false; } catch { return false; }
    }
    return true;
  }
  async function setSteer(mode) {
    if (mode === 'tilt' && !(await motionPermission())) { ctx.getHud()?.toast?.('Tilt needs motion access: allow it in your browser', 3); return; }
    prefs.steer = mode; save({ steer: mode }); touch.setMode(mode); drawSettings();
    requestAnimationFrame(() => layout.apply(touch.mode)); // (each way of steering has its own layout)
    if (mode === 'tilt') setTimeout(() => { if (!touch.tilt.seen) ctx.getHud()?.toast?.('No tilt sensor found: try Slide', 3); }, 2500);
  }

  // ---- Settings in the pause menu: steering, tilt, frame rate ----
  const list = document.querySelector('#pause .set-list');
  const rows = document.createElement('div');
  rows.className = 'm-settings';
  rows.innerHTML =
    '<div class="set-row"><span class="set-txt"><b>Steering</b><small>Touch controls</small></span>' +
      '<div class="lb-seg" id="m-steer"><button type="button" data-v="slide">Slide</button><button type="button" data-v="buttons">Buttons</button><button type="button" data-v="tilt">Tilt</button></div></div>' +
    '<div class="set-row" id="m-tilt-row"><span class="set-txt"><b>Tilt</b><small>Level is how you hold the phone now</small></span>' +
      '<div class="lb-seg"><button type="button" id="m-recenter">Recenter</button><button type="button" id="m-invert">Invert</button></div></div>' +
    '<div class="set-row"><span class="set-txt"><b>Frame rate</b><small id="m-fps-sub">Lower runs cooler and saves battery</small></span>' +
      `<div class="lb-seg" id="m-fps"><button type="button" data-v="auto">Auto</button>${MOBILE.caps.slice(1).map((c) => `<button type="button" data-v="${c}">${c}</button>`).join('')}</div></div>` +
    '<div class="set-row"><span class="set-txt"><b>HUD layout</b><small>Move and size the pedals, buttons, speed, map and timing</small></span>' +
      '<div class="lb-seg"><button type="button" id="m-hud-edit">Edit layout</button></div></div>';
  list?.prepend(rows);
  function drawSettings() {
    for (const b of rows.querySelectorAll('#m-steer button')) b.classList.toggle('on', b.dataset.v === prefs.steer);
    for (const b of rows.querySelectorAll('#m-fps button')) b.classList.toggle('on', b.dataset.v === String(prefs.fps));
    rows.querySelector('#m-tilt-row').style.display = prefs.steer === 'tilt' ? '' : 'none';
    rows.querySelector('#m-invert').classList.toggle('on', !!prefs.invert);
    $('m-fps-sub').textContent = prefs.fps === 'auto' ? `Auto: ${cap} fps now, lower if the phone gets hot` : 'Lower runs cooler and saves battery';
  }
  rows.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.closest('#m-steer')) setSteer(b.dataset.v);
    else if (b.closest('#m-fps')) { prefs.fps = b.dataset.v === 'auto' ? 'auto' : Number(b.dataset.v); save({ fps: prefs.fps }); cap = prefs.fps === 'auto' ? MOBILE.caps[0] : prefs.fps; drawSettings(); }
    else if (b.id === 'm-recenter') { touch.recenter(); ctx.getHud()?.toast?.('Tilt recentred', 1.2); }
    else if (b.id === 'm-hud-edit') editHud();
    else if (b.id === 'm-invert') { prefs.invert = !prefs.invert; save({ invert: prefs.invert }); touch.setInvert(prefs.invert); drawSettings(); }
  });

  // the HUD editor: from the pause menu's Settings (the race stays paused behind it), back there when you're done
  function editHud() {
    const pause = $('pause');
    pause.classList.add('hidden');
    touch.show(true, ctx.getRace()); touch.el.classList.add('has-boost'); // (every control, to place)
    layout.edit(touch.mode, () => { pause.classList.remove('hidden'); placed = 0; });
  }

  // ---- the frame cap, dynamic resolution aimed at it, and the heat guard ----
  let cap = prefs.fps === 'auto' ? MOBILE.caps[0] : prefs.fps;
  let next = 0, fpsNow = 0, last = 0, sum = 0, n = 0, since = 0, strikes = 0, lastRace = null, wake = null, hitWas = 0, sweep = 0, placed = 0;
  drawSettings();
  ctx.setFrameGate((t) => {
    const race = ctx.getRace(), racing = !!race;
    const fps = racing ? cap : Math.min(cap, MOBILE.menuFps), interval = 1000 / fps;
    if (fps !== fpsNow) { fpsNow = fps; ctx.drs.slow = interval * 1.11; ctx.drs.fast = interval * 1.05; next = t; sum = n = 0; since = t; strikes = 0; }
    if (t < next - 1.5) return false;               // not yet (a 60 Hz screen at 45: every other frame, then two)
    next = Math.max(next + interval, t);            // (after a stall: start again from now)
    perFrame(race, t);
    // heat guard: frames well slower than the cap while the resolution is already as low as it goes → step down
    if (last) { sum += t - last; n++; }
    last = t;
    if (racing && prefs.fps === 'auto' && t - since > MOBILE.heat.window * 1000 && n > 10) {
      const avg = sum / n, low = ctx.drsState.scale <= ctx.drs.min + 1e-3;
      strikes = avg > interval * MOBILE.heat.over && low ? strikes + 1 : 0;
      if (strikes >= MOBILE.heat.strikes) {
        const k = MOBILE.caps.indexOf(cap);
        if (k >= 0 && k < MOBILE.caps.length - 1) {
          cap = MOBILE.caps[k + 1];
          ctx.getHud()?.toast?.(`Phone working hard: ${cap} fps to keep it cool`, 2.5);
          drawSettings();
        }
        strikes = 0;
      }
      sum = n = 0; since = t;
    }
    return true;
  });

  // once a frame (only frames that are drawn): touch controls on while racing, the screen kept on, a buzz on a hit, and
  // a light sweep for car paint with clearcoat (a second layer of reflections: costly on a phone)
  function perFrame(race, t) {
    const racing = !!race && !$('hud').classList.contains('hidden') && $('pause').classList.contains('hidden') && $('results').classList.contains('hidden');
    if (!document.body.classList.contains('hud-editing')) touch.show(racing && !start.isConnected, race);
    if (racing && t - placed > 500) { placed = t; layout.apply(touch.mode); } // (your layout: items that have just appeared too)
    if (race !== lastRace) {
      lastRace = race;
      if (race) { touch.tilt.neutral = null; keepAwake(true); sweep = 0; } else keepAwake(false); // (tilt: level is how you hold it at the start)
    }
    const hit = race?.player?.state?.hitWall ?? 0;
    if (hit > 0.35 && hitWas <= 0.35) { try { navigator.vibrate?.(Math.round(20 + hit * 40)); } catch { /* none */ } }
    hitWas = hit;
    if (t - sweep > 4000) { sweep = t; noClearcoat(ctx.scene); }
  }
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener?.('release', () => { wake = null; }); }
      else if (!on && wake) { await wake.release(); wake = null; }
    } catch { wake = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && lastRace) keepAwake(true); });
  window.addEventListener('orientationchange', () => { touch.tilt.neutral = null; });

  window.__mobile = { touch, prefs, get cap() { return cap; } }; // (for checking it in the browser's console)
}

// clearcoat off on every material that has it (the car models' paint): checked every few seconds as models load
const seen = new WeakSet();
function noClearcoat(scene) {
  scene.traverse((o) => {
    for (const m of [o.material].flat()) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (m.clearcoat > 0) { m.clearcoat = 0; m.needsUpdate = true; }
    }
  });
}

// The page's head for a phone: no pinch zoom, drawn under the notch, and what "Add to Home Screen" needs (the icon,
// the name, and opening full screen in landscape: public/mobile/manifest.webmanifest)
function headTags() {
  const head = document.head;
  const meta = (name, content) => { let m = head.querySelector(`meta[name="${name}"]`); if (!m) { m = document.createElement('meta'); m.name = name; head.appendChild(m); } m.content = content; };
  meta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  meta('theme-color', '#000000');
  meta('mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-status-bar-style', 'black-translucent');
  meta('apple-mobile-web-app-title', 'Apex Circuit');
  const link = (rel, href, extra = {}) => { const l = document.createElement('link'); l.rel = rel; l.href = href; Object.assign(l, extra); head.appendChild(l); };
  link('manifest', '/mobile/manifest.webmanifest');
  link('apple-touch-icon', '/mobile/apple-touch-icon.png');
}