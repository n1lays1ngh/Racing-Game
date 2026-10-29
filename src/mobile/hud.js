// Your own HUD on a phone (src/mobile/ only: the desktop HUD isn't touched). Every touch control and HUD panel has a
// place and a size: a sensible default for each way of steering (touch.js), or wherever you've put it in the editor.
//
//   const layout = new HudLayout()
//   layout.apply(mode)        put everything where it goes for this steering mode ('slide' | 'buttons' | 'tilt')
//   layout.edit(mode, done)   the editor: drag anything to move it, pinch it or use the − / + and the slider to size
//                             it, Reset puts this mode's layout back to the defaults, Done saves it (in this browser)
//
// Positions are kept as shares of the screen (the item's centre), so a layout fits any phone and either way round.
export const ITEMS = [ // id, what it is, label, the editor's size range (× its default size)
  { id: 'gas', sel: '#touch .t-gas', label: 'Throttle' },
  { id: 'brake', sel: '#touch .t-brake', label: 'Brake' },
  { id: 'boost', sel: '#touch .t-boost', label: 'Boost' },
  { id: 'left', sel: '#touch .t-left', label: 'Left', modes: ['buttons'] },
  { id: 'right', sel: '#touch .t-right', label: 'Right', modes: ['buttons'] },
  { id: 'keys', sel: '#touch .t-top', label: 'Buttons' },
  { id: 'speedo', sel: '#speedo', label: 'Speed' },
  { id: 'tower', sel: '#tower', label: 'Positions' },
  { id: 'timing', sel: '#timing', label: 'Lap time' },
  { id: 'map', sel: '#map-panel', label: 'Map' },
];
// Defaults: which corner (or edge) of the screen an item sits at, the gap to it (px) and its size (1 = as drawn; the HUD
// panels are drawn at the desktop's size, so they're scaled down)
const PANEL = { tower: 0.42, timing: 0.42, map: 0.32, speedo: 0.34 };
function defaults(mode) {
  const d = {
    keys: { a: 'tc', x: 0, y: 8, s: 1 },
    tower: { a: 'tl', x: 14, y: 8, s: PANEL.tower },
    timing: { a: 'tr', x: 14, y: 8, s: PANEL.timing },
    map: { a: 'tl', x: 14, y: 124, s: PANEL.map },        // under the positions
    gas: { a: 'br', x: 14, y: 12, s: 1 },
    brake: { a: 'br', x: 118, y: 12, s: 1 },               // beside the throttle
    boost: { a: 'br', x: 14, y: 166, s: 1 },               // above it
    left: { a: 'bl', x: 14, y: 12, s: 1 },
    right: { a: 'bl', x: 118, y: 12, s: 1 },
    speedo: { a: 'bl', x: 14, y: 12, s: PANEL.speedo },    // bottom left (your thumb steers anywhere on the left)
  };
  if (mode === 'buttons') d.speedo = { a: 'bc', x: -40, y: 10, s: PANEL.speedo }; // (the arrows are bottom left)
  if (mode === 'tilt') { d.brake = { a: 'bl', x: 14, y: 12, s: 1 }; d.boost = { a: 'br', x: 14, y: 174, s: 1 }; d.speedo = { a: 'bc', x: 0, y: 10, s: PANEL.speedo }; }
  return d;
}
const KEY = 'apex-circuit:mobile-hud';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const $ = (s) => document.querySelector(s);

export class HudLayout {
  constructor() { this.saved = load(); this.mode = 'slide'; }

  // where an item goes now: { x, y } (its centre, px) and s (its scale)
  place(item, mode, el) {
    const W = innerWidth, H = innerHeight, mine = this.saved[mode]?.[item.id];
    if (mine) return { x: mine.cx * W, y: mine.cy * H, s: mine.s };
    const d = defaults(mode)[item.id], w = el.offsetWidth * d.s, h = el.offsetHeight * d.s, a = d.a;
    const x = a[1] === 'l' ? d.x + w / 2 : a[1] === 'r' ? W - d.x - w / 2 : W / 2 + d.x;
    const y = a[0] === 't' ? d.y + h / 2 : a[0] === 'b' ? H - d.y - h / 2 : H / 2 + d.y;
    return { x, y, s: d.s };
  }

  apply(mode = this.mode) {
    this.mode = mode;
    for (const item of ITEMS) {
      const el = $(item.sel);
      if (!el || !el.offsetWidth) continue; // (not shown right now: placed when it is)
      const p = this.place(item, mode, el);
      const w = el.offsetWidth * p.s, h = el.offsetHeight * p.s; // (kept on the screen)
      const x = clamp(p.x, w / 2, Math.max(w / 2, innerWidth - w / 2)), y = clamp(p.y, h / 2, Math.max(h / 2, innerHeight - h / 2));
      Object.assign(el.style, { position: 'fixed', left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto', margin: '0',
        transform: `translate(-50%, -50%) scale(${p.s})`, transformOrigin: '50% 50%' });
    }
  }

  // ---------- the editor ----------
  edit(mode, done) {
    this.mode = mode;
    document.body.classList.add('hud-editing');
    const layer = document.createElement('div');
    layer.id = 'hud-edit';
    layer.innerHTML =
      '<div class="he-bar"><b class="he-name">Tap a control or panel</b>' +
      '<button type="button" class="he-btn" data-a="smaller" aria-label="Smaller">−</button>' +
      '<input type="range" class="he-size" min="40" max="250" step="1" value="100" aria-label="Size">' +
      '<button type="button" class="he-btn" data-a="bigger" aria-label="Bigger">+</button>' +
      '<button type="button" class="he-txt" data-a="reset">Reset</button><button type="button" class="he-txt he-done" data-a="done">Done</button></div>' +
      '<p class="he-tip">Drag to move · pinch, or − / +, to size · saved for this steering mode</p>';
    document.body.appendChild(layer);
    const bar = layer.querySelector('.he-bar'), size = layer.querySelector('.he-size'), name = layer.querySelector('.he-name'), tip = layer.querySelector('.he-tip');
    const items = ITEMS.filter((it) => !it.modes || it.modes.includes(mode)).map((it) => ({ ...it, el: $(it.sel) })).filter((it) => it.el);
    const handles = new Map();
    for (const it of items) {
      const h = document.createElement('div');
      h.className = 'he-item'; h.dataset.id = it.id; h.innerHTML = `<span>${it.label}</span>`;
      layer.insertBefore(h, bar); handles.set(it.id, h);
    }
    let sel = null;
    const mine = () => (this.saved[mode] ??= {});
    const current = (it) => { const p = this.place(it, mode, it.el); return p; };
    const set = (it, x, y, s) => { mine()[it.id] = { cx: x / innerWidth, cy: y / innerHeight, s }; this.apply(mode); draw(); };
    const draw = () => {
      for (const it of items) {
        const r = it.el.getBoundingClientRect(), h = handles.get(it.id);
        Object.assign(h.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        h.classList.toggle('on', sel === it);
      }
      bar.classList.toggle('has-sel', !!sel);
      if (sel) { name.textContent = sel.label; size.value = String(Math.round((current(sel).s / defaults(mode)[sel.id].s) * 100)); }
      else name.textContent = 'Tap a control or panel';
      // the bar keeps out of the way: the other half of the screen from what you're moving
      const r = sel?.el.getBoundingClientRect(), low = !!r && r.top + r.height / 2 < innerHeight / 2;
      bar.style.top = low ? '76%' : '34%'; tip.style.top = low ? 'calc(76% + 34px)' : 'calc(34% + 34px)';
    };
    const resize = (k) => { if (!sel) return; const p = current(sel), d = defaults(mode)[sel.id].s; set(sel, p.x, p.y, clamp(k, 0.4 * d, 2.5 * d)); };
    // drag one finger to move; two fingers on the screen pinch the selected item
    const ptr = new Map();
    let drag = null, pinch = null;
    layer.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.he-bar')) return;
      e.preventDefault();
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { layer.setPointerCapture(e.pointerId); } catch { /* fine */ }
      if (ptr.size === 2 && sel) {
        const [a, b] = [...ptr.values()];
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: current(sel).s }; drag = null; return;
      }
      const h = e.target.closest('.he-item');
      if (!h) { sel = null; draw(); return; }
      sel = items.find((it) => it.id === h.dataset.id);
      const p = current(sel);
      drag = { id: e.pointerId, dx: e.clientX - p.x, dy: e.clientY - p.y };
      draw();
    });
    layer.addEventListener('pointermove', (e) => {
      if (!ptr.has(e.pointerId)) return;
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptr.size >= 2 && sel) {
        const [a, b] = [...ptr.values()];
        resize(pinch.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0)); return;
      }
      if (drag && drag.id === e.pointerId && sel) { const p = current(sel); set(sel, e.clientX - drag.dx, e.clientY - drag.dy, p.s); }
    });
    const up = (e) => { ptr.delete(e.pointerId); if (ptr.size < 2) pinch = null; if (drag?.id === e.pointerId) drag = null; };
    layer.addEventListener('pointerup', up); layer.addEventListener('pointercancel', up);
    size.addEventListener('input', () => { if (sel) resize((Number(size.value) / 100) * defaults(mode)[sel.id].s); });
    bar.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'smaller' && sel) resize(current(sel).s / 1.1);
      if (a === 'bigger' && sel) resize(current(sel).s * 1.1);
      if (a === 'reset') { delete this.saved[mode]; save(this.saved); this.apply(mode); sel = null; draw(); }
      if (a === 'done') { save(this.saved); window.removeEventListener('resize', onResize); layer.remove(); document.body.classList.remove('hud-editing'); done?.(); }
    });
    const onResize = () => { this.apply(mode); draw(); };
    window.addEventListener('resize', onResize);
    this.apply(mode); requestAnimationFrame(() => { this.apply(mode); draw(); });
  }
}