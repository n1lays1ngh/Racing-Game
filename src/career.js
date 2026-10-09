// Career: one championship at a time, in one class of car (Formula 1, Hypercar or GT3), round by round on its calendar,
// with points and standings. Only career races have pit stops and tyres (race.js `career`; pitstop.js, tyres.js).
// Kept in this browser (localStorage). Main menu → Career.
//
//   const career = new Career({ tracks, onRace(cfg), onClose() })   (main.js)
//   career.open()             the career screen: set up a championship, or the season so far and the next round
//   career.record(race)       a career race just finished (the results screen): points, standings, next round
//   career.state              the championship (null: none)
import { TEAMS } from './race.js';
import { getCar } from './cars/index.js';
import { listReplays } from './replay.js';

const KEY = 'apex-circuit:career';
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');

const REPLAYS = '<section class="cr-panel cr-replays hidden"><h3>Race replays</h3><div id="cr-replays" class="cr-replay-list"></div></section>';
const SPORTS = ['lemans', 'daytona', 'nurburgring', 'bahrain', 'portimao', 'silverstone', 'monza', 'cota', 'interlagos', 'qatar'];
export const CAREER = {
  series: {
    f1: { name: 'Formula 1 World Championship', short: 'F1', cars: ['f1'], calendar: null },  // null: every circuit with a round, in order
    hypercar: { name: 'Hypercar Endurance Championship', short: 'Hypercar', cars: ['hypercar'], calendar: SPORTS },
    gt3: { name: 'GT3 Championship', short: 'GT3', cars: ['gt3', 'porsche'], calendar: SPORTS },
  },
  points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
  lengths: [[0.1, '10%'], [0.25, '25%'], [0.5, '50%'], [1, 'Full']], // share of a Grand Prix's 305 km
  minLaps: 3,
  difficulty: [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['expert', 'Expert']],
  damage: [['low', 'Low'], ['medium', 'Medium'], ['real', 'Real']], // damage.js: Low never puts you out, Real ends your race in a big hit
  firstGrid: 10,   // round 1 you start here; after that from your place in the championship
};

// A circuit's outline for the next-round card, drawn like the minimap (north up: x mirrored, z up)
function outline(def, W = 150, H = 110, pad = 8) {
  const p = def.points; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const k = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (z1 - z0)), ox = (W - (x1 - x0) * k) / 2, oz = (H - (z1 - z0) * k) / 2;
  const pt = ([x, z]) => `${(W - ox - (x - x0) * k).toFixed(1)} ${(oz + (z1 - z) * k).toFixed(1)}`;
  const d = 'M' + p.map(pt).join('L') + 'Z', [sx, sy] = pt(p[0]).split(' ');
  return `<svg class="cr-map" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}"/><circle cx="${sx}" cy="${sy}" r="3.5"/></svg>`;
}
function lapLength(def) {
  let L = 0; const p = def.points;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return L;
}

function load() { try { return JSON.parse(localStorage.getItem(KEY)) ?? null; } catch { return null; } }
function save(s) { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private mode */ } }

export class Career {
  constructor({ tracks, onRace, onClose }) {
    this.tracks = tracks; this.onRace = onRace; this.onClose = onClose;
    this.state = load();
    this.pick = { series: 'f1', car: 'f1', length: 0.25, difficulty: 'medium', damage: 'medium' };
    this.el = $('career');
    $('cr-back').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => this.click(e));
    this.door();
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && !this.el.classList.contains('hidden')) { e.preventDefault(); this.close(); } });
  }

  calendar(series = this.state?.series) {
    const S = CAREER.series[series];
    if (S.calendar) return S.calendar.map((id) => this.tracks.find((t) => t.id === id)).filter(Boolean);
    return this.tracks.filter((t) => t.round).sort((a, b) => a.round - b.round);
  }
  lapsAt(def, length = this.state.length) { // laps for a share of a Grand Prix distance, from the circuit's points
    return Math.max(CAREER.minLaps, Math.round(length * Math.ceil(305000 / lapLength(def))));
  }

  // The start screen's Career button: where the championship is
  door() {
    const s = this.state, el = $('cr-door-sub'); if (!el) return;
    el.textContent = !s ? 'A championship: pit stops, tyres, damage and strategy'
      : s.round >= this.calendar().length ? `${CAREER.series[s.series].short}: season complete` : `${CAREER.series[s.series].short}: round ${s.round + 1} of ${this.calendar().length}`;
  }
  open() { this.el.classList.remove('hidden'); this.render(); $('cr-back').focus({ preventScroll: true }); }
  close() { this.el.classList.add('hidden'); this.onClose?.(); }

  // ---------- the championship ----------
  start({ name, color }) {
    const p = this.pick, S = CAREER.series[p.series];
    this.state = { v: 1, series: p.series, car: S.cars.includes(p.car) ? p.car : S.cars[0], length: p.length, difficulty: p.difficulty, damage: p.damage,
      name: name || 'You', color, round: 0, results: [], points: {}, at: Date.now() };
    save(this.state); this.render(); this.door();
  }
  reset() { this.state = null; save(null); this.render(); this.door(); }

  // The race config for the next round (main.js startGame)
  nextRace() {
    const s = this.state, def = this.calendar()[s.round];
    if (!def) return null;
    const table = this.standings(), me = table.findIndex((r) => r.me);
    return { track: def.id, laps: this.lapsAt(def), difficulty: s.difficulty, aiCount: TEAMS.length - 1, car: s.car, time: null,
      playerName: s.name, playerColor: s.color, career: true, round: s.round, damage: s.damage ?? 'medium',
      playerGrid: s.round === 0 || me < 0 ? CAREER.firstGrid : me + 1 };
  }

  // A career race has finished (main.js, when the results open): points by finishing place, then the next round
  record(race) {
    const s = this.state;
    if (!s || race.round !== s.round) return;
    const rows = race.standings.map((c, k) => {
      const pts = !c.dnf ? CAREER.points[k] ?? 0 : 0, who = c.isPlayer ? '@me' : c.team.name;
      s.points[who] = (s.points[who] ?? 0) + pts;
      return { who, pos: k + 1, pts, dnf: !!c.dnf, best: c.bestLap };
    });
    s.results.push({ track: race.track.id, rows, at: Date.now() });
    s.round++;
    save(s); this.door();
  }

  // The last few career races (replay.js): watch or record them in the cinematic replay
  async drawReplays() {
    const list = await listReplays(), box = $('cr-replays');
    if (!box) return;
    box.closest('.cr-replays').classList.toggle('hidden', !list.length);
    box.innerHTML = list.map(({ id, meta: m }) => {
      const me = m.results?.find((r) => r.isPlayer), when = new Date(m.at ?? 0).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return `<div class="cr-replay"><div><b>${esc(m.trackName ?? m.track)}</b><small>${esc(m.series ?? '')}${m.round != null ? ` · round ${m.round + 1}` : ''} · ${m.laps} laps · ${when}</small></div>` +
        `<span class="cr-res${me && !me.dnf && me.pos <= 3 ? ' podium' : ''}">${me ? (me.dnf ? 'DNF' : `P${me.pos}`) : ''}</span>` +
        `<button type="button" class="pm-btn" data-replay="${esc(id)}"><span>Watch</span></button></div>`;
    }).join('');
  }

  standings() {
    const s = this.state; if (!s) return [];
    const names = [...TEAMS.slice(1).map((t) => t.name), '@me'];
    const wins = (w) => s.results.filter((r) => r.rows[0]?.who === w).length;
    return names.map((w) => ({ who: w, me: w === '@me', name: w === '@me' ? s.name : w, pts: s.points[w] ?? 0, wins: wins(w),
      color: w === '@me' ? s.color : TEAMS.find((t) => t.name === w)?.color ?? 0x888888 }))
      .sort((a, b) => b.pts - a.pts || b.wins - a.wins);
  }

  // ---------- the screen ----------
  click(e) {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.series) { this.pick.series = d.series; this.pick.car = CAREER.series[d.series].cars[0]; this.render(); }
    else if (d.car) { this.pick.car = d.car; this.render(); }
    else if (d.length) { this.pick.length = Number(d.length); this.render(); }
    else if (d.diff) { this.pick.difficulty = d.diff; this.render(); }
    else if (d.dmg) { this.pick.damage = d.dmg; this.render(); }
    else if (d.replay) this.onReplay?.(d.replay); // (main.js: the cinematic replay of that race)
    else if (b.id === 'cr-start') this.start({ name: $('opt-name').value.trim(), color: this.color?.() ?? 0xe10600 });
    else if (b.id === 'cr-race') { const cfg = this.nextRace(); if (cfg) { this.el.classList.add('hidden'); this.onRace(cfg); } }
    else if (b.id === 'cr-reset') {
      if (b.dataset.sure) this.reset(); else { b.dataset.sure = '1'; b.textContent = 'Click again to reset the championship'; }
    }
  }

  render() {
    const s = this.state, body = $('cr-body');
    if (!s) { // set up a championship
      const p = this.pick, S = CAREER.series[p.series];
      $('cr-kicker').textContent = 'Career'; $('cr-title').textContent = 'New championship';
      $('cr-sub').textContent = 'One championship at a time: pit stops, tyres and strategy, round by round';
      const seg = (attr, list, on) => list.map(([v, label]) => `<button type="button" data-${attr}="${v}" class="${String(v) === String(on) ? 'on' : ''}">${label}</button>`).join('');
      const cards = Object.entries(CAREER.series).map(([id, x]) =>
        `<button type="button" class="cr-card${id === p.series ? ' on' : ''}" data-series="${id}"><b>${esc(x.short)}</b><span>${esc(x.name)}</span>` +
        `<small>${this.calendar(id).length} rounds</small></button>`).join('');
      body.innerHTML = `<div class="cr-setup"><div class="cr-cards">${cards}</div>` +
        (S.cars.length > 1 ? `<div class="seg-row"><span>Car</span><div class="lb-seg">${seg('car', S.cars.map((c) => [c, getCar(c).car]), p.car)}</div></div>` : '') +
        `<div class="seg-row"><span>Race length</span><div class="lb-seg">${seg('length', CAREER.lengths, p.length)}</div></div>` +
        `<div class="seg-row"><span>AI skill</span><div class="lb-seg">${seg('diff', CAREER.difficulty, p.difficulty)}</div></div>` +
        `<div class="seg-row"><span>Damage</span><div class="lb-seg">${seg('dmg', CAREER.damage, p.damage)}</div></div>` +
        `<p class="cr-cal">${this.calendar(p.series).map((t, k) => `<span>R${k + 1} ${esc(t.name)}</span>`).join('')}</p>` +
        `<button id="cr-start" class="start" type="button"><span>Start championship</span></button></div>` + REPLAYS;
      this.drawReplays();
      return;
    }
    const S = CAREER.series[s.series], cal = this.calendar(), table = this.standings(), done = s.round >= cal.length;
    $('cr-kicker').textContent = S.name; $('cr-title').textContent = done ? 'Season complete' : `Round ${s.round + 1} of ${cal.length}`;
    $('cr-sub').textContent = `${getCar(s.car).car}, ${CAREER.lengths.find(([v]) => v === s.length)?.[1] ?? ''} race distance, ${s.difficulty} AI, ${s.damage ?? 'medium'} damage`;
    const next = cal[s.round], me = table.findIndex((r) => r.me), lead = table[0]?.pts ?? 0;
    const champ = done ? `<div class="cr-champ"><b>${table[0].me ? 'You are the champion' : `${esc(table[0].name)} is the champion`}</b>` +
      `<span>You finished P${me + 1} with ${table[me].pts} points</span></div>` : '';
    const grid = s.round === 0 || me < 0 ? CAREER.firstGrid : me + 1;
    const nextCard = next ? `<section class="cr-next">${outline(next)}<div class="cr-next-info"><span class="cr-label">Next round</span>` +
      `<b>${esc(next.name)}</b><span class="cr-facts">${esc(next.country)}<i></i>${this.lapsAt(next)} laps<i></i>${(lapLength(next) / 1000).toFixed(2)} km lap<i></i>Grid P${grid}</span></div>` +
      `<button id="cr-race" class="start cr-go" type="button"><span>Race</span></button></section>` : '';
    const rows = table.map((r, k) => `<tr class="${r.me ? 'me' : ''}"><td class="p">${k + 1}</td><td class="who"><i style="background:${hex(r.color)}"></i>${esc(r.name)}</td>` +
      `<td class="c">${r.wins || ''}</td><td class="r gap">${k && lead - r.pts ? `−${lead - r.pts}` : ''}</td><td class="r pts">${r.pts}</td></tr>`).join('');
    const calRows = cal.map((t, k) => {
      const res = s.results[k], win = res?.rows[0], mine = res?.rows.find((x) => x.who === '@me');
      const name = (w) => (w === '@me' ? s.name : w), state = res ? 'done' : k === s.round ? 'next' : 'later';
      const you = mine ? (mine.dnf ? '<span class="cr-res dnf">DNF</span>' : `<span class="cr-res${mine.pos <= 3 ? ' podium' : ''}">P${mine.pos}</span>`) : '';
      return `<tr class="${state}"><td class="p">${k + 1}</td><td>${esc(t.name)}</td>` +
        `<td>${win ? esc(name(win.who)) : state === 'next' ? '<span class="cr-tag">Next</span>' : ''}</td><td class="r">${you}</td></tr>`;
    }).join('');
    body.innerHTML = champ + nextCard +
      `<div class="cr-tables"><section class="cr-panel"><h3>Standings</h3><div class="cr-scroll"><table class="cr-table">` +
      `<thead><tr><th class="p">Pos</th><th>Driver</th><th class="c">Wins</th><th class="r">Gap</th><th class="r">Points</th></tr></thead><tbody>${rows}</tbody></table></div></section>` +
      `<section class="cr-panel"><h3>Calendar</h3><div class="cr-scroll"><table class="cr-table">` +
      `<thead><tr><th class="p">Round</th><th>Circuit</th><th>Winner</th><th class="r">You</th></tr></thead><tbody>${calRows}</tbody></table></div></section></div>` +
      REPLAYS + `<button id="cr-reset" class="st-back cr-reset" type="button">${done ? 'Start a new championship' : 'Reset championship'}</button>`;
    this.drawReplays();
    // each table scrolled so your place and the next round are in view
    for (const row of body.querySelectorAll('tr.me, tr.next')) {
      const box = row.closest('.cr-scroll'); box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2);
    }
  }
}