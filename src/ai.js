// AI drivers use exactly the same physics as the player. They follow the
// precomputed racing line with pure-pursuit steering and a speed profile.
import { CAR, clamp } from './physics.js';
import { HALF_WIDTH } from './track.js';

// Target speed at every sample: max cornering speed, then a backward pass
// so the car brakes early enough for the next corner.
export function buildSpeedProfile(track, gripSafety = 0.97) {
  const { n, ds } = track;
  const v = new Float32Array(n);
  const mu = CAR.mu * gripSafety;
  for (let i = 0; i < n; i++) {
    const k = track.rcurv[i];
    const denom = k - mu * CAR.downforce;
    v[i] = denom <= 1e-5 ? 95 : Math.min(95, Math.sqrt((mu * CAR.g) / denom));
  }
  for (let loop = 0; loop < 2; loop++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = v[(i + 1) % n];
      const brake = 0.9 * Math.min(CAR.brake, 1.2 * mu * (CAR.g + CAR.downforce * next * next));
      v[i] = Math.min(v[i], Math.sqrt(next * next + 2 * brake * ds));
    }
  }
  return v;
}

export class AIDriver {
  constructor(car, track, profile, skill = 0.93) {
    this.car = car; this.track = track; this.profile = profile;
    this.skill = skill;
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
        if (this.offsetTimer <= 0 && v > o.speed - 1) {
          this.offsetTarget = dLat > 0 ? -3.5 : 3.5;
          this.offsetTimer = 2.5;
        }
        if (gap < 12) blockSpeed = Math.min(blockSpeed, o.speed - 1 + gap * 0.3);
      }
    }
    if (this.offsetTimer <= 0) this.offsetTarget = 0;
    this.offset += clamp(this.offsetTarget - this.offset, -2 * dt, 2 * dt);

    // --- Steering: pure pursuit on the racing line ------------------------
    const look = Math.round((7 + v * 0.3) / track.ds);
    const j = (i + look) % track.n;
    const lim = HALF_WIDTH - 1.2;
    const off = clamp(track.ro[j] + this.offset, -lim, lim) - track.ro[j];
    const tx = track.rx[j] + track.nx[j] * off;
    const tz = track.rz[j] + track.nz[j] * off;
    const dx = tx - car.x, dz = tz - car.z;
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    const ahead = dx * fx + dz * fz, left = dx * fz - dz * fx;
    const ld2 = Math.max(ahead * ahead + left * left, 1);
    const curvature = (2 * left) / ld2;
    const steerAngle = Math.atan(curvature * CAR.wheelbase);
    const steerLimit = CAR.maxSteer / (1 + v / CAR.steerFade);
    const steer = clamp(steerAngle / steerLimit, -1, 1);

    // --- Throttle / brake ---------------------------------------------------
    // Look slightly further ahead at speed so the AI doesn't arrive at corners too fast.
    const k = (i + 3 + Math.round((v * 0.12) / track.ds)) % track.n;
    let target = this.profile[k] * this.skill;
    target = Math.min(target, blockSpeed);
    const err = target - v;
    let throttle = 0, brake = 0;
    if (err > 0) throttle = clamp(err / 3, 0.3, 1);
    else if (err < -1) brake = clamp(-err / 6, 0.15, 1);
    // Recover if stuck facing the wrong way
    if (ahead < 0) { throttle = 0.5; }
    return { throttle, brake, steer, abs: true, tc: true }; // AI drives with assists
  }
}