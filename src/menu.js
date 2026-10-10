// Main menu: a start screen, then three steps, then the race.
//
//   home    Race (→ the steps), Quick race (your last setup, straight away), Multiplayer, Your stats, graphics
//   1 car   one tall panel per car (src/cars/) with numbers worked out from its physics
//   2 track the circuit you've picked (outline with a car running round it, the hills along the lap, your best
//           lap there in this car) and every circuit as a tile
//   3 setup time of day (Day / Night, Twilight where that's the circuit's own time, Night without floodlights where the
//           car has it), laps (1–100), AI cars and their skill, your name and colour → Start race
//
// The top bar shows the steps and what you picked in each (click one to go back to it); the bottom bar has
// Back (Esc) and Next (Enter). Keys: ← → ↑ ↓ change the car / circuit / laps and AI cars, N the time of day.
// The form elements (#opt-track, #opt-laps, #opt-diff, #opt-ai, #opt-name, the colour swatches) stay the source of
// truth: main.js and lobby.js read them. The car and the time of day go to main.js through onCar / onTime, a new
// circuit through the select's change event (main.js rebuilds the circuit and the live race behind the menu).
// Your last choices are remembered in this browser.
import { timesFor, raceSetup } from './cars/index.js';
import { getStats } from './stats.js';
import { formatTime } from './race.js';

const $ = (id) => document.getElementById(id);
const KEY = 'apex-circuit:setup';
const STEPS = ['home', 'car', 'track', 'setup'];
const MAX_LAPS = 100;
const GP_DISTANCE = 305000; // m: a Grand Prix is the fewest laps that make 305 km (a tick on the laps slider)
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const clampLaps = (n) => Math.min(MAX_LAPS, Math.max(1, Math.round(Number(n) || 3)));
const lapsText = (n) => (n === 1 ? '1 lap' : `${n} laps`);
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function load() { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...v })); } catch { /* private mode */ } }
// The time of day you last picked (null until you pick one: each circuit at its own time)
export const savedTime = () => load().time ?? null;

// ---- the times of day, as the race step shows them ----
const TOD = {
  day: { name: 'Day', sub: 'In daylight', short: 'by day' },
  dusk: { name: 'Twilight', sub: 'The sun going down', short: 'at twilight' },
  night: { name: 'Night', sub: 'Under the floodlights', short: 'at night' },
  dark: { name: 'No floodlights', sub: 'Only the pit straight is lit: your headlights do the rest', short: 'at night, no floodlights' },
};

// ---- the car sheet: numbers worked out from the car's physics (same sums as physics.js) ----
const STATS = [
  { key: 'top', label: 'Top speed', unit: 'km/h', fmt: (v) => Math.round(v), high: true },
  { key: 't200', label: '0 to 200 km/h', unit: 's', fmt: (v) => v.toFixed(1), high: false },
  { key: 'g', label: 'Cornering at 200 km/h', unit: 'g', fmt: (v) => v.toFixed(1), high: true },
  { key: 'stop', label: 'Braking from 200 km/h', unit: 'm', fmt: (v) => Math.round(v), high: false },
];
function carNumbers(car) {
  const p = car.physics, E = car.ers?.auto ? car.ers : null, dt = 1 / 240;
  const lat = (u) => p.mu * (p.g + p.downforce * u * u);
  const push = (v) => { // flat out on a level road (the Hypercar's hybrid deploys by itself; ERS on a button doesn't count)
    const u = Math.max(v, 0);
    // the engine: a fixed power (p.power) up to p.accel, or p.accel fading toward top speed (as in physics.js)
    let a = p.power ? Math.min(p.accel, p.power / Math.max(u, 1)) : p.accel * (1 - p.accelFade * Math.min(u / 90, 1));
    if (p.traction) { // wheelspin: only so much goes down, traction control saves a little of the rest
      const most = p.traction * lat(u);
      if (a > most) a = most + (a - most) * 0.15 * (1 - (p.tc ?? 0));
    }
    if (E && v > E.minSpeed) a += Math.min(E.maxPush, E.power / v) * (1 - Math.min(1, Math.max(0, (v - E.maxSpeed + 8) / 8)));
    return a - p.drag * v * v - p.roll;
  };
  let v = 0, t = 0;
  while (v < 200 / 3.6 && t < 60) { v += push(v) * dt; t += dt; }
  const t200 = v >= 200 / 3.6 ? t : 99;
  let lo = 1, hi = 200; // top speed: where the push runs out
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (push(m) > 0) lo = m; else hi = m; }
  let stop = 0; v = 200 / 3.6; // off the throttle and on the brakes: engine braking counts too
  while (v > 0) { stop += v * dt; v -= (Math.min(p.brake, 1.2 * lat(v)) + p.drag * v * v + p.roll + (p.liftOff ?? 0)) * dt; }
  return { top: lo * 3.6, t200, g: lat(200 / 3.6) / p.g, stop };
}

// ---- a circuit's outline and hills, straight from its file (the exact numbers come once it's built) ----
function circuitInfo(def) {
  const pts = def.points;
  let len = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  const e = def.elevation ?? [];
  let lo = Infinity, hi = -Infinity;
  for (const h of e) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  return { len, climb: e.length ? hi - lo : 0, lo, hi };
}
// The outline fitted into a w × h box, north up (x mirrored, as on the minimap)
function fitOutline(pts, w, h, pad) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const sc = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxZ - minZ));
  const ox = (w - (maxX - minX) * sc) / 2, oy = (h - (maxZ - minZ) * sc) / 2;
  return pts.map(([x, z]) => [w - (ox + (x - minX) * sc), oy + (maxZ - z) * sc]);
}
function outlinePath(def) { // for the small tiles
  const step = Math.max(1, Math.ceil(def.points.length / 90));
  const pts = fitOutline(def.points.filter((_, i) => i % step === 0), 100, 60, 4);
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('') + 'Z';
}
function duration(t) {
  const m = Math.max(1, Math.round(t / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const andList = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
// ↑ ↓ in a grid: of els, the nearest one in the row above (d = -1) / below (d = 1) cur, by where they are on screen
function rowStep(els, cur, d) {
  if (!cur) return null;
  const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2;
  let pick = null, score = Infinity;
  for (const t of els) {
    const q = t.getBoundingClientRect(), dy = (q.top - r.top) * d;
    if (dy <= 4) continue;
    const s = dy * 4 + Math.abs(q.left + q.width / 2 - cx);
    if (s < score) { score = s; pick = t; }
  }
  return pick;
}

// cars: the list from src/cars/; carId: the one picked; onCar(id) / onTime(time): you picked another
export function setupMenu({ tracks, cars, carId, onStart, onCar, onTime }) {
  const menu = $('menu'), select = $('opt-track'), laps = $('opt-laps'), diff = $('opt-diff');
  const saved = load();
  let car = cars.find((c) => c.id === carId) ?? cars[0], time = savedTime(), step = 'home';
  // circuits in the order the tiles show them: the Grand Prix calendar, then the rest
  const ordered = [...tracks.filter((t) => t.round), ...tracks.filter((t) => !t.round)];
  const current = () => tracks.find((t) => t.id === select.value) ?? tracks[0];
  const infos = new Map(), info = (def) => { if (!infos.has(def)) infos.set(def, circuitInfo(def)); return infos.get(def); };
  const exact = new Map(); // circuit id → { len, climb } once it has been built (setTrackInfo)
  const lenOf = (def) => exact.get(def.id)?.len ?? info(def).len;
  const climbOf = (def) => exact.get(def.id)?.climb ?? info(def).climb;
  const records = () => getStats(car.id).circuits ?? {}; // your records in this car, per circuit (stats.js)

  if (saved.track && tracks.some((t) => t.id === saved.track)) select.value = saved.track;
  laps.value = String(clampLaps(saved.laps ?? laps.value));
  if (saved.diff) diff.value = saved.diff;
  if (saved.color) document.querySelector(`.swatch[data-color="${saved.color}"]`)?.click();

  // ---------- steps ----------
  const HINTS = {
    car: '<kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> change car',
    track: '<kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> change circuit',
    setup: '<kbd>←</kbd><kbd>→</kbd> laps <kbd>⇧</kbd> ×10 &nbsp; <kbd>↑</kbd><kbd>↓</kbd> AI cars &nbsp; <kbd>N</kbd> time of day',
  };
  const NEXT = { car: 'Next: circuit', track: 'Next: race setup' };
  function go(to, { focus = true } = {}) {
    if (!STEPS.includes(to)) return;
    const from = step;
    step = to;
    menu.classList.remove('boot'); // the first-load entrance only plays once
    menu.dataset.step = to;
    menu.dataset.dir = STEPS.indexOf(to) >= STEPS.indexOf(from) ? 'fwd' : 'back';
    const page = menu.querySelector(`[data-page="${to}"]`);
    if (from !== to) { page.classList.remove('enter'); void page.offsetWidth; page.classList.add('enter'); }
    for (const b of menu.querySelectorAll('.mn-steps [data-go]')) {
      if (b.dataset.go === to) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    }
    $('mn-hint').innerHTML = HINTS[to] ?? '';
    $('mn-next-label').textContent = NEXT[to] ?? 'Next';
    if (to === 'car') drawCars();
    if (to === 'track') { drawTiles(); fitMap(); }
    if (to === 'setup') { showTime(); showLaps(); }
    // keyboard focus on what this page is about
    const target = to === 'home' ? $('btn-race') : to === 'car' ? menu.querySelector('.slat.on')
      : to === 'track' ? menu.querySelector('.tile.on') : $('opt-laps');
    if (focus) target?.focus({ preventScroll: true });
    if (to === 'track') reveal(false);
  }
  const next = () => (step === 'setup' ? start() : go(STEPS[STEPS.indexOf(step) + 1]));
  const back = () => { if (step !== 'home') go(STEPS[STEPS.indexOf(step) - 1]); };
  const start = () => onStart();
  menu.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
  $('btn-race').addEventListener('click', () => go('car'));
  $('btn-quick').addEventListener('click', start);
  $('mn-back').addEventListener('click', back);
  $('mn-next').addEventListener('click', next);
  setTimeout(() => menu.classList.remove('boot'), 4000);

  // What you've picked, in the top bar and on the Quick race button
  function summary() {
    const def = current(), n = clampLaps(laps.value), choice = raceSetup(car, def, time).choice;
    $('sum-car').textContent = car.name;
    $('sum-track').textContent = def.name;
    $('sum-setup').textContent = `${lapsText(n)} ${TOD[choice].short}`;
    $('quick-sub').textContent = `${car.name} at ${def.name}, ${lapsText(n)}${choice === 'day' ? '' : ' ' + TOD[choice].short}`;
  }

  // ---------- 1 · car ----------
  const numbers = new Map(cars.map((c) => [c, carNumbers(c)]));
  const best = Object.fromEntries(STATS.map((s) => {
    const v = cars.map((c) => numbers.get(c)[s.key]);
    return [s.key, s.high ? Math.max(...v) : Math.min(...v)];
  }));
  function carNotes(c) {
    const p = c.physics, out = [];
    if (c.ers?.auto) out.push(`Hybrid boost by itself above ${Math.round(c.ers.minSpeed * 3.6)} km/h`);
    else if (c.ers) out.push('ERS boost: hold Shift (R1)');
    out.push(p.abs && p.tc ? 'ABS and traction control' : p.tc ? 'Traction control, no ABS' : p.abs ? 'ABS' : 'No driver aids');
    const n = c.trackLimits?.strikes ?? 1;
    out.push(n > 1 ? `${n} track-limits strikes a lap before it's deleted` : 'One track-limits strike deletes the lap');
    if (c.headlights) out.push('Headlights for the night races (H)');
    const dark = (c.darkNights ?? []).map((id) => tracks.find((t) => t.id === id)?.name).filter(Boolean);
    if (dark.length) out.push(`${andList(dark)} at night with no floodlights`);
    return out;
  }
  // the cards: two rows once there are more than 4 cars; what the picked car comes with goes in the strip below them
  const detail = document.createElement('div');
  detail.id = 'car-detail'; detail.className = 'car-detail'; detail.setAttribute('aria-live', 'polite');
  $('car-pick').after(detail);
  function drawCars() {
    const per = cars.length > 4 ? Math.ceil(cars.length / 2) : cars.length, rows = [];
    for (let i = 0; i < cars.length; i += per) rows.push(cars.slice(i, i + per));
    $('car-pick').style.setProperty('--cars', per); // (the big letters shrink to fit more cars in a row)
    $('car-pick').innerHTML = rows.map((row) => `<div class="slat-row" role="presentation">${row.map((c) => {
      const nums = numbers.get(c);
      const stats = STATS.map((s) => {
        const v = nums[s.key], f = s.high ? v / best[s.key] : best[s.key] / v;
        return `<span class="stat"><span class="stat-l">${s.label}</span><b>${s.fmt(v)}<small>${s.unit}</small></b><i style="--f:${f.toFixed(3)}"></i></span>`;
      }).join('');
      return `<button type="button" class="slat${c === car ? ' on' : ''}" data-pick data-car="${esc(c.id)}" role="radio" aria-checked="${c === car}">` +
        `<span class="slat-big" aria-hidden="true">${esc(c.short ?? c.name)}</span>` +
        `<span class="slat-head"><b>${esc(c.name)}</b><span>${esc(c.car)}</span></span>` +
        `<span class="slat-stats">${stats}</span>` +
        '</button>';
    }).join('')}</div>`).join('');
    showDetail();
  }
  function showDetail() {
    const driven = getStats(car.id).total.laps;
    detail.innerHTML = `<b class="cd-name">${esc(car.name)}</b>` +
      `<span class="cd-specs">${(car.specs ?? []).map((s) => `<span>${esc(s)}</span>`).join('')}</span>` +
      `<span class="cd-notes">${carNotes(car).map((n) => `<span>${esc(n)}</span>`).join('')}</span>` +
      `<span class="cd-you">${driven ? `You've driven ${driven.toLocaleString()} ${driven === 1 ? 'lap' : 'laps'} in it` : 'Not driven yet'}</span>`;
  }
  function markCars() {
    for (const b of $('car-pick').querySelectorAll('.slat')) {
      const on = b.dataset.car === car.id;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', on);
    }
    showDetail();
  }
  function pickCar(c) {
    if (!c || c === car) return;
    car = c; markCars(); showDef(current(), false); summary();
    if (step === 'track') drawTiles(); // your best laps are per car
    onCar?.(car.id);
  }
  const carPick = $('car-pick');
  carPick.addEventListener('click', (e) => { const b = e.target.closest('[data-car]'); if (b) pickCar(cars.find((c) => c.id === b.dataset.car)); });
  carPick.addEventListener('dblclick', (e) => { if (e.target.closest('[data-car]')) next(); });
  function stepCar(d) {
    pickCar(cars[(cars.indexOf(car) + d + cars.length) % cars.length]);
    if (document.activeElement?.closest?.('#car-pick')) carPick.querySelector('.slat.on')?.focus({ preventScroll: true });
  }
  function stepCarRow(d) { // ↑ ↓: the card above / below (one row: just the next car)
    const slats = [...carPick.querySelectorAll('.slat')];
    const pick = rowStep(slats, carPick.querySelector('.slat.on'), d);
    if (!pick) { if (!carPick.querySelector('.slat-row + .slat-row')) stepCar(d); return; }
    pickCar(cars.find((c) => c.id === pick.dataset.car));
    if (document.activeElement?.closest?.('#car-pick')) pick.focus({ preventScroll: true });
  }

  // ---------- 2 · circuit ----------
  const grid = $('trk-grid');
  function drawTiles() {
    const rec = records();
    const tile = (def) => {
      const b = rec[def.id]?.bestClean?.t, on = def.id === select.value;
      return `<button type="button" class="tile${on ? ' on' : ''}" data-pick data-track="${esc(def.id)}" role="radio" aria-checked="${on}">` +
        `<span class="tile-top"><i>${def.round ? `R${def.round}` : ''}</i>${b ? `<em title="Your best lap here in the ${esc(car.name)}">${formatTime(b)}</em>` : ''}</span>` +
        `<svg viewBox="0 0 100 60" aria-hidden="true"><path d="${outlinePath(def)}"/></svg>` +
        `<b>${esc(def.name)}</b><span>${esc(def.country)}</span></button>`;
    };
    const gp = ordered.filter((t) => t.round), more = ordered.filter((t) => !t.round);
    grid.innerHTML = `<h3 class="trk-group">Grand Prix calendar</h3>${gp.map(tile).join('')}` +
      (more.length ? `<h3 class="trk-group">Classics</h3>${more.map(tile).join('')}` : '');
  }
  function markTiles() {
    for (const b of grid.querySelectorAll('.tile')) {
      const on = b.dataset.track === select.value;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', on);
    }
  }
  function reveal(smooth = true) { // keep the picked tile in view
    grid.querySelector('.tile.on')?.scrollIntoView({ block: 'nearest', behavior: smooth && !reduceMotion() ? 'smooth' : 'auto' });
  }
  function pickTrack(id) {
    if (!id || id === select.value) return;
    select.value = id;
    save({ track: id });
    showDef(current()); markTiles(); summary();
    if (step === 'setup') { showTime(); showLaps(); }
    select.dispatchEvent(new Event('change')); // main.js builds the circuit and the live race behind the menu
  }
  function stepTrack(d) {
    const i = ordered.findIndex((t) => t.id === select.value);
    pickTrack(ordered[(i + d + ordered.length) % ordered.length].id);
    afterKeyPick();
  }
  function stepTrackRow(d) { // ↑ ↓: the tile above / below
    const tiles = [...grid.querySelectorAll('.tile')];
    const pick = rowStep(tiles, tiles.find((t) => t.dataset.track === select.value), d);
    if (pick) { pickTrack(pick.dataset.track); afterKeyPick(); }
  }
  function afterKeyPick() {
    reveal();
    if (document.activeElement?.closest?.('#trk-grid')) grid.querySelector('.tile.on')?.focus({ preventScroll: true });
  }
  grid.addEventListener('click', (e) => { const b = e.target.closest('[data-track]'); if (b) pickTrack(b.dataset.track); });
  grid.addEventListener('dblclick', (e) => { if (e.target.closest('[data-track]')) next(); });
  $('c-prev').addEventListener('click', () => { stepTrack(-1); });
  $('c-next').addEventListener('click', () => { stepTrack(1); });

  // the picked circuit: name, numbers, badges
  function showDef(def, animate = true) {
    const i = ordered.indexOf(def), rec = records()[def.id];
    $('c-round').textContent = def.round ? `Round ${def.round}` : 'Classic';
    $('c-count').textContent = `${i + 1} of ${ordered.length}`;
    $('c-name').textContent = def.name;
    $('c-country').textContent = def.country;
    $('c-len').textContent = (lenOf(def) / 1000).toFixed(2);
    $('c-elev').textContent = Math.round(climbOf(def));
    const b = rec?.bestClean?.t;
    $('c-best').textContent = b ? formatTime(b) : 'None yet';
    $('c-best').classList.toggle('has', !!b);
    $('c-best-l').textContent = `your best lap in the ${car.name}`;
    const own = def.time ?? 'day';
    const badges = [[def.type === 'street' ? 'Street circuit' : 'Permanent circuit', ''],
      [own === 'night' ? 'Raced at night' : own === 'dusk' ? 'Raced at twilight' : 'Raced by day', 't-' + own]];
    if (def.banking?.length) badges.push(['Banked corners', '']);
    $('c-badges').innerHTML = badges.map(([t, cls]) => `<span class="${cls}">${t}</span>`).join('');
    $('c-prof-note').textContent = climbOf(def) < 3 ? 'Flat all the way round' : '';
    makeOutline(def);
    if (!animate) return;
    const box = menu.querySelector('.trk-detail');
    box.classList.remove('swap'); void box.offsetWidth; box.classList.add('swap');
  }

  // the outline, with a car running round it, and the hills along the lap underneath
  const canvas = $('c-map'), g = canvas.getContext('2d');
  const prof = $('c-prof'), pg = prof.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let outline = [], profile = null, runner = 0, shownDef = null;
  function fitCanvas(cv) {
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return false;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    return true;
  }
  function fitMap() {
    const a = fitCanvas(canvas), b = fitCanvas(prof);
    if ((a || b) && shownDef) makeOutline(shownDef);
  }
  function makeOutline(def) {
    shownDef = def;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) { outline = []; return; }
    outline = fitOutline(def.points, W, H, 22 * dpr);
    let L = 0; outline.cum = [0];
    for (let i = 1; i <= outline.length; i++) {
      const a = outline[i - 1], b = outline[i % outline.length];
      L += Math.hypot(b[0] - a[0], b[1] - a[1]); outline.cum.push(L);
    }
    outline.total = L;
    const e = def.elevation ?? [], inf = info(def);
    profile = e.length > 1 && inf.hi - inf.lo >= 3 ? { e, lo: inf.lo, hi: inf.hi } : null;
  }
  function pointAlong(f) {
    const d = f * outline.total, c = outline.cum;
    let i = 1; while (i < c.length - 1 && c[i] < d) i++;
    const a = outline[i - 1], b = outline[i % outline.length], u = (d - c[i - 1]) / Math.max(c[i] - c[i - 1], 1e-6);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  }
  function drawOutline() {
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!outline.length) return;
    g.lineJoin = g.lineCap = 'round';
    g.beginPath(); outline.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
    g.shadowColor = 'rgba(225,6,0,0.55)'; g.shadowBlur = 22 * dpr;
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 14 * dpr; g.stroke();
    g.shadowBlur = 0; g.strokeStyle = '#f4f5f7'; g.lineWidth = 4 * dpr; g.stroke();
    for (let k = 18; k >= 0; k--) { // a car running round the lap, with a fading tail
      const [x, y] = pointAlong(((runner - k * 0.0035) % 1 + 1) % 1);
      g.beginPath(); g.arc(x, y, (k === 0 ? 6.5 : 4.5 * (1 - k / 19)) * dpr, 0, Math.PI * 2);
      g.fillStyle = k === 0 ? '#ff2a1a' : `rgba(255,42,26,${0.5 * (1 - k / 19)})`; g.fill();
    }
    const [sx, sy] = outline[0]; // start / finish
    g.fillStyle = '#fff'; g.fillRect(sx - 2.5 * dpr, sy - 8 * dpr, 5 * dpr, 16 * dpr);
  }
  function drawProfile() {
    const W = prof.width, H = prof.height;
    pg.clearRect(0, 0, W, H);
    if (!profile || !W) return;
    const { e, lo, hi } = profile, n = e.length, top = 6 * dpr, bot = H - 4 * dpr;
    const y = (h) => bot - ((h - lo) / (hi - lo)) * (bot - top);
    pg.beginPath(); pg.moveTo(0, H);
    for (let i = 0; i < n; i++) pg.lineTo((i / (n - 1)) * W, y(e[i]));
    pg.lineTo(W, H); pg.closePath();
    const fill = pg.createLinearGradient(0, top, 0, H);
    fill.addColorStop(0, 'rgba(255,255,255,0.22)'); fill.addColorStop(1, 'rgba(255,255,255,0.02)');
    pg.fillStyle = fill; pg.fill();
    pg.beginPath();
    for (let i = 0; i < n; i++) pg[i ? 'lineTo' : 'moveTo']((i / (n - 1)) * W, y(e[i]));
    pg.strokeStyle = 'rgba(255,255,255,0.7)'; pg.lineWidth = 1.5 * dpr; pg.stroke();
    const f = runner * (n - 1), i0 = Math.floor(f), h = e[i0] + (e[Math.min(i0 + 1, n - 1)] - e[i0]) * (f - i0);
    pg.beginPath(); pg.arc(runner * W, y(h), 4.5 * dpr, 0, Math.PI * 2); pg.fillStyle = '#ff2a1a'; pg.fill();
  }
  if (window.ResizeObserver) new ResizeObserver(fitMap).observe(canvas.parentElement);
  window.addEventListener('resize', fitMap);
  let last = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    const dt = (now - last) / 1000; last = now;
    if (menu.classList.contains('hidden') || step !== 'track') return;
    runner = (runner + dt / 10) % 1; // one lap every 10 s
    drawOutline(); drawProfile();
  })(last);

  // ---------- 3 · race setup ----------
  // time of day: what this car can race at this circuit
  function showTime() {
    const def = current(), setup = raceSetup(car, def, time), options = timesFor(car, def), own = def.time ?? 'day';
    $('time-row').classList.toggle('hidden', options.length < 2);
    $('opt-time').innerHTML = options.map((t) => {
      const on = t === setup.choice;
      return `<button type="button" class="tod${on ? ' on' : ''}" data-v="${t}" role="radio" aria-checked="${on}">` +
        `<span class="tod-ico i-${t}" aria-hidden="true"></span><b>${TOD[t].name}</b><small>${TOD[t].sub}</small>` +
        `${t === own ? '<em>Like the real race</em>' : ''}</button>`;
    }).join('');
  }
  function pickTime(t) {
    if (!t || t === raceSetup(car, current(), time).choice) return;
    time = t; save({ time });
    showTime(); summary();
    onTime?.(time);
  }
  $('opt-time').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pickTime(b.dataset.v); });
  function toggleTime() { // N (X on a controller): the next time of day
    const options = timesFor(car, current());
    if (options.length < 2) return;
    const now = raceSetup(car, current(), time).choice;
    pickTime(options[(options.indexOf(now) + 1) % options.length]);
  }

  // laps: 1–100, with the Grand Prix distance for this circuit marked
  let ticksFor = '';
  function drawTicks(def) {
    const L = lenOf(def), key = `${def.id}|${Math.round(L)}`;
    if (key === ticksFor) return;
    ticksFor = key;
    const gp = Math.ceil(GP_DISTANCE / L), pos = (n) => ((n - 1) / (MAX_LAPS - 1)).toFixed(4);
    const marks = [1, 10, 25, 50, 75, 100].filter((n) => gp > MAX_LAPS || Math.abs(n - gp) > 7);
    $('laps-ticks').innerHTML = marks.map((n) => `<button type="button" data-laps="${n}" style="--p:${pos(n)}">${n}</button>`).join('') +
      (gp <= MAX_LAPS ? `<button type="button" class="gp" data-laps="${gp}" style="--p:${pos(gp)}" title="A Grand Prix: the fewest laps that make 305 km"><b>${gp}</b><span>305 km</span></button>` : '');
  }
  function showLaps() {
    const n = clampLaps(laps.value), def = current(), L = lenOf(def);
    $('laps-out').textContent = n;
    laps.style.setProperty('--p', ((n - 1) / (MAX_LAPS - 1)).toFixed(4));
    drawTicks(def);
    const km = (n * L) / 1000;
    $('laps-km').textContent = km >= 100 ? Math.round(km) : km.toFixed(1);
    const rec = records()[def.id], avg = rec?.flyN ? rec.flySum / rec.flyN : rec?.bestClean?.t ?? null;
    $('laps-avg').textContent = avg ? formatTime(avg) : 'None yet';
    $('laps-time').textContent = avg ? duration(n * avg) : '–';
    $('laps-note').textContent = avg ? '' : `Drive a lap of ${def.name} in the ${car.name} and the race time shows here.`;
    summary();
  }
  function setLaps(n) {
    laps.value = String(clampLaps(n));
    save({ laps: Number(laps.value) });
    showLaps();
  }
  laps.addEventListener('input', () => setLaps(laps.value));
  $('laps-ticks').addEventListener('click', (e) => { const b = e.target.closest('[data-laps]'); if (b) { setLaps(b.dataset.laps); laps.focus({ preventScroll: true }); } });

  // AI cars (0 = Practice: just you) and their skill
  const ai = $('opt-ai'), aiLabel = $('ai-count-label'), name = $('opt-name');
  if (saved.ai != null) ai.value = saved.ai;
  if (saved.name) name.value = saved.name;
  const showAi = () => {
    const n = Number(ai.value), max = Number(ai.max);
    aiLabel.textContent = n === 0 ? 'Practice' : n === max ? 'Full grid' : `${n} cars`;
    aiLabel.title = n === 0 ? 'Just you on track' : `${n} AI ${n === 1 ? 'car' : 'cars'}`;
    aiLabel.classList.toggle('practice', n === 0);
    ai.style.setProperty('--p', (n / max).toFixed(4));
    $('ai-skill-row').classList.toggle('off', n === 0); // no rivals, no difficulty
  };
  const setAi = (n) => { ai.value = String(Math.min(Number(ai.max), Math.max(0, n))); showAi(); save({ ai: Number(ai.value) }); };
  ai.addEventListener('input', () => setAi(Number(ai.value)));
  showAi();
  name.addEventListener('input', () => save({ name: name.value.trim() }));
  name.addEventListener('keydown', (e) => { // typing ≠ shortcuts
    if (e.code === 'Enter' || e.code === 'Escape') name.blur();
    e.stopPropagation();
  });
  // the sliders move with the arrow keys themselves; Enter (start) and Esc (back) still reach the menu
  for (const r of [laps, ai]) r.addEventListener('keydown', (e) => { if (/^(Arrow|Page|Home|End)/.test(e.code)) e.stopPropagation(); });

  // segmented buttons for the AI skill (the select stays the source of truth)
  for (const seg of document.querySelectorAll('#menu .seg[data-for]')) {
    const sel = $(seg.dataset.for);
    const draw = () => {
      seg.innerHTML = [...sel.options].map((o) =>
        `<button type="button" class="${o.value === sel.value ? 'on' : ''}" data-v="${o.value}">${o.textContent}</button>`).join('');
    };
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      sel.value = b.dataset.v; draw(); save({ diff: sel.value });
    });
    draw();
  }
  document.querySelectorAll('#menu .swatch').forEach((el) => el.addEventListener('click', () => save({ color: el.dataset.color })));

  // ---------- keyboard (a controller sends the same keys, input.js) ----------
  window.addEventListener('keydown', (e) => {
    if (menu.classList.contains('hidden')) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) && t.type !== 'range') return;
    const k = e.code;
    if (k === 'Enter') {
      const pickable = t?.closest('[data-pick]');
      if (pickable) { e.preventDefault(); pickable.click(); next(); return; } // Enter on a car / circuit: take it and go on
      if (t?.closest('button')) return;                                       // any other button: it presses itself
      e.preventDefault(); next(); return;
    }
    if (k === 'Escape') { e.preventDefault(); back(); return; }
    if (step === 'home') return;
    if (k === 'KeyN') { toggleTime(); return; }
    const arrow = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1, PageDown: -1, PageUp: 1 }[k];
    if (!arrow) return;
    e.preventDefault();
    if (step === 'car') (k === 'ArrowUp' || k === 'ArrowDown' ? stepCarRow(arrow) : stepCar(arrow));
    else if (step === 'track') (k === 'ArrowUp' || k === 'ArrowDown' ? stepTrackRow(arrow) : stepTrack(arrow));
    else if (step === 'setup') {
      if (k === 'ArrowUp' || k === 'ArrowDown') setAi(Number(ai.value) - arrow); // ↑ more AI cars, ↓ fewer
      else setLaps(clampLaps(laps.value) + arrow * (k.startsWith('Page') || e.shiftKey ? 10 : 1));
    }
  });

  showDef(current(), false);
  summary();
  go('home', { focus: false });
  menu.classList.add('boot'); // (go() takes it off; the first visit to the start screen keeps its entrance)

  return {
    // The circuit in the select changed from outside (the lobby showing the host's pick): show it
    refresh() { showDef(current(), false); markTiles(); summary(); if (step === 'setup') { showTime(); showLaps(); } },
    // Exact numbers once the circuit has been built
    setTrackInfo(track) {
      let lo = Infinity, hi = -Infinity;
      if (track.h) for (let i = 0; i < track.n; i++) { lo = Math.min(lo, track.h[i]); hi = Math.max(hi, track.h[i]); }
      exact.set(track.id, { len: track.length, climb: Number.isFinite(hi - lo) ? hi - lo : 0 });
      if (track.id !== select.value) return;
      $('c-len').textContent = (track.length / 1000).toFixed(2);
      $('c-elev').textContent = Math.round(climbOf(current()));
      if (step === 'setup') showLaps();
    },
    // Show a page of the menu: 'home', 'car', 'track' or 'setup'
    go,
  };
}