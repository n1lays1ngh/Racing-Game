// Arcade open-wheel car physics: built to be fun, not a simulation.
// The car rotates toward where you steer (with a little weight), can slide a
// bit past the grip limit, straightens itself out, and only locks the brakes
// if you brake hard while turning hard.
//
// Conventions: heading h = 0 faces +Z. Forward = (sin h, cos h),
// left = (cos h, -sin h). Positive steer turns left (h increases).
import { projectOnTrack, HALF_WIDTH, KERB_WIDTH, SURFACES } from './track.js';
import { heightAtS } from './elevation.js';
import { bankLift, bankRoll } from './banking.js';

export const CAR = {
  // --- engine & brakes ---
  accel: 16,            // m/s² engine push at low speed
  accelFade: 0.6,       // how much engine push fades toward top speed
  drag: 0.00075,        // aero drag (× v²)
  roll: 0.4,            // rolling resistance, m/s²
  liftOff: 11.5,           // m/s² extra slowing when off the throttle (engine braking)
  brake: 40,            // m/s² max braking (still limited by grip)
  // --- grip ---
  mu: 1.8,              // tyre grip
  g: 9.81,
  downforce: 0.0016,    // extra grip per v² (more grip in fast corners)
  // --- steering & handling feel ---
  wheelbase: 3.6,
  maxSteer: 0.42,       // steering lock at low speed
  steerFade: 32,        // lock reduces with speed (higher = more lock at speed)
  steerRate: 2.0,       // how fast the front wheels turn
  yawResponse: 9,       // how quickly the car rotates (lower = heavier, higher = sharper)
  slideAllowance: 1.2,  // how far the car can rotate past grip → small controllable slide
  trailBrake: 0.15,     // extra rotation while braking into a corner
  powerRotation: 0.3,   // extra rotation on throttle in slow corners
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
    y: 0, pitch: 0, roll: 0, // height, nose-up angle and sideways tilt from hills and banking
    steer: 0, speed: 0, vf: 0, slip: 0,
    yawRate: 0, lockF: false,
    throttle: 0, brake: 0,
    surface: 'road', hitWall: 0,
    trackIndex: -1, s: 0, lateral: 0,
    wheelSpin: 0,
  };
}

// Steering lock available at a given speed (the AI uses this too).
export function steerLimit(vf) {
  return CAR.maxSteer / (1 + Math.max(vf, 0) / CAR.steerFade);
}

// Cornering grip. vcurv > 0 in a dip (car pressed into the road = more grip),
// < 0 over a crest (car goes light = less grip).
export function lateralGrip(vf, surfaceGrip = 1, vcurv = 0) {
  const gEff = Math.max(CAR.g + vcurv * vf * vf, 2);
  return CAR.mu * surfaceGrip * (gEff + CAR.downforce * vf * vf);
}

export function stepCar(car, input, track, dt) {
  const p = CAR;

  // --- Where are we on the circuit? -------------------------------------
  const proj = projectOnTrack(track, car.x, car.z, car.trackIndex);
  car.trackIndex = proj.i; car.s = proj.s; car.lateral = proj.lateral;
  const absLat = Math.abs(proj.lateral);
  const hw = track.hw ? track.hw[proj.i] : HALF_WIDTH, kerb = track.kerb ?? KERB_WIDTH;
  let grip = 1, extraDrag = 0;
  if (absLat > hw + kerb) {
    // Run-off: what's there depends on the circuit (see surface / gravel in the circuit file)
    const surf = track.surfL ? (proj.lateral > 0 ? track.surfL : track.surfR)[proj.i] : SURFACES.grass;
    if (surf === SURFACES.tarmac) { car.surface = 'runoff'; grip = 0.85; }
    else if (surf === SURFACES.gravel) { car.surface = 'gravel'; grip = 0.35; extraDrag = 6 + 0.006 * car.vf * car.vf; }
    else { car.surface = 'grass'; grip = 0.5; extraDrag = 3 + 0.003 * car.vf * car.vf; }
  } else if (absLat > hw) { car.surface = 'kerb'; grip = 0.93; }
  else car.surface = 'road';
  const grade = track.grade ? track.grade[proj.i] : 0;   // hills
  const vcurv = track.vcurv ? track.vcurv[proj.i] : 0;
  const bank = track.bank ? track.bank[proj.i] : 0;      // banked corners

  // --- Current velocity in the car's frame --------------------------------
  let fx = Math.sin(car.h), fz = Math.cos(car.h);
  let vf = car.vx * fx + car.vz * fz;          // forward speed
  let vl = car.vx * fz - car.vz * fx;          // sideways speed (left)
  const thr = clamp(input.throttle, 0, 1), brk = clamp(input.brake, 0, 1);
  car.throttle = thr; car.brake = brk;

  // --- Steering ---------------------------------------------------------
  const target = clamp(input.steer, -1, 1) * steerLimit(vf);
  car.steer += clamp(target - car.steer, -p.steerRate * dt, p.steerRate * dt);

  // input.grip: AI difficulty bonus. Banking adds grip when turning into it, takes it away the other way.
  const bankGrip = p.g * (1 + 0.5 * p.mu) * Math.sin(Math.abs(bank)) * (car.yawRate * bank >= 0 ? 1 : -1);
  const latMax = Math.max(lateralGrip(vf, grip * (input.grip ?? 1), vcurv) + bankGrip, 2);

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
  // Engine braking: the car slows noticeably as soon as you lift off the throttle.
  const lift = vf > 1 ? p.liftOff * (1 - thr) : 0;
  const resist = (p.drag * vf * vf + p.roll + extraDrag + lift) * dt;
  vf = Math.abs(vf) <= resist ? 0 : vf - Math.sign(vf) * resist;
  // Gravity along the slope: slower uphill, faster downhill (not while parked).
  if (Math.abs(vf) > 0.5 || thr > 0) vf -= (p.g * grade / Math.sqrt(1 + grade * grade)) * dt;

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
  car.y = (track.h ? heightAtS(track, car.s) : 0) + bankLift(track, proj.i, car.lateral);
  car.roll = bankRoll(track, proj.i, car.lateral);
  car.pitch = Math.atan(grade);

  // --- Barriers (distance varies around the lap, see track.js) -------------
  car.hitWall = Math.max(0, car.hitWall - dt);
  const i = car.trackIndex;
  const nx = track.nx[i], nz = track.nz[i];
  const lat = (car.x - track.cx[i]) * nx + (car.z - track.cz[i]) * nz;
  const limit = (lat > 0 ? track.wallL[i] : track.wallR[i]) - 1.1;
  if (Math.abs(lat) > limit) {
    const side = Math.sign(lat);
    const push = (Math.abs(lat) - limit) * side;
    car.x -= nx * push; car.z -= nz * push;
    const vn = (car.vx * nx + car.vz * nz) * side; // speed into the wall
    if (vn > 0) {
      // Bounce off a little (30%) and scrape along the wall: the speed lost along the wall is limited by
      // how hard the car hit it, so a glancing touch costs a little and a head-on crash costs a lot.
      // (Taking 20% off all the speed on every touch used to leave a car stuck against the wall.)
      const e = 0.3, mu = 0.45, tx = track.tx[i], tz = track.tz[i];
      car.vx -= nx * side * vn * (1 + e); car.vz -= nz * side * vn * (1 + e);
      const vt = car.vx * tx + car.vz * tz, dv = Math.min(Math.abs(vt), mu * (1 + e) * vn) * Math.sign(vt);
      car.vx -= tx * dv; car.vz -= tz * dv;
      if (vn > 2) { car.yawRate *= 0.5; car.hitWall = Math.min(1, vn / 15 + 0.2); } // a real hit, not a brush
      // Turn the nose away from the wall: a share of the angle on impact, then steadily while you keep
      // pushing into it, so the car slides along and drives off instead of pinning itself.
      const into = (Math.sin(car.h) * nx + Math.cos(car.h) * nz) * side;      // > 0: nose points at the wall
      if (into > 0.02) {
        const turnAway = -Math.sign((Math.cos(car.h) * nx - Math.sin(car.h) * nz) * side) || 1; // which way lowers `into`
        const angle = Math.asin(Math.min(1, into));
        car.h += turnAway * Math.min(angle, angle * 0.35 * Math.min(1, vn / 12) + 1.2 * dt);
      }
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
  car.y = track.h ? track.h[i] : 0;
  car.pitch = track.grade ? Math.atan(track.grade[i]) : 0;
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