// Arcade open-wheel car physics: built to be fun, not a simulation.
// The car rotates toward where you steer (with a little weight), can slide a
// bit past the grip limit, straightens itself out, and only locks the brakes
// if you brake hard while turning hard.
//
// Conventions: heading h = 0 faces +Z. Forward = (sin h, cos h),
// left = (cos h, -sin h). Positive steer turns left (h increases).
import { projectOnTrack, HALF_WIDTH, KERB_WIDTH, WALL_OFFSET } from './track.js';

export const CAR = {
  // --- engine & brakes ---
  accel: 16,            // m/s² engine push at low speed
  accelFade: 0.6,       // how much engine push fades toward top speed
  drag: 0.00075,        // aero drag (× v²)
  roll: 0.4,            // rolling resistance, m/s²
  brake: 40,            // m/s² max braking (still limited by grip)
  // --- grip ---
  mu: 1.8,              // tyre grip
  g: 9.81,
  downforce: 0.0016,    // extra grip per v² (more grip in fast corners)
  // --- steering & handling feel ---
  wheelbase: 3.6,
  maxSteer: 0.36,       // steering lock at low speed
  steerFade: 32,        // lock reduces with speed (higher = more lock at speed)
  steerRate: 2.0,       // how fast the front wheels turn
  yawResponse: 8,       // how quickly the car rotates (lower = heavier, higher = sharper)
  slideAllowance: 1.2,  // how far the car can rotate past grip → small controllable slide
  trailBrake: 0.15,     // extra rotation while braking into a corner
  powerRotation: 0.1,   // extra rotation on throttle in slow corners
  stability: 2.5,       // how strongly slides straighten out (higher = safer, lower = driftier)
  // --- lock-ups ---
  lockThreshold: 1.25,  // brake + cornering needed to lock the fronts (higher = harder to lock)
  lockSteer: 0.35,      // steering left while locked (lock-up understeer)
  lockBrake: 0.8,       // braking left while locked
  reverseMax: 12,
  radius: 1.25,         // collision circle radius (two circles per car)
};

export function createCarState(x, z, heading) {
  return {
    x, z, h: heading, vx: 0, vz: 0,
    steer: 0, speed: 0, vf: 0, slip: 0,
    yawRate: 0, lockF: false,
    throttle: 0, brake: 0,
    surface: 'road', hitWall: 0,
    trackIndex: -1, s: 0, lateral: 0,
    wheelSpin: 0,
  };
}

export function lateralGrip(vf, surfaceGrip = 1) {
  return CAR.mu * surfaceGrip * (CAR.g + CAR.downforce * vf * vf);
}

export function stepCar(car, input, track, dt) {
  const p = CAR;

  // --- Where are we on the circuit? -------------------------------------
  const proj = projectOnTrack(track, car.x, car.z, car.trackIndex);
  car.trackIndex = proj.i; car.s = proj.s; car.lateral = proj.lateral;
  const absLat = Math.abs(proj.lateral);
  let grip = 1, extraDrag = 0;
  if (absLat > HALF_WIDTH + KERB_WIDTH) { car.surface = 'grass'; grip = 0.5; extraDrag = 3 + 0.003 * car.vf * car.vf; }
  else if (absLat > HALF_WIDTH) { car.surface = 'kerb'; grip = 0.93; }
  else car.surface = 'road';

  // --- Current velocity in the car's frame --------------------------------
  let fx = Math.sin(car.h), fz = Math.cos(car.h);
  let vf = car.vx * fx + car.vz * fz;          // forward speed
  let vl = car.vx * fz - car.vz * fx;          // sideways speed (left)
  const thr = clamp(input.throttle, 0, 1), brk = clamp(input.brake, 0, 1);
  car.throttle = thr; car.brake = brk;

  // --- Steering ---------------------------------------------------------
  const steerLimit = p.maxSteer / (1 + Math.max(vf, 0) / p.steerFade);
  const target = clamp(input.steer, -1, 1) * steerLimit;
  car.steer += clamp(target - car.steer, -p.steerRate * dt, p.steerRate * dt);

  const latMax = lateralGrip(vf, grip);

  // --- Lock-up: only when braking hard AND cornering hard ------------------
  const latUse = Math.abs(car.yawRate * vf) / latMax;   // how much cornering grip is in use
  const load = Math.hypot(brk, latUse);
  if (input.abs || brk < 0.8 || vf < 10) car.lockF = false; // ease off the brake to recover
  else if (!car.lockF && load > p.lockThreshold) car.lockF = true;

  // --- Rotation -----------------------------------------------------------
  const slow = clamp(1 - vf / 60, 0, 1);
  let yawTarget = vf * Math.tan(car.steer) / p.wheelbase;           // where you're steering
  yawTarget *= 1 + p.trailBrake * brk + p.powerRotation * thr * slow;
  if (car.lockF) yawTarget *= p.lockSteer;
  const yawMax = p.slideAllowance * latMax / Math.max(Math.abs(vf), 3);
  yawTarget = clamp(yawTarget, -yawMax, yawMax);
  // Slides straighten themselves out: turn the nose toward where the car is travelling.
  const slipAngle = Math.atan2(vl, Math.max(Math.abs(vf), 1));
  yawTarget += p.stability * slipAngle;

  car.yawRate += (yawTarget - car.yawRate) * (1 - Math.exp(-p.yawResponse * dt));
  car.h += car.yawRate * dt;

  // Velocity in the car's new frame: any sideways part is the slide.
  fx = Math.sin(car.h); fz = Math.cos(car.h);
  const lx = fz, lz = -fx;
  vf = car.vx * fx + car.vz * fz;
  vl = car.vx * lx + car.vz * lz;

  // --- Throttle / brake ---------------------------------------------------
  if (thr > 0) {
    if (vf >= -0.5) vf += thr * p.accel * (1 - p.accelFade * Math.min(Math.max(vf, 0) / 90, 1)) * dt;
    else vf = Math.min(0, vf + thr * 10 * dt); // throttle while reversing = stop
  }
  if (brk > 0) {
    if (vf > 0.3) {
      let decel = Math.min(p.brake, 1.2 * latMax) * brk;
      if (car.lockF) decel *= p.lockBrake;
      vf = Math.max(0, vf - decel * dt);
    } else {
      vf = Math.max(-p.reverseMax, vf - brk * 7 * dt); // reverse
    }
  }
  const resist = (p.drag * vf * vf + p.roll + extraDrag) * dt;
  vf = Math.abs(vf) <= resist ? 0 : vf - Math.sign(vf) * resist;

  // --- Tyres pull the slide back in, up to the grip limit ----------------
  car.slip = car.lockF ? Math.max(Math.abs(vl), vf * 0.3) : Math.abs(vl);
  const corr = latMax * dt;
  vl = Math.abs(vl) <= corr ? 0 : vl - Math.sign(vl) * corr;

  car.vx = fx * vf + lx * vl;
  car.vz = fz * vf + lz * vl;
  car.x += car.vx * dt;
  car.z += car.vz * dt;
  car.vf = vf;
  car.speed = Math.hypot(car.vx, car.vz);
  car.wheelSpin += vf * dt / 0.36;

  // --- Barriers -----------------------------------------------------------
  car.hitWall = Math.max(0, car.hitWall - dt);
  const i = car.trackIndex;
  const nx = track.nx[i], nz = track.nz[i];
  const lat = (car.x - track.cx[i]) * nx + (car.z - track.cz[i]) * nz;
  const limit = WALL_OFFSET - 1.1;
  if (Math.abs(lat) > limit) {
    const side = Math.sign(lat);
    const push = (Math.abs(lat) - limit) * side;
    car.x -= nx * push; car.z -= nz * push;
    const vn = (car.vx * nx + car.vz * nz) * side; // speed into the wall
    if (vn > 0) {
      car.vx -= nx * side * vn * 1.3; car.vz -= nz * side * vn * 1.3;
      car.vx *= 0.8; car.vz *= 0.8;
      car.yawRate *= 0.5;
      car.hitWall = Math.min(1, vn / 15 + 0.2);
    }
  }
}

// Put a car back on the circuit (used for the R key and the grid).
export function placeCar(car, track, s, lateral = 0) {
  s = ((s % track.length) + track.length) % track.length;
  const i = Math.floor(s / track.ds) % track.n;
  car.x = track.cx[i] + track.nx[i] * lateral;
  car.z = track.cz[i] + track.nz[i] * lateral;
  car.h = Math.atan2(track.tx[i], track.tz[i]);
  car.vx = car.vz = car.vf = car.speed = car.steer = car.yawRate = 0;
  car.lockF = false;
  car.trackIndex = i; car.s = s; car.lateral = lateral;
}

// Simple 8-speed gearbox for the HUD and engine sound.
const GEAR_TOP = [0, 24, 36, 47, 57, 66, 75, 83, 95]; // m/s at the top of each gear
export function gearbox(speed) {
  if (speed < 0.5) return { gear: 'N', rpm: 4000 };
  let g = 1;
  while (g < 8 && speed > GEAR_TOP[g]) g++;
  const lo = g === 1 ? 0 : GEAR_TOP[g - 1] * 0.82, hi = GEAR_TOP[g];
  const f = clamp((speed - lo) / (hi - lo), 0, 1);
  return { gear: String(g), rpm: 6000 + f * 7000 };
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }