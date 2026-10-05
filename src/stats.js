// Your driving stats, recorded while you drive and kept in this browser (localStorage):
//   overall    time on track, distance, laps (and how many were clean), races, wins, podiums, top speed
//   per lap    time, the three sectors, top speed, clean or off track, practice / race / online, the car
//   per circuit fastest lap (valid laps only), best sectors (→ theoretical best), average lap, races,
//              wins, podiums, best and average finish, time on track, distance, top speed
// Records are per circuit and per car (src/cars/): a GT3 lap doesn't compete with an F1 lap. The overall
// totals count every car; each car also has its own totals. Stats saved before cars had their own records
// (version 1) were all driven in the F1 car, so they become the F1 car's when they're first read.
// The stats screen (statsScreen.js, main menu → Your stats) shows them.
//
//   const run = new StatsRun(race, { online })   main.js, when a race or practice session starts
//   run.update(dt, counting)   every frame (counting: false while a solo race is paused)
//   run.lap(event)             a 'lap' event from race.js → { lap, best, prevBest }
//   run.finish()               you took the chequered flag
//   run.end()                  you left / restarted / closed the page (safe to call twice)
//   run.flush()                save what's been driven so far (tab hidden)
//   getStats(car)              one car's records, laps, sessions and totals, for the stats screen
//   getStats()                 everything (the overall totals in .total)
//   resetStats()               wipe it all
//
// Units: times in seconds, distances in metres, speeds in km/h, dates in ms (Date.now()).
// "Clean" (shown as "valid") = the lap wasn't invalidated: track limits, or a reset with R. race.js decides that
// (TRACK_LIMITS) and puts it in the 'lap' event, so the HUD and your stats always agree. Only valid laps can be
// your fastest lap, and only sectors you stayed on track in count as best sectors.
// Sectors are the same thirds of the lap as the HUD's S1 / S2 / S3. Lap 1 starts from the grid, so it
// doesn't count towards the average lap.

const KEY = 'apex-circuit:stats';
const VERSION = 2;
const FIRST_CAR = 'f1'; // laps and sessions saved without a car were driven in this one
export const LIMITS = { laps: 3000, races: 500 }; // the lap and session logs keep the newest this many; totals and records keep everything
const r3 = (t) => Math.round(t * 1000) / 1000;

const blankTotal = () => ({ time: 0, dist: 0, laps: 0, cleanLaps: 0, sessions: 0, races: 0, finished: 0, wins: 0, podiums: 0, top: 0 });
function blank() {
  return {
    v: VERSION, since: Date.now(),
    total: blankTotal(), // every car
    cars: {},     // car id → { total, circuits: { circuit id → see blankCircuit() } }
    laps: [],     // { c, car, t, n, at, clean, s: [s1, s2, s3]?, top, mode, diff?, standing? }   oldest first
    races: [],    // { c, car, at, mode, diff?, laps, done, field, grid?, pos?, result, best?, total? }  oldest first
  };
}
function blankCircuit() {
  return {
    time: 0, dist: 0, top: 0, laps: 0, cleanLaps: 0,
    flySum: 0, flyN: 0,                  // flying laps (not lap 1), for the average
    bestClean: null,                     // your record here: fastest valid lap { t, at, clean, mode, diff?, s? }
    best: null,                          // (the same; older saves could have an invalid lap here, so the screen uses bestClean)
    bestSec: [null, null, null],         // from sectors without track-limits trouble
    sessions: 0, races: 0, finished: 0, wins: 0, podiums: 0, bestPos: null, posSum: 0,
    first: null, last: null,
  };
}

// ---------- storage ----------
let data = null, dirty = false, saveQueued = false;

function read() {
  try {
    let d = JSON.parse(localStorage.getItem(KEY));
    // version 1 (before each car had its own records): everything in it was driven in the F1 car
    if (d && d.v === 1 && d.total && d.circuits) {
      d = { v: VERSION, since: d.since, total: d.total, cars: { [FIRST_CAR]: { total: { ...d.total }, circuits: d.circuits } },
        laps: d.laps, races: d.races };
    }
    if (d && d.v === VERSION && d.total && d.cars) {
      const b = blank();
      return { ...b, ...d, total: { ...b.total, ...d.total }, laps: d.laps ?? [], races: d.races ?? [] };
    }
  } catch { /* nothing saved yet, or it couldn't be read */ }
  return blank();
}
const db = () => (data ??= read());
// one car's records and totals (made when you first drive it)
const carsFilledIn = new WeakSet(); // car entries already given any fields they were missing
function carOf(car) {
  const all = db().cars, c = (all[car] ??= { total: blankTotal(), circuits: {} });
  if (!carsFilledIn.has(c)) { c.total = Object.assign(blankTotal(), c.total); c.circuits ??= {}; carsFilledIn.add(c); }
  return c;
}
const filledIn = new WeakSet(); // circuit records already given any fields they were missing
function circuitOf(car, id) {
  const all = carOf(car).circuits;
  if (!all[id] || !filledIn.has(all[id])) { all[id] = Object.assign(blankCircuit(), all[id] ?? {}); filledIn.add(all[id]); }
  return all[id];
}

function save() {
  saveQueued = false;
  if (!dirty || !data) return;
  for (let k = 0; k < 4; k++) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); dirty = false; return; } catch (err) {
      const full = err?.name === 'QuotaExceededError' || err?.code === 22;
      if (!full || data.laps.length < 50) { console.warn('Stats: could not save', err); return; } // private mode or similar
      data.laps.splice(0, Math.ceil(data.laps.length / 2));   // storage full: drop the older half of the logs
      data.races.splice(0, Math.ceil(data.races.length / 2)); // (totals and records stay)
    }
  }
}
// Save when the browser has a moment, so writing never lands on the frame you cross the line.
function saveSoon() {
  dirty = true;
  if (saveQueued) return;
  saveQueued = true;
  if (typeof requestIdleCallback === 'function') requestIdleCallback(save, { timeout: 2000 });
  else setTimeout(save, 400);
}

// For the stats screen. Read fresh (another tab may have raced meanwhile) unless there's unsaved driving.
// car: just that car's (its records, laps and sessions, and its totals in .total); none = everything.
export function getStats(car = null) {
  if (!dirty) data = read();
  const d = db();
  if (!car) return d;
  const own = d.cars[car] ?? { total: blankTotal(), circuits: {} }, mine = (x) => (x.car ?? FIRST_CAR) === car;
  return { ...d, car, total: { ...blankTotal(), ...own.total }, circuits: own.circuits, laps: d.laps.filter(mine), races: d.races.filter(mine) };
}

export function resetStats() {
  data = blank(); dirty = true; save();
}

// ---------- recording one race / practice session ----------
export class StatsRun {
  constructor(race, { online = false } = {}) {
    if (!dirty) data = read();                 // pick up anything another tab saved
    this.race = race; this.id = race.track.id; this.L = race.track.length;
    this.car = race.carDef?.id ?? FIRST_CAR;     // which car: records are per circuit and per car
    this.field = race.cars.length;
    this.mode = online ? 'online' : this.field > 1 ? 'race' : 'practice';
    this.diff = race.cars.some((c) => c.ai && !c.isPlayer) ? race.difficulty : null; // AI skill, if there were AI cars
    this.time = 0; this.dist = 0; this.top = 0; // driven since the last commit (top: this whole session)
    this.started = false; this.ended = false; this.finished = false;
    this.lapsDone = race.player.lapsDone;
    this.newLap();
    this.prevS = null; this.prevT = null;
    this.saveIn = 60;
  }

  newLap() {
    this.cross = [null, null]; // race clock when you passed 1/3 and 2/3 of the lap
    this.lapTop = 0;
  }

  update(dt, counting) {
    if (this.ended) return;
    const race = this.race, p = race.player, st = p.state;
    if (p.lapsDone !== this.lapsDone) {        // crossed the line (race.js has already sent the 'lap' event)
      if (p.lapsDone > this.lapsDone) this.newLap();
      this.lapsDone = p.lapsDone;
    }
    if (race.state === 'countdown') return;
    if (!this.started) {                        // lights out: a session (and a race, if there are rivals)
      this.started = true;
      const d = db(), c = circuitOf(this.car, this.id), t = carOf(this.car).total;
      d.total.sessions++; t.sessions++; c.sessions++;
      if (this.mode !== 'practice') { d.total.races++; t.races++; c.races++; }
      c.first ??= Date.now(); c.last = Date.now();
      saveSoon();
    }
    const driving = p.finishTime == null && !p.dnf;
    if (!driving) return;
    if (counting) { this.time += dt; this.dist += st.speed * dt; }
    const kmh = st.speed * 3.6;
    if (kmh > this.top) this.top = kmh;
    if (kmh > this.lapTop) this.lapTop = kmh;
    if (p.lapsDone >= 0) {
      // sector splits: when you passed 1/3 and 2/3 of the lap (between this frame and the last)
      if (this.prevS != null && st.s > this.prevS && st.s - this.prevS < this.L / 2) {
        for (let k = 0; k < 2; k++) {
          const b = (this.L * (k + 1)) / 3;
          if (this.prevS < b && st.s >= b) this.cross[k] = this.prevT + ((b - this.prevS) / (st.s - this.prevS)) * (race.time - this.prevT);
        }
      }
    }
    this.prevS = st.s; this.prevT = race.time;
    this.saveIn -= dt;
    if (this.saveIn <= 0) { this.saveIn = 60; this.commit(); } // now and then, in case the browser crashes
  }

  // A lap from race.js: { lap, time, at, valid, offSec }. Returns { lap: the record, best: new circuit record?, prevBest }.
  lap(e) {
    if (this.ended) return null;
    const d = db(), c = circuitOf(this.car, this.id), t = carOf(this.car).total;
    const start = e.at - e.time, [b1, b2] = this.cross;
    const off = e.offSec ?? [false, false, false]; // sectors where you broke track limits (or reset)
    const rec = {
      c: this.id, car: this.car, t: r3(e.time), n: e.lap, at: Date.now(),
      clean: e.valid !== false, top: Math.round(this.lapTop), mode: this.mode,
    };
    if (b1 != null && b2 != null && b1 > start && b2 > b1 && b2 < e.at) rec.s = [r3(b1 - start), r3(b2 - b1), r3(e.at - b2)];
    if (this.diff) rec.diff = this.diff;
    if (e.lap === 1) rec.standing = true; // from the grid

    const prevBest = c.bestClean?.t ?? null;
    const brief = () => ({ t: rec.t, at: rec.at, clean: rec.clean, mode: rec.mode, ...(rec.diff ? { diff: rec.diff } : {}), ...(rec.s ? { s: rec.s } : {}) });
    const best = rec.clean && (prevBest == null || rec.t < prevBest); // an invalidated lap can't be a record
    if (best) c.best = c.bestClean = brief();
    if (rec.s) rec.s.forEach((v, k) => { if (!off[k] && (c.bestSec[k] == null || v < c.bestSec[k])) c.bestSec[k] = v; });

    c.laps++; d.total.laps++; t.laps++;
    if (rec.clean) { c.cleanLaps++; d.total.cleanLaps++; t.cleanLaps++; }
    if (!rec.standing) { c.flySum += rec.t; c.flyN++; }
    c.last = rec.at;
    d.laps.push(rec);
    if (d.laps.length > LIMITS.laps) d.laps.splice(0, d.laps.length - LIMITS.laps);
    this.commit();
    return { lap: rec, best, prevBest };
  }

  finish() {
    if (this.ended || this.finished) return;
    this.finished = true;
    this.commit();
    this.logSession('finished');
  }

  // Add the time and distance driven so far to the totals, and save soon.
  commit() {
    if (!this.started) return;
    const d = db(), c = circuitOf(this.car, this.id), t = carOf(this.car).total, top = Math.round(this.top);
    d.total.time += this.time; t.time += this.time; c.time += this.time;
    d.total.dist += this.dist; t.dist += this.dist; c.dist += this.dist;
    d.total.top = Math.max(d.total.top, top); t.top = Math.max(t.top, top); c.top = Math.max(c.top, top);
    c.last = Date.now();
    this.time = 0; this.dist = 0;
    saveSoon();
  }

  flush() { this.commit(); save(); }

  end() {
    if (this.ended) return;
    this.commit();
    if (!this.finished) this.logSession('retired'); // left before the flag (quit, restart, lost the connection)
    this.ended = true;
    save(); // straight away: the page may be closing
  }

  logSession(result) {
    if (!this.started) return; // never got past the start lights
    const d = db(), c = circuitOf(this.car, this.id), t = carOf(this.car).total, p = this.race.player, isRace = this.mode !== 'practice';
    const r = { c: this.id, car: this.car, at: Date.now(), mode: this.mode, laps: this.race.laps, done: Math.max(0, p.lapsDone), field: this.field, result };
    if (this.diff) r.diff = this.diff;
    if (p.bestLap != null) r.best = r3(p.bestLap);
    if (isRace) r.grid = p.grid;
    if (result === 'finished') {
      r.total = r3(p.finishTime);
      if (isRace) {
        r.pos = p.position;
        d.total.finished++; t.finished++; c.finished++; c.posSum += p.position;
        if (p.position === 1) { d.total.wins++; t.wins++; c.wins++; }
        if (p.position <= 3) { d.total.podiums++; t.podiums++; c.podiums++; }
        c.bestPos = c.bestPos == null ? p.position : Math.min(c.bestPos, p.position);
      }
    }
    d.races.push(r);
    if (d.races.length > LIMITS.races) d.races.splice(0, d.races.length - LIMITS.races);
    saveSoon();
  }
}