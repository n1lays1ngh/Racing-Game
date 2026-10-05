// AI drivers use exactly the same physics as the player. They follow the
// precomputed racing line with pure-pursuit steering and a speed profile, and use the ERS battery
// boost (ers.js) out of corners and on the straights, keeping some back for attacking and defending.
import { CAR, clamp, steerLimit } from './physics.js';
import { HALF_WIDTH } from './track.js';

export const AI_TUNE = {
  // Hairpins and other very tight corners: the AI gets this much more steering lock than the base car
  // (like its grip bonus, see DIFFICULTY in race.js), so it takes them at a real hairpin speed instead
  // of crawling round. 1 = same lock as you; 1.2 ≈ 45–50 km/h through a Monaco-style hairpin.
  lockBonus: 1.2,
  // Corners slower than `below` (m/s; 25 = 90 km/h) are planned this much faster. 1 = off.
  slowCorners: { below: 25, boost: 1.04 },
  minWideSpeed: 9,    // when it runs wide in a tight corner it slows to no less than this (m/s) to get back on line
  ers: {
    straight: 1.6,    // deploys when the road ahead is clear to accelerate for this many seconds
    reserve: [0.1, 0.4], // charge each driver keeps back (picked at random per driver) …
    attack: 45,       // … but spends it when a car is this close ahead (metres)
    defend: 15,       // … or this close behind
  },
};
const VMAX = 120; // planned speed on straights (above what the car can reach, so the AI never lifts there)

// Target speed at every sample: max cornering speed, then a backward pass
// so the car brakes early enough for the next corner.
// grip = extra grip the AI gets on this difficulty (1 = same as the player).
// grip: AI grip bonus; gripSafety: how close to the cornering limit it plans (1 = right on it);
// brakeUse: how much of the car's braking it plans to use (1 = all of it, latest braking);
// p: the car's physics (its file in src/cars/), since every kind of car has its own corner speeds.
export function buildSpeedProfile(track, grip = 1, gripSafety = 0.97, brakeUse = 0.9, p = CAR) {
  const { n, ds } = track;
  const v = new Float32Array(n);
  const mu = p.mu * grip * gripSafety;
  const vc = (i) => (track.vcurv ? track.vcurv[i] : 0);   // + dip, − crest
  const grade = (i) => (track.grade ? track.grade[i] : 0); // + uphill
  for (let i = 0; i < n; i++) {
    const k = track.rcurv[i];
    const denom = k - mu * p.downforce - mu * vc(i); // crests lower the corner speed
    const bankG = p.g * (1 + 0.5 * p.mu) * Math.sin(Math.abs(track.bank ? track.bank[i] : 0)); // banking helps
    v[i] = denom <= 1e-5 ? VMAX : Math.min(VMAX, Math.sqrt((mu * p.g + bankG) / denom));
    if (v[i] < AI_TUNE.slowCorners.below) v[i] *= AI_TUNE.slowCorners.boost; // a little braver in slow corners
    // Also slow enough that the steering has the lock for this corner (with the AI's extra lock).
    const lockNeeded = Math.atan(k * (p.steerBase ?? p.wheelbase)) * 1.02; // small safety margin
    let lo = 0, hi = VMAX; // fastest speed that still has enough lock
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2;
      if (steerLimit(mid, p) * AI_TUNE.lockBonus >= lockNeeded) lo = mid; else hi = mid;
    }
    v[i] = Math.min(v[i], Math.max(lo, 5));
  }
  for (let loop = 0; loop < 2; loop++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = v[(i + 1) % n];
      const gEff = Math.max(p.g + vc(i) * next * next, 2);
      let brake = brakeUse * Math.min(p.brake, 1.2 * mu * (gEff + p.downforce * next * next));
      brake = Math.max(brake + p.g * grade(i), 5); // uphill helps, downhill hurts
      v[i] = Math.min(v[i], Math.sqrt(next * next + 2 * brake * ds));
    }
  }
  return v;
}

// When the AI runs out of steering lock and drifts wide of its line:
const WIDE = 1;         // metres outside the line before it reacts
const ROOM = 3;         // ...and less than this much tarmac left on the outside
const LOCK_BRAKE = 1.3; // needs 30% more lock than it has → brake, not just lift

export class AIDriver {
  constructor(car, track, profile, skill = 0.93, grip = 1) {
    this.car = car; this.track = track; this.profile = profile;
    this.skill = skill; this.grip = grip;
    this.p = car.spec?.physics ?? CAR;                   // the car it's driving (src/cars/)
    this.offset = 0; this.offsetTarget = 0; this.offsetTimer = 0;
    const [r0, r1] = AI_TUNE.ers.reserve;
    this.ersReserve = r0 + Math.random() * (r1 - r0);   // some drivers save more battery than others
    this.usesErs = skill > 0.8 && (car.spec ? !!car.spec.ers : true); // (not on your cool-down lap; not if the car has none)
  }

  update(dt, others) {
    const { car, track, p } = this;
    const i = car.trackIndex < 0 ? 0 : car.trackIndex;
    const v = Math.max(car.vf, 0);

    // --- Traffic: pick a side to overtake, don't rear-end anyone ---------
    let blockSpeed = Infinity, ahead = Infinity, behind = Infinity; // nearest car ahead / behind (metres)
    this.offsetTimer -= dt;
    for (const o of others) {
      if (o === car) continue;
      let gap = o.s - car.s;
      if (gap < -track.length / 2) gap += track.length;
      if (gap > track.length / 2) gap -= track.length;
      if (gap > 0) ahead = Math.min(ahead, gap); else behind = Math.min(behind, -gap);
      const dLat = o.lateral - (car.lateral);
      if (gap > 0 && gap < 30 && Math.abs(dLat) < 3) {
        // Only pull out to pass where the track is fairly straight, and not wider than the road allows.
        const straight = track.rcurv[i] < 1 / 150 && track.rcurv[(i + 15) % track.n] < 1 / 150;
        if (this.offsetTimer <= 0 && v > o.speed - 1 && straight) {
          const side = Math.min(3.5, Math.max((track.hw ? track.hw[i] : HALF_WIDTH) - 2.5, 1));
          this.offsetTarget = dLat > 0 ? -side : side;
          this.offsetTimer = 2.5;
        }
        if (gap < 12) blockSpeed = Math.min(blockSpeed, o.speed - 1 + gap * 0.3);
      }
    }
    if (this.offsetTimer <= 0) this.offsetTarget = 0;
    this.offset += clamp(this.offsetTarget - this.offset, -2 * dt, 2 * dt);

    // --- Steering: pure pursuit on the racing line ------------------------
    // Look less far ahead in tight corners so the AI doesn't cut across them.
    // When it has run wide (last step), aim further along the line so it rejoins gradually.
    let lookDist = 5 + v * 0.28;
    const kAhead = Math.max(track.rcurv[i], track.rcurv[(i + Math.round(lookDist / track.ds)) % track.n]);
    if (kAhead > 1e-4) lookDist = Math.min(lookDist, 1.3 / kAhead);
    lookDist = Math.max(lookDist, 5) * (this.wasWide ? 1.5 : 1);
    const j = (i + Math.round(lookDist / track.ds)) % track.n;
    const lim = Math.max((track.hw ? track.hw[j] : HALF_WIDTH) - 1.2, 0.5); // stay on the tarmac
    const off = clamp(track.ro[j] + this.offset, -lim, lim) - track.ro[j];
    const tx = track.rx[j] + track.nx[j] * off;
    const tz = track.rz[j] + track.nz[j] * off;
    const dx = tx - car.x, dz = tz - car.z;
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    const fwd = dx * fx + dz * fz, left = dx * fz - dz * fx;
    const ld2 = Math.max(fwd * fwd + left * left, 1);
    const curvature = (2 * left) / ld2;
    const steerAngle = Math.atan(curvature * (p.steerBase ?? p.wheelbase));
    const lockHere = steerLimit(v, p) * AI_TUNE.lockBonus;  // the AI's steering lock at this speed
    const steer = clamp(steerAngle / lockHere, -1, 1);

    // --- Throttle / brake ---------------------------------------------------
    // Look slightly further ahead at speed so the AI doesn't arrive at corners too fast.
    // Use the slowest target between here and a little way ahead.
    const look = 3 + Math.round((v * 0.12) / track.ds);
    let target = Infinity;
    for (let d = 0; d <= look; d++) target = Math.min(target, this.profile[(i + d) % track.n]);
    target *= this.skill;
    target = Math.min(target, blockSpeed);
    // Running out of steering lock (car drifting wide of the line)? Lift, and if it's
    // well past the limit, slow down until the lock is enough (but not to a crawl: it also aims
    // further along the line, above, so it needs less lock to get back).
    const need = Math.abs(steerAngle), have = lockHere;
    const wide = (car.lateral - (track.ro[i] + this.offset)) * Math.sign(steerAngle) < -WIDE; // outside of the line
    this.wasWide = wide && need > have;
    const hwHere = track.hw ? track.hw[i] : HALF_WIDTH;
    const room = hwHere + car.lateral * Math.sign(steerAngle); // tarmac left on the outside
    const outOfLock = need > have && v > 10 && wide && room < ROOM;
    if (outOfLock && need > have * LOCK_BRAKE) {
      const fits = p.steerFade * ((p.maxSteer * AI_TUNE.lockBonus) / need - 1);       // speed at which the lock is enough
      target = Math.min(target, Math.max(fits, AI_TUNE.minWideSpeed));
    }
    const err = target - v;
    let throttle = 0, brake = 0;
    if (err > 0 && !outOfLock) throttle = err > 1 ? 1 : 0.5 + err * 0.5;
    else if (err < -0.5) brake = clamp(-err / 3, 0.2, 1);
    // Recover if stuck facing the wrong way
    if (fwd < 0) { throttle = 0.5; }

    // --- ERS (ers.js) -----------------------------------------------------
    // Deploy when flat out with clear road to accelerate (out of corners, down the straights), keeping
    // a reserve unless there's a car to attack or keep behind; a full battery is always used (braking
    // into the next corner would be wasted otherwise).
    let boost = false;
    if (this.usesErs && throttle >= 0.9 && v > 8 && !outOfLock && fwd > 0) {
      const charge = car.ers ?? 1, span = Math.round((v * AI_TUNE.ers.straight) / track.ds);
      let clear = true;
      for (let d = 0; d <= span && clear; d += 2) clear = this.profile[(i + d) % track.n] * this.skill > v + 6;
      const fight = ahead < AI_TUNE.ers.attack || behind < AI_TUNE.ers.defend;
      boost = clear && (charge > 0.97 || charge > (fight ? 0.02 : this.ersReserve));
    }
    // AI never locks up; `lock`: its extra steering lock (AI_TUNE.lockBonus, physics.js)
    return { throttle, brake, steer, boost, abs: true, grip: this.grip, lock: AI_TUNE.lockBonus };
  }
}