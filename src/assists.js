// Driving assists for your car (pause menu → Settings, or the race setup): steering assist and brake assist, each Off,
// Low, Medium or High. They only change what your car is told to do, from the same racing line and speed plan the AI
// and the racing line on the track use (track.js; ai.js buildSpeedProfile and its steering), worked out for the car you
// drive. The AI cars are never touched. No rendering here: it runs in the headless sim too.
//
//   prepareAssists(race)                              when a race is set up (its speed plan: a moment's work)
//   applyAssists(race, input, { steer, brake }, dt) → the input your car gets this physics step (main.js, every step)
//
// Brake assist: when you're faster than the car can take what's coming (the speed plan a moment ahead), it brakes for you
// and takes the throttle away while it does; it also keeps the wheels from locking (at every level).
//   low     only steps in when you're well over the limit: you still do the braking
//   medium  brakes for you to just over the limit, and eases the throttle when you're running wide out of a corner
//   high    brakes to the limit, lifts the throttle at it and when you're running wide: you can keep the throttle
//           down all lap
// Steering assist: every level keeps you on the road (when the car runs toward the edge, it steers you back); medium
// and high also steer you along the racing line: medium does part of it, high all of it (let go and it drives the line).
// Steer yourself and it hands the steering back to you (the harder you steer, the more), so you can still pass and defend.
import { clamp, steerLimit } from './physics.js';
import { KERB_WIDTH, projectOnTrack } from './track.js';
import { AIDriver, AI_TUNE, buildSpeedProfile } from './ai.js';

export const ASSIST_LEVELS = ['off', 'low', 'medium', 'high'];
export const ASSIST_NAMES = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High' };
// what each level does, in a few words (the pause menu's Settings and the race setup)
export const ASSIST_NOTES = {
  steer: { off: 'all yours', low: 'keeps you on the road', medium: 'helps you round the racing line, keeps you on the road',
    high: 'steers the racing line for you (steer yourself to take over)' },
  brake: { off: 'all yours', low: 'brakes when you’re far too fast, no lock-ups', medium: 'brakes for the corners, no lock-ups',
    high: 'brakes and lifts for you: keep the throttle down' },
};
export const ASSISTS = {
  brake: {
    // margin: braking starts above the plan × this; gain: brake per m/s over; lift: eases off the throttle as you reach
    // the limit; wide: how much throttle it takes away when you're running wide, out of a corner
    low:    { margin: 1.04, gain: 0.3,  lift: false, wide: 0 },
    medium: { margin: 1.02, gain: 0.35, lift: false, wide: 0.5 },
    high:   { margin: 1.0,  gain: 0.5,  lift: true,  wide: 1 },
    lookahead: 0.3,   // s: it looks this far ahead in the plan (it brakes a moment early, so it gets there in time)
    minSpeed: 8,      // m/s: not below this (pulling away, the pit lane)
  },
  steer: {
    // line: how much of the steering toward the racing line it does for you when you aren't steering (0–1); give: how
    // much of that it hands back as you steer yourself (all of `give` by `override`); edge: how hard it keeps you on the road
    low:    { line: 0,    give: 0,   edge: 1.0 },
    medium: { line: 0.6,  give: 0.6, edge: 1.3 },
    high:   { line: 1.0,  give: 0.7, edge: 1.5 },
    override: 0.6,    // steering this hard (or harder) yourself: you've taken over as far as the level lets you
    look: [0.2, 0.4, 0.6], // s: keeping you on the road, it looks where you'll be this far ahead
    kerb: 0.6,        // … and lets you use this much of the kerb
    ramp: 1.5,        // … m past that, it's steering you back as hard as `edge` lets it
    minSpeed: 3,      // m/s
  },
};

const out = { throttle: 0, brake: 0, steer: 0, boost: false, abs: false }; // (one object, reused every step: no garbage)

// For each race: the speed plan the brake assist brakes to (your car's, as the AI plans its own, but with only the
// steering lock your car has: the AI gets a little extra in hairpins), and the driver that works out the steering along
// the racing line (only its steering is used: it never drives your car)
const races = new WeakMap();
export function prepareAssists(race) { // (main.js: while the race loads, so nothing is worked out when the lights go out)
  let c = races.get(race);
  if (!c || c.car !== race.player?.state) {
    const lock = AI_TUNE.lockBonus, hairpin = AI_TUNE.hairpin.bonus;
    AI_TUNE.lockBonus = 1; AI_TUNE.hairpin.bonus = 0;
    let profile;
    try { profile = buildSpeedProfile(race.track, 1, 0.97, 0.9, race.carDef?.physics); } finally { AI_TUNE.lockBonus = lock; AI_TUNE.hairpin.bonus = hairpin; }
    c = { car: race.player?.state, profile, driver: null };
    races.set(race, c);
  }
  return c;
}
function lineDriver(race, c) {
  return (c.driver ??= new AIDriver(race.player.state, race.track, c.profile, 1));
}

// Where the car will be if it keeps going as it is (the way it's moving, turning as fast as it is), checked at
// ASSISTS.steer.look seconds ahead: the first time it's off the road → { t, over (m past the edge), side (+1 left) }
const found = { t: 0, over: 0, side: 0 };
function ahead(st, t) {
  const E = ASSISTS.steer, v = Math.hypot(st.vx, st.vz), r = st.yawRate ?? 0;
  if (v < 1) return null;
  const a0 = Math.atan2(st.vx, st.vz), kerb = (t.kerb ?? KERB_WIDTH) * E.kerb;
  let hint = st.trackIndex;
  for (const tk of E.look) {
    // along an arc: turning at r for tk seconds at speed v (a straight line if it isn't turning)
    const a = a0 + r * tk, d = Math.abs(r) > 1e-4 ? null : v * tk;
    const x = d != null ? st.x + Math.sin(a0) * d : st.x + (v / r) * (Math.cos(a0) - Math.cos(a));
    const z = d != null ? st.z + Math.cos(a0) * d : st.z + (v / r) * (Math.sin(a) - Math.sin(a0));
    const q = projectOnTrack(t, x, z, hint); hint = q.i;
    const over = Math.abs(q.lateral) - (t.hw[q.i] + kerb);
    if (over > 0) { found.t = tk; found.over = over; found.side = Math.sign(q.lateral); return found; }
  }
  return null;
}

export function applyAssists(race, input, levels, dt) {
  const B = ASSISTS.brake[levels?.brake], S = ASSISTS.steer[levels?.steer];
  if (!B && !S) return input;                                   // both off: exactly what you pressed
  const car = race.player, st = car?.state, t = race.track;
  if (!st || race.state !== 'racing' || car.finishTime != null || car.dnf || st.inPitLane || st.trackIndex < 0) return input;
  const c = prepareAssists(race), i = st.trackIndex, n = t.n, ds = t.ds, v = st.vf;
  let throttle = input.throttle, brake = input.brake, steer = input.steer;

  // where the car is heading: off the road a moment from now? (both assists use it; null if not, or already off)
  const onRoad = Math.abs(st.lateral) < t.hw[i] + (t.kerb ?? KERB_WIDTH); // (already off: no tugging you about out there)
  const path = onRoad && ((S && S.edge > 0) || B?.wide) && v > ASSISTS.steer.minSpeed ? ahead(st, t) : null;

  // ---- steering assist ----
  if (S && v > ASSISTS.steer.minSpeed) {
    if (S.line > 0) { // the racing line: steered as an AI driver would steer your car along it (ai.js, the same code)
      const drv = lineDriver(race, c), auto = clamp(drv.update(dt, race.cars).steer * drv.lockNow, -1, 1); // (its extra lock → yours)
      const w = S.line * (1 - S.give * clamp(Math.abs(steer) / ASSISTS.steer.override, 0, 1));
      steer += (auto - steer) * w;
    }
    // keep it on the road: where the car is going, as it's going now (its speed, the way it's moving and how fast it's
    // turning), a few moments ahead. If that's off the road (past the white line and a little of the kerb), it steers
    // back by about as much as it takes to stay on: more the further off, up to `edge` times that
    if (S.edge > 0 && path) {
      const p = st.spec?.physics, base = p?.steerBase ?? p?.wheelbase ?? 3.6, vv = Math.max(v, 5);
      const need = (2 * path.over) / (path.t * path.t);                     // m/s² more toward the middle to stay on
      const angle = Math.atan((need * base) / (vv * vv));                   // the steering angle for that
      const k = S.edge * clamp(path.over / ASSISTS.steer.ramp, 0.25, 1);
      steer += -path.side * k * (angle / steerLimit(v, p));
    }
    steer = clamp(steer, -1, 1);
  }

  // ---- brake assist ----
  if (B && v > ASSISTS.brake.minSpeed) {
    const prof = c.profile, k = Math.max(1, Math.round((v * ASSISTS.brake.lookahead) / ds));
    let limit = Math.min(prof[i], prof[(i + k) % n]);
    // worn tyres or a damaged car take a corner slower than the plan (made for fresh tyres and a whole car)
    limit *= Math.sqrt(clamp((st.tyreGrip ?? 1) * (st.damage?.fx?.grip ?? 1), 0.5, 1.1));
    const over = v - limit * B.margin;
    if (over > 0) {
      const b = clamp(over * B.gain, 0, 1);
      brake = Math.max(brake, b);
      throttle = Math.min(throttle, b > 0.3 ? 0 : 1 - b / 0.3); // (no throttle against the brakes)
    } else if (B.lift && over > -1.5) {
      throttle = Math.min(throttle, clamp(-over / 1.5, 0, 1));  // high: ease off as you reach the limit
    }
  }
  // running wide (out of a corner, on the throttle): where the car's heading is off the road → off the throttle (medium:
  // partly), and on high a touch of brake if it's well off, so the car tightens its line
  if (B?.wide && path && v > ASSISTS.brake.minSpeed) {
    const f = clamp(path.over / 0.8, 0, 1);
    throttle = Math.min(throttle, 1 - B.wide * f);
    if (B.lift) brake = Math.max(brake, 0.25 * clamp(path.over - 1, 0, 1));
  }

  Object.assign(out, input); // (anything else the input carries, as it is)
  out.throttle = throttle; out.brake = brake; out.steer = steer;
  out.abs = !!B || !!input.abs;   // (brake assist: the wheels don't lock, at every level)
  return out;
}