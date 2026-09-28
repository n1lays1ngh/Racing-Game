// AI drivers use exactly the same physics as the player. They follow the
// precomputed racing line with pure-pursuit steering and a speed profile.
import { CAR, clamp, steerLimit } from './physics.js';
import { HALF_WIDTH } from './track.js';

// Target speed at every sample: max cornering speed, then a backward pass
// so the car brakes early enough for the next corner.
// grip = extra grip the AI gets on this difficulty (1 = same as the player).
// grip: AI grip bonus; gripSafety: how close to the cornering limit it plans (1 = right on it);
// brakeUse: how much of the car's braking it plans to use (1 = all of it, latest braking).
export function buildSpeedProfile(track, grip = 1, gripSafety = 0.97, brakeUse = 0.9) {
  const { n, ds } = track;
  const v = new Float32Array(n);
  const mu = CAR.mu * grip * gripSafety;
  const vc = (i) => (track.vcurv ? track.vcurv[i] : 0);   // + dip, − crest
  const grade = (i) => (track.grade ? track.grade[i] : 0); // + uphill
  for (let i = 0; i < n; i++) {
    const k = track.rcurv[i];
    const denom = k - mu * CAR.downforce - mu * vc(i); // crests lower the corner speed
    const bankG = CAR.g * (1 + 0.5 * CAR.mu) * Math.sin(Math.abs(track.bank ? track.bank[i] : 0)); // banking helps
    v[i] = denom <= 1e-5 ? 95 : Math.min(95, Math.sqrt((mu * CAR.g + bankG) / denom));
    // Also slow enough that the steering has the lock for this corner.
    const lockNeeded = Math.atan(k * CAR.wheelbase) * 1.02; // small safety margin
    let lo = 0, hi = 95; // fastest speed that still has enough lock
    for (let it = 0; it < 20; it++) {
      const mid = (lo + hi) / 2;
      if (steerLimit(mid) >= lockNeeded) lo = mid; else hi = mid;
    }
    v[i] = Math.min(v[i], Math.max(lo, 5));
  }
  for (let loop = 0; loop < 2; loop++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = v[(i + 1) % n];
      const gEff = Math.max(CAR.g + vc(i) * next * next, 2);
      let brake = brakeUse * Math.min(CAR.brake, 1.2 * mu * (gEff + CAR.downforce * next * next));
      brake = Math.max(brake + CAR.g * grade(i), 5); // uphill helps, downhill hurts
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
    this.offset = 0; this.offsetTarget = 0; this.offsetTimer = 0;
  }

  update(dt, others) {
    const { car, track } = this;
    const i = car.trackIndex < 0 ? 0 : car.trackIndex;
    const v = Math.max(car.vf, 0);

    // --- Traffic: pick a side to overtake, don't rear-end anyone ---------
    let blockSpeed = Infinity;
    this.offsetTimer -= dt;
    for (const o of others) {
      if (o === car) continue;
      let gap = o.s - car.s;
      if (gap < -track.length / 2) gap += track.length;
      if (gap > track.length / 2) gap -= track.length;
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
    let lookDist = 5 + v * 0.28;
    const kAhead = Math.max(track.rcurv[i], track.rcurv[(i + Math.round(lookDist / track.ds)) % track.n]);
    if (kAhead > 1e-4) lookDist = Math.min(lookDist, 1.3 / kAhead);
    lookDist = Math.max(lookDist, 5);
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
    const steerAngle = Math.atan(curvature * CAR.wheelbase);
    const steer = clamp(steerAngle / steerLimit(v), -1, 1);

    // --- Throttle / brake ---------------------------------------------------
    // Look slightly further ahead at speed so the AI doesn't arrive at corners too fast.
    // Use the slowest target between here and a little way ahead.
    const ahead = 3 + Math.round((v * 0.12) / track.ds);
    let target = Infinity;
    for (let d = 0; d <= ahead; d++) target = Math.min(target, this.profile[(i + d) % track.n]);
    target *= this.skill;
    target = Math.min(target, blockSpeed);
    // Running out of steering lock (car drifting wide of the line)? Lift, and if it's
    // well past the limit, slow down until the lock is enough.
    const need = Math.abs(steerAngle), have = steerLimit(v);
    const wide = (car.lateral - (track.ro[i] + this.offset)) * Math.sign(steerAngle) < -WIDE; // outside of the line
    const hwHere = track.hw ? track.hw[i] : HALF_WIDTH;
    const room = hwHere + car.lateral * Math.sign(steerAngle); // tarmac left on the outside
    const outOfLock = need > have && v > 10 && wide && room < ROOM;
    if (outOfLock && need > have * LOCK_BRAKE) target = Math.min(target, Math.max(CAR.steerFade * (CAR.maxSteer / need - 1), 6));
    const err = target - v;
    let throttle = 0, brake = 0;
    if (err > 0 && !outOfLock) throttle = err > 1 ? 1 : 0.5 + err * 0.5;
    else if (err < -0.5) brake = clamp(-err / 3, 0.2, 1);
    // Recover if stuck facing the wrong way
    if (fwd < 0) { throttle = 0.5; }
    return { throttle, brake, steer, abs: true, grip: this.grip }; // AI never locks up
  }
}