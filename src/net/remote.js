// Other people's cars in an online race.
// Their position arrives 20–30 times a second, already a few hundredths of a second old. Between
// packets the car carries on at its last speed and rate of turn ("dead reckoning"), so it is drawn
// where it is now, not where it was. When a packet disagrees, the difference is eased out over a
// fraction of a second instead of the car jumping.
import { projectOnTrack } from '../track.js';
import { heightAtS } from '../elevation.js';
import { bankLift, bankRoll } from '../banking.js';

export const SMOOTH = {
  blend: 0.12,     // seconds to ease out a correction
  snap: 12,        // metres: a bigger correction (a reset, say) jumps straight there
  maxAhead: 0.4,   // never guess further ahead than this (seconds)
  hold: 0.6,       // no news for this long: stop guessing, hold still
};

// Carry a car on along its curve for dt seconds (h = 0 faces +Z, positive yaw turns left).
function coast(b, dt) {
  const a = b.w * dt, c = Math.cos(a), s = Math.sin(a);
  const vx = b.vx * c + b.vz * s, vz = b.vz * c - b.vx * s;
  b.h += a; b.vx = vx; b.vz = vz;
  b.x += vx * dt; b.z += vz * dt;
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Mark a car as driven from the network. race.step() calls car.advance(dt) for it.
export function makeRemote(car, track) {
  const s = car.state;
  car.remote = true; car.ai = null;
  car.net = { base: { x: s.x, z: s.z, h: s.h, vx: 0, vz: 0, w: 0 }, err: { x: 0, z: 0, h: 0 }, quiet: 0, lastTime: -Infinity, laps: null };
  car.advance = (dt) => advanceRemote(car, track, dt);
}

// A packet for this car arrived; age = how old it is (seconds).
export function applyPacket(car, p, age) {
  const n = car.net, s = car.state;
  const b = { x: p.x, z: p.z, h: p.h, vx: p.vx, vz: p.vz, w: p.yawRate };
  coast(b, Math.min(Math.max(age, 0), SMOOTH.maxAhead));
  // keep drawing it where it is now, and ease the difference away
  const ex = s.x - b.x, ez = s.z - b.z, eh = wrap(s.h - b.h);
  if (n.first !== false || Math.hypot(ex, ez) > SMOOTH.snap) { n.err.x = n.err.z = n.err.h = 0; n.first = false; }
  else { n.err.x = ex; n.err.z = ez; n.err.h = eh; b.h = s.h - eh; } // same turn count as the car we draw
  n.base = b; n.quiet = 0;
  s.steer = p.steer; s.throttle = p.throttle; s.brake = p.brake;
  // lap bookkeeping comes from whoever drives the car
  n.laps = p.lapsDone;
  car.lastLap = p.lastLap; car.bestLap = p.bestLap;
  if (p.finishTime != null) car.finishTime = p.finishTime;
  if (p.dnf) car.dnf = true;
}

export function advanceRemote(car, track, dt) {
  const n = car.net, b = n.base, s = car.state;
  n.quiet += dt;
  if (n.quiet < SMOOTH.hold) coast(b, dt);
  else { b.vx *= 0.9; b.vz *= 0.9; b.w = 0; } // connection hiccup: don't fly off into the scenery
  const k = Math.exp(-dt / SMOOTH.blend);
  n.err.x *= k; n.err.z *= k; n.err.h *= k;
  s.x = b.x + n.err.x; s.z = b.z + n.err.z; s.h = b.h + n.err.h;
  s.vx = b.vx; s.vz = b.vz; s.yawRate = b.w;
  s.vf = s.vx * Math.sin(s.h) + s.vz * Math.cos(s.h);
  s.speed = Math.hypot(s.vx, s.vz);
  s.wheelSpin += s.vf * dt / 0.36;
  // where that is on the circuit: height, slope and banking, like physics.js
  const proj = projectOnTrack(track, s.x, s.z, s.trackIndex);
  s.trackIndex = proj.i; s.s = proj.s; s.lateral = proj.lateral;
  s.y = (track.h ? heightAtS(track, s.s) : 0) + bankLift(track, proj.i, s.lateral);
  s.roll = bankRoll(track, proj.i, s.lateral);
  s.pitch = Math.atan(track.grade ? track.grade[proj.i] : 0);
  const hw = track.hw ? track.hw[proj.i] : 6;
  s.surface = Math.abs(s.lateral) > hw + (track.kerb ?? 1) ? 'grass' : Math.abs(s.lateral) > hw ? 'kerb' : 'road';
}