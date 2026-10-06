// Race logic: grid, start lights, laps, timing, positions, car-to-car contact.
// No rendering here, so a whole race can be simulated headless.
import { createCarState, stepCar, placeCar, CAR } from './physics.js';
import { AIDriver, buildSpeedProfile } from './ai.js';
import { towFor } from './slipstream.js';
import { getCar, DEFAULT_CAR } from './cars/index.js';

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

// How fast the AI is. pace = how close to its own limit it drives (1 = on the limit);
// grip = grip bonus over you (racing games do this so the AI can keep up with a fast human);
// safety = how close to the cornering limit it plans; brakeUse = how late it brakes (1 = latest).
export const DIFFICULTY = {
  easy:   { pace: 0.93, grip: 1.0,  safety: 0.96, brakeUse: 0.85 },
  medium: { pace: 0.97, grip: 1.02, safety: 0.98, brakeUse: 0.92 },
  hard:   { pace: 1.0,  grip: 1.06, safety: 1.0,  brakeUse: 1.0 },
  expert: { pace: 1.0,  grip: 1.15, safety: 1.0,  brakeUse: 1.0 },
};

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

export class Race {
  // aiCount: how many AI cars (0 = Practice, just you). playerName: shown in the tower and results.
  // Online races (see net/session.js) also pass:
  //   humans: [{ id, name, color }] – everyone in the room, in grid order (they start behind the AI)
  //   localId: which of them is you. collisions: false = cars drive through each other.
  // car: which car everyone races (an id from src/cars/, or the car itself); one kind of car per race.
  constructor(track, { laps = 3, difficulty = 'medium', playerColor, aiCount = TEAMS.length - 1, playerName,
    humans = null, localId = null, collisions = true, car = DEFAULT_CAR } = {}) {
    this.track = track;
    this.carDef = typeof car === 'string' || car == null ? getCar(car) : car;
    this.laps = laps;
    this.collisions = collisions;
    this.difficulty = difficulty;
    this.countdownClock = null;   // online: a shared clock runs the start lights (else they count up here)
    this.state = 'countdown';     // countdown → racing → finished
    this.time = 0;                // race clock, starts at lights out
    this.countdown = 0;           // time since the lights sequence began
    this.lightsOutAt = 5 + 0.4 + Math.random() * 1.2;
    this.lightsOn = 0;
    const diff = DIFFICULTY[difficulty] ?? DIFFICULTY.medium;
    const physics = this.carDef.physics;          // the AI's corner speeds and braking come from the car it drives
    this.profile = buildSpeedProfile(track, diff.grip, diff.safety, diff.brakeUse, physics);
    this.playerProfile = buildSpeedProfile(track, 1, 0.97, 0.9, physics); // for the cool-down lap
    this.cars = [];
    this.leaderTimes = new Float32Array(Math.ceil(((laps + 1) * track.length) / 10) + 10).fill(-1);
    this.events = [];             // messages for the HUD ("New best lap" etc.)

    // Grid: two columns, 8 m between rows, just behind the start line.
    // AI in team order, you (or everyone in an online room) at the back of the grid
    const n = Math.max(0, Math.min(aiCount, TEAMS.length - 1));
    const order = [...TEAMS.keys()].filter((k) => k !== 0).slice(0, n).map((k) => ({ teamIdx: k }));
    if (humans) humans.forEach((h, k) => order.push({ teamIdx: 0, human: h, id: 100 + k }));
    else order.push({ teamIdx: 0, human: { id: localId } }); // alone = pole position
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
        position: slot + 1, gap: 0, grid: slot + 1,
        // track limits: this lap invalid? which sectors? (and the same for the lap just finished)
        lapInvalid: false, offSec: [false, false, false], lastLapInvalid: false, lastOffSec: [false, false, false],
        strikes: 0, wasOff: false, // track limits broken this lap (cars allowed more than one), and off right now?
        crossedBack: false, // reversed back over the line: crossing it again carries on the same lap
      };
      if (!human) {
        const skill = diff.pace * (0.975 + Math.random() * 0.035) * (1 - slot * 0.0015); // front-runners a touch quicker
        car.ai = new AIDriver(state, track, this.profile, Math.min(skill, 1.02), diff.grip);
      }
      this.cars.push(car);
    });
    this.player = this.cars.find(c => c.isPlayer);
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
    const states = this.cars.filter((c) => !c.dnf).map((c) => c.state);
    // slipstream: how much each car here is in the wake of the car(s) ahead (slipstream.js; physics.js uses it)
    for (const car of this.cars) if (!car.dnf && !car.remote) car.state.tow = towFor(car.state, states);
    for (const car of this.cars) {
      if (car.dnf) continue;
      if (car.remote) { car.advance?.(dt); this.countLap(car); continue; } // driven from the network
      const input = car.ai ? car.ai.update(dt, states) : playerInput;
      stepCar(car.state, input, this.track, dt);
      this.updateLap(car);
      this.checkLimits(car);
      if (car.ai) { // AI wedged against a wall or another car for a while: put it back on the track (like pressing R)
        car.stuck = car.state.speed < 1.5 ? (car.stuck ?? 0) + dt : 0;
        if (car.stuck > 2.5) {
          const hw = this.track.hw[car.state.trackIndex] ?? 5;
          placeCar(car.state, this.track, car.state.s, (car.id % 2 ? 1 : -1) * Math.min(2, hw - 1.5));
          car.stuck = 0;
        }
      }
    }
    this.resolveContacts();
    this.updatePositions();
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
      car.lastLap = lap; car.lapStart = this.time;
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
    const L = this.track.length;
    // Leader's timestamp every 10 m → real time gaps for everyone else.
    const lead = sorted[0];
    const idx = Math.floor((lead.progress + L) / 10);
    for (let k = Math.max(0, idx - 3); k <= idx && k < this.leaderTimes.length; k++) {
      if (this.leaderTimes[k] < 0) this.leaderTimes[k] = this.time;
    }
    sorted.forEach((c, i) => {
      c.position = i + 1;
      if (i === 0) { c.gap = 0; return; }
      if (c.finishTime != null) { c.gap = c.finishTime - lead.finishTime; return; }
      const k = Math.floor((c.progress + L) / 10);
      const t = this.leaderTimes[Math.max(0, Math.min(k, this.leaderTimes.length - 1))];
      c.gap = t >= 0 ? this.time - t : 0;
    });
    this.standings = sorted;
  }

  // Each car is two circles (front and rear; their size and spacing come from the car's file in src/cars/).
  // Push overlapping cars apart and exchange momentum along the contact normal.
  // Online, a car driven from the network only moves when its owner says so: the local car takes the whole push.
  resolveContacts() {
    if (!this.collisions) return;
    const cars = this.cars;
    for (let a = 0; a < cars.length; a++) {
      for (let b = a + 1; b < cars.length; b++) {
        const ca = cars[a], cb = cars[b];
        if (ca.dnf || cb.dnf || (ca.remote && cb.remote)) continue;
        const wa = ca.remote ? 0 : cb.remote ? 1 : 0.5, wb = cb.remote ? 0 : ca.remote ? 1 : 0.5; // share of the push
        const A = ca.state, B = cb.state;
        if ((A.x - B.x) ** 2 + (A.z - B.z) ** 2 > 64) continue;
        const pa = A.spec?.physics ?? CAR, pb = B.spec?.physics ?? CAR, reach = pa.radius + pb.radius;
        const offA = pa.contactOffset ?? 1.4, offB = pb.contactOffset ?? 1.4;
        for (const oa of [offA, -offA]) {
          for (const ob of [offB, -offB]) {
            const ax = A.x + Math.sin(A.h) * oa, az = A.z + Math.cos(A.h) * oa;
            const bx = B.x + Math.sin(B.h) * ob, bz = B.z + Math.cos(B.h) * ob;
            let dx = bx - ax, dz = bz - az;
            const d = Math.hypot(dx, dz);
            if (d >= reach || d < 1e-4) continue;
            dx /= d; dz /= d;
            const push = reach - d;
            A.x -= dx * push * wa; A.z -= dz * push * wa;
            B.x += dx * push * wb; B.z += dz * push * wb;
            const rel = (B.vx - A.vx) * dx + (B.vz - A.vz) * dz;
            if (rel < 0) {
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