// In-race HUD (HTML overlay), laid out like a TV/game broadcast:
//   left  – timing tower: position, lap, every car with interval or gap to leader (T switches)
//   right – lap timing with sectors and live delta, circuit map, speed/gear/shift lights, ERS battery
// Sector colours: purple = fastest of anyone, green = your personal best, yellow = slower.
import { formatTime } from './race.js';
import { gearbox } from './physics.js';
import { wasPressed } from './input.js';
import { PITLANE } from './pitlane.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const MAP_SIZE = 268;      // minimap size in CSS pixels
const DELTA_STEP = 20;     // metres between live-delta reference points
const REV_LEDS = 15;

export class HUD {
  constructor(track) {
    this.el = {
      hud: $('hud'), speed: $('speed'), gear: $('gear'), thr: $('thr'), brk: $('brk'), revlights: $('revlights'),
      lap: $('lap'), lapTotal: $('lap-total'), pos: $('pos'), posTotal: $('pos-total'),
      cur: $('t-cur'), last: $('t-last'), best: $('t-best'), delta: $('t-delta'),
      sectors: [1, 2, 3].map((k) => $('sec' + k)),
      standings: $('standings'), mode: $('tower-mode'), mapName: $('map-name'),
      toast: $('toast'), lights: $('lights'), wrong: $('wrongway'), cam: $('cam-name'),
      limits: $('limits'), limitsWhy: $('limits-why'), invalid: $('t-invalid'), // track limits (race.js)
    };
    this.limitsTimer = 0;
    this.el.revlights.innerHTML = Array.from({ length: REV_LEDS }, (_, k) =>
      `<span class="${k < 5 ? 'g' : k < 10 ? 'r' : 'b'}"></span>`).join('');
    this.leds = [...this.el.revlights.children];
    this.lamps = [...this.el.lights.querySelectorAll('.lamp')];
    this.toastTimer = 0;
    this.frame = 0;
    this.showLeaderGap = false; // T toggles interval ↔ gap to leader
    this.setupMinimap(track);
    this.setupErs();
    this.setupTow();
  }

  // ---------- ERS battery (ers.js) ----------
  // A charge bar under the speed: green when charged, blue while braking charges it, yellow while you
  // deploy. When the battery is full (and you're racing) a reminder to deploy flashes above it.
  // It depends on your car (src/cars/): the Hypercar's hybrid deploys by itself (HYBRID, no reminder), the GT3
  // has none (no bar). Cars with driver aids (ABS, traction control) get two lights that show when they work,
  // and cars with headlights (headlights.js) a green LIGHTS light while they're on.
  setupErs() {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'grid', gridTemplateColumns: 'auto 1fr 46px', alignItems: 'center', columnGap: '10px', marginTop: '12px' });
    row.innerHTML = `<span data-label style="font-size:12px;font-weight:900;letter-spacing:0.14em;color:#ffd400">⚡ ERS</span>
      <div style="position:relative;height:12px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden">
        <div data-fill style="position:absolute;inset:0;transform-origin:left;background:#1fe05a;transition:background-color 0.15s"></div>
        <div style="position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 2px),rgba(11,13,19,0.9) calc(10% - 2px) 10%)"></div>
      </div>
      <b data-pct style="font-size:15px;font-weight:900;text-align:right">100%</b>
      <span data-mode style="grid-column:1/-1;margin-top:4px;font-size:10px;font-weight:700;letter-spacing:0.18em;color:var(--muted);height:12px"></span>`;
    $('speedo').appendChild(row);
    const aids = document.createElement('div'); // ABS and TC lights
    Object.assign(aids.style, { display: 'none', gap: '6px', marginTop: '10px' });
    const lamp = (txt) => `<span data-aid="${txt}" style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:900;letter-spacing:0.14em;` +
      `border:1px solid rgba(255,255,255,0.18);color:var(--muted);transition:background-color 0.1s,color 0.1s">${txt}</span>`;
    aids.innerHTML = lamp('ABS') + lamp('TC') + lamp('LIGHTS');
    $('speedo').appendChild(aids);
    const remind = document.createElement('div');
    remind.textContent = '⚡ BATTERY FULL · HOLD SHIFT / R1 TO DEPLOY';
    Object.assign(remind.style, { position: 'absolute', left: '50%', bottom: '31%', transform: 'translateX(-50%)', padding: '7px 18px',
      background: 'rgba(11,13,19,0.86)', border: '1px solid #ffd400', color: '#ffd400', borderRadius: '6px', whiteSpace: 'nowrap',
      font: "900 15px 'Titillium Web', sans-serif", letterSpacing: '0.12em', boxShadow: '0 0 18px rgba(255,212,0,0.35)', display: 'none' });
    this.el.hud.appendChild(remind);
    this.ers = { row, label: row.querySelector('[data-label]'), fill: row.querySelector('[data-fill]'), pct: row.querySelector('[data-pct]'),
      mode: row.querySelector('[data-mode]'), remind, full: 0, aids, abs: aids.querySelector('[data-aid="ABS"]'), tc: aids.querySelector('[data-aid="TC"]'),
      lights: aids.querySelector('[data-aid="LIGHTS"]') };
  }

  // The bar and the lights for this car (its file in src/cars/)
  setupCar(spec) {
    const E = this.ers, ers = spec ? spec.ers : {}, p = spec?.physics ?? {};
    E.row.style.display = ers ? 'grid' : 'none';
    E.label.textContent = ers?.auto ? '⚡ HYBRID' : '⚡ ERS';
    E.auto = !!ers?.auto;
    E.aids.style.display = p.abs || p.tc || spec?.headlights ? 'flex' : 'none';
    E.abs.style.display = p.abs ? '' : 'none'; E.tc.style.display = p.tc ? '' : 'none';
    E.lights.style.display = spec?.headlights ? '' : 'none';
    E.spec = spec;
  }

  updateErs(race, s, dt) {
    const E = this.ers;
    if (E.spec !== s.spec) this.setupCar(s.spec);
    for (const [el, on, colour] of [[E.abs, s.absActive, '#ffb000'], [E.tc, s.tcActive, '#ffb000'], [E.lights, s.lightsOn, '#1fe05a']]) {
      if (el.dataset.on !== String(!!on)) { // driver aids working: amber; headlights on: green
        el.dataset.on = String(!!on);
        el.style.background = on ? colour : 'transparent'; el.style.color = on ? '#0b0d13' : 'var(--muted)';
      }
    }
    if (s.spec && !s.spec.ers) { if (E.showing) { E.showing = false; E.remind.style.display = 'none'; } return; }
    const charge = s.ers ?? 1, pct = Math.round(charge * 100), full = charge >= 0.995;
    const mode = s.ersMode === 'deploy' || s.ersMode === 'harvest' ? s.ersMode : full ? 'full' : '';
    if (pct !== E.pctShown) { E.pctShown = pct; E.fill.style.transform = `scaleX(${charge.toFixed(3)})`; E.pct.textContent = pct + '%'; }
    if (mode !== E.modeShown) {
      E.modeShown = mode;
      const [colour, label] = { deploy: ['#ffd400', 'DEPLOYING'], harvest: ['#3d9bff', 'CHARGING'], full: ['#1fe05a', 'FULL'], '': ['#1fe05a', ''] }[mode];
      E.fill.style.background = colour; E.mode.textContent = label; E.mode.style.color = colour;
    }
    // Full battery while racing on the move (not finished, not in the pit lane): after a second, flash the reminder
    const racing = race.state === 'racing' && race.player.finishTime == null;
    E.full = full && racing && !E.auto && !s.pitLimiter && s.speed > 15 ? E.full + dt : 0; // (a hybrid that deploys by itself needs no reminder)
    const show = E.full > 1 && (this.frame >> 4) % 3 !== 2;
    if (show !== E.showing) { E.showing = show; E.remind.style.display = show ? 'block' : 'none'; }
  }

  // ---------- slipstream (slipstream.js) ----------
  // A bar under the ERS battery: how strong the tow from the car ahead is. Dim when you're not in anyone's wake.
  setupTow() {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'grid', gridTemplateColumns: 'auto 1fr 46px', alignItems: 'center', columnGap: '10px', marginTop: '8px',
      opacity: '0.35', transition: 'opacity 0.2s' });
    row.innerHTML = `<span data-label style="font-size:12px;font-weight:900;letter-spacing:0.14em;color:var(--muted)">≋ TOW</span>
      <div style="position:relative;height:8px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden">
        <div data-fill style="position:absolute;inset:0;transform-origin:left;transform:scaleX(0);background:#5fd8ff"></div>
      </div>
      <b data-pct style="font-size:13px;font-weight:900;text-align:right;color:var(--muted)">--</b>`;
    $('speedo').appendChild(row);
    this.tow = { row, fill: row.querySelector('[data-fill]'), pct: row.querySelector('[data-pct]'), label: row.querySelector('[data-label]'), shown: 0, on: false, txt: '' };
  }

  updateTow(s, dt) {
    const T = this.tow, target = s.tow ?? 0;
    T.shown += (target - T.shown) * Math.min(1, dt * 8);         // smooth, so it doesn't flicker
    const on = T.shown > 0.03;
    if (on !== T.on) {
      T.on = on; T.row.style.opacity = on ? '1' : '0.35';
      T.label.style.color = T.pct.style.color = on ? '#5fd8ff' : 'var(--muted)';
    }
    T.fill.style.transform = `scaleX(${T.shown.toFixed(3)})`;
    const txt = on ? Math.round(T.shown * 100) + '%' : '--';
    if (txt !== T.txt) { T.txt = txt; T.pct.textContent = txt; }
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
    const pad = 18 * dpr, span = Math.max(maxX - minX, maxZ - minZ);
    const scale = (c.width - pad * 2) / span;
    const ox = pad + ((span - (maxX - minX)) * scale) / 2, oz = pad + ((span - (maxZ - minZ)) * scale) / 2;
    // Mirror X so north is up (x points west in the game).
    this.toMap = (x, z) => [c.width - (ox + (x - minX) * scale), oz + (maxZ - z) * scale];
    // Pre-render the circuit, coloured by sector, once.
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
    path(0, track.n); g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 10 * dpr; g.stroke();
    const lane = track.pitLane;   // the pit lane (pitlane.js), a thin line beside the track
    if (lane) {
      g.beginPath();
      for (let k = 0; k <= lane.steps; k += 2) {
        const i = (lane.i0 + k) % track.n, lat = lane.side * (lane.inner[i] + lane.out[i]) / 2;
        const [px, py] = this.toMap(track.cx[i] + track.nx[i] * lat, track.cz[i] + track.nz[i] * lat);
        k === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.strokeStyle = 'rgba(200,208,218,0.7)'; g.lineWidth = 1.6 * dpr; g.stroke();
    }
    const third = Math.floor(track.n / 3), secCol = ['#e9ecef', '#c9d1db', '#e9ecef'];
    for (let k = 0; k < 3; k++) {
      path(k * third, k === 2 ? track.n : (k + 1) * third + 2);
      g.strokeStyle = secCol[k]; g.lineWidth = 4 * dpr; g.stroke();
    }
    // Sector boundaries and the start/finish line
    for (const [i, col, w] of [[third, '#ffd400', 2.5], [third * 2, '#ffd400', 2.5], [0, '#e10600', 4]]) {
      const [px, py] = this.toMap(track.cx[i], track.cz[i]);
      const nx = -track.nx[i], nz = -track.nz[i];         // normal in map space (x mirrored, z up)
      g.strokeStyle = col; g.lineWidth = w * dpr; g.beginPath();
      g.moveTo(px - nx * 7 * dpr, py - nz * 7 * dpr); g.lineTo(px + nx * 7 * dpr, py + nz * 7 * dpr); g.stroke();
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
        g.beginPath(); g.arc(x, y, 6.5 * dpr, 0, Math.PI * 2); g.fillStyle = hex(car.team.color); g.fill();
        g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.stroke();
        g.font = `900 ${9.5 * dpr}px 'Titillium Web', sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle';
        g.lineWidth = 3 * dpr; g.strokeStyle = 'rgba(0,0,0,0.85)';
        const tag = car.team.name.slice(0, 3).toUpperCase();
        g.strokeText(tag, x + 9 * dpr, y); g.fillStyle = '#fff'; g.fillText(tag, x + 9 * dpr, y);
      } else if (car.isPlayer) { // glowing marker with your position
        g.beginPath(); g.arc(x, y, 11 * dpr, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.18)'; g.fill();
        g.beginPath(); g.arc(x, y, 8 * dpr, 0, Math.PI * 2); g.fillStyle = '#e10600'; g.fill();
        g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.stroke();
        g.fillStyle = '#fff'; g.font = `900 ${10 * dpr}px 'Titillium Web', sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(car.position), x, y + 0.5 * dpr);
      } else {
        g.beginPath(); g.arc(x, y, 5 * dpr, 0, Math.PI * 2);
        g.fillStyle = hex(car.team.color); g.fill();
        g.lineWidth = 1.5 * dpr; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.stroke();
      }
    }
  }

  // ---------- sectors and live delta ----------
  resetTiming() {
    this.sec = new Map();            // per car: { laps, idx, start, pb: [s1,s2,s3] }
    this.bestSec = [Infinity, Infinity, Infinity];
    this.shown = [null, null, null]; // player's sectors on screen: { t, cls }
    this.holdPrev = 0;               // keep last lap's sectors up for a moment after the line
    this.samples = []; this.ref = null; this.playerLaps = null;
    this.grid = null;
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
          if (car.isPlayer) { this.shown[2] = { t, cls }; this.holdPrev = 3; }
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
      const v = this.shown[k];
      el.className = 'sec ' + (v ? v.cls : '');
      el.lastChild.textContent = v ? v.t.toFixed(3) : `S${k + 1}`;
    });
  }

  updateDelta(race, p) {
    if (this.playerLaps == null) this.playerLaps = p.lapsDone;
    if (p.lapsDone > this.playerLaps) {                     // lap finished: keep it as the reference if it's your best
      if (this.playerLaps >= 0 && p.lastLap != null && p.lastLap === p.bestLap && this.samples.length > 5) this.ref = this.samples;
      this.samples = []; this.playerLaps = p.lapsDone;
    }
    if (p.lapsDone < 0 || p.finishTime != null) { this.el.delta.textContent = '--.--'; this.el.delta.className = ''; return; }
    const elapsed = race.time - p.lapStart, bin = Math.floor(p.state.s / DELTA_STEP);
    if (this.samples[bin] == null) this.samples[bin] = elapsed;
    const r = this.ref && this.ref[bin];
    if (r == null) { this.el.delta.textContent = '--.--'; this.el.delta.className = ''; return; }
    const d = elapsed - r;
    this.el.delta.textContent = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2);
    this.el.delta.className = d > 0.005 ? 'slower' : 'faster';
  }

  // ---------- timing tower ----------
  updateTower(race) {
    if (wasPressed('KeyT')) this.showLeaderGap = !this.showLeaderGap;
    this.el.mode.textContent = this.showLeaderGap ? 'Leader' : 'Interval';
    if (race.state === 'countdown' || !this.grid) this.grid = new Map(race.cars.map((c) => [c, c.position]));
    const fl = race.bestLapOverall?.name;
    const st = race.standings;
    this.el.standings.classList.toggle('compact', st.length > 12); // big fields: slimmer rows
    this.el.standings.innerHTML = st.map((c, i) => {
      let gap;
      if (c.dnf) gap = 'DNF';
      else if (race.state === 'countdown') gap = '';
      else if (i === 0) gap = this.showLeaderGap ? 'Leader' : 'Interval';
      else {
        const v = this.showLeaderGap ? c.gap : c.gap - st[i - 1].gap;
        gap = '+' + Math.max(0, v).toFixed(3);
      }
      const moved = (this.grid.get(c) ?? c.position) - c.position;
      const chg = moved > 0 ? `<span class="chg up">▲${moved}</span>` : moved < 0 ? `<span class="chg down">▼${-moved}</span>` : '<span class="chg"></span>';
      const abbr = c.isHuman ? c.team.name.slice(0, 8).toUpperCase() : c.team.name.slice(0, 3).toUpperCase(); // people: full name
      const flag = c.finishTime != null ? '<span class="chq"></span>' : '';
      const fastest = fl === c.team.name ? '<span class="fl" title="Fastest lap"></span>' : '';
      const cls = [c.isPlayer ? 'me' : c.isHuman ? 'human' : '', i === 0 ? 'leader' : '', c.dnf ? 'dnf' : ''].join(' ');
      return `<li class="${cls}"><span class="p">${c.position}</span>` +
        `<span class="bar" style="background:${hex(c.team.color)}"></span><span class="n">${abbr}${fastest}</span>` +
        `${chg}<span class="g">${flag}${gap}</span></li>`;
    }).join('');
  }

  // ---------- every frame ----------
  update(race, dt) {
    const p = race.player, s = p.state;
    const kmh = Math.round(Math.abs(s.vf) * 3.6);
    const box = s.spec?.gearbox, gb = gearbox(Math.abs(s.vf), box);   // the car's gearbox (src/cars/)
    const [r0, r1] = box?.rpm ?? [6000, 13000];
    this.el.speed.textContent = kmh;
    this.el.gear.textContent = s.vf < -0.5 ? 'R' : gb.gear;
    const lit = Math.round(Math.min(1, Math.max(0, (gb.rpm - r0) / (r1 - r0))) * REV_LEDS);
    const flash = gb.rpm > (box?.flash ?? 12600) && (this.frame >> 2) % 2;
    if (lit !== this.litLeds || flash !== this.flash) {
      this.leds.forEach((l, k) => l.classList.toggle('on', k < lit && !flash));
      this.litLeds = lit; this.flash = flash;
    }
    this.el.thr.style.transform = `scaleY(${(s.throttle ?? 0).toFixed(2)})`;
    this.el.brk.style.transform = `scaleY(${(s.brake ?? 0).toFixed(2)})`;

    // Practice (no AI): no timing tower, the lap timing on the right says it all
    const practice = race.cars.length === 1;
    if (practice !== this.practice) { this.practice = practice; $('tower').classList.toggle('hidden', practice); }
    const lap = Math.min(Math.max(p.lapsDone + 1, 1), race.laps);
    this.el.lap.textContent = lap; this.el.lapTotal.textContent = '/' + race.laps;
    this.el.pos.textContent = p.position; this.el.posTotal.textContent = '/' + race.cars.length;
    const running = race.state === 'racing' && p.finishTime == null;
    this.el.cur.textContent = running ? formatTime(race.time - p.lapStart) : formatTime(p.finishTime ?? 0);
    this.el.last.textContent = formatTime(p.lastLap);
    // track limits: the running lap and the last lap are struck through while they're invalid; before that (cars
    // allowed more than one) the warnings so far: "Limits 2/5"
    const invalid = running && !!p.lapInvalid, allowed = p.state.spec?.trackLimits?.strikes ?? 1;
    const warned = running && !invalid && allowed > 1 && p.strikes > 0;
    this.el.cur.classList.toggle('invalid', invalid);
    if (this.el.invalid) {
      const label = invalid ? 'Invalid' : warned ? `Limits ${p.strikes}/${allowed}` : '';
      if (this.el.invalid.textContent !== label && label) this.el.invalid.textContent = label;
      this.el.invalid.classList.toggle('hidden', !invalid && !warned);
      this.el.invalid.classList.toggle('warn', warned);
    }
    this.el.last.classList.toggle('invalid', p.lastLap != null && !!p.lastLapInvalid);
    if (this.limitsTimer > 0) { this.limitsTimer -= dt; if (this.limitsTimer <= 0) this.el.limits?.classList.remove('show'); }
    this.el.best.textContent = formatTime(p.bestLap);
    this.el.best.classList.toggle('overall', p.bestLap != null && race.bestLapOverall?.time === p.bestLap);

    this.updateSectors(race, dt);
    this.updateDelta(race, p);
    if (this.frame++ % 8 === 0 && race.standings) this.updateTower(race); // DOM writes are the slow part

    // Start lights
    const showLights = race.state === 'countdown' || (race.time < 1.2 && race.state === 'racing');
    this.el.lights.classList.toggle('show', showLights);
    this.lamps.forEach((l, i) => l.classList.toggle('on', race.state === 'countdown' && i < race.lightsOn));

    // Wrong way: facing against the track direction while moving
    const t = race.track, i = Math.max(0, s.trackIndex);
    const facing = Math.sin(s.h) * t.tx[i] + Math.cos(s.h) * t.tz[i];
    this.el.wrong.classList.toggle('show', race.state === 'racing' && facing < -0.3 && s.speed > 4);

    // Pit lane speed limiter (pitlane.js): a flashing badge while it's holding you
    if (s.pitLimiter && !this.el.limiter) {
      const b = this.el.limiter = document.createElement('div');
      b.textContent = `PIT LIMITER  ${PITLANE.limit} km/h`;
      Object.assign(b.style, { position: 'absolute', left: '50%', bottom: '24%', transform: 'translateX(-50%)', padding: '6px 16px',
        background: '#ffd400', color: '#111', font: "900 18px 'Titillium Web', sans-serif", letterSpacing: '0.12em',
        borderRadius: '6px', boxShadow: '0 4px 16px rgba(0,0,0,0.4)', pointerEvents: 'none', display: 'none' });
      this.el.hud.appendChild(b);
    }
    if (this.el.limiter) this.el.limiter.style.display = s.pitLimiter && (this.frame >> 4) % 4 !== 3 ? 'block' : 'none';

    this.updateErs(race, s, dt);
    this.updateTow(s, dt);

    if (this.toastTimer > 0) { this.toastTimer -= dt; if (this.toastTimer <= 0) this.el.toast.classList.remove('show'); }
    this.drawMinimap(race);
  }

  // Track limits: "Lap invalidated" banner. e: the 'invalid' event from race.js { why, lap, sector }
  invalidated(e, seconds = 2.6) {
    this.limitsBanner(e.why === 'reset' ? `Car reset · lap ${e.lap}` : `Track limits · sector ${e.sector} · lap ${e.lap}`, 'Lap invalidated', false, seconds);
  }
  // … and the warnings before that, in cars allowed more than one (the Hypercar and GT3): { strike, of, lap, sector }
  limitsWarning(e, seconds = 2.2) {
    this.limitsBanner(`Track limits · sector ${e.sector} · ${e.of - e.strike} left this lap`, `Warning ${e.strike} of ${e.of}`, true, seconds);
  }
  limitsBanner(why, title, warn, seconds) {
    if (!this.el.limits) return;
    this.el.limitsWhy.textContent = why;
    this.el.limits.querySelector('b').textContent = title;
    this.el.limits.classList.toggle('warn', warn);
    this.el.limits.classList.remove('show'); void this.el.limits.offsetWidth; // restart the slide-in
    this.el.limits.classList.add('show');
    this.limitsTimer = seconds;
  }

  toast(text, seconds = 2.2) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('show');
    this.toastTimer = seconds;
  }

  setCamera(name) { this.el.cam.textContent = name; }
  show(v) {
    this.el.hud.classList.toggle('hidden', !v);
    if (v) this.resetTiming();
    this.limitsTimer = 0; this.el.limits?.classList.remove('show'); // no banner left over from the last race
  }
}