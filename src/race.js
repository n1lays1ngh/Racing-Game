// Race logic: grid, start lights, laps, timing, positions, car-to-car contact.
// No rendering here, so a whole race can be simulated headless.
import { createCarState, stepCar, placeCar, CAR, clamp } from './physics.js';
import { AIDriver, buildSpeedProfile, newPlanStep } from './ai.js';
import { towFor } from './slipstream.js';
import { getCar, DEFAULT_CAR } from './cars/index.js';
import { PitStops } from './pitstop.js';
import { TYRES, fitTyres, chooseCompound } from './tyres.js';
import { DAMAGE, fitDamage, hitDamage, repair } from './damage.js';

// The grid: you plus 19 AI drivers (made-up teams). Add or remove entries to change the field size.
// The tower shows the first three letters of each name, so keep those unique.
export const TEAMS = [
  { name: 'You',      color: 0xe10600, accent: 0xffffff, number: 1 },
  { name: 'Vortex',   color: 0x1e41ff, accent: 0xffd400, number: 7 },
  { name: 'Solaris',  color: 0xff8000, accent: 0x111111, number: 4 },
  { name: 'Kestrel',  color: 0x00a19b, accent: 0xe8e8e8, number: 22 },
  { name: 'Nimbus',   color: 0xe8e8e8, accent: 0x0090ff, number: 11 },
  { name: 'Ferro',    color: 0x2b2b2b, accent: 0xff2d55, number: 33 },
  { name: 'Aurora',   color: 0x7a2bd6, accent: 0x00e5ff, number: 16 },
  { name: 'Titan',    color: 0x1b5e20, accent: 0xffd700, number: 14 },
  { name: 'Zephyr',   color: 0x3fb4ff, accent: 0x0b1a3a, number: 23 },
  { name: 'Onyx',     color: 0x121212, accent: 0xd4af37, number: 55 },
  { name: 'Halcyon',  color: 0xff4fa3, accent: 0x1e1e1e, number: 10 },
  { name: 'Raptor',   color: 0xc62828, accent: 0xf5f5f5, number: 31 },
  { name: 'Cobalt',   color: 0x0d47a1, accent: 0xff6d00, number: 2 },
  { name: 'Mistral',  color: 0x9ccc65, accent: 0x263238, number: 27 },
  { name: 'Pulsar',   color: 0xffeb3b, accent: 0x212121, number: 44 },
  { name: 'Ember',    color: 0xff5722, accent: 0x3e2723, number: 18 },
  { name: 'Glacier',  color: 0xb3e5fc, accent: 0x01579b, number: 63 },
  { name: 'Phantom',  color: 0x5d4037, accent: 0xffcc80, number: 81 },
  { name: 'Tempest',  color: 0x00897b, accent: 0xff1744, number: 12 },
  { name: 'Vanta',    color: 0x455a64, accent: 0xaeea00, number: 43 },
];

// How fast the AI is (ai.js). A setting given as [quickest, slowest] is for the front and the back of the grid: the
// grid is in pace order, quickest at the front, so the field strings out like a real one instead of running nose to
// tail (the drivers in between are spread evenly between the two, with a touch of luck).
//   pace     cornering speed (1 = right on the car's limit)
//   power    how much of the engine it uses (1 = all of it): the slower drivers are slower on the straights too
//   brakeUse how late it brakes (1 = the latest there is)
//   grip     grip over yours (1 = the same car as you; above 1 so the AI can keep up with a very quick human)
//   safety   how close to the grip limit it plans its corner speeds (1 = right on it)
//   defence  how far it moves over to cover the inside when someone's right behind before a corner (0 = never)
// Lap times on its own against a perfect lap in the same car, roughly: easy 6–9% slower, medium 2–4% slower, hard from
// 1% quicker (the front of the grid) to 1–2% slower (the back), expert 2–2.5% quicker to 0.5–1.5% quicker.
export const DIFFICULTY = {
  easy:   { pace: [0.94, 0.917],  power: [0.944, 0.91],  brakeUse: [0.86, 0.843], grip: 1.0,  safety: 0.97, defence: 0.25 },
  medium: { pace: [0.975, 0.954], power: [0.976, 0.948], brakeUse: [0.93, 0.911], grip: 1.0,  safety: 0.99, defence: 0.45 },
  hard:   { pace: [1.0, 0.98],    power: [0.995, 0.966], brakeUse: [0.98, 0.96],  grip: 1.03, safety: 1.0,  defence: 0.65 },
  expert: { pace: [1.0, 0.985],   power: [1.0, 0.982],   brakeUse: [1.0, 0.98],   grip: 1.08, safety: 1.0,  defence: 0.8 },
};
// a [quickest, slowest] setting for a driver `rank` of the way down the grid (0 = the front, 1 = the back)
export const paceAt = (x, rank) => (Array.isArray(x) ? x[0] + (x[1] - x[0]) * rank : x);

// Track limits. The white line is the edge of the track: the kerbs are fine, but take all four wheels past the
// line (the car's centre more than `margin` beyond it) and you've broken track limits. In the F1 car that
// invalidates the lap straight away; the Hypercar and GT3 get warnings first: the lap is only invalidated the 5th
// time in a lap (`trackLimits.strikes` in the car's file; each trip off the track counts once, however long). The
// HUD says so straight away (hud.js), an invalidated lap doesn't count as a best lap, and your stats mark it
// (stats.js). Driving into the pit lane is fine. resetInvalidates: pressing R (back onto the track) invalidates the
// lap straight away, in any car.
export const TRACK_LIMITS = {
  enabled: true,
  margin: 1.0,             // metres: half a car's width, so it's "all four wheels" past the white line
  minSpeed: 3,             // m/s: don't count a car that's crawling (it got there at speed anyway)
  deleteLapTimes: true,    // invalid laps don't count as anyone's best lap (or the fastest lap)
  resetInvalidates: true,
};
const sectorOf = (s, L) => (s >= (2 * L) / 3 ? 2 : s >= L / 3 ? 1 : 0); // the HUD's S1 / S2 / S3

// ---- Gaps (the timing tower and the HUD) ----
// Like the timing loops in a real circuit, but one every GAP_STEP metres all the way round: the race clock when each car
// (and the race lead) passed each point, worked out between physics steps, so a gap is exact to the thousandth and
// doesn't jump about. car.gap: behind the leader (s); car.interval: behind the car ahead (s, or null until it can be
// measured, e.g. just after the start for cars behind the leader's grid slot); car.lapsDown: laps behind the leader.
export const GAP_STEP = 4; // m between timing points
const TRACE = 2048;   // timing points each car remembers (2048 × 4 m ≈ 8 km): enough for the interval to the car ahead
export const newTrace = (size, ring) => ({ T: new Float64Array(size).fill(-1), ring, k: -1, p: null, t: 0 });
// The car (or the lead) is at progress P (m from a lap before the line) at race time `time`: note the timing points passed
export function tracePass(tr, P, time) {
  if (!(P >= 0)) return;
  if (tr.p == null) { tr.p = P; tr.t = time; tr.k = Math.floor(P / GAP_STEP); return; }
  if (P <= tr.p) { tr.t = time; return; } // going backwards or stopped: it passes the next point some time after now
  const k1 = Math.floor(P / GAP_STEP), n = tr.T.length;
  for (let k = tr.k + 1; k <= k1; k++) {
    if (!tr.ring && k >= n) break;
    tr.T[tr.ring ? k % n : k] = tr.t + ((k * GAP_STEP - tr.p) / (P - tr.p)) * (time - tr.t);
  }
  tr.k = Math.max(tr.k, k1); tr.p = P; tr.t = time;
}
// When it passed progress P (null: not yet, or too long ago to remember). The HUD's live delta uses these too.
export function traceTime(tr, P) {
  if (!(P >= 0) || tr.p == null) return null;
  const n = tr.T.length, k = Math.floor(P / GAP_STEP), at = (j) => tr.T[tr.ring ? j % n : j];
  if (k > tr.k || (tr.ring && k <= tr.k - n) || (!tr.ring && k >= n)) return null;
  const t0 = at(k);
  if (t0 < 0) return null;
  const next = k + 1 <= tr.k && (tr.ring || k + 1 < n);
  const p1 = next ? (k + 1) * GAP_STEP : tr.p, t1 = next ? at(k + 1) : tr.t;
  if (t1 < 0 || p1 <= k * GAP_STEP) return t0;
  return t0 + ((P - k * GAP_STEP) / (p1 - k * GAP_STEP)) * (t1 - t0);
}

export class Race {
  // aiCount: how many AI cars (0 = Practice, just you). playerName: shown in the tower and results.
  // Online races (see net/session.js) also pass:
  //   humans: [{ id, name, color }] – everyone in the room, in grid order (they start behind the AI)
  //   localId: which of them is you. collisions: false = cars drive through each other.
  // car: which car everyone races (an id from src/cars/, or the car itself); one kind of car per race.
  constructor(track, { laps = 3, difficulty = 'medium', playerColor, aiCount = TEAMS.length - 1, playerName,
    humans = null, localId = null, collisions = true, car = DEFAULT_CAR, tyres = null, career = false, round = null, playerGrid = null, damage = null } = {}) {
    this.track = track;
    this.carDef = typeof car === 'string' || car == null ? getCar(car) : car;
    this.laps = laps;
    this.collisions = collisions;
    this.difficulty = difficulty;
    this.career = !!career; this.round = round; // career (career.js): pit stops and tyres are only in career races
    this.countdownClock = null;   // online: a shared clock runs the start lights (else they count up here)
    this.state = 'countdown';     // countdown → racing → finished
    this.time = 0;                // race clock, starts at lights out
    this.countdown = 0;           // time since the lights sequence began
    this.lightsOutAt = 5 + 0.4 + Math.random() * 1.2;
    this.lightsOn = 0;
    const diff = DIFFICULTY[difficulty] ?? DIFFICULTY.medium;
    const physics = this.carDef.physics;          // the AI's corner speeds and braking come from the car it drives
    this.profile = buildSpeedProfile(track, diff.grip, diff.safety, paceAt(diff.brakeUse, 0), physics);
    this.playerProfile = buildSpeedProfile(track, 1, 0.97, 0.9, physics); // for the cool-down lap
    this.cars = [];
    this.leadTrace = newTrace(Math.ceil(((laps + 2) * track.length) / GAP_STEP) + 8, false); // the race lead, the whole race (gaps)
    this.events = [];             // messages for the HUD ("New best lap" etc.)
    this.contacts = 0; this.touch = new Map(); this.contactStep = 0; // car-to-car contacts (each new touch once: npm run sim)

    // Grid: two columns, 8 m between rows, just behind the start line.
    // AI in team order, you (or everyone in an online room) at the back of the grid
    const n = Math.max(0, Math.min(aiCount, TEAMS.length - 1));
    const order = [...TEAMS.keys()].filter((k) => k !== 0).slice(0, n).map((k) => ({ teamIdx: k }));
    if (humans) humans.forEach((h, k) => order.push({ teamIdx: 0, human: h, id: 100 + k }));
    else order.push({ teamIdx: 0, human: { id: localId } }); // alone = pole position
    if (playerGrid && !humans) order.splice(Math.min(order.length - 1, Math.max(0, playerGrid - 1)), 0, order.pop()); // (career: your grid slot)
    order.forEach(({ teamIdx, human, id }, slot) => {
      const team = { ...TEAMS[teamIdx] };
      const isPlayer = !!human && human.id === localId;
      if (isPlayer && playerColor != null) team.color = playerColor;
      if (isPlayer && playerName) team.name = playerName;
      if (human?.name) { team.name = human.name; team.color = human.color ?? team.color; }
      const state = createCarState(0, 0, 0, this.carDef);
      placeCar(state, track, track.length - 10 - slot * 8, slot % 2 === 0 ? 2.8 : -2.8);
      const car = {
        id: id ?? teamIdx, team, state, isPlayer, isHuman: !!human, humanId: human?.id ?? null,
        lapsDone: -1, prevS: state.s, progress: 0,
        lapStart: 0, lastLap: null, bestLap: null, finishTime: null,
        position: slot + 1, gap: 0, gapKnown: false, interval: null, lapsDown: 0, grid: slot + 1,
        trace: newTrace(TRACE, true), // timing points it passed (for the interval of the car behind it)
        // track limits: this lap invalid? which sectors? (and the same for the lap just finished)
        lapInvalid: false, offSec: [false, false, false], lastLapInvalid: false, lastOffSec: [false, false, false],
        strikes: 0, wasOff: false, // track limits broken this lap (cars allowed more than one), and off right now?
        crossedBack: false, // reversed back over the line: crossing it again carries on the same lap
        // (the rest of its fields, from the start: see physics.js createCarState)
        ai: null, pitAI: null, dnf: false, stuck: 0, lastLapAt: null,
        box: null, pit: null, pitLaps: null, wearLimit: 0, nextTyres: null, boxCall: false,
        retiring: null, retireT: 0, retired: null, parked: false,
      };
      if (!human) { // each driver's pace: roughly the quickest at the front of the grid (DIFFICULTY above). Not exactly
        // in order, as after a real qualifying: a few start out of place and have to fight their way back up
        const rank = n > 1 ? clamp((Math.min(slot, n - 1) + (Math.random() - 0.5) * 5) / (n - 1), 0, 1) : 0;
        const pace = paceAt(diff.pace, rank) * (1 + (Math.random() - 0.5) * 0.004);
        car.ai = new AIDriver(state, track, this.profile, Math.min(pace, 1.02), diff.grip, {
          brakeUse: paceAt(diff.brakeUse, rank), power: Math.min(1, paceAt(diff.power, rank)),
          safety: diff.safety, defence: diff.defence, start: true });
      }
      this.cars.push(car);
    });
    this.player = this.cars.find(c => c.isPlayer);
    this.pits = this.career ? new PitStops(this) : null; // career: boxes, the AI's stops, the stops themselves (pitstop.js)
    // Tyres (tyres.js): you start on your pick (TYRES.start, or 1 / 2 / 3 on the grid), the AI on a mix, and a pit stop
    // fits the set you chose on the pit page (car.nextTyres), or the softest one that lasts the rest of the race
    if (this.career) for (const c of this.cars) {
      const pick = c.isHuman ? (c.isPlayer ? tyres : null) ?? TYRES.start
        : this.laps < TYRES.twoCompounds ? chooseCompound(this, this.laps)
        : Math.random() < 0.35 ? 'soft' : Math.random() < 0.8 ? 'medium' : 'hard';
      fitTyres(c.state, pick, this);
    }
    // Damage (damage.js): career only, Low / Medium / Real (the career's setting); repaired at a pit stop
    this.damage = this.career && damage ? damage : null;
    if (this.damage) for (const c of this.cars) fitDamage(c.state, this.damage, this.carDef);
    if (this.pits) this.pits.onService = (c) => {
      fitTyres(c.state, c.nextTyres ?? chooseCompound(this, this.laps - c.lapsDone, c.state.tyres?.used), this); c.nextTyres = null;
      repair(c.state);
    };
    this.bestLapOverall = null;
    this.updatePositions();
    this.cars.forEach((c, i) => { c.position = i + 1; }); // grid order until the start
    this.standings = [...this.cars];
  }

  step(dt, playerInput) {
    if (this.state === 'countdown') {
      this.countdown = this.countdownClock ? this.countdownClock() : this.countdown + dt;
      this.lightsOn = Math.max(0, Math.min(5, Math.floor(this.countdown)));
      if (this.countdown >= this.lightsOutAt) {
        this.state = 'racing'; this.lightsOn = 0;
        this.time = this.countdownClock ? this.countdown - this.lightsOutAt : 0;
        this.events.push({ type: 'go' });
      }
      for (const c of this.cars) {
        if (c.remote) c.advance?.(dt);
        else c.state.throttle = c.isPlayer ? playerInput.throttle : 0.4;
      }
      return;
    }

    this.time += dt;
    newPlanStep(); // (the AI's plans this step: ai.js)
    const states = this.liveStates ??= []; states.length = 0; // (one array, reused every step: no garbage)
    for (const c of this.cars) if (!c.dnf) states.push(c.state);
    // slipstream: how much each car here is in the wake of the car(s) ahead (slipstream.js; physics.js uses it)
    for (const car of this.cars) if (!car.dnf && !car.remote) car.state.tow = towFor(car.state, states);
    for (const car of this.cars) {
      if (car.dnf) continue;
      if (car.remote) { car.advance?.(dt); this.countLap(car); continue; } // driven from the network
      this.pits?.update(car, dt); // pit stops: in the pit lane the car drives itself (pitstop.js)
      const driver = car.ai ?? car.pitAI;
      let input = driver ? driver.update(dt, this.cars) : playerInput; // (the AI sees every car: ai.js)
      if (car.retiring) { // broken (damage.js): no drive, coast to a stop, then out
        input = { ...input, throttle: 0, brake: Math.max(0.5, input.brake ?? 0), boost: false };
        car.retireT = (car.retireT ?? 0) + dt;
        if (car.state.speed < 1 || car.retireT > 6) { this.retire(car); continue; }
      }
      stepCar(car.state, input, this.track, dt);
      if (car.state.damage?.changed) this.damageNews(car);
      this.updateLap(car);
      this.checkLimits(car);
      if (car.ai && car.pit?.state !== 'stop') { // AI wedged against a wall or another car for a while: put it back on the track (like pressing R)
        car.stuck = car.state.speed < 1.5 ? (car.stuck ?? 0) + dt : 0;
        if (car.stuck > 2.5) {
          // back on the road where it stopped, on whichever line is clearest of the other cars
          const tr = this.track, st = car.state, L = tr.length, hw = tr.hw[st.trackIndex] ?? 5, m = Math.max(0, hw - 1.5);
          let at = 0, room = -1;
          for (const lat of [-Math.min(2, m), 0, Math.min(2, m), -m, m]) {
            let r = Infinity;
            for (const o of this.cars) {
              if (o === car || o.dnf) continue;
              let d = o.state.s - st.s; if (d > L / 2) d -= L; else if (d < -L / 2) d += L;
              if (Math.abs(d) < 40) r = Math.min(r, Math.hypot(d, (o.state.lateral - lat) * 3));
            }
            if (r > room + 0.5) { room = r; at = lat; }
          }
          placeCar(st, tr, st.s, at);
          car.stuck = 0;
        }
      }
    }
    this.resolveContacts();
    this.updatePositions();
  }

  // Damage just changed (damage.js): tell you when a part gets bad ({ type: 'damage', part, level }), and a car that's
  // broken stops racing
  damageNews(car) {
    const d = car.state.damage; d.changed = false;
    if (car.isPlayer) for (const part of DAMAGE.parts) {
      const level = DAMAGE.warn.filter((w) => d.parts[part] >= w).length;
      if (level > (d.warned[part] ?? 0)) { d.warned[part] = level; this.events.push({ type: 'damage', part, level }); }
    }
    if (d.out && !car.retiring && !car.dnf && car.finishTime == null) { car.retiring = d.out; car.retireT = 0; }
  }

  // Out of the race: parked off the track if there's room (else the marshals take it away), DNF.
  // Events: { type: 'retired', part } for you (your race is over: the results), { type: 'out', car, part } for the others
  retire(car) {
    car.dnf = true; car.retired = car.retiring; car.retiring = null;
    const st = car.state, t = this.track, i = Math.max(0, st.trackIndex), side = Math.sign(st.lateral) || 1;
    const lat = Math.min(t.hw[i] + (t.kerb ?? 1) + 4, (side > 0 ? t.wallL[i] : t.wallR[i]) - 2);
    car.parked = lat > t.hw[i] + 1.5 && !st.inPitLane;
    if (car.parked) placeCar(st, t, st.s, side * lat);
    if (car.isPlayer) { this.state = 'finished'; this.events.push({ type: 'retired', part: car.retired }); }
    else this.events.push({ type: 'out', car, part: car.retired });
  }

  updateLap(car) {
    const L = this.track.length, s = car.state.s;
    if (car.prevS > L * 0.75 && s < L * 0.25) {
      car.lapsDone++;
      if (car.crossedBack) car.crossedBack = false; // back over the line after rolling back across it: same lap, carry on
      else this.completeLap(car);
    } else if (car.prevS < L * 0.25 && s > L * 0.75) {
      car.lapsDone--; car.crossedBack = true; // crossed the line backwards
    }
    car.prevS = s;
    car.progress = car.lapsDone * L + s;
  }

  // Crossed the line (forwards): time the lap, start the next one, maybe the flag.
  completeLap(car) {
    const valid = !car.lapInvalid;
    car.lastLapInvalid = car.lapInvalid; car.lastOffSec = car.offSec;
    car.lapInvalid = false; car.offSec = [false, false, false]; car.strikes = 0;
    if (car.lapsDone >= 1 && car.finishTime == null) {
      const lap = this.time - car.lapStart;
      car.lastLap = lap; car.lastLapAt = this.time; car.lapStart = this.time; // (lastLapAt: when, for the HUD)
      const counts = valid || !TRACK_LIMITS.deleteLapTimes; // an invalidated lap can't be a best lap
      if (counts && (car.bestLap == null || lap < car.bestLap)) {
        car.bestLap = lap;
        if (car.isPlayer) this.events.push({ type: 'bestLap', time: lap });
      }
      // every lap you complete, for your stats (stats.js). at: race clock when you crossed the line;
      // valid / offSec: track limits (which sectors you went off in)
      if (car.isPlayer) this.events.push({ type: 'lap', lap: car.lapsDone, time: lap, at: this.time, valid, offSec: car.lastOffSec });
      if (counts && (this.bestLapOverall == null || lap < this.bestLapOverall.time)) {
        this.bestLapOverall = { time: lap, name: car.team.name };
      }
    }
    if (car.lapsDone >= this.laps && car.finishTime == null) {
      car.finishTime = this.time;
      if (car.isPlayer) {
        this.state = 'finished';
        this.events.push({ type: 'finish' });
        // Hand the player's car to the AI for a cool-down lap.
        car.ai = new AIDriver(car.state, this.track, this.playerProfile, 0.7);
      }
    } else if (car.isPlayer && car.lapsDone === this.laps - 1 && car.lapsDone >= 1) {
      this.events.push({ type: 'finalLap' });
    }
  }

  // Track limits (TRACK_LIMITS above), checked every physics step for the cars driven here.
  // Each trip off the track is one strike; the car's `trackLimits.strikes`-th in a lap invalidates it (warnings before
  // that: { type: 'warning', strike, of, lap, sector } for the HUD). Once it's invalid, every sector you go off in is marked.
  checkLimits(car) {
    const st = car.state, i = st.trackIndex, T = TRACK_LIMITS;
    if (!T.enabled || car.lapsDone < 0 || car.finishTime != null || i < 0 || st.inPitLane) { car.wasOff = false; return; }
    const off = st.speed >= T.minSpeed && Math.abs(st.lateral) > this.track.hw[i] + T.margin;
    const fresh = off && !car.wasOff; car.wasOff = off;
    if (!off) return;
    if (car.lapInvalid) { this.invalidate(car, 'limits'); return; }
    if (fresh) car.strikes++;
    const allowed = this.carDef.trackLimits?.strikes ?? 1;
    if (car.strikes >= allowed) { this.invalidate(car, 'limits'); return; }
    if (fresh && car.isPlayer) {
      this.events.push({ type: 'warning', strike: car.strikes, of: allowed, lap: car.lapsDone + 1, sector: sectorOf(st.s, this.track.length) + 1 });
    }
  }

  // Mark the lap (and this sector) invalid. The first time in a lap, tell the HUD: { type: 'invalid', why, lap, sector }
  invalidate(car, why) {
    const k = sectorOf(car.state.s, this.track.length);
    car.offSec[k] = true;
    if (car.lapInvalid) return;
    car.lapInvalid = true;
    if (car.isPlayer) this.events.push({ type: 'invalid', why, lap: car.lapsDone + 1, sector: k + 1 });
  }

  // Online: someone else's car. Its owner times its laps; here we only count them, so it's ranked smoothly.
  countLap(car) {
    const L = this.track.length, s = car.state.s;
    if (car.prevS > L * 0.75 && s < L * 0.25) { car.lapsDone++; car.lapStart = this.time; }
    else if (car.prevS < L * 0.25 && s > L * 0.75) car.lapsDone--;
    else if (car.net?.laps != null && s > L * 0.25 && s < L * 0.75) car.lapsDone = car.net.laps; // agree with the owner
    car.prevS = s;
    car.progress = car.lapsDone * L + s;
  }

  updatePositions() {
    const sorted = [...this.cars].sort((a, b) => {
      if (!!a.dnf !== !!b.dnf) return a.dnf ? 1 : -1; // retired / disconnected: bottom of the order
      if (a.finishTime != null && b.finishTime != null) return a.finishTime - b.finishTime;
      if (a.finishTime != null) return -1;
      if (b.finishTime != null) return 1;
      return b.progress - a.progress;
    });
    const L = this.track.length, now = this.time;
    // Timing points (GAP_STEP above): where everyone is now, and the race lead
    for (const c of this.cars) if (!c.dnf) tracePass(c.trace, c.progress + L, now);
    const lead = sorted[0];
    tracePass(this.leadTrace, lead.progress + L, now);
    const leadP = lead.finishTime != null ? this.laps * L : lead.progress; // (the leader's cool-down lap doesn't lap anyone)
    sorted.forEach((c, i) => {
      c.position = i + 1;
      if (i === 0) { c.gap = 0; c.gapKnown = true; c.interval = null; c.lapsDown = 0; return; }
      const ahead = sorted[i - 1];
      if (c.finishTime != null) { // the flag: gaps are the finishing times
        c.gap = c.finishTime - lead.finishTime; c.gapKnown = true; c.lapsDown = 0;
        c.interval = ahead.finishTime != null ? c.finishTime - ahead.finishTime : null;
        return;
      }
      const P = c.progress + L, tLead = traceTime(this.leadTrace, P);
      c.gapKnown = tLead != null;
      c.gap = c.gapKnown ? now - tLead : 0;
      c.lapsDown = Math.max(0, Math.floor((leadP - c.progress) / L));
      const tAhead = ahead.dnf ? null : traceTime(ahead.trace, P);
      c.interval = tAhead != null ? now - tAhead
        : c.gapKnown && ahead.gapKnown && ahead.finishTime == null ? Math.max(0, c.gap - ahead.gap) : null;
    });
    this.standings = sorted;
  }

  // Each car is two circles (front and rear; their size and spacing come from the car's file in src/cars/).
  // Push overlapping cars apart and exchange momentum along the contact normal.
  // Online, a car driven from the network only moves when its owner says so: the local car takes the whole push.
  resolveContacts() {
    if (!this.collisions) return;
    const cars = this.cars, step = ++this.contactStep;
    for (let a = 0; a < cars.length; a++) {
      for (let b = a + 1; b < cars.length; b++) {
        const ca = cars[a], cb = cars[b];
        if (ca.dnf || cb.dnf || (ca.remote && cb.remote)) continue;
        const wa = ca.remote ? 0 : cb.remote ? 1 : 0.5, wb = cb.remote ? 0 : ca.remote ? 1 : 0.5; // share of the push
        const A = ca.state, B = cb.state;
        if ((A.x - B.x) ** 2 + (A.z - B.z) ** 2 > 64) continue;
        const pa = A.spec?.physics ?? CAR, pb = B.spec?.physics ?? CAR, reach = pa.radius + pb.radius;
        const offA = pa.contactOffset ?? 1.4, offB = pb.contactOffset ?? 1.4;
        let hit = 0, hx = 0, hz = 0; // the hardest touch between these two this step (damage.js)
        for (const oa of [offA, -offA]) {
          for (const ob of [offB, -offB]) {
            const ax = A.x + Math.sin(A.h) * oa, az = A.z + Math.cos(A.h) * oa;
            const bx = B.x + Math.sin(B.h) * ob, bz = B.z + Math.cos(B.h) * ob;
            let dx = bx - ax, dz = bz - az;
            const d = Math.hypot(dx, dz);
            if (d >= reach || d < 1e-4) continue;
            const key = a * 256 + b;
            const last = this.touch.get(key);
            if (last === undefined || last < step - 1) this.contacts++;
            this.touch.set(key, step);
            dx /= d; dz /= d;
            const push = reach - d;
            A.x -= dx * push * wa; A.z -= dz * push * wa;
            B.x += dx * push * wb; B.z += dz * push * wb;
            const rel = (B.vx - A.vx) * dx + (B.vz - A.vz) * dz;
            if (rel < 0) {
              if (-rel > hit) { hit = -rel; hx = dx; hz = dz; }
              const j = -rel * 1.2; // mostly inelastic
              A.vx -= dx * j * wa; A.vz -= dz * j * wa;
              B.vx += dx * j * wb; B.vz += dz * j * wb;
              if (cars[a].isPlayer || cars[b].isPlayer) {
                const p = cars[a].isPlayer ? A : B;
                p.hitWall = Math.max(p.hitWall, Math.min(1, -rel / 10));
              }
            }
          }
        }
        if (hit > 0 && this.damage) { // career: both cars take it, each where it was hit
          if (A.damage && !ca.remote) hitDamage(A, hx, hz, hit, 'car');
          if (B.damage && !cb.remote) hitDamage(B, -hx, -hz, hit, 'car');
          if (A.damage?.changed) this.damageNews(ca);
          if (B.damage?.changed) this.damageNews(cb);
        }
      }
    }
  }

  resetPlayer() {
    const p = this.player, s = p.state;
    if (TRACK_LIMITS.enabled && TRACK_LIMITS.resetInvalidates && p.lapsDone >= 0 && p.finishTime == null) this.invalidate(p, 'reset');
    placeCar(s, this.track, s.s, 0);
  }

  takeEvents() { const e = this.events; this.events = []; return e; }
}

export function formatTime(t) {
  if (t == null || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}