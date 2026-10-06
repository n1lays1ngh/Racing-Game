// In-race HUD (HTML overlay, index.html #hud), laid out like a TV broadcast and a race car's dash:
//   top left     timing tower: every car with the interval to the car ahead, or the gap to the leader (T switches)
//   top right    lap timing: the running lap, the live delta to your best lap, sectors, best and last lap, the cars
//                just ahead of and behind you on the road (to the thousandth), then the circuit map
//   bottom right the dash: shift lights, a rev counter drawn for your car's gearbox (src/cars/), gear, speed, revs,
//                pedals, the ERS / hybrid battery, the driver aids and headlights lights, the tow
// Sector and lap colours: purple = fastest of anyone, green = your personal best, yellow = slower.
// Gaps and intervals come from race.js (timing points every few metres, so they're exact and don't jump about).
import { formatTime, newTrace, tracePass, traceTime, GAP_STEP } from './race.js';
import { gearbox } from './physics.js';
import { wasPressed } from './input.js';
import { PITLANE } from './pitlane.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const MAP_SIZE = 200;      // minimap size in CSS pixels
const REV_LEDS = 15;       // shift lights: 5 green, 5 red, 5 blue
const TOWER_EVERY = 12;    // frames between timing tower updates (a gap that changes every frame can't be read)
const LAP_POPUP = 4;       // s: your lap time stays up this long after the line
const HINT_FOR = 12;       // s: the key hints at the bottom, from the start of a race

// ---- the rev counter (an SVG arc of segments) ----
const TC = { cx: 125, cy: 110, r: 98, sweep: 125, segs: 44 }; // centre, radius, ± degrees from straight up, segments
const polar = (r, deg) => { const a = (deg * Math.PI) / 180; return [TC.cx + r * Math.sin(a), TC.cy - r * Math.cos(a)]; };
const arcPath = (r, d0, d1) => {
  const [x0, y0] = polar(r, d0), [x1, y1] = polar(r, d1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${d1 - d0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); // 11 850

// ---- gaps as the timing tower writes them ----
const fmtGap = (v) => (v < 60 ? `+${v.toFixed(3)}` : `+${Math.floor(v / 60)}:${(v % 60).toFixed(3).padStart(6, '0')}`);
const fmtLaps = (n) => `+${n} ${n === 1 ? 'lap' : 'laps'}`;
const fmtDelta = (d) => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(3)}`;
const code = (c) => (c.isHuman ? c.team.name.slice(0, 8) : c.team.name.slice(0, 3)).toUpperCase(); // people: their name

export class HUD {
  constructor(track) {
    this.el = {
      hud: $('hud'), tower: $('tower'), speed: $('speed'), gear: $('gear'), rpm: $('rpm'), thr: $('thr'), brk: $('brk'),
      revlights: $('revlights'), tacho: $('tacho'),
      lap: $('lap'), lapTotal: $('lap-total'), pos: $('pos'), posTotal: $('pos-total'),
      label: $('t-label'), cur: $('t-cur'), last: $('t-last'), best: $('t-best'), delta: $('t-delta'),
      sectors: [1, 2, 3].map((k) => $('sec' + k)),
      battle: $('battle'), ahead: $('bt-ahead'), behind: $('bt-behind'),
      standings: $('standings'), mode: $('tower-mode'), mapName: $('map-name'),
      toast: $('toast'), lights: $('lights'), wrong: $('wrongway'), cam: $('cam-name'), camChip: $('cam-chip'), hint: $('cam-hint'),
      limits: $('limits'), limitsWhy: $('limits-why'), invalid: $('t-invalid'), // track limits (race.js)
      ers: $('ers'), ersLabel: $('ers-label'), ersFill: $('ers-fill'), ersPct: $('ers-pct'), ersMode: $('ers-mode'),
      abs: $('aid-abs'), tc: $('aid-tc'), lightsLamp: $('aid-lights'), tow: $('tow'), towFill: $('tow-fill'),
      remind: $('ers-remind'), limiter: $('pit-limiter'),
    };
    this.el.revlights.innerHTML = Array.from({ length: REV_LEDS }, (_, k) => `<span class="${k < 5 ? 'g' : k < 10 ? 'r' : 'b'}"></span>`).join('');
    this.leds = [...this.el.revlights.children];
    this.lamps = [...this.el.lights.querySelectorAll('.lamp')];
    this.el.limiter.textContent = `Pit limiter ${PITLANE.limit} km/h`;
    this.toastTimer = 0; this.limitsTimer = 0; this.camTimer = 0; this.hintTimer = 0;
    this.frame = 0;
    this.showLeaderGap = false; // T toggles interval ↔ gap to leader
    this.spec = undefined;
    this.setupMinimap(track);
  }

  // ---------- your car: the rev counter for its gearbox, which lights and bars it has ----------
  setupCar(spec) {
    this.spec = spec;
    const box = spec?.gearbox, p = spec?.physics ?? {}, ers = spec ? spec.ers : {};
    // rev counter: from the idle revs to the top of the range, in thousands; the shift zone in red
    const lo = Math.floor((box?.neutral ?? 4000) / 1000) * 1000, hi = Math.ceil((box?.rpm?.[1] ?? 13000) / 1000) * 1000;
    const flash = box?.flash ?? hi, deg = (rpm) => -TC.sweep + ((rpm - lo) / (hi - lo)) * TC.sweep * 2;
    const step = (TC.sweep * 2) / TC.segs, segs = [];
    for (let k = 0; k < TC.segs; k++) {
      const d0 = -TC.sweep + k * step, d1 = d0 + step - 1.5, mid = lo + ((k + 0.5) / TC.segs) * (hi - lo);
      segs.push(`<path class="tc-seg${mid >= flash ? ' red' : ''}" d="${arcPath(TC.r, d0, d1)}"/>`);
    }
    const marks = [];
    for (let r = lo; r <= hi; r += 1000) {
      const d = deg(r), [x0, y0] = polar(82, d), [x1, y1] = polar(89, d), [tx, ty] = polar(72, d);
      marks.push(`<line class="tc-tick" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`,
        `<text class="tc-num${r >= flash ? ' red' : ''}" x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}">${r / 1000}</text>`);
    }
    this.el.tacho.innerHTML = `<path class="tc-track" d="${arcPath(TC.r, -TC.sweep, TC.sweep)}"/>` +
      `<path class="tc-red" d="${arcPath(86, deg(flash), TC.sweep)}"/>` + segs.join('') + marks.join('');
    this.segs = [...this.el.tacho.querySelectorAll('.tc-seg')];
    this.tc = { lo, hi, flash, r0: box?.rpm?.[0] ?? 6000, r1: box?.rpm?.[1] ?? 13000, lit: -1, rpm: box?.neutral ?? lo, shown: '' };
    this.litLeds = -1; this.flash = null;
    // ERS / hybrid battery (none in the GT3), driver aids, headlights
    const E = this.el;
    E.ers.style.display = ers ? '' : 'none';
    E.ersLabel.textContent = ers?.auto ? 'Hybrid' : 'ERS';
    this.ersAuto = !!ers?.auto; this.ersShown = null; this.ersModeShown = null;
    E.abs.style.display = p.abs ? '' : 'none';
    E.tc.style.display = p.tc ? '' : 'none';
    E.lightsLamp.style.display = spec?.headlights ? '' : 'none';
  }

  // ---------- minimap ----------
  setupMinimap(track) {
    const c = $('minimap'); this.map = c; this.mapCtx = c.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = c.height = MAP_SIZE * dpr; c.style.width = c.style.height = MAP_SIZE + 'px';
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < track.n; i++) {
      minX = Math.min(minX, track.cx[i]); maxX = Math.max(maxX, track.cx[i]);
      minZ = Math.min(minZ, track.cz[i]); maxZ = Math.max(maxZ, track.cz[i]);
    }
    const pad = 16 * dpr, span = Math.max(maxX - minX, maxZ - minZ);
    const scale = (c.width - pad * 2) / span;
    const ox = pad + ((span - (maxX - minX)) * scale) / 2, oz = pad + ((span - (maxZ - minZ)) * scale) / 2;
    // Mirror X so north is up (x points west in the game).
    this.toMap = (x, z) => [c.width - (ox + (x - minX) * scale), oz + (maxZ - z) * scale];
    // Pre-render the circuit once: the road, the pit lane, the sector lines and the start / finish
    const bg = document.createElement('canvas'); bg.width = bg.height = c.width;
    const g = bg.getContext('2d');
    g.lineJoin = g.lineCap = 'round';
    const path = (from, to) => {
      g.beginPath();
      for (let i = from; i <= to; i += 2) {
        const [px, py] = this.toMap(track.cx[i % track.n], track.cz[i % track.n]);
        i === from ? g.moveTo(px, py) : g.lineTo(px, py);
      }
    };
    path(0, track.n); g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 9 * dpr; g.stroke();
    const lane = track.pitLane;   // the pit lane (pitlane.js), a thin line beside the track
    if (lane) {
      g.beginPath();
      for (let k = 0; k <= lane.steps; k += 2) {
        const i = (lane.i0 + k) % track.n, lat = lane.side * (lane.inner[i] + lane.out[i]) / 2;
        const [px, py] = this.toMap(track.cx[i] + track.nx[i] * lat, track.cz[i] + track.nz[i] * lat);
        k === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.strokeStyle = 'rgba(200,208,218,0.55)'; g.lineWidth = 1.4 * dpr; g.stroke();
    }
    path(0, track.n); g.strokeStyle = '#e9ecef'; g.lineWidth = 3.2 * dpr; g.stroke();
    const third = Math.floor(track.n / 3);
    for (const [i, col, w] of [[third, 'rgba(255,255,255,0.55)', 2], [third * 2, 'rgba(255,255,255,0.55)', 2], [0, '#e10600', 3.5]]) {
      const [px, py] = this.toMap(track.cx[i], track.cz[i]);
      const nx = -track.nx[i], nz = -track.nz[i];         // normal in map space (x mirrored, z up)
      g.strokeStyle = col; g.lineWidth = w * dpr; g.beginPath();
      g.moveTo(px - nx * 6 * dpr, py - nz * 6 * dpr); g.lineTo(px + nx * 6 * dpr, py + nz * 6 * dpr); g.stroke();
    }
    this.mapBg = bg; this.dpr = dpr;
    this.el.mapName.textContent = track.name;
    this.resetTiming();
  }

  drawMinimap(race) {
    const g = this.mapCtx, dpr = this.dpr;
    g.clearRect(0, 0, this.map.width, this.map.height);
    g.drawImage(this.mapBg, 0, 0);
    const rank = (c) => (c.isPlayer ? 2 : c.isHuman ? 1 : 0);
    const cars = race.cars.filter((c) => !c.dnf).sort((a, b) => rank(a) - rank(b)); // you on top, then friends
    for (const car of cars) {
      const [x, y] = this.toMap(car.state.x, car.state.z);
      if (car.isHuman && !car.isPlayer) { // a friend online: bigger dot with a white ring and their name
        g.beginPath(); g.arc(x, y, 6 * dpr, 0, Math.PI * 2); g.fillStyle = hex(car.team.color); g.fill();
        g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.stroke();
        g.font = `900 ${9.5 * dpr}px 'Titillium Web', sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.lineWidth = 3 * dpr; g.strokeStyle = 'rgba(0,0,0,0.85)';
        const tag = car.team.name.slice(0, 3).toUpperCase();
        g.strokeText(tag, x + 9 * dpr, y); g.fillStyle = '#fff'; g.fillText(tag, x + 9 * dpr, y);
      } else if (car.isPlayer) { // your marker, with your position in it
        g.beginPath(); g.arc(x, y, 10 * dpr, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.16)'; g.fill();
        g.beginPath(); g.arc(x, y, 7.5 * dpr, 0, Math.PI * 2); g.fillStyle = '#e10600'; g.fill();
        g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.stroke();
        g.fillStyle = '#fff'; g.font = `900 ${9.5 * dpr}px 'Titillium Web', sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(car.position), x, y + 0.5 * dpr);
      } else {
        g.beginPath(); g.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
        g.fillStyle = hex(car.team.color); g.fill();
        g.lineWidth = 1.5 * dpr; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.stroke();
      }
    }
  }

  // ---------- sectors, the live delta, your lap times ----------
  resetTiming() {
    this.sec = new Map();            // per car: { laps, idx, start, pb: [s1,s2,s3] }
    this.bestSec = [Infinity, Infinity, Infinity];
    this.shown = [null, null, null]; // player's sectors on screen: { t, cls }
    this.holdPrev = 0;               // keep last lap's sectors up for a moment after the line
    this.lapTrace = null; this.ref = null; this.playerLaps = null; // live delta (timing points, like race.js)
    this.bestBefore = null; this.pop = null; // your lap time popup after the line
    this.grid = null; this.trend = new Map();
    this.deltaShown = ''; this.curShown = '';
  }

  sectorColour(car, k, t) {
    const rec = this.sec.get(car);
    let cls = 'yellow';
    if (t < this.bestSec[k]) { this.bestSec[k] = t; cls = 'purple'; }
    else if (t < rec.pb[k]) cls = 'green';
    if (t < rec.pb[k]) rec.pb[k] = t;
    return cls;
  }

  updateSectors(race, dt) {
    const L = race.track.length;
    for (const car of race.cars) {
      let rec = this.sec.get(car);
      if (!rec) { rec = { laps: car.lapsDone, idx: 0, start: car.lapStart, pb: [Infinity, Infinity, Infinity] }; this.sec.set(car, rec); }
      if (car.finishTime != null && rec.laps >= race.laps) continue;
      if (car.lapsDone > rec.laps) {                       // crossed the line
        if (rec.laps >= 0 && rec.idx === 2) {
          const t = car.lapStart - rec.start, cls = car.lastOffSec?.[2] ? 'invalid' : this.sectorColour(car, 2, t); // off track: no best
          if (car.isPlayer) { this.shown[2] = { t, cls }; this.holdPrev = LAP_POPUP; }
        }
        rec.laps = car.lapsDone; rec.idx = 0; rec.start = car.lapStart;
        continue;
      }
      rec.laps = car.lapsDone;
      if (car.lapsDone < 0) continue;                        // still behind the line at the start
      const idx = car.state.s >= (2 * L) / 3 ? 2 : car.state.s >= L / 3 ? 1 : 0;
      if (idx === rec.idx + 1) {
        const t = race.time - rec.start, cls = car.offSec?.[rec.idx] ? 'invalid' : this.sectorColour(car, rec.idx, t);
        if (car.isPlayer) {
          if (rec.idx === 0) this.shown = [null, null, null];
          this.shown[rec.idx] = { t, cls };
        }
        rec.idx = idx; rec.start = race.time;
      }
    }
    if (this.holdPrev > 0) { this.holdPrev -= dt; if (this.holdPrev <= 0) this.shown = [null, null, null]; }
    this.el.sectors.forEach((el, k) => {
      const v = this.shown[k], cls = 'sec ' + (v ? v.cls : ''), txt = v ? v.t.toFixed(3) : `S${k + 1}`;
      if (el.className !== cls) el.className = cls;
      if (el.lastChild.textContent !== txt) el.lastChild.textContent = txt;
    });
  }

  // Live delta: this lap against your best lap of the race, at the same point of the lap (to the thousandth)
  updateDelta(race, p) {
    const L = race.track.length;
    if (this.playerLaps == null) this.playerLaps = p.lapsDone;
    if (p.lapsDone !== this.playerLaps) {
      const done = this.lapTrace;                            // a lap just finished: your new best? then it's the one to beat
      if (p.lapsDone > this.playerLaps && this.playerLaps >= 0 && p.lastLap != null && p.lastLap === p.bestLap && done && done.k * GAP_STEP > L * 0.8) this.ref = done;
      this.lapTrace = null; this.playerLaps = p.lapsDone;
    }
    if (p.lapsDone < 0 || p.finishTime != null) return null;
    const elapsed = race.time - p.lapStart;
    this.lapTrace ??= newTrace(Math.ceil(L / GAP_STEP) + 8, false);
    tracePass(this.lapTrace, p.state.s, elapsed);
    const r = this.ref ? traceTime(this.ref, p.state.s) : null;
    return r == null ? null : elapsed - r;
  }

  // The big lap timer, its label, the delta, best and last lap
  updateLapTimes(race, p, dt) {
    const E = this.el, running = race.state === 'racing' && p.finishTime == null;
    const lap = Math.min(Math.max(p.lapsDone + 1, 1), race.laps);
    // crossed the line on a timed lap: put the lap time up for a few seconds, coloured, with the change on your best
    if (p.lastLap != null && p.lastLapAt !== this.popFor && p.lapsDone >= 1) {
      this.popFor = p.lastLapAt;
      const valid = !p.lastLapInvalid, prev = this.bestBefore;
      const cls = !valid ? 'invalid' : race.bestLapOverall?.time === p.lastLap ? 'purple' : p.bestLap === p.lastLap ? 'green' : 'yellow';
      this.pop = { t: p.lastLap, cls, diff: valid && prev != null ? p.lastLap - prev : null, left: LAP_POPUP, lap: p.lapsDone };
    }
    this.bestBefore = p.bestLap;
    const delta = this.updateDelta(race, p);
    if (this.pop) { this.pop.left -= dt; if (this.pop.left <= 0) this.pop = null; }

    let label, cur, curCls = '', dTxt = '–', dCls = '';
    if (this.pop) {
      label = `Lap ${this.pop.lap}`; cur = formatTime(this.pop.t); curCls = 'pop ' + this.pop.cls;
      if (this.pop.diff != null) { dTxt = fmtDelta(this.pop.diff); dCls = this.pop.diff < 0 ? 'faster' : 'slower'; }
      else if (this.pop.cls === 'invalid') { dTxt = 'Deleted'; dCls = 'slower'; }
    } else if (p.finishTime != null) {
      label = 'Race time'; cur = formatTime(p.finishTime); curCls = 'done';
    } else {
      label = race.state === 'countdown' ? 'Lap 1' : `Lap ${lap}`;
      cur = formatTime(running ? race.time - p.lapStart : 0);
      if (delta != null && (this.frame & 3) === 0) { this.deltaTxt = fmtDelta(delta); this.deltaCls = delta > 0.0005 ? 'slower' : 'faster'; }
      if (delta != null) { dTxt = this.deltaTxt ?? fmtDelta(delta); dCls = this.deltaCls ?? ''; } else this.deltaTxt = null;
    }
    if (E.label.textContent !== label) E.label.textContent = label;
    if (cur !== this.curShown) { this.curShown = cur; E.cur.textContent = cur; }
    // track limits: the running lap and the last lap are struck through while they're invalid; before that (cars
    // allowed more than one) the warnings so far: "Limits 2/5"
    const invalid = running && !this.pop && !!p.lapInvalid, allowed = p.state.spec?.trackLimits?.strikes ?? 1;
    const warned = running && !this.pop && !invalid && allowed > 1 && p.strikes > 0;
    const cls = ['tm-cur', curCls, invalid ? 'invalid' : ''].join(' ').trim();
    if (E.cur.className !== cls) E.cur.className = cls;
    const tag = invalid ? 'Invalid' : warned ? `Limits ${p.strikes}/${allowed}` : '';
    if (tag && E.invalid.textContent !== tag) E.invalid.textContent = tag;
    E.invalid.classList.toggle('hidden', !tag);
    E.invalid.classList.toggle('warn', warned);
    const dc = 'tm-delta ' + dCls;
    if (dTxt !== this.deltaShown) { this.deltaShown = dTxt; E.delta.textContent = dTxt; }
    if (E.delta.className !== dc) E.delta.className = dc;

    const best = formatTime(p.bestLap), last = formatTime(p.lastLap);
    if (E.best.textContent !== best) E.best.textContent = best;
    if (E.last.textContent !== last) E.last.textContent = last;
    E.best.classList.toggle('purple', p.bestLap != null && race.bestLapOverall?.time === p.bestLap);
    E.last.classList.toggle('invalid', p.lastLap != null && !!p.lastLapInvalid);
  }

  // ---------- timing tower ----------
  gapText(race, st, i) {
    const c = st[i], L = race.track.length;
    if (c.dnf) return 'DNF';
    if (race.state === 'countdown') return '';
    if (i === 0) return this.showLeaderGap ? 'Leader' : 'Interval';
    if (this.showLeaderGap) return c.lapsDown > 0 ? fmtLaps(c.lapsDown) : c.gapKnown ? fmtGap(c.gap) : '';
    const ahead = st[i - 1], down = c.finishTime == null && ahead.finishTime == null ? Math.floor((ahead.progress - c.progress) / L) : 0;
    return down > 0 ? fmtLaps(down) : c.interval != null ? fmtGap(c.interval) : '';
  }

  updateTower(race) {
    this.el.mode.textContent = this.showLeaderGap ? 'Gap to leader' : 'Interval';
    if (race.state === 'countdown' || !this.grid) this.grid = new Map(race.cars.map((c) => [c, c.position]));
    const fl = race.bestLapOverall?.name;
    const st = race.standings;
    this.el.standings.classList.toggle('compact', st.length > 12); // big fields: slimmer rows
    this.el.standings.innerHTML = st.map((c, i) => {
      const moved = (this.grid.get(c) ?? c.position) - c.position;
      const chg = moved > 0 ? `<span class="chg up">${moved}</span>` : moved < 0 ? `<span class="chg down">${-moved}</span>` : '<span class="chg"></span>';
      const flag = c.finishTime != null ? '<span class="chq"></span>' : '';
      const fastest = fl === c.team.name ? '<span class="fl" title="Fastest lap"></span>' : '';
      const cls = [c.isPlayer ? 'me' : c.isHuman ? 'human' : '', i === 0 ? 'leader' : '', c.dnf ? 'dnf' : ''].join(' ');
      return `<li class="${cls}"><span class="p">${c.position}</span>` +
        `<span class="bar" style="background:${hex(c.team.color)}"></span><span class="n">${code(c)}${fastest}</span>` +
        `${chg}<span class="g">${flag}${this.gapText(race, st, i)}</span></li>`;
    }).join('');
  }

  // The cars either side of you on the road, and whether the gap is coming down (green) or going up (red) for you
  updateBattle(race) {
    const p = race.player, st = race.standings, i = st.indexOf(p), L = race.track.length;
    const show = race.cars.length > 1 && race.state !== 'countdown';
    this.el.battle.classList.toggle('hidden', !show);
    if (!show) return;
    const row = (el, car, gap, laps, good) => {
      el.classList.toggle('hidden', !car);
      if (!car) return;
      el.querySelector('i').style.background = hex(car.team.color);
      el.querySelector('.bt-name').textContent = `P${car.position} ${code(car)}`;
      el.querySelector('.bt-gap').textContent = car.dnf ? 'DNF' : laps > 0 ? fmtLaps(laps) : gap != null ? gap.toFixed(3) : '–';
      const key = el.id, was = this.trend.get(key), now = performance.now() / 1000;
      let cls = '';
      if (gap != null && laps === 0) {
        if (!was || was.car !== car) this.trend.set(key, { car, gap, at: now, cls: '' });
        else if (now - was.at > 1.5) { // compare with 1.5 s ago
          const d = gap - was.gap;
          was.cls = Math.abs(d) < 0.02 ? '' : (d < 0) === good ? 'good' : 'bad';
          was.gap = gap; was.at = now;
        }
        cls = this.trend.get(key).cls;
      }
      el.className = `bt-row ${cls}`;
    };
    const ahead = i > 0 ? st[i - 1] : null, behind = i >= 0 && i < st.length - 1 ? st[i + 1] : null;
    const lapsAhead = ahead && p.finishTime == null && ahead.finishTime == null ? Math.floor((ahead.progress - p.progress) / L) : 0;
    const lapsBehind = behind && p.finishTime == null && behind.finishTime == null ? Math.floor((p.progress - behind.progress) / L) : 0;
    row(this.el.ahead, ahead, p.interval, lapsAhead, true);           // the car ahead: closing in is good
    row(this.el.behind, behind && !behind.dnf ? behind : null, behind?.interval, lapsBehind, false); // the car behind: pulling away is good
  }

  // ---------- the dash ----------
  updateDash(race, s, dt) {
    if (this.spec !== s.spec) this.setupCar(s.spec);
    const E = this.el, tc = this.tc;
    const kmh = String(Math.round(Math.abs(s.vf) * 3.6));
    if (E.speed.textContent !== kmh) E.speed.textContent = kmh;
    const gb = gearbox(Math.abs(s.vf), s.spec?.gearbox);
    const gear = s.vf < -0.5 ? 'R' : gb.gear;
    if (E.gear.textContent !== gear) E.gear.textContent = gear;
    // revs (on the grid you can rev it, as you hear in audio.js); the needle follows fast but not instantly
    const target = race.state === 'countdown' ? tc.r0 + (s.throttle ?? 0) * ((tc.r1 - tc.r0) * 6 / 7) : gb.rpm;
    tc.rpm += (target - tc.rpm) * Math.min(1, dt * 16);
    const f = Math.min(1, Math.max(0, (tc.rpm - tc.lo) / (tc.hi - tc.lo))), lit = Math.round(f * TC.segs);
    if (lit !== tc.lit) { tc.lit = lit; this.segs.forEach((seg, k) => seg.classList.toggle('on', k < lit)); }
    const rpmTxt = groupDigits(Math.round(tc.rpm / 50) * 50);
    if (rpmTxt !== tc.shown) { tc.shown = rpmTxt; E.rpm.textContent = rpmTxt; }
    // shift lights: fill up through the gear, flash at the top
    const leds = Math.round(Math.min(1, Math.max(0, (tc.rpm - tc.r0) / (tc.r1 - tc.r0))) * REV_LEDS);
    const flash = tc.rpm > tc.flash && (this.frame >> 2) % 2 === 1;
    if (leds !== this.litLeds || flash !== this.flash) {
      this.leds.forEach((l, k) => l.classList.toggle('on', k < leds && !flash));
      this.litLeds = leds; this.flash = flash;
    }
    E.thr.style.transform = `scaleY(${(s.throttle ?? 0).toFixed(2)})`;
    E.brk.style.transform = `scaleY(${(s.brake ?? 0).toFixed(2)})`;
    // driver aids working (amber), headlights on (green)
    E.abs.classList.toggle('on', !!s.absActive);
    E.tc.classList.toggle('on', !!s.tcActive);
    E.lightsLamp.classList.toggle('on', !!s.lightsOn);
    this.updateErs(race, s, dt);
    this.updateTow(s, dt);
  }

  // ERS / hybrid battery (ers.js): green when charged, blue while braking charges it, gold while it deploys.
  // A full battery while you're racing (and the car has a boost button): after a second, a reminder to use it.
  updateErs(race, s, dt) {
    const E = this.el;
    if (!s.spec?.ers) { E.remind.classList.remove('show'); return; }
    const charge = s.ers ?? 1, pct = Math.round(charge * 100), full = charge >= 0.995;
    const mode = s.ersMode === 'deploy' || s.ersMode === 'harvest' ? s.ersMode : full ? 'full' : '';
    if (pct !== this.ersShown) { this.ersShown = pct; E.ersFill.style.transform = `scaleX(${charge.toFixed(3)})`; E.ersPct.textContent = pct + '%'; }
    if (mode !== this.ersModeShown) {
      this.ersModeShown = mode;
      E.ers.dataset.mode = mode;
      E.ersMode.textContent = { deploy: 'Deploy', harvest: 'Harvest', full: 'Full', '': '' }[mode];
    }
    const racing = race.state === 'racing' && race.player.finishTime == null;
    this.fullFor = full && racing && !this.ersAuto && !s.pitLimiter && s.speed > 15 ? (this.fullFor ?? 0) + dt : 0;
    E.remind.classList.toggle('show', this.fullFor > 1 && (this.frame >> 4) % 3 !== 2);
  }

  // Slipstream (slipstream.js): how strong the tow from the car ahead is; dim when you're not in anyone's wake
  updateTow(s, dt) {
    this.towShown = (this.towShown ?? 0) + ((s.tow ?? 0) - (this.towShown ?? 0)) * Math.min(1, dt * 8); // smooth, so it doesn't flicker
    this.el.tow.classList.toggle('on', this.towShown > 0.03);
    this.el.towFill.style.transform = `scaleX(${this.towShown.toFixed(3)})`;
  }

  // ---------- every frame ----------
  update(race, dt) {
    const p = race.player, s = p.state, E = this.el;
    // Practice (no AI): no timing tower, the lap timing on the right says it all
    const practice = race.cars.length === 1;
    if (practice !== this.practice) { this.practice = practice; E.tower.classList.toggle('hidden', practice); }
    const lap = Math.min(Math.max(p.lapsDone + 1, 1), race.laps);
    E.lap.textContent = lap; E.lapTotal.textContent = '/' + race.laps;
    E.pos.textContent = p.position; E.posTotal.textContent = '/' + race.cars.length;

    this.updateLapTimes(race, p, dt);
    this.updateSectors(race, dt);
    if (wasPressed('KeyT')) { this.showLeaderGap = !this.showLeaderGap; this.towerAt = -1; }
    if (race.standings && (this.towerAt == null || this.frame - this.towerAt >= TOWER_EVERY || this.towerAt < 0)) {
      this.towerAt = this.frame;
      this.updateTower(race); // DOM writes are the slow part
      this.updateBattle(race);
    }
    if (this.limitsTimer > 0) { this.limitsTimer -= dt; if (this.limitsTimer <= 0) E.limits.classList.remove('show'); }
    this.updateDash(race, s, dt);

    // Start lights
    const showLights = race.state === 'countdown' || (race.time < 1.2 && race.state === 'racing');
    E.lights.classList.toggle('show', showLights);
    this.lamps.forEach((l, i) => l.classList.toggle('on', race.state === 'countdown' && i < race.lightsOn));

    // Wrong way: facing against the track direction while moving
    const t = race.track, i = Math.max(0, s.trackIndex);
    const facing = Math.sin(s.h) * t.tx[i] + Math.cos(s.h) * t.tz[i];
    E.wrong.classList.toggle('show', race.state === 'racing' && facing < -0.3 && s.speed > 4);
    // Pit lane speed limiter (pitlane.js): a flashing flag while it's holding you
    E.limiter.classList.toggle('show', !!s.pitLimiter && (this.frame >> 4) % 4 !== 3);

    // key hints for the first seconds, the camera's name for a moment after you change it
    this.hintTimer -= dt; this.camTimer -= dt;
    E.hint.classList.toggle('show', race.state === 'countdown' || this.hintTimer > 0);
    E.camChip.classList.toggle('show', this.camTimer > 0);
    if (this.toastTimer > 0) { this.toastTimer -= dt; if (this.toastTimer <= 0) E.toast.classList.remove('show'); }
    this.drawMinimap(race);
    this.frame++;
  }

  // Track limits: "Lap invalidated" banner. e: the 'invalid' event from race.js { why, lap, sector }
  invalidated(e, seconds = 2.6) {
    this.limitsBanner(e.why === 'reset' ? `Car reset, lap ${e.lap}` : `Track limits, sector ${e.sector}, lap ${e.lap}`, 'Lap invalidated', false, seconds);
  }
  // … and the warnings before that, in cars allowed more than one (the Hypercar and GT3): { strike, of, lap, sector }
  limitsWarning(e, seconds = 2.2) {
    const left = e.of - e.strike;
    this.limitsBanner(`Track limits, sector ${e.sector}: ${left} more and the lap is deleted`, `Warning ${e.strike} of ${e.of}`, true, seconds);
  }
  limitsBanner(why, title, warn, seconds) {
    this.el.limitsWhy.textContent = why;
    this.el.limits.querySelector('b').textContent = title;
    this.el.limits.classList.toggle('warn', warn);
    this.el.limits.classList.remove('show'); void this.el.limits.offsetWidth; // restart the slide-in
    this.el.limits.classList.add('show');
    this.limitsTimer = seconds;
  }

  toast(text, seconds = 2.2) {
    this.el.toast.textContent = text;
    this.el.toast.classList.remove('show'); void this.el.toast.offsetWidth;
    this.el.toast.classList.add('show');
    this.toastTimer = seconds;
  }

  setCamera(name) { this.el.cam.textContent = name; this.camTimer = 1.8; }
  show(v) {
    this.el.hud.classList.toggle('hidden', !v);
    if (v) { this.resetTiming(); this.hintTimer = HINT_FOR; this.towerAt = null; this.popFor = null; }
    this.limitsTimer = 0; this.el.limits.classList.remove('show'); // no banner left over from the last race
  }
}