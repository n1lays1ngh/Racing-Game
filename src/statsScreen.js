// The stats screen: main menu → Your stats.
//   Circuits   your totals, then every circuit: fastest lap, laps, races, wins, best finish, time driven
//   All laps   every lap you've driven, newest first (or fastest first for one circuit), with sectors
//   A circuit  (click a row) fastest lap, best sectors and theoretical best, average lap, consistency,
//              a chart of your lap times, your 10 fastest laps and your recent sessions there
// The numbers are recorded by stats.js while you drive; this file only shows them.
import { getStats, resetStats, LIMITS } from './stats.js';
import { DEFAULT_CAR } from './cars/index.js';
import { formatTime } from './race.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const PAGE = 100; // laps per "show more"

// Lap-time chart. Laps are orange, your best is purple (the game's "fastest" colour); the pair was checked
// for colour-blind separation on the dark panel. Invalidated laps are also hollow, so colour is never the only cue.
const CHART = {
  laps: 80,          // the last this many laps on the circuit
  slowCap: 1.25,     // laps slower than 125% of your best sit on the top edge (as a triangle) so they don't squash the rest
  height: 250,
};

const MODE = { practice: 'Practice', race: 'Race', online: 'Online' };
const DIFF = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };

// ---------- formatting ----------
export function fmtDuration(s) {
  s = Math.max(0, s || 0);
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
const fmtKm = (m) => { const km = (m || 0) / 1000; return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`; };
const fmtSec = (t) => (t == null ? '--' : t.toFixed(3));
const fmtGap = (d) => (d == null ? '' : d < 0.0005 ? '' : `+${d.toFixed(3)}`);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '--');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function fmtDate(at, withTime = false) {
  if (!at) return '--';
  const d = new Date(at), thisYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) });
  return withTime ? `${day}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : day;
}
const sessionName = (x) => [MODE[x.mode] ?? x.mode, x.diff ? DIFF[x.diff] : null].filter(Boolean).join(' · ');
const tile = (label, value, sub = '') => `<div class="st-tile"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

// Chart axis: a round step for about four gridlines, and m:ss labels
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-3)));
  for (const k of [1, 2, 5, 10]) if (k * p >= raw) return k * p;
  return 10 * p;
}
function fmtAxis(t, step) {
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0, f = 10 ** dec;
  t = Math.round(t * f) / f;
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`;
}

// Circuit shape from its file (north up, like the menu and minimap)
function outline(def, w, h, stroke) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of def.points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const pad = stroke + 1, sc = Math.min((w - 2 * pad) / (maxX - minX || 1), (h - 2 * pad) / (maxZ - minZ || 1));
  const ox = (w - (maxX - minX) * sc) / 2, oy = (h - (maxZ - minZ) * sc) / 2;
  const pts = def.points.map(([x, z]) => `${(w - (ox + (x - minX) * sc)).toFixed(1)},${(oy + (maxZ - z) * sc).toFixed(1)}`).join(' ');
  return `<svg class="st-outline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">` +
    `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linejoin="round"/></svg>`;
}

function resultCell(r) {
  if (r.result !== 'finished') return `<span class="muted">${r.mode === 'practice' ? 'Left early' : 'Retired'}</span>`;
  if (r.pos == null) return 'Completed';
  const moved = (r.grid ?? r.pos) - r.pos;
  const gain = moved > 0 ? `<span class="gain up">▲${moved}</span>` : moved < 0 ? `<span class="gain down">▼${-moved}</span>` : '';
  return `<b>P${r.pos}</b><span class="muted"> of ${r.field}</span>${gain}`;
}

export class StatsScreen {
  constructor({ tracks, onClose }) {
    this.tracks = tracks; this.onClose = onClose;
    this.el = $('stats'); this.body = $('st-body');
    this.view = 'circuits';          // 'circuits' | 'laps' | 'circuit'
    this.circuit = null; this.from = 'circuits';
    this.filter = { c: 'all', clean: false, sort: 'new', shown: PAGE };
    this.thumbs = new Map();
    this.car = DEFAULT_CAR;          // whose records are shown (records are per circuit and per car, stats.js)
    this.data = getStats(this.car);
    $('st-back').addEventListener('click', () => this.back());
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('keydown', (e) => {
      if (['SELECT', 'INPUT'].includes(e.target.tagName)) e.stopPropagation(); // arrow keys work in the filters, not the game
      if (e.code === 'Enter' && e.target.dataset?.circuit) this.openCircuit(e.target.dataset.circuit);
    });
    window.addEventListener('keydown', (e) => { if (this.visible && e.code === 'Escape') { e.preventDefault(); this.back(); } });
    window.addEventListener('resize', () => { if (this.visible && this.view === 'circuit') this.drawChart(); });
    this.refreshButton();
  }

  get visible() { return !this.el.classList.contains('hidden'); }

  open() {
    this.data = getStats(this.car);
    this.view = 'circuits'; this.circuit = null;
    this.el.classList.remove('hidden');
    this.render();
    $('st-back').focus({ preventScroll: true });
  }
  close() { this.el.classList.add('hidden'); this.refreshButton(); this.onClose?.(); }
  back() {
    if (this.view === 'circuit') { this.view = this.from; this.circuit = null; this.render(); }
    else this.close();
  }
  openCircuit(id) {
    if (this.view !== 'circuit') this.from = this.view;
    this.view = 'circuit'; this.circuit = id;
    this.render();
  }

  // The line under "Your stats" on the main-menu button
  refreshButton() {
    const el = $('st-open-sub');
    if (!el) return;
    const t = getStats().total;
    el.textContent = t.laps ? `${plural(t.laps, 'lap')} · ${fmtDuration(t.time)} on track` : 'Lap records for every circuit';
  }

  // ---------- events ----------
  onClick(e) {
    const t = e.target.closest('[data-act], [data-circuit]');
    if (!t || !this.body.contains(t)) return;
    if (t.dataset.circuit) { this.openCircuit(t.dataset.circuit); return; }
    switch (t.dataset.act) {
      case 'tab': this.view = t.dataset.v; this.render(); break;
      case 'more': this.filter.shown += PAGE; this.render({ keepScroll: true }); break;
      case 'laps-here': Object.assign(this.filter, { c: this.circuit, shown: PAGE }); this.view = 'laps'; this.circuit = null; this.render(); break;
      case 'reset':
        if (window.confirm("Delete all your stats? Every lap, record and race result will be gone, and this can't be undone.")) {
          resetStats(); this.data = getStats(this.car); this.view = 'circuits'; this.render();
        }
        break;
    }
  }
  onChange(e) {
    const t = e.target, f = this.filter;
    if (t.id === 'st-f-circuit') { f.c = t.value; f.shown = PAGE; if (f.c === 'all') f.sort = 'new'; }
    else if (t.id === 'st-f-sort') { f.sort = t.value; f.shown = PAGE; }
    else if (t.id === 'st-f-clean') { f.clean = t.checked; f.shown = PAGE; }
    else return;
    this.render({ keepScroll: true });
  }

  // ---------- drawing ----------
  render({ keepScroll = false } = {}) {
    const focus = document.activeElement?.id;
    const def = this.view === 'circuit' ? this.tracks.find((t) => t.id === this.circuit) : null;
    if (this.view === 'circuit' && !def) this.view = 'circuits';
    const c = def ? this.data.circuits[def.id] : null;
    $('st-kicker').textContent = def ? [def.round ? `Round ${def.round}` : null, def.country].filter(Boolean).join(' · ') : 'Driver profile';
    $('st-title').textContent = def ? def.name : 'Your stats';
    $('st-sub').textContent = def
      ? (c?.first ? `First driven ${fmtDate(c.first)} · last ${fmtDate(c.last)}` : 'Not driven yet')
      : `Since ${fmtDate(this.data.since)} · saved in this browser`;
    $('st-art').innerHTML = def ? outline(def, 180, 110, 4) : '';
    $('st-back').querySelector('span').textContent = def ? '‹ Back' : '‹ Menu';

    if (def) this.body.innerHTML = this.circuitPage(def);
    else this.body.innerHTML = this.totals() + this.tabs() + (this.view === 'laps' ? this.lapsPage() : this.circuitsPage()) + this.footer();
    if (def) this.drawChart();
    if (focus && this.body.contains($(focus))) $(focus).focus({ preventScroll: true });
    if (!keepScroll) this.el.scrollTop = 0;
  }

  name(id) { return this.tracks.find((t) => t.id === id)?.name ?? id; }
  thumb(def) {
    if (!this.thumbs.has(def.id)) this.thumbs.set(def.id, outline(def, 44, 28, 2));
    return this.thumbs.get(def.id);
  }

  totals() {
    const t = this.data.total;
    if (!t.sessions) {
      return '<div class="st-empty"><b>No laps yet</b><span>Every lap you drive is recorded here: lap and sector times, top speed, ' +
        'valid laps and race results, for every circuit. Go and set some times.</span></div>';
    }
    const practice = t.sessions - t.races;
    const driven = this.tracks.filter((def) => this.data.circuits[def.id]?.sessions).length;
    return `<div class="st-tiles">${[
      tile('Time on track', fmtDuration(t.time)),
      tile('Distance', fmtKm(t.dist)),
      tile('Laps', t.laps.toLocaleString(), t.laps ? `${pct(t.cleanLaps, t.laps)} valid` : ''),
      tile('Races', t.races.toLocaleString(), [`${t.finished} finished`, practice ? `${practice} practice` : null].filter(Boolean).join(' · ')),
      tile('Wins', t.wins.toLocaleString(), t.finished ? `${pct(t.wins, t.finished)} of races finished` : ''),
      tile('Podiums', t.podiums.toLocaleString(), t.finished ? `${pct(t.podiums, t.finished)} of races finished` : ''),
      tile('Top speed', t.top ? `${t.top}<small> km/h</small>` : '--'),
      tile('Circuits', `${driven}<small> of ${this.tracks.length}</small>`, driven < this.tracks.length ? `${this.tracks.length - driven} still to drive` : 'every one'),
    ].join('')}</div>`;
  }

  tabs() {
    const tab = (v, label) => `<button type="button" class="st-tab${this.view === v ? ' on' : ''}" data-act="tab" data-v="${v}">${label}</button>`;
    return `<div class="st-tabs">${tab('circuits', 'Circuits')}${tab('laps', `All laps <small>${this.data.laps.length.toLocaleString()}</small>`)}</div>`;
  }

  footer() {
    if (!this.data.total.sessions) return '';
    return '<div class="st-foot"><span>Your stats are saved in this browser only.</span>' +
      '<button type="button" class="st-link danger" data-act="reset">Reset all stats</button></div>';
  }

  // ---- Circuits tab ----
  circuitsPage() {
    const rows = this.tracks.map((def) => {
      const c = this.data.circuits[def.id];
      const name = `<td class="st-cname"><div>${this.thumb(def)}<span><b>${esc(def.name)}</b><small>${esc(def.country ?? '')}</small></span></div></td>`;
      if (!c?.sessions) return `<tr class="none">${name}<td colspan="7" class="muted">Not driven yet</td></tr>`;
      return `<tr class="go" data-circuit="${esc(def.id)}" tabindex="0" title="Open ${esc(def.name)}">${name}` +
        `<td class="r t purple">${formatTime(c.bestClean?.t)}</td>` +
        `<td class="r">${c.laps}</td><td class="r">${c.races}</td><td class="r">${c.wins}</td>` +
        `<td class="c">${c.bestPos ? 'P' + c.bestPos : '--'}</td>` +
        `<td class="r">${fmtDuration(c.time)}</td><td class="r muted">${fmtDate(c.last)}<span class="st-go">›</span></td></tr>`;
    }).join('');
    return '<div class="st-panel"><div class="st-scroll"><table class="st-table st-circuits"><thead><tr><th>Circuit</th><th class="r">Fastest lap</th>' +
      '<th class="r">Laps</th><th class="r">Races</th><th class="r">Wins</th><th class="c">Best finish</th><th class="r">Time</th>' +
      `<th class="r">Last driven</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  // ---- All laps tab ----
  lapsPage() {
    const d = this.data, f = this.filter;
    const driven = this.tracks.filter((def) => d.circuits[def.id]?.laps);
    if (f.c !== 'all' && !driven.some((def) => def.id === f.c)) f.c = 'all';
    if (f.c === 'all') f.sort = 'new'; // lap times from different circuits can't be compared
    let list = d.laps.filter((l) => (f.c === 'all' || l.c === f.c) && (!f.clean || l.clean));
    list = f.sort === 'fast' ? [...list].sort((a, b) => a.t - b.t || a.at - b.at) : [...list].reverse();

    const options = ['<option value="all">All circuits</option>',
      ...driven.map((def) => `<option value="${esc(def.id)}"${def.id === f.c ? ' selected' : ''}>${esc(def.name)}</option>`)].join('');
    const filters = '<div class="st-filters">' +
      `<label>Circuit <select id="st-f-circuit">${options}</select></label>` +
      `<label>Order <select id="st-f-sort"${f.c === 'all' ? ' disabled title="Pick a circuit to sort by lap time"' : ''}>` +
      `<option value="new">Newest first</option><option value="fast"${f.sort === 'fast' ? ' selected' : ''}>Fastest first</option></select></label>` +
      `<label class="st-check"><input type="checkbox" id="st-f-clean"${f.clean ? ' checked' : ''}> Valid laps only</label>` +
      `<span class="st-count">${plural(list.length, 'lap')}</span></div>`;
    if (!list.length) return filters + `<div class="st-panel st-none">${d.laps.length ? 'No laps match these filters.' : 'No laps yet.'}</div>`;

    const opts = { circuit: f.c === 'all', rank: f.sort === 'fast' };
    const rows = list.slice(0, f.shown).map((l, i) => this.lapRow(l, opts, i + 1)).join('');
    const more = list.length > f.shown ? `<button type="button" class="st-more" data-act="more">Show ${Math.min(PAGE, list.length - f.shown)} more</button>` : '';
    const capped = d.laps.length >= LIMITS.laps
      ? `<p class="st-fine">The newest ${LIMITS.laps.toLocaleString()} laps are listed here. Records and totals count every lap you've driven.</p>` : '';
    return filters + `<div class="st-panel"><div class="st-scroll"><table class="st-table">${this.lapHead(opts)}<tbody>${rows}</tbody></table></div></div>${more}${capped}`;
  }

  lapHead({ circuit = false, rank = false } = {}) {
    return `<thead><tr>${rank ? '<th class="c">#</th>' : ''}<th>Date</th>${circuit ? '<th>Circuit</th>' : ''}<th class="c">Lap</th>` +
      '<th class="r">Time</th><th class="r">Gap to best</th><th class="r">S1</th><th class="r">S2</th><th class="r">S3</th>' +
      '<th class="r">Top km/h</th><th>Track limits</th><th>Session</th></tr></thead>';
  }

  lapRow(l, { circuit = false, rank = false } = {}, k = 0) {
    const c = this.data.circuits[l.c], best = c?.bestClean, bs = c?.bestSec ?? []; // bestClean: fastest valid lap
    const pb = !!best && best.t === l.t && best.at === l.at;
    const sec = (j) => `<td class="r s${l.s && bs[j] != null && Math.abs(l.s[j] - bs[j]) < 0.0005 ? ' purple' : ''}">${fmtSec(l.s?.[j])}</td>`; // your best sector
    return `<tr>${rank ? `<td class="c muted">${k}</td>` : ''}<td class="muted">${fmtDate(l.at, true)}</td>` +
      (circuit ? `<td>${esc(this.name(l.c))}</td>` : '') +
      `<td class="c">${l.n}${l.standing ? '<i class="st-tag" title="From the grid: a standing start">Start</i>' : ''}</td>` +
      `<td class="r t${pb ? ' purple' : ''}">${formatTime(l.t)}${pb ? '<i class="st-tag pb" title="Your fastest lap here">PB</i>' : ''}</td>` +
      `<td class="r muted">${pb || !best ? '' : fmtGap(l.t - best.t)}</td>${sec(0)}${sec(1)}${sec(2)}` +
      `<td class="r">${l.top || '--'}</td>` +
      `<td>${l.clean ? '<span class="st-clean">Valid</span>' : '<span class="st-off">Invalid</span>'}</td>` +
      `<td class="muted">${sessionName(l)}</td></tr>`;
  }

  // ---- one circuit ----
  circuitPage(def) {
    const d = this.data, c = d.circuits[def.id];
    if (!c?.sessions) return `<div class="st-panel st-none">You haven't driven ${esc(def.name)} yet. Pick it on the main menu and set a time.</div>`;
    const laps = d.laps.filter((l) => l.c === def.id);
    const b = c.bestClean, bc = c.bestClean; // fastest valid lap
    const theo = c.bestSec.every((v) => v != null) ? c.bestSec.reduce((a, v) => a + v, 0) : null;
    const toFind = theo != null && bc ? Math.max(0, bc.t - theo) : null;
    // consistency: spread of your last 20 valid flying laps
    const fly = laps.filter((l) => l.clean && !l.standing).slice(-20).map((l) => l.t);
    const mean = fly.reduce((a, t) => a + t, 0) / (fly.length || 1);
    const sd = fly.length >= 3 ? Math.sqrt(fly.reduce((a, t) => a + (t - mean) ** 2, 0) / (fly.length - 1)) : null;
    const avg = c.flyN ? c.flySum / c.flyN : null;
    const practice = c.sessions - c.races;

    const hero = '<div class="st-hero">' +
      '<div class="st-card"><span class="st-label">Fastest lap</span>' +
      `<b class="st-big purple">${formatTime(b?.t)}</b>` +
      `<small>${b ? `${fmtDate(b.at, true)} · ${sessionName(b)}` : 'No valid laps yet'}</small>` +
      (b?.s ? `<div class="st-alt"><span>Its sectors</span><b class="st-mono">${b.s.map(fmtSec).join('  ·  ')}</b></div>` : '') +
      '</div>' +
      '<div class="st-card"><span class="st-label">Best sectors</span>' +
      `<div class="st-secs">${[0, 1, 2].map((k) => `<div><span>S${k + 1}</span><b>${fmtSec(c.bestSec[k])}</b></div>`).join('')}</div>` +
      `<div class="st-alt"><span>Theoretical best</span><b class="purple">${formatTime(theo)}</b>` +
      `${toFind != null ? `<em>${toFind.toFixed(3)} s quicker than your fastest lap</em>` : ''}</div>` +
      '<small>Your best S1, S2 and S3 put together (sectors within track limits only).</small></div></div>';

    const tiles = `<div class="st-tiles">${[
      tile('Laps', c.laps.toLocaleString(), c.laps ? `${pct(c.cleanLaps, c.laps)} valid` : ''),
      tile('Average lap', avg ? formatTime(avg) : '--', 'flying laps (not lap 1)'),
      tile('Consistency', sd != null ? `±${sd.toFixed(2)}<small> s</small>` : '--', sd != null ? `last ${fly.length} valid laps` : 'needs 3 valid flying laps'),
      tile('Top speed', c.top ? `${c.top}<small> km/h</small>` : '--'),
      tile('Time on track', fmtDuration(c.time)),
      tile('Distance', fmtKm(c.dist)),
      tile('Races', c.races, c.races ? `${plural(c.wins, 'win')} · ${plural(c.podiums, 'podium')}` : `${practice} practice`),
      tile('Best finish', c.bestPos ? `P${c.bestPos}` : '--', c.finished ? `average P${(c.posSum / c.finished).toFixed(1)}` : ''),
    ].join('')}</div>`;

    const shown = Math.min(laps.length, CHART.laps);
    const chart = '<div class="st-panel st-chart-panel"><div class="st-phead">' +
      `<span>Lap times <small>${shown > 1 ? `your last ${shown} laps here, oldest to newest` : ''}</small></span>` +
      '<span class="st-legend"><span><i class="k dot"></i>Valid lap</span><span><i class="k ring"></i>Invalidated</span>' +
      '<span id="st-key-slow" class="hidden"><i class="k tri"></i>Off the scale</span><span><i class="k line"></i>Best so far</span></span>' +
      '</div><div id="st-chart" class="st-chart"></div></div>';

    const top = [...laps].sort((x, y) => x.t - y.t || x.at - y.at).slice(0, 10);
    const topRows = top.map((l, i) => {
      const pb = b && l.t === b.t && l.at === b.at;
      return `<tr><td class="c muted">${i + 1}</td><td class="r t${pb ? ' purple' : ''}">${formatTime(l.t)}</td>` +
        `<td class="r muted">${b ? fmtGap(l.t - b.t) : ''}</td>` +
        `${[0, 1, 2].map((k) => `<td class="r s${l.s && c.bestSec[k] != null && Math.abs(l.s[k] - c.bestSec[k]) < 0.0005 ? ' purple' : ''}">${fmtSec(l.s?.[k])}</td>`).join('')}` +
        `<td>${l.clean ? '<span class="st-clean">Valid</span>' : '<span class="st-off">Invalid</span>'}</td>` +
        `<td class="muted">${fmtDate(l.at)}</td></tr>`;
    }).join('');
    const topTable = '<div class="st-panel"><div class="st-phead"><span>Your fastest laps here</span>' +
      '<button type="button" class="st-link" data-act="laps-here">Every lap here ›</button></div>' +
      (top.length
        ? '<div class="st-scroll"><table class="st-table compact"><thead><tr><th class="c">#</th><th class="r">Time</th><th class="r">Gap</th>' +
          `<th class="r">S1</th><th class="r">S2</th><th class="r">S3</th><th>Limits</th><th>Date</th></tr></thead><tbody>${topRows}</tbody></table></div>`
        : '<p class="st-fine">No completed laps yet.</p>') + '</div>';

    const races = d.races.filter((r) => r.c === def.id).slice(-10).reverse();
    const raceRows = races.map((r) => `<tr><td class="muted">${fmtDate(r.at, true)}</td><td>${sessionName(r)}</td>` +
      `<td>${resultCell(r)}</td><td class="r t">${formatTime(r.best)}</td><td class="c">${r.done}/${r.laps}</td></tr>`).join('');
    const raceTable = '<div class="st-panel"><div class="st-phead"><span>Recent sessions</span></div>' +
      (races.length
        ? '<div class="st-scroll"><table class="st-table compact"><thead><tr><th>Date</th><th>Session</th><th>Result</th>' +
          `<th class="r">Best lap</th><th class="c">Laps</th></tr></thead><tbody>${raceRows}</tbody></table></div>`
        : '<p class="st-fine">No sessions yet.</p>') + '</div>';

    return hero + tiles + chart + `<div class="st-two">${topTable}${raceTable}</div>`;
  }

  // Lap times on this circuit: one mark per lap (oldest left), and a line for your best so far.
  drawChart() {
    const box = $('st-chart');
    if (!box) return;
    const all = this.data.laps.filter((l) => l.c === this.circuit);
    const laps = all.slice(-CHART.laps), skip = all.length - laps.length, n = laps.length;
    if (n < 2) { box.innerHTML = '<p class="st-fine">Drive a couple of laps here to see your lap times over time.</p>'; return; }
    let before = Infinity; // your best from laps older than the ones shown
    for (let i = 0; i < skip; i++) before = Math.min(before, all[i].t);
    const record = this.data.circuits[this.circuit]?.bestClean;

    const W = Math.max(300, Math.floor(box.clientWidth)), H = CHART.height, P = { l: 58, r: 14, t: 12, b: 28 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const lo = Math.min(before, ...laps.map((l) => l.t));
    const hiRaw = Math.max(lo + 0.5, ...laps.map((l) => l.t).filter((t) => t <= lo * CHART.slowCap));
    const step = niceStep((hiRaw - lo) / 4);
    const y0 = Math.floor(lo / step) * step, y1 = Math.max(Math.ceil(hiRaw / step) * step, y0 + step);
    const X = (i) => P.l + (i / (n - 1)) * iw;
    const Y = (t) => P.t + (1 - (Math.min(t, y1) - y0) / (y1 - y0)) * ih;

    let grid = '';
    for (let k = 0, steps = Math.round((y1 - y0) / step); k <= steps; k++) {
      const v = y0 + k * step, y = Y(v).toFixed(1);
      grid += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}"/><text class="ylab" x="${P.l - 8}" y="${y}">${fmtAxis(v, step)}</text>`;
    }
    const ticks = new Set(Array.from({ length: Math.min(6, n) }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, Math.min(6, n) - 1))));
    for (const i of ticks) grid += `<text class="xlab" x="${X(i).toFixed(1)}" y="${H - 8}">${skip + i + 1}</text>`;

    let best = before, path = '';
    laps.forEach((l, i) => {
      const nb = Math.min(best, l.t);
      if (i === 0) path += `M${X(0).toFixed(1)},${Y(best === Infinity ? nb : best).toFixed(1)}`;
      else path += `H${X(i).toFixed(1)}`;
      if (nb < best && best !== Infinity) path += `V${Y(nb).toFixed(1)}`;
      best = nb;
    });

    $('st-key-slow')?.classList.toggle('hidden', !laps.some((l) => l.t > y1)); // legend: only if there are any
    let marks = '';
    laps.forEach((l, i) => {
      const x = X(i).toFixed(1), cls = l.clean ? 'm-fill' : 'm-ring';
      if (l.t > y1) marks += `<path class="${cls}" d="M${x},${P.t} l-5,8 h10 z"/>`;          // off the scale: a triangle on the top edge
      else if (record && l.t === record.t && l.at === record.at) marks += `<circle class="m-best" cx="${x}" cy="${Y(l.t).toFixed(1)}" r="6"/>`;
      else marks += `<circle class="${cls}" cx="${x}" cy="${Y(l.t).toFixed(1)}" r="${l.clean ? 4.5 : 4}"/>`;
    });

    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Your last ${n} lap times at ${esc(this.name(this.circuit))}">` +
      `${grid}<path class="bestline" d="${path}"/>${marks}` +
      `<line class="hair" y1="${P.t}" y2="${H - P.b}" visibility="hidden"/><circle class="focus" r="8" visibility="hidden"/>` +
      `<rect x="${P.l - 8}" y="0" width="${iw + 16}" height="${H}" fill="transparent"/></svg><div class="st-tip hidden"></div>`;

    // hover (or tap): the nearest lap, with a hairline and its details
    const svg = box.querySelector('svg'), hair = svg.querySelector('.hair'), ring = svg.querySelector('.focus'), tip = box.querySelector('.st-tip');
    const show = (e) => {
      const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - P.l) / iw) * (n - 1))));
      const l = laps[i], x = X(i), y = l.t > y1 ? P.t + 5 : Y(l.t);
      hair.setAttribute('x1', x); hair.setAttribute('x2', x); hair.setAttribute('visibility', 'visible');
      ring.setAttribute('cx', x); ring.setAttribute('cy', y); ring.setAttribute('visibility', 'visible');
      const gap = record && !(l.t === record.t && l.at === record.at) ? `<em>${fmtGap(l.t - record.t)}</em>` : '<em class="purple">your best</em>';
      tip.innerHTML = `<b>${formatTime(l.t)}</b>${gap}<span>Lap ${skip + i + 1} here · ${fmtDate(l.at, true)}</span>` +
        `<span>${l.clean ? 'Valid' : 'Invalidated: track limits'} · ${sessionName(l)}${l.standing ? ' · from the grid' : ''}</span>` +
        (l.s ? `<span>${l.s.map(fmtSec).join('  ·  ')}</span>` : '');
      tip.classList.remove('hidden');
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = `${x + 14 + tw > W ? x - 14 - tw : x + 14}px`;
      tip.style.top = `${Math.max(0, Math.min(H - th, y - th / 2))}px`;
    };
    const hide = () => { hair.setAttribute('visibility', 'hidden'); ring.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
  }
}