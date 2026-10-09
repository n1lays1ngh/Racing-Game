// Pit stops: every car has a box in front of its garage (the pit building's bays, venue.js), the AI has a strategy
// (when to stop), and the stop itself: in the pit lane the car drives itself (the AI's driving, ai.js) to its box,
// stops, is serviced for its stop time, and drives out; you get your car back at the end of the lane. Like the F1
// games: drive into the pit lane (or ask to box, B, and follow the line) and the team takes over.
// No rendering here (race.js runs it, so pit stops work in the headless sim too). The crews you see: pitcrew.js.
//
//   race.pits = new PitStops(race)   (race.js)
//   race.pits.update(car, dt)        every physics step, before the car's input is worked out
//   car.box  { i, s, lat, bay }      its box: track sample, lap distance, lateral (signed), which bay
//   car.pit  { state, stops, last, timer, total }   state: 'none' | 'in' (heading for the box) | 'stop' | 'out'
//   car.pitLaps                      the laps an AI car stops at the end of (its strategy)
//   car.boxCall                      you've asked to box (main.js, B): the stop happens when you reach the pit lane
// Events (race.events): { type: 'pitIn', car } when your car's stop starts, { type: 'pitStop', car, time } when it's done.
import { pitRoute, PITLANE } from './pitlane.js';
import { AIDriver } from './ai.js';
import { TYRES } from './tyres.js';
import { needsRepair, repairTime } from './damage.js';

export const PITSTOP = {
  time: 2.4,             // seconds stationary, unless the car's file says (pitStop.time in src/cars/)
  spread: 0.12,          // AI stops vary by up to this share either way …
  slow: { chance: 0.06, extra: [1.5, 4] },  // … and now and then one goes wrong (a stuck wheel nut): seconds added
  approach: 450,         // metres before the pit entry from which a car that's stopping this lap heads for it
  minLaps: 4,            // races shorter than this: the AI doesn't stop
  twoStops: 30,          // races this long or longer: two stops
  toBox: 40,             // metres over which a car swings from the fast lane into its box (and back out)
};

const mod = (v, m) => ((v % m) + m) % m;
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// The boxes: two per piece of the pit building (the same pieces venue.js builds), in front of the garages in the
// working lane. One per car, spread along the building.
function makeBoxes(t, lane, count) {
  const pit = lane.pit, chunks = Math.max(1, Math.round(pit.len / PITLANE.garagePiece)), clen = pit.len / chunks, bays = [];
  for (let c = 0; c < chunks; c++) for (const f of [0.25, 0.75]) bays.push(pit.s + (c + f) * clen);
  const boxes = [];
  for (let k = 0; k < count; k++) {
    const bay = Math.min(bays.length - 1, Math.floor((k * bays.length) / count)), s = mod(bays[bay], t.length);
    const i = Math.floor(s / t.ds) % t.n;
    if (!lane.range[i]) continue;
    const work = lane.inner[i] + PITLANE.fastLane, mid = work + (lane.out[i] - work) / 2; // the working lane's middle …
    const lat = lane.side * Math.max(lane.inner[i] + 1.5, Math.min(lane.out[i] - 1.6, mid)); // … inside the lane where it's narrow
    boxes.push({ i, s, lat, bay });
  }
  return boxes;
}

// The line into a box: the way into the pits (pitlane.js pitRoute, down the fast lane), swinging over to the box
function boxRoute(t, base, box) {
  const o = Float32Array.from(base.offsets), K = Math.round(PITSTOP.toBox / t.ds);
  for (let k = -K - 3; k <= K + 3; k++) {
    const i = mod(box.i + k, t.n);
    const f = k < -3 ? smooth((k + K + 3) / K) : k > 3 ? smooth((K + 3 - k) / K) : 1;
    o[i] = base.offsets[i] + (box.lat - base.offsets[i]) * f;
  }
  return o;
}

export class PitStops {
  constructor(race) {
    this.race = race;
    const t = race.track, lane = t.pitLane;
    this.lane = lane;
    this.base = lane ? pitRoute(t) : null;
    const boxes = lane ? makeBoxes(t, lane, race.cars.length) : [];
    race.cars.forEach((c, k) => {
      c.box = boxes.length ? boxes[k % boxes.length] : null;
      if (c.box) c.box.route ??= boxRoute(t, this.base, c.box);
      c.pit = { state: 'none', stops: 0, last: null, timer: 0, total: 0, lap: -1 };
    });
    this.stopTime = race.carDef.pitStop?.time ?? PITSTOP.time;
  }

  // The AI's strategy: it stops when its tyres are worn (car.wearLimit, tyres.js), and in a race that needs two
  // compounds it stops by the lap planned here at the latest
  plan() {
    const L = this.race.laps;
    if (L < Math.max(PITSTOP.minLaps, TYRES.twoCompounds)) return [];
    return [Math.min(L - 1, Math.max(2, Math.round(L * (0.35 + Math.random() * 0.3))))];
  }

  update(car, dt) {
    const race = this.race, t = race.track, lane = this.lane, st = car.state, p = car.pit;
    if (!lane || !car.box || car.remote || car.dnf || race.state !== 'racing') return;
    car.pitLaps ??= car.ai && car.finishTime == null ? this.plan() : [];
    const k = mod(st.trackIndex - lane.i0, t.n), inRange = k <= lane.steps;
    if (p.state === 'none') {
      const toEntry = mod(lane.entry - st.s, t.length), lap = car.lapsDone + 1;
      if (!car.wearLimit) car.wearLimit = 0.7 + Math.random() * 0.15; // (0 until set: race.js)
      const w = st.tyres?.wear, avg = w ? (w[0] + w[1] + w[2] + w[3]) / 4 : 0;
      const worn = avg >= car.wearLimit && (lap <= race.laps - 2 || avg >= 0.97); // (with a lap to go it nurses them home)
      const due = p.stops < car.pitLaps.length && lap >= car.pitLaps[p.stops]; // (the stop its strategy needs)
      const hurt = needsRepair(st) && lap < race.laps; // damaged (damage.js): in for repairs
      const ai = car.ai && car.finishTime == null && !car.retiring && p.lap !== lap && lap < race.laps && (due || worn || hurt); // stop now
      if ((ai && toEntry < PITSTOP.approach) || (car.isPlayer && !car.ai && st.inPitLane && inRange && k < lane.steps / 2 &&
        (car.boxCall || Math.abs(st.lateral) > t.hw[st.trackIndex] + t.kerb + 1.5))) { // (you: asked to box, or clearly into the lane, not on a kerb)
        p.state = 'in'; p.lap = lap; car.boxCall = false; st.autopilot = true; // (the team drives: no damage, damage.js)
        const driver = car.ai ?? (car.pitAI = new AIDriver(st, t, race.playerProfile, 0.95, 1)); // you: the team takes over
        driver.route = car.box.route; driver.stopAt = car.box; driver.hold = false;
        if (car.isPlayer) race.events.push({ type: 'pitIn', car });
      }
      return;
    }
    const driver = car.ai ?? car.pitAI;
    if (p.state === 'in') {
      const d = mod(car.box.s - st.s + t.length / 2, t.length) - t.length / 2; // metres to the box (− = past it)
      if (d < 1.5 && st.speed < 1.2) {
        p.state = 'stop'; driver.hold = true;
        st.vx = st.vz = st.vf = st.speed = 0; st.yawRate = 0;
        const slow = !car.isPlayer && Math.random() < PITSTOP.slow.chance;
        p.total = this.stopTime * (1 + (Math.random() - 0.5) * 2 * (car.isPlayer ? 0.03 : PITSTOP.spread))
          + (slow ? PITSTOP.slow.extra[0] + Math.random() * (PITSTOP.slow.extra[1] - PITSTOP.slow.extra[0]) : 0);
        p.repair = repairTime(st); p.total += p.repair; // fixing damage takes longer (damage.js)
        p.timer = p.total;
      } else if (!inRange && k < lane.steps + 100) this.done(car); // out the other end without stopping
    } else if (p.state === 'stop') {
      st.vx = st.vz = 0;
      p.timer -= dt;
      if (p.timer <= 0) {
        p.state = 'out'; p.stops++; p.last = p.total; driver.hold = false; driver.stopAt = null;
        this.onService?.(car); // (fresh tyres: section 3)
        race.events.push({ type: 'pitStop', car, time: p.total });
      }
    } else if (p.state === 'out' && !st.inPitLane && (!inRange || k > lane.steps - 3)) this.done(car);
  }

  done(car) {
    const driver = car.ai ?? car.pitAI;
    if (driver) { driver.route = null; driver.stopAt = null; driver.hold = false; }
    car.pitAI = null; car.pit.state = 'none'; car.state.autopilot = false;
  }
}