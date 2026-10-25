// A more realistic car model: two axles with their own tyres (a "bicycle model"), for the car you drive when its file
// has a `sim` block (src/cars/f1.js). physics.js calls simStep() instead of its arcade step for that car.
//
// What it models that the arcade one doesn't:
//   • Each axle's tyres make their own sideways force from their own slip angle (the angle between where the wheel
//     points and where it's going). Force builds up with slip to a peak, then falls away a little past it: go past the
//     rear's peak and the back of the car lets go (snap oversteer); past the front's and it washes wide (understeer).
//   • Load on each axle: the car's weight (weightFront), its downforce (aeroFront: the aero balance) and weight transfer
//     (braking loads the front, accelerating loads the rear, cgHeight). More load = more grip on that axle, a little less
//     per kilo (loadExp). So lifting or braking mid-corner moves grip forward and the rear gets light; power moves it back.
//     The rear tyres are wider than the fronts and grip more per kilo (understeer / refSpeed set how much).
//   • The car turns because those forces twist it about its centre of gravity (yaw inertia), not because the steering
//     sets a rotation rate. Nothing straightens a slide for you (apart from the optional assist below): you catch it.
//   • Each axle's grip is shared between going and turning (a friction ellipse): wheelspin on the rear axle (traction
//     control catches some of it) or a locked axle under braking leaves it little grip for cornering.
//
// What it keeps, so everything else in the game still fits: the car's total grip at any speed is exactly the arcade
// model's (physics.js lateralGrip: mu × (g + downforce × v²), with the surface, tyres, damage, dirty air and banking), only
// split between the axles. So the braking zones, the racing line and the AI's plans (ai.js, all worked out from that
// sum) stay right. The engine, brakes, drag, slipstream, ERS, hills, the pit limiter and the walls are the same too.
//
// Below walking pace (sim.enterSpeed / exitSpeed) the arcade model takes over: slip angles mean little when the car's
// barely moving, and the sums get stiff. The AI always uses the arcade model (its steering and speed plans are built
// round it), and so does your car when the team or the AI drives it (pit lane, cool-down lap): race.js tells stepCar.
//
// Conventions as in physics.js: heading h = 0 faces +Z, forward = (sin h, cos h), left = (cos h, −sin h), positive steer
// and yaw turn left. Forces here are per kilo of car (m/s²).
import { clamp } from './physics.js';
import { ersStep } from './ers.js';
import { SLIPSTREAM } from './slipstream.js';
import { pitSpeedLimit, PITLANE } from './pitlane.js';
import { tyreStep } from './tyres.js';

// The sim block's defaults (a car's file can set any of them: see f1.js)
export const SIM_DEFAULTS = {
  enabled: true,
  weightFront: 0.45,     // share of the car's weight on the front axle
  aeroFront: 0.42,       // share of the downforce on the front axle (aero balance)
  cgHeight: 0.3,         // m: centre of gravity height (how much weight moves under braking and acceleration)
  yawInertia: 1.0,       // yaw inertia ÷ (mass × a × b), a and b the distances from the CG to each axle (~0.9–1.2)
  peakSlip: [0.105, 0.09], // rad: slip angle at which the front / rear tyres grip the most (~6° / 5°)
  falloff: 0.14,         // grip lost sliding well past the peak (0.14 = 14% less than at the peak)
  loadExp: 0.8,          // tyre load sensitivity: an axle's grip grows as its load to this power (1 = in proportion; real
                         // tyres ~0.8: a heavily loaded axle grips less per kilo, a lightly loaded one more)
  // The rear tyres are much wider than the fronts (an F1 car's: 405 mm against 305), so they grip more per kilo. How much
  // more is set so the car has this much understeer at refSpeed: the rear can corner this much harder than it needs to.
  // (Without it, hard braking leaves the rear, which carries over half the cornering, the weaker axle: a spin into
  // every corner.) More = safer and lazier; 0 = neutral; below 0 = oversteer.
  understeer: 0.05,
  refSpeed: 45,          // m/s
  longGrip: 1.2,         // the tyres take this much more lengthways than sideways (as the arcade model)
  brakeBias: 0.56,       // share of the braking on the front axle
  relax: 0.5,            // m: tyre relaxation length (slip builds up over this much travel: smooths the steering)
  brakeAssist: true,     // true: like brake-by-wire with ABS: the braking is shared between the axles by the grip each has
                         // and never goes past brakeMargin of it, so there's grip left to turn and nothing locks. false:
                         // the fixed brakeBias, and brake too hard for the grip and the wheels lock (fronts: you go
                         // straight on; rears: you spin)
  brakeMargin: 0.88,     // with the assist: the most of each axle's lengthways grip the brakes use
  lockAt: 1.12,          // without the assist: an axle locks when the braking asked of it is this much over its grip …
  lockedGrip: 0.25,      // … and a locked axle keeps this share of its sideways grip
  slideAssist: 0.25,     // 0–1: yaw damping that helps catch a slide once the rear is past its peak (0 = none, real)
  stability: 5,          // 1/s: damping of the car's slip angle (how fast it starts to rotate away from its path). Hard
                         // braking puts ~70% of the load on the fronts, and a two-axle car is then unstable (any yaw
                         // grows by itself: a real driver catches it with his feet and hands, a keyboard can't). 0 = none
  enterSpeed: 5,         // m/s: above this it's this model, below exitSpeed the arcade one again
  exitSpeed: 3,
  substeps: 2,           // sub-steps per physics step (the tyre forces are stiff)
  // Its own steering rack: the tyres need a few degrees of slip on top of the corner's angle, so the arcade rack (which
  // leaves ~6° at 300 km/h) would run out of lock in fast corners. Lock at low speed, and how it shrinks with speed:
  maxSteer: 0.42,        // rad (~24°: Monaco's hairpin)
  steerFade: 55,         // m/s: lock = maxSteer ÷ (1 + speed ÷ steerFade) (~9° at 300 km/h)
};
const cache = new WeakMap(); // sim block → it with the defaults filled in (and the rear tyres' grip factor, rearGrip)
const simOf = (S) => { let s = cache.get(S); if (!s) { s = { ...SIM_DEFAULTS, ...S }; cache.set(S, s); } return s; };

// Sideways force of a tyre (share of its grip, −1 … 1) at slip x (slip angle ÷ its peak slip angle): rises steeply,
// rounds off to 1 at the peak, then falls away to 1 − falloff by 2.5 × the peak slip
function tyreCurve(x, falloff) {
  const a = Math.abs(x);
  const f = a <= 1 ? a * (2 - a) : 1 - falloff * Math.min(1, (a - 1) / 1.5) * (2 - Math.min(1, (a - 1) / 1.5));
  return x < 0 ? -f : f;
}

// One physics step of the car with the tyre model. env (from physics.js stepCar): p (the car's physics), latMax (its
// total cornering grip now, m/s², everything included), grip (the surface), extraDrag, grade, vcurv, thr, brk, dfx (damage)
export function simStep(car, input, track, dt, env) {
  const p = env.p, S = simOf(p.sim), n = Math.max(1, S.substeps | 0), h = dt / n;
  const L = p.wheelbase, a = L * (1 - S.weightFront), b = L * S.weightFront; // CG to the front / rear axle
  const kz = S.yawInertia * a * b;
  if (S.rearGrip == null) { // the rear tyres' grip per kilo against the fronts', for `understeer` at refSpeed (see above)
    const aeroRef = p.downforce * S.refSpeed * S.refSpeed;
    const nFr = S.weightFront * p.g + S.aeroFront * aeroRef, nRr = (1 - S.weightFront) * p.g + (1 - S.aeroFront) * aeroRef;
    S.rearGrip = ((a / L) * (1 + S.understeer)) / ((b / L) * (1 - S.understeer)) * (nFr / nRr);
  }
  // entering this model: the tyres' slip as they are now (no jolt)
  if (!car.simWas) {
    const fx = Math.sin(car.h), fz = Math.cos(car.h), u = Math.max(car.vx * fx + car.vz * fz, 1), v = car.vx * fz - car.vz * fx;
    car.slipF = Math.atan2(v + a * car.yawRate, u) - car.steer; car.slipR = Math.atan2(v - b * car.yawRate, u);
    car.longAx = 0;
  }
  car.simWas = true;
  const { thr, brk, dfx } = env;
  car.throttle = thr; car.brake = brk;
  // steering: its own rack (maxSteer / steerFade above), turned at the car's steerRate
  const target = clamp(input.steer + (dfx?.pull ?? 0), -1, 1) * (S.maxSteer / (1 + Math.max(car.vf, 0) / S.steerFade));
  car.steer += clamp(target - car.steer, -p.steerRate * dt, p.steerRate * dt);
  const tc = p.tc ?? 0, tow = car.tow ?? 0;
  let latUseOut = 0, driveOut = 0, slipOut = 0, lockF = false, lockR = false, absOn = false, tcOn = false, spinOut = 0, longOut = 0;

  for (let k = 0; k < n; k++) {
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    let u = car.vx * fx + car.vz * fz;          // forward speed
    let v = car.vx * fz - car.vz * fx;          // sideways speed (left)
    let r = car.yawRate;
    const uu = Math.max(u, 3), d = car.steer;

    // ---- load on each axle (m/s² of the car's mass): weight, downforce, and weight moving with the car's acceleration
    const gEff = Math.max(p.g + env.vcurv * u * u, 2), aero = (dfx?.aero ?? 1) * p.downforce * u * u;
    const shift = (car.longAx * S.cgHeight) / L; // + accelerating: onto the rear
    const nF0 = S.weightFront * gEff + S.aeroFront * aero, nR0 = (1 - S.weightFront) * gEff + (1 - S.aeroFront) * aero;
    const nF = Math.max(nF0 - shift, 0.15 * nF0), nR = Math.max(nR0 + shift, 0.15 * nR0);
    // each axle's grip: the car's total (as the arcade model, so the AI's sums still fit), split by load and tyre (the
    // wider rears grip more per kilo), then moved by the weight transfer (load sensitivity: grip ∝ load^loadExp)
    const wF = nF0, wR = S.rearGrip * nR0, share = env.latMax / (wF + wR);
    const gF = share * wF * (nF / nF0) ** S.loadExp, gR = share * wR * (nR / nR0) ** S.loadExp;
    const lF = S.longGrip * gF, lR = S.longGrip * gR;     // lengthways
    // how much of each axle's sideways grip the corner is using (from the slip it has now): what's left over is what
    // traction control and the brake assist let you use lengthways (cornering first, like a driver feeding the pedals)
    const useF = Math.abs(tyreCurve(car.slipF / S.peakSlip[0], S.falloff)), useR = Math.abs(tyreCurve(car.slipR / S.peakSlip[1], S.falloff));
    const leftF = Math.max(0.45, Math.sqrt(Math.max(0, 1 - useF * useF))), leftR = Math.max(0.15, Math.sqrt(Math.max(0, 1 - useR * useR)));

    // ---- lengthways: the engine on the rear axle, the brakes on both ----
    let fxF = 0, fxR = 0, spin = 0, drive = thr * (1 - (tcOn ? 0.15 : 0));
    if (thr > 0 && u >= -0.5) {
      const push = drive * (dfx?.power ?? 1) * (p.power ? Math.min(p.accel, p.power / Math.max(u, 1))
        : p.accel * (1 - p.accelFade * Math.min(Math.max(u, 0) / 90, 1)));
      const most = lR * leftR * 0.95; // what the rear tyres can put down with the cornering they're doing
      if (push > most) { // wheelspin: traction control catches most of it, the rest spins the wheels (and the rear lets go)
        const over = push - most;
        spin = Math.min(1, over / push) * (1 - tc);
        if (tc && over > 0.5) tcOn = true;
        fxR = most + over * 0.15 * (1 - tc);
      } else fxR = push;
      driveOut = drive;
    }
    if (brk > 0 && u > 0.3) {
      let dF = p.brake * brk * S.brakeBias, dR = p.brake * brk * (1 - S.brakeBias);
      if (S.brakeAssist || p.abs) { // shared by grip, never more than brakeMargin of it: no lock-ups, grip left to turn
        // (the rear gets the corner first: braking a rear that's cornering hard is how a car spins on the way in, so as
        // the corner loads it the braking moves forward, as brake-by-wire does)
        // And it trail-brakes for you: hard braking moves the weight forward, so a cornering rear (which carries more
        // than half the cornering, the weight being rearward) runs out of grip first and the car spins on the way in. As
        // the rear nears its limit the braking eases off, the weight comes back onto the rear and it grips again.
        const ease = clamp(1 - (useR - 0.75) * 2.5, 0.35, 1);
        const want = (dF + dR) * ease, mF = S.brakeMargin * lF * leftF, mR = S.brakeMargin * lR * leftR;
        dF = want * (lF / (lF + lR)); dR = want - dF;
        if (dF > mF || dR > mR) { absOn = !!p.abs; dF = Math.min(dF, mF); dR = Math.min(dR, mR); }
      } else {
        lockF = car.lockF ? dF > lF * 0.9 : dF > lF * S.lockAt; // (eases off before it unlocks: hysteresis)
        lockR = car.lockR ? dR > lR * 0.9 : dR > lR * S.lockAt;
        if (lockF) dF = lF * 0.85; else dF = Math.min(dF, lF);  // a locked tyre slides: a bit less than its best
        if (lockR) dR = lR * 0.85; else dR = Math.min(dR, lR);
      }
      fxF -= dF; fxR -= dR;
    }
    car.lockF = lockF; car.lockR = lockR;

    // ---- sideways: each axle's slip angle, its grip left over from going / stopping, and the tyre curve ----
    const relaxK = Math.min(1, (Math.abs(u) * h) / S.relax);
    car.slipF += (Math.atan2(v + a * r, uu) - d - car.slipF) * relaxK;
    car.slipR += (Math.atan2(v - b * r, uu) - car.slipR) * relaxK;
    const left = (g, fxx) => g * Math.sqrt(Math.max(0.04, 1 - (fxx / (S.longGrip * g)) ** 2)); // friction ellipse
    let cF = left(gF, fxF), cR = left(gR, fxR) * (1 - 0.6 * spin);
    if (lockF) cF = gF * S.lockedGrip;
    if (lockR) cR = gR * S.lockedGrip;
    const fyF = -cF * tyreCurve(car.slipF / S.peakSlip[0], S.falloff);
    const fyR = -cR * tyreCurve(car.slipR / S.peakSlip[1], S.falloff);

    // ---- the rest, as the arcade model: ERS, drag (less in the tow), rolling, engine braking, the hill, run-off ----
    let ax = fxF * Math.cos(d) + fxR - fyF * Math.sin(d);
    ax += ersStep(car, { boost: input.boost, throttle: thr, brake: brk }, u, h);
    const lift = u > 1 ? p.liftOff * (1 - thr) : 0;
    ax -= Math.sign(u) * (p.drag * (1 - SLIPSTREAM.dragCut * tow) * u * u + p.roll + env.extraDrag + lift);
    ax -= (p.g * env.grade) / Math.sqrt(1 + env.grade * env.grade);
    const ay = fyF * Math.cos(d) + fxF * Math.sin(d) + fyR;
    // yaw: the axles' forces twisting the car about its centre of gravity (+ the slide assist, only past the rear's peak)
    let dr = (a * (fyF * Math.cos(d) + fxF * Math.sin(d)) - b * fyR) / kz;
    // stability: damps how fast the car's slip angle (the angle between where it points and where it's going) changes:
    // the rotation is pulled toward ay ÷ u, the rate that just follows the curve it's on. Nothing in a steady corner (it
    // doesn't steer the car for you), but a car starting to rotate away under braking is held. Past the rear's peak the
    // slide assist adds more of the same.
    const follow = ay / uu, past = Math.abs(car.slipR) / S.peakSlip[1] - 1;
    dr -= (S.stability + (S.slideAssist > 0 && past > 0 ? S.slideAssist * Math.min(1, past) * 6 : 0)) * (r - follow);

    // ---- move ----
    // (u, v are in this sub-step's frame and go back to the world below; the next sub-step reads them off the new
    // heading, and that's where the turning shows. So no u·r / v·r terms here: they'd count the turn twice.)
    u += ax * h;
    v += ay * h;
    r += dr * h;
    // pit lane limiter: holds you at the limit, slows you to it if you come in fast (pitlane.js)
    const pitLimit = pitSpeedLimit(car, track);
    car.pitLimiter = pitLimit > 0;
    if (pitLimit && u > pitLimit) u = Math.max(pitLimit, u - PITLANE.slowdown * h);
    car.yawRate = r;
    car.h += r * h;
    car.vx = fx * u + fz * v; car.vz = fz * u - fx * v; // (in the old heading's frame: the turn shows next sub-step)
    car.x += car.vx * h; car.z += car.vz * h;
    car.vf = u;
    car.longAx = car.longAx + (ax - car.longAx) * Math.min(1, h * 12); // (the weight moves over a moment, not instantly)

    latUseOut = Math.abs(ay) / Math.max(gF + gR, 1);
    slipOut = Math.max(Math.abs(v), lockF ? u * 0.3 : 0);
    spinOut = spin; longOut = Math.max(Math.abs(fxR + fxF), 0);
  }
  car.absActive = absOn; car.tcActive = tcOn; car.spin = spinOut; car.longA = longOut;
  car.slip = slipOut;
  if (car.tyres) tyreStep(car, dt, { lat: Math.min(1.2, latUseOut), brake: brk, throttle: driveOut, slip: car.slip, lock: car.lockF || car.lockR, dist: Math.abs(car.vf) * dt, length: track.length });
}