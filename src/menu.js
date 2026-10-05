// Main menu: car picker, circuit picker with a live outline, Day / Night (where the car can race both),
// lap and difficulty buttons, keyboard shortcuts.
// The <select> elements stay in the page as the source of truth (main.js reads them);
// this file just gives them a nicer face and remembers your last choices.
// The car and the time of day go to main.js through onCar / onTime (it rebuilds the circuit and the live race).
import { timesFor, raceSetup } from './cars/index.js';

const $ = (id) => document.getElementById(id);
const KEY = 'apex-circuit:setup';
const TIME = { night: 'Night race', dusk: 'Twilight race', day: 'Day race' };
const TIME_SHORT = { day: 'Day', dusk: 'Twilight', night: 'Night' };
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function load() { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...v })); } catch { /* private mode */ } }
// The time of day you last picked, where a circuit offers a choice ('day' unless you picked another)
export const savedTime = () => load().time ?? 'day';

// cars: the list from src/cars/; carId: the one picked; onCar(id) / onTime(time): you picked another
export function setupMenu({ tracks, cars, carId, onStart, onCar, onTime }) {
  const menu = $('menu'), select = $('opt-track'), laps = $('opt-laps'), diff = $('opt-diff');
  const saved = load();
  let car = cars.find((c) => c.id === carId) ?? cars[0], time = savedTime();
  const current = () => tracks.find((t) => t.id === select.value) ?? tracks[0];
  if (saved.track && tracks.some((t) => t.id === saved.track)) select.value = saved.track;
  if (saved.laps) laps.value = saved.laps;
  if (saved.diff) diff.value = saved.diff;
  if (saved.color) document.querySelector(`.swatch[data-color="${saved.color}"]`)?.click();

  // ---- AI cars (0 = Practice: just you) and your name ----
  const ai = $('opt-ai'), aiLabel = $('ai-count-label'), name = $('opt-name');
  if (saved.ai != null) ai.value = saved.ai;
  if (saved.name) name.value = saved.name;
  const showAi = () => {
    const n = Number(ai.value);
    aiLabel.textContent = n === 0 ? 'Practice' : n === Number(ai.max) ? `${n} · Full` : String(n);
    aiLabel.classList.toggle('practice', n === 0);
    $('ai-skill-row').classList.toggle('off', n === 0);   // no rivals, no difficulty
  };
  ai.addEventListener('input', () => { showAi(); save({ ai: Number(ai.value) }); });
  name.addEventListener('input', () => save({ name: name.value.trim() }));
  name.addEventListener('keydown', (e) => { if (e.code === 'Enter') name.blur(); e.stopPropagation(); }); // typing ≠ shortcuts
  ai.addEventListener('keydown', (e) => e.stopPropagation()); // arrow keys move the slider, not the circuit
  showAi();

  // ---- segmented buttons for laps and difficulty ----
  for (const seg of document.querySelectorAll('.seg')) {
    const sel = $(seg.dataset.for);
    const draw = () => {
      seg.innerHTML = [...sel.options].map((o) =>
        `<button type="button" class="${o.value === sel.value ? 'on' : ''}" data-v="${o.value}">${o.textContent}</button>`).join('');
    };
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      sel.value = b.dataset.v; draw(); save({ [sel.id === 'opt-laps' ? 'laps' : 'diff']: sel.value });
    });
    draw();
  }
  document.querySelectorAll('.swatch').forEach((el) => el.addEventListener('click', () => save({ color: el.dataset.color })));

  // ---- circuit card ----
  const canvas = $('c-map'), g = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = 360, H = 190;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  let outline = [], runner = 0;

  function makeOutline(def) {
    const pts = def.points;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const pad = 18, sc = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ));
    const ox = (W - (maxX - minX) * sc) / 2, oy = (H - (maxZ - minZ) * sc) / 2;
    outline = pts.map(([x, z]) => [(W - (ox + (x - minX) * sc)) * dpr, (oy + (maxZ - z) * sc) * dpr]); // x mirrored: north up
    // cumulative length, to run a dot round the lap
    let L = 0; outline.cum = [0];
    for (let i = 1; i <= outline.length; i++) {
      const a = outline[i - 1], b = outline[i % outline.length];
      L += Math.hypot(b[0] - a[0], b[1] - a[1]); outline.cum.push(L);
    }
    outline.total = L;
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
    g.shadowColor = 'rgba(225,6,0,0.55)'; g.shadowBlur = 18 * dpr;
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 11 * dpr; g.stroke();
    g.shadowBlur = 0; g.strokeStyle = '#f4f5f7'; g.lineWidth = 3.5 * dpr; g.stroke();
    // a car running round the lap, with a fading tail
    for (let k = 14; k >= 0; k--) {
      const [x, y] = pointAlong(((runner - k * 0.004) % 1 + 1) % 1);
      g.beginPath(); g.arc(x, y, (k === 0 ? 5 : 3.5 * (1 - k / 15)) * dpr, 0, Math.PI * 2);
      g.fillStyle = k === 0 ? '#ff2a1a' : `rgba(255,42,26,${0.5 * (1 - k / 15)})`; g.fill();
    }
    const [sx, sy] = outline[0];
    g.fillStyle = '#fff'; g.fillRect(sx - 2 * dpr, sy - 6 * dpr, 4 * dpr, 12 * dpr);
  }
  let last = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    if (menu.classList.contains('hidden')) { last = now; return; }
    runner = (runner + (now - last) / 1000 / 9) % 1; last = now; // one lap every 9 s
    drawOutline();
  })(last);

  function showDef(def, animate = true) {
    const i = tracks.indexOf(def);
    $('c-round').textContent = def.round ? `Round ${def.round}` : 'Classic';
    $('c-name').textContent = def.name;
    $('c-country').textContent = def.country;
    $('c-count').textContent = `${i + 1}/${tracks.length}`;
    showTime(def);
    makeOutline(def);
    if (!animate) return;
    const card = document.querySelector('.circuit-card');
    card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap');
  }
  // The time of day for this car here: the badge, and the Day / Night buttons when it can race both
  function showTime(def) {
    const setup = raceSetup(car, def, time), options = timesFor(car, def);
    const badges = [TIME[setup.time], def.type === 'street' ? 'Street circuit' : 'Permanent circuit'];
    if (setup.lighting === 'pits') badges.push('Only the pit straight lit');
    if (def.banking?.length) badges.push('Banked corners');
    $('c-badges').innerHTML = badges.map((b, k) => `<span class="${k === 0 ? 't-' + setup.time : ''}">${b}</span>`).join('');
    const row = $('time-row');
    row.classList.toggle('hidden', options.length < 2);
    $('opt-time').innerHTML = options.map((t) =>
      `<button type="button" class="${t === setup.time ? 'on' : ''}" data-v="${t}">${TIME_SHORT[t] ?? t}</button>`).join('');
  }
  function pickTime(t) {
    if (!t || t === time) return;
    time = t; save({ time });
    showTime(current());
    onTime?.(time);
  }
  $('opt-time').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pickTime(b.dataset.v); });
  function toggleTime() { // N / B on a controller: the other time of day, where there's a choice
    const options = timesFor(car, current());
    if (options.length < 2) return;
    const now = raceSetup(car, current(), time).time;
    pickTime(options[(options.indexOf(now) + 1) % options.length]);
  }

  // ---- car picker: one button per car (↑ ↓ to change) ----
  function showCars() {
    $('car-pick').innerHTML = cars.map((c) =>
      `<button type="button" class="${c === car ? 'on' : ''}" data-car="${esc(c.id)}" role="radio" aria-checked="${c === car}">` +
      `<b>${esc(c.name)}</b><span>${esc(c.car)}</span></button>`).join('');
    $('car-spec').textContent = (car.specs ?? []).join(' · ');
  }
  function pickCar(c) {
    if (!c || c === car) return;
    car = c; showCars(); showTime(current());
    onCar?.(car.id);
  }
  $('car-pick').addEventListener('click', (e) => { const b = e.target.closest('button[data-car]'); if (b) pickCar(cars.find((c) => c.id === b.dataset.car)); });
  const stepCar = (step) => pickCar(cars[(cars.indexOf(car) + step + cars.length) % cars.length]);
  showCars();
  function choose(step) {
    const i = (tracks.findIndex((t) => t.id === select.value) + step + tracks.length) % tracks.length;
    select.value = tracks[i].id;
    select.dispatchEvent(new Event('change')); // main.js rebuilds the circuit and the live race
  }
  select.addEventListener('change', () => { showDef(tracks.find((t) => t.id === select.value)); save({ track: select.value }); });
  $('c-prev').addEventListener('click', () => choose(-1));
  $('c-next').addEventListener('click', () => choose(1));
  showDef(tracks.find((t) => t.id === select.value) ?? tracks[0]);

  // ---- keyboard: ↑ ↓ car, ← → circuits, N day / night, Enter to race ----
  window.addEventListener('keydown', (e) => {
    if (menu.classList.contains('hidden') || ['SELECT', 'INPUT'].includes(e.target.tagName)) return;
    if (e.code === 'ArrowLeft') choose(-1);
    else if (e.code === 'ArrowRight') choose(1);
    else if (e.code === 'ArrowUp') { e.preventDefault(); stepCar(-1); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); stepCar(1); }
    else if (e.code === 'KeyN') toggleTime();
    else if (e.code === 'Enter') onStart();
  });

  return {
    // The circuit in the select changed from outside (the lobby showing the host's pick): show it
    refresh() { showDef(current(), false); },
    // Exact numbers once the circuit has been built
    setTrackInfo(track) {
      let lo = Infinity, hi = -Infinity;
      if (track.h) for (let i = 0; i < track.n; i++) { lo = Math.min(lo, track.h[i]); hi = Math.max(hi, track.h[i]); }
      $('c-len').textContent = (track.length / 1000).toFixed(2);
      $('c-elev').textContent = Number.isFinite(hi - lo) ? Math.round(hi - lo) : 0;
    },
  };
}