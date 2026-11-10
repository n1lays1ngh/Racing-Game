// Career: one championship at a time, in one class (Formula, Hypercar, GT3 or MotoGP), round by round on a calendar
// you choose, with qualifying (qualifying.js: each series' own format, every session's length yours to set), points
// and standings. Career races have tyres, pit stops and damage (race.js `career`; pitstop.js, tyres.js, damage.js),
// and you pick the tyres you qualify and start the race on. Kept in this browser (localStorage). Main menu → Career.
//
//   const career = new Career({ tracks, onRace(cfg), onClose() })   (main.js)
//   career.open()              the career screen: set up a championship, or the season so far and the next round
//   career.record(race)        a career race just finished (the results screen): points, standings, next round
//   career.recordSession(race) a qualifying session just ended (main.js): its times, who's through, the grid
//   career.state               the championship (null: none)
import { TEAMS } from './race.js';
import { getCar } from './cars/index.js';
import { listReplays } from './replay.js';
import { TYRES } from './tyres.js';
import { QUALI, formatFor, newWeekend, sessionConfig, recordSession as qualiRecord, gridOf } from './qualifying.js';

const KEY = 'apex-circuit:career';
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const hex = (c) => '#' + (c ?? 0x888888).toString(16).padStart(6, '0');
const fmt = (t) => { if (t == null) return '—'; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(3).padStart(6, '0')}`; };

const SPORTS = ['lemans', 'daytona', 'nurburgring', 'bahrain', 'portimao', 'silverstone', 'monza', 'cota', 'interlagos', 'qatar'];
const BIKES = ['qatar', 'portimao', 'cota', 'silverstone', 'redbullring', 'istanbul', 'nurburgring', 'interlagos'];
export const CAREER = {
  // kind: its qualifying format (qualifying.js); strategy: false = no tyre wear or pit stops (a MotoGP race is flat out)
  series: {
    f1: { name: 'Open-Wheel World Championship', short: 'OW', cars: ['f1'], calendar: null, kind: 'formula' }, // null: every circuit with a round, in order
    hypercar: { name: 'Hypercar Endurance Championship', short: 'Hypercar', cars: ['hypercar'], calendar: SPORTS, kind: 'endurance' },
    gt3: { name: 'GT3 Championship', short: 'GT3', cars: ['gt3', 'porsche', 'mclaren'], calendar: SPORTS, kind: 'gt' },
    motogp: { name: 'MotoGP World Championship', short: 'MotoGP', cars: ['motogp'], calendar: BIKES, kind: 'bike', strategy: false,
      points: [25, 20, 16, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] },
  },
  points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
  lengths: [[0.1, '10%'], [0.25, '25%'], [0.5, '50%'], [1, 'Full']], // share of a Grand Prix's 305 km
  minLaps: 3,
  difficulty: [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['expert', 'Expert']],
  damage: [['low', 'Low'], ['medium', 'Medium'], ['real', 'Real']], // damage.js: Low never puts you out, Real ends your race in a big hit
  firstGrid: 10,   // no qualifying: round 1 you start here; after that from your place in the championship
  tyres: { quali: 'soft', race: 'medium' }, // the sets you pick to start with (changed on the career screen)
};

// A circuit's outline, drawn like the minimap (north up: x mirrored, z up)
function outline(def, W = 150, H = 110, pad = 8, cls = 'cw-map') {
  const p = def.points; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const k = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (z1 - z0)), ox = (W - (x1 - x0) * k) / 2, oz = (H - (z1 - z0) * k) / 2;
  const pt = ([x, z]) => `${(W - ox - (x - x0) * k).toFixed(1)} ${(oz + (z1 - z) * k).toFixed(1)}`;
  const d = 'M' + p.map(pt).join('L') + 'Z', [sx, sy] = pt(p[0]).split(' ');
  return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}"/><circle cx="${sx}" cy="${sy}" r="4"/></svg>`;
}
function lapLength(def) {
  let L = 0; const p = def.points;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return L;
}

function load() { try { return JSON.parse(localStorage.getItem(KEY)) ?? null; } catch { return null; } }
function save(s) { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private mode */ } }
const AI_NAMES = () => TEAMS.slice(1).map((t) => t.name);
// each team's pace for a season (0 = the quickest … 1): a shuffle, so the order changes from one championship to the next
function newRanks() {
  const names = AI_NAMES();
  for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
  return Object.fromEntries(names.map((n, i) => [n, names.length > 1 ? i / (names.length - 1) : 0]));
}
const defaultMinutes = (series) => formatFor(CAREER.series[series].kind).map((s) => s.minutes);

export class Career {
  constructor({ tracks, onRace, onClose }) {
    this.tracks = tracks; this.onRace = onRace; this.onClose = onClose;
    this.state = load();
    if (this.state) this.upgrade();
    this.pick = { series: 'f1', car: 'f1', length: 0.25, difficulty: 'medium', damage: 'medium', quali: true, minutes: defaultMinutes('f1'), calendar: null };
    this.tab = 'standings'; this.tabFor = ''; this.ses = null; // the season screen: the panel showing, and the qualifying session in it
    this.el = $('career');
    $('cr-back').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => this.click(e));
    this.door();
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && !this.el.classList.contains('hidden')) { e.preventDefault(); this.close(); } });
  }
  // a championship saved by an older version: what it didn't have yet
  upgrade() {
    const s = this.state;
    if (!CAREER.series[s.series]) { this.state = null; return; }
    s.ranks ??= newRanks();
    s.quali ??= { on: true, minutes: defaultMinutes(s.series) };
    s.tyres ??= { ...CAREER.tyres };
    s.calendar ??= null;
    s.v = 2;
  }

  // the circuits of a series (its own calendar, or the one you picked)
  seriesCalendar(series) {
    const S = CAREER.series[series];
    if (S.calendar) return S.calendar.map((id) => this.tracks.find((t) => t.id === id)).filter(Boolean);
    return this.tracks.filter((t) => t.round).sort((a, b) => a.round - b.round);
  }
  calendar(series = this.state?.series) {
    const ids = series === this.state?.series ? this.state?.calendar : null, all = this.seriesCalendar(series);
    return ids ? ids.map((id) => all.find((t) => t.id === id) ?? this.tracks.find((t) => t.id === id)).filter(Boolean) : all;
  }
  lapsAt(def, length = this.state.length) { // laps for a share of a Grand Prix distance, from the circuit's points
    return Math.max(CAREER.minLaps, Math.round(length * Math.ceil(305000 / lapLength(def))));
  }
  get series() { return CAREER.series[this.state?.series]; }
  get format() { return formatFor(this.series?.kind); }
  get tyresOn() { return this.series?.strategy !== false; }

  // The start screen's Career button: where the championship is
  door() {
    const s = this.state, el = $('cr-door-sub'); if (!el) return;
    el.textContent = !s ? 'A championship: qualifying, pit stops, tyres, damage and strategy'
      : s.round >= this.calendar().length ? `${CAREER.series[s.series].short}: season complete` : `${CAREER.series[s.series].short}: round ${s.round + 1} of ${this.calendar().length}`;
  }
  open() { this.el.classList.remove('hidden'); this.render(); this.el.scrollTop = 0; $('cr-back').focus({ preventScroll: true }); }
  close() { this.el.classList.add('hidden'); this.onClose?.(); }

  // ---------- the championship ----------
  start({ name, color }) {
    const p = this.pick, S = CAREER.series[p.series];
    const all = this.seriesCalendar(p.series).map((t) => t.id), picked = p.calendar ? all.filter((id) => p.calendar.includes(id)) : null;
    this.state = { v: 2, series: p.series, car: S.cars.includes(p.car) ? p.car : S.cars[0], length: p.length, difficulty: p.difficulty, damage: p.damage,
      name: name || 'You', color, round: 0, results: [], points: {}, at: Date.now(),
      calendar: picked && picked.length && picked.length < all.length ? picked : null,
      quali: { on: !!p.quali, minutes: [...p.minutes] }, ranks: newRanks(), tyres: { ...CAREER.tyres }, weekend: null };
    save(this.state); this.render(); this.door();
  }
  reset() { this.state = null; save(null); this.render(); this.door(); }

  // this round's qualifying (made the first time it's needed)
  weekend() {
    const s = this.state;
    if (!s.quali?.on) return null;
    if (!s.weekend || s.weekend.round !== s.round) s.weekend = newWeekend(s.round, ['@me', ...AI_NAMES()]);
    return s.weekend;
  }
  qualiDone() { const w = this.weekend(); return !w || w.skipped || w.k >= this.format.length; }

  base(def) {
    const s = this.state;
    return { track: def.id, laps: this.lapsAt(def), difficulty: s.difficulty, aiCount: TEAMS.length - 1, car: s.car, time: null,
      playerName: s.name, playerColor: s.color, career: true, round: s.round, damage: s.damage ?? 'medium',
      paceRank: s.ranks, strategy: this.tyresOn ? true : false };
  }
  // The next qualifying session (main.js startGame)
  nextSession() {
    const s = this.state, def = this.calendar()[s.round], w = this.weekend();
    if (!def || !w || this.qualiDone()) return null;
    return { ...this.base(def), session: sessionConfig(w, this.format, s.quali.minutes), tyres: this.tyresOn ? s.tyres.quali : null };
  }
  // The race (main.js startGame): the grid from qualifying (or, skipped: from the championship)
  nextRace() {
    const s = this.state, def = this.calendar()[s.round];
    if (!def) return null;
    const w = s.quali?.on ? this.weekend() : null, cfg = { ...this.base(def), tyres: this.tyresOn ? s.tyres.race : null };
    if (w?.grid) cfg.gridOrder = w.grid;
    else { const table = this.standings(), me = table.findIndex((r) => r.me); cfg.playerGrid = s.round === 0 || me < 0 ? CAREER.firstGrid : me + 1; }
    return cfg;
  }
  gridSlot() { // where you start the race, if it's known yet
    const s = this.state, w = s.quali?.on ? this.weekend() : null;
    if (w?.grid) return w.grid.indexOf('@me') + 1;
    if (w && !w.skipped) return null;
    const table = this.standings(), me = table.findIndex((r) => r.me);
    return s.round === 0 || me < 0 ? CAREER.firstGrid : me + 1;
  }

  // A qualifying session has ended (main.js): times, who's through, and the grid once it's all done
  recordSession(race) {
    const s = this.state, w = this.weekend();
    if (!s || !w || race.round !== s.round || !race.session || race.recorded) return;
    race.recorded = true;
    qualiRecord(w, this.format, race);
    save(s);
  }

  // A career race has finished (main.js, when the results open): points by finishing place, then the next round
  record(race) {
    const s = this.state;
    if (!s || race.round !== s.round || race.session) return;
    const pts = this.series.points ?? CAREER.points;
    const rows = race.standings.map((c, k) => {
      const p = !c.dnf ? pts[k] ?? 0 : 0, who = c.isPlayer ? '@me' : c.team.name;
      s.points[who] = (s.points[who] ?? 0) + p;
      return { who, pos: k + 1, pts: p, dnf: !!c.dnf, best: c.bestLap, grid: c.grid };
    });
    const pole = s.weekend?.round === s.round && s.weekend.grid ? s.weekend.grid[0] : null;
    s.results.push({ track: race.track.id, rows, at: Date.now(), pole });
    s.round++; s.weekend = null;
    save(s); this.door();
  }

  // The last few career races (replay.js): watch or record them in the cinematic replay
  async drawReplays() {
    const list = (await listReplays()).filter((r) => (r.meta.kind ?? 'career') === 'career'), box = $('cr-replays');
    const tab = this.el.querySelector('[data-tab="replays"]'); // (the season screen: its Replays tab, only when there are some)
    if (tab) { tab.classList.toggle('hidden', !list.length); const n = tab.querySelector('small') ?? tab.appendChild(document.createElement('small')); n.textContent = String(list.length); }
    if (!box) return;
    box.closest('.cw-replays')?.classList.toggle('hidden', !list.length);
    if (!list.length) { box.innerHTML = '<p class="cw-fine">No race replays yet.</p>'; return; }
    box.innerHTML = list.map(({ id, meta: m }) => {
      const me = m.results?.find((r) => r.isPlayer), when = new Date(m.at ?? 0).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return `<div class="cw-replay"><div><b>${esc(m.trackName ?? m.track)}</b><small>${esc(m.series ?? '')}${m.round != null ? ` · round ${m.round + 1}` : ''} · ${m.laps} laps · ${when}</small></div>` +
        `<span class="cw-res${me && !me.dnf && me.pos <= 3 ? ' podium' : ''}">${me ? (me.dnf ? 'DNF' : `P${me.pos}`) : ''}</span>` +
        `<button type="button" class="cw-btn ghost small" data-replay="${esc(id)}">Watch</button></div>`;
    }).join('');
  }

  standings() {
    const s = this.state; if (!s) return [];
    const names = [...AI_NAMES(), '@me'];
    const wins = (w) => s.results.filter((r) => r.rows[0]?.who === w).length;
    const podiums = (w) => s.results.filter((r) => r.rows.findIndex((x) => x.who === w) < 3 && r.rows.some((x) => x.who === w)).length;
    return names.map((w) => ({ who: w, me: w === '@me', name: w === '@me' ? s.name : w, pts: s.points[w] ?? 0, wins: wins(w), podiums: podiums(w),
      color: w === '@me' ? s.color : TEAMS.find((t) => t.name === w)?.color ?? 0x888888 }))
      .sort((a, b) => b.pts - a.pts || b.wins - a.wins);
  }
  nameOf(w) { return w === '@me' ? this.state.name : w; }
  colorOf(w) { return w === '@me' ? this.state.color : TEAMS.find((t) => t.name === w)?.color; }

  // ---------- the screen ----------
  click(e) {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset, p = this.pick;
    if (d.series) { p.series = d.series; p.car = CAREER.series[d.series].cars[0]; p.minutes = defaultMinutes(d.series); p.calendar = null; this.render(); }
    else if (d.car) { p.car = d.car; this.render(); }
    else if (d.length) { p.length = Number(d.length); this.render(); }
    else if (d.diff) { p.difficulty = d.diff; this.render(); }
    else if (d.dmg) { p.damage = d.dmg; this.render(); }
    else if (d.quali) { p.quali = d.quali === 'on'; this.render(); }
    else if (d.mins) { const k = Number(d.k), [lo, hi] = QUALI.minutes; p.minutes[k] = Math.min(hi, Math.max(lo, p.minutes[k] + Number(d.mins))); this.render(); }
    else if (d.realLengths != null) { p.minutes = [...(QUALI.real[CAREER.series[p.series].kind] ?? defaultMinutes(p.series))]; this.render(); }
    else if (d.round) { // the calendar: a circuit in or out
      const all = this.seriesCalendar(p.series).map((t) => t.id), on = new Set(p.calendar ?? all);
      if (on.has(d.round)) { if (on.size > 1) on.delete(d.round); } else on.add(d.round);
      p.calendar = all.filter((id) => on.has(id)); this.render();
    } else if (d.cal) { const all = this.seriesCalendar(p.series).map((t) => t.id); p.calendar = d.cal === 'all' ? null : [all[0]]; this.render(); }
    else if (d.tab) { this.tab = d.tab; this.render(); }
    else if (d.ses) { this.ses = Number(d.ses); this.render(); }
    else if (d.tyre) { this.state.tyres[d.for] = d.tyre; save(this.state); this.render(); }
    else if (d.replay) this.onReplay?.(d.replay); // (main.js: the cinematic replay of that race)
    else if (b.id === 'cr-start') this.start({ name: $('opt-name').value.trim(), color: this.color?.() ?? 0xe10600 });
    else if (b.id === 'cr-go') { // the next session, or the race
      const cfg = this.qualiDone() ? this.nextRace() : this.nextSession();
      if (cfg) { save(this.state); this.el.classList.add('hidden'); this.onRace(cfg); }
    } else if (b.id === 'cr-skip') { const w = this.weekend(); if (w) { w.skipped = true; w.grid = null; save(this.state); this.render(); } }
    else if (b.id === 'cr-reset') {
      if (d.sure) this.reset(); else { d.sure = '1'; b.textContent = 'Click again to reset the championship'; }
    }
  }

  seg(attr, list, on, extra = '') {
    return `<div class="cw-seg"${extra}>${list.map(([v, label]) => `<button type="button" data-${attr}="${v}" class="${String(v) === String(on) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
  }

  render() {
    if (!this.state) return this.renderSetup();
    const s = this.state, S = this.series, cal = this.calendar(), table = this.standings(), done = s.round >= cal.length, body = $('cr-body');
    $('cr-kicker').textContent = S.name; $('cr-title').textContent = done ? 'Season complete' : `Round ${s.round + 1} of ${cal.length}`;
    $('cr-sub').textContent = [getCar(s.car).car, `${CAREER.lengths.find(([v]) => v === s.length)?.[1] ?? ''} race distance`, `${s.difficulty} AI`,
      `${s.damage ?? 'medium'} damage`, s.quali?.on ? 'qualifying' : 'no qualifying'].join(' · ');
    const me = table.findIndex((r) => r.me), lead = table[0]?.pts ?? 0;
    const champ = done ? `<section class="cw-champ"><span class="cw-eyebrow">Champion</span><b>${table[0].me ? 'You are the champion' : esc(table[0].name)}</b>` +
      `<span>You finished P${me + 1} with ${table[me].pts} points · ${table[me].wins} win${table[me].wins === 1 ? '' : 's'}</span></section>` : '';
    // Under the next round: one panel at a time (Qualifying, Standings, Calendar, Replays), each shown whole: two
    // columns of ten, nothing to scroll inside. It opens on this weekend's qualifying once there is one.
    const w = s.weekend && s.weekend.round === s.round && s.weekend.sessions.length ? s.weekend : null;
    const tabs = [w ? ['quali', 'Qualifying', w.sessions.at(-1).name] : null, ['standings', 'Standings', me >= 0 ? `P${me + 1} · ${table[me].pts} pts` : ''],
      ['calendar', 'Calendar', `${Math.min(s.round + 1, cal.length)} of ${cal.length}`], ['replays', 'Replays', '']].filter(Boolean);
    if (this.tabFor !== `${s.round}|${w ? w.sessions.length : 0}`) { this.tabFor = `${s.round}|${w ? w.sessions.length : 0}`; this.tab = w ? 'quali' : 'standings'; this.ses = null; }
    if (!tabs.some(([id]) => id === this.tab)) this.tab = 'standings';
    const tab = this.tab;
    const panel = tab === 'quali' ? this.qualiHtml(w)
      : tab === 'calendar' ? `<ol class="cw-cal cw-grid">${this.calendarRows(cal)}</ol>`
      : tab === 'replays' ? '<div id="cr-replays" class="cw-replay-list"></div>'
      : `<ol class="cw-standings cw-two" style="--rows:${Math.ceil(table.length / 2)}">${table.map((r, k) => this.standingRow(r, k, lead)).join('')}</ol>`;
    body.innerHTML = champ + (done ? '' : this.heroHtml(cal[s.round])) +
      `<section class="cw-card cw-board"><nav class="cw-tabs">${tabs.map(([id, name, note]) =>
        `<button type="button" data-tab="${id}" class="${id === tab ? 'on' : ''}${id === 'replays' ? ' hidden' : ''}"><b>${name}</b>${note ? `<small>${esc(note)}</small>` : ''}</button>`).join('')}` +
      `<button id="cr-reset" class="cw-link" type="button">${done ? 'Start a new championship' : 'Reset championship'}</button></nav>` +
      `<div class="cw-panel">${panel}</div></section>`;
    this.drawReplays();
  }

  // the next round: the circuit, the weekend so far, your tyres, and the button for what's next
  heroHtml(def) {
    const s = this.state, w = this.weekend(), F = this.format, slot = this.gridSlot();
    const steps = (s.quali?.on ? F.map((q, k) => {
      const ses = w?.sessions[k], mine = ses?.rows.find((r) => r.who === '@me');
      const state = w?.skipped ? 'skip' : ses ? 'done' : k === w?.k ? 'now' : '';
      const note = w?.skipped ? 'Skipped' : ses ? (mine ? `P${mine.pos}${mine.out ? ' · out' : ''}` : 'Without you') : `${s.quali.minutes[k] ?? q.minutes} min`;
      return `<li class="${state}"><b>${esc(q.name)}</b><small>${note}</small></li>`;
    }) : []).concat(`<li class="${this.qualiDone() ? 'now' : ''}"><b>Race</b><small>${this.lapsAt(def)} laps</small></li>`).join('');
    const quali = !this.qualiDone(), next = quali ? F[w.k] : null;
    const tyre = (forWhat, label) => !this.tyresOn ? '' : `<div class="cw-tyre"><span>${label}</span><div class="cw-tyres">${TYRES.order.map((c) => {
      const C = TYRES.compounds[c];
      return `<button type="button" class="t-${c}${s.tyres[forWhat] === c ? ' on' : ''}" data-tyre="${c}" data-for="${forWhat}" title="${C.name}"><i>${C.letter}</i>${C.name}</button>`;
    }).join('')}</div></div>`;
    const tyres = quali ? tyre('quali', 'Qualifying tyres') + tyre('race', 'Race start tyres') : tyre('race', 'Race start tyres');
    return `<section class="cw-hero"><div class="cw-hero-map">${outline(def, 220, 170, 12)}</div>` +
      `<div class="cw-hero-info"><span class="cw-eyebrow">Round ${s.round + 1} · ${esc(def.country)}</span><h3>${esc(def.name)}</h3>` +
      `<div class="cw-facts"><span><b>${this.lapsAt(def)}</b> laps</span><span><b>${(lapLength(def) / 1000).toFixed(2)}</b> km a lap</span>` +
      `<span>Grid <b>${slot ? `P${slot}` : 'from qualifying'}</b></span></div><ol class="cw-steps">${steps}</ol></div>` +
      `<div class="cw-hero-act">${tyres}<button id="cr-go" class="start cw-go" type="button"><span>${quali ? `Start ${esc(next.name)}` : 'Race'}</span></button>` +
      (quali && w.k === 0 ? '<button id="cr-skip" class="cw-btn ghost" type="button">Skip qualifying</button>' : '') +
      (quali ? `<p class="cw-fine">${esc(next.name)}: ${s.quali.minutes[w.k] ?? next.minutes} minutes. Pause → End session to finish early.</p>` : '') + '</div></section>';
  }

  // this weekend's qualifying: one session at a time (the latest first; Q1 / Q2 / Q3 to look back), the whole
  // classification in two columns, with the line under the last car that went through
  qualiHtml(w) {
    const k = Math.min(this.ses ?? w.sessions.length - 1, w.sessions.length - 1), ses = w.sessions[k], pole = ses.rows[0]?.best;
    const rows = ses.rows.map((r) => `<li class="${r.who === '@me' ? 'me' : ''}${r.out ? ' out' : ''}${ses.cut && r.pos === ses.cut ? ' cut' : ''}">` +
      `<span class="p">${r.pos}</span><i style="background:${hex(this.colorOf(r.who))}"></i><span class="n">${esc(this.nameOf(r.who))}</span>` +
      `<span class="t">${fmt(r.best)}</span><span class="g">${r.pos > 1 && r.best != null && pole != null ? `+${(r.best - pole).toFixed(3)}` : r.pos === 1 && r.best != null ? 'Pole' : ''}</span></li>`).join('');
    const mine = ses.rows.find((r) => r.who === '@me');
    const pick = w.sessions.length > 1 ? `<div class="cw-seg cw-ses">${w.sessions.map((x, i) => `<button type="button" data-ses="${i}" class="${i === k ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>` : '';
    const note = [ses.simulated ? 'Run without you' : mine ? `You: P${mine.pos}${mine.best != null ? ` · ${fmt(mine.best)}` : ''}${mine.out ? ' · knocked out' : ''}` : '',
      ses.cut ? `Top ${ses.cut} went through` : w.grid ? 'This is the grid' : 'Final order'].filter(Boolean).join('  ·  ');
    return `<div class="cw-panel-head">${pick}<span>${esc(note)}</span></div><ol class="cw-times cw-two" style="--rows:${Math.ceil(ses.rows.length / 2)}">${rows}</ol>`;
  }

  standingRow(r, k, lead) {
    const pos = k + 1, medal = pos <= 3 ? ` m${pos}` : '';
    return `<li class="${r.me ? 'me' : ''}${medal}"><span class="p">${pos}</span><i style="background:${hex(r.color)}"></i>` +
      `<span class="n">${esc(r.name)}${r.wins ? `<small>${r.wins} win${r.wins > 1 ? 's' : ''}</small>` : ''}</span>` +
      `<span class="g">${k && lead - r.pts ? `−${lead - r.pts}` : ''}</span><span class="pts">${r.pts}<em style="--f:${lead ? (r.pts / lead).toFixed(3) : 0}"></em></span></li>`;
  }

  calendarRows(cal) {
    const s = this.state;
    return cal.map((t, k) => {
      const res = s.results[k], win = res?.rows[0], mine = res?.rows.find((x) => x.who === '@me');
      const state = res ? 'done' : k === s.round ? 'next' : '';
      const you = mine ? (mine.dnf ? '<span class="cw-res dnf">DNF</span>' : `<span class="cw-res${mine.pos <= 3 ? ' podium' : ''}">P${mine.pos}</span>`) : '';
      return `<li class="${state}"><span class="p">${k + 1}</span><span class="n"><b>${esc(t.name)}</b><small>${esc(t.country)}</small></span>` +
        `<span class="w">${win ? `<i style="background:${hex(this.colorOf(win.who))}"></i>${esc(this.nameOf(win.who))}` : state === 'next' ? '<span class="cw-tag">Next</span>' : ''}</span>${you}</li>`;
    }).join('');
  }

  // ---------- a new championship ----------
  renderSetup() {
    const p = this.pick, S = CAREER.series[p.series], body = $('cr-body'), F = formatFor(S.kind);
    $('cr-kicker').textContent = 'Career'; $('cr-title').textContent = 'New championship';
    $('cr-sub').textContent = 'Qualifying, pit stops, tyres and strategy, round by round';
    const cards = Object.entries(CAREER.series).map(([id, x]) => {
      const car = getCar(x.cars[0]);
      return `<button type="button" class="cw-series${id === p.series ? ' on' : ''}" data-series="${id}"><b>${esc(x.short)}</b><span>${esc(x.name)}</span>` +
        `<small>${esc(car.car)}${x.cars.length > 1 ? ` +${x.cars.length - 1}` : ''} · ${this.seriesCalendar(id).length} circuits · ${formatFor(x.kind).map((q) => q.name).join(', ')}</small></button>`;
    }).join('');
    const row = (label, html, note = '') => `<div class="cw-row"><span class="cw-label">${label}${note ? `<small>${note}</small>` : ''}</span>${html}</div>`;
    const sessions = p.quali ? F.map((q, k) => row(esc(q.name), `<div class="cw-step"><button type="button" data-mins="-1" data-k="${k}" aria-label="Shorter">−</button>` +
      `<b>${p.minutes[k]} min</b><button type="button" data-mins="1" data-k="${k}" aria-label="Longer">+</button></div>`,
      q.out ? `slowest ${q.out} out` : q.keep ? `top ${q.keep} through` : k === F.length - 1 && F.length > 1 ? 'for pole' : '')).join('') : '';
    const all = this.seriesCalendar(p.series), on = new Set(p.calendar ?? all.map((t) => t.id));
    const chips = all.map((t, k) => `<button type="button" class="cw-chip${on.has(t.id) ? ' on' : ''}" data-round="${t.id}"><span>${k + 1}</span>${esc(t.name)}</button>`).join('');
    body.innerHTML = `<div class="cw-setup"><section class="cw-card pad"><header><h3>Series</h3></header><div class="cw-series-row">${cards}</div></section>` +
      '<div class="cw-cols">' +
      `<section class="cw-card pad"><header><h3>Race weekend</h3></header>` +
      (S.cars.length > 1 ? row('Car', this.seg('car', S.cars.map((c) => [c, esc(getCar(c).car) + (getCar(c).dev ? ' <small class="dev-tag">Dev</small>' : '')]), p.car)) : '') +
      row('Race length', this.seg('length', CAREER.lengths, p.length)) +
      row('AI skill', this.seg('diff', CAREER.difficulty, p.difficulty)) +
      row('Damage', this.seg('dmg', CAREER.damage, p.damage)) + '</section>' +
      `<section class="cw-card pad"><header><h3>Qualifying</h3><button type="button" class="cw-link" data-real-lengths>Real lengths</button></header>` +
      row('Qualifying', this.seg('quali', [['on', 'On'], ['off', 'Off']], p.quali ? 'on' : 'off'), p.quali ? '' : 'grid from the standings') + sessions +
      (p.quali ? '<p class="cw-fine">You can end a session early (pause → End session): the others\' laps for the time left are worked out.</p>' : '') + '</section></div>' +
      `<section class="cw-card pad"><header><h3>Calendar</h3><small>${on.size} of ${all.length} rounds</small>` +
      '<span class="cw-links"><button type="button" class="cw-link" data-cal="all">All</button><button type="button" class="cw-link" data-cal="none">Clear</button></span></header>' +
      `<div class="cw-chips">${chips}</div><p class="cw-fine">Tap a circuit to take it in or out of the season. Rounds run in this order.</p></section>` +
      `<div class="cw-foot"><button id="cr-start" class="start cw-go" type="button"><span>Start championship</span></button></div></div>` +
      '<section class="cw-card cw-replays hidden"><header><h3>Race replays</h3></header><div id="cr-replays" class="cw-replay-list"></div></section>';
    this.drawReplays();
  }
}