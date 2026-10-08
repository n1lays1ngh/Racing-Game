// Damage (career only, race.js): where a car is hit and how hard, what that does to how it drives, when it's out of
// the race, and the repair at a pit stop. No rendering here (it runs in the headless sim too). The HUD's damage page:
// hud.js. How tough each car is: `damage` in its file in src/cars/ (the F1 car breaks the easiest).
//
//   fitDamage(state, mode, carDef)          race.js, career races: state.damage
//   hitDamage(state, dx, dz, speed, kind)   physics.js (barriers) and race.js (cars): (dx, dz) points from the car to
//                                           what it hit, speed: how fast into it (m/s), kind: 'wall' | 'car'
//   state.damage = { parts: { front, rear, left, right } (0 fine … 1 broken), fx, total, out, changed }
//   state.damage.fx = { grip, aero, power, pull }   what physics.js does with it
//   repairTime(state), repair(state), needsRepair(state)   pitstop.js / race.js

export const DAMAGE = {
  // the career's damage setting: how much a hit costs, the most a part can take, and whether you can be put out
  modes: {
    low: { name: 'Low', scale: 0.35, cap: 0.6, retire: false },    // knocks, never out of the race
    medium: { name: 'Medium', scale: 0.7, cap: 1, retire: true },
    real: { name: 'Real', scale: 1.3, cap: 1, retire: true },      // a big hit is the end of your race
  },
  wall: { v0: 4, k: 0.011 },    // barriers: impact speed (m/s, straight into it) that does nothing; damage per (m/s over it)^1.5
  car: { v0: 2.5, k: 0.02 },    // other cars: the same, for the closing speed
  parts: ['front', 'rear', 'left', 'right'],
  names: { front: 'Front wing', rear: 'Rear', left: 'Left side', right: 'Right side' },
  out: { rear: 1, left: 1, right: 1, total: 2.4 }, // retired: one of these broken (a front wing isn't), or this much in all
  effect: {
    frontGrip: 0.08,   // a broken front wing: this much less grip …
    frontAero: 0.4,    // … and this share of the downforce (the car's file can say: damage.frontAero)
    rearAero: 0.2, rearPower: 0.25, // rear (wing, diffuser, gearbox): downforce and drive
    sideGrip: 0.07,    // a side (suspension, floor): grip …
    pull: 0.12,        // … and the car pulls that way (share of full steering lock)
  },
  repair: { front: 7, rear: 12, left: 10, right: 10 }, // seconds a stop takes longer to fix a broken part (less for less)
  fixFrom: 0.05,       // parts with less than this aren't touched at a stop
  pitAt: 0.35,         // the AI comes in for repairs when a part is this bad
  warn: [0.25, 0.6],   // you're told when a part gets this bad
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function fitDamage(state, mode = 'medium', carDef = state.spec) {
  const m = DAMAGE.modes[mode] ?? DAMAGE.modes.medium, c = carDef?.damage ?? {};
  state.damage = {
    mode, scale: m.scale / (c.strength ?? 1), cap: m.cap, retire: m.retire, frontAero: c.frontAero ?? DAMAGE.effect.frontAero,
    parts: { front: 0, rear: 0, left: 0, right: 0 }, fx: { grip: 1, aero: 1, power: 1, pull: 0 },
    total: 0, out: null, changed: false, warned: {},
  };
}

// A hit: shared out between the parts facing it (head-on: the front; side-on: that side; in between: both)
export function hitDamage(state, dx, dz, speed, kind = 'wall') {
  const d = state.damage; if (!d || d.out || state.autopilot) return 0; // (not while the team drives it in the pits: pitstop.js)
  const K = DAMAGE[kind] ?? DAMAGE.wall, over = speed - K.v0;
  if (over <= 0) return 0;
  const amount = K.k * over ** 1.5 * d.scale;
  const fx = Math.sin(state.h), fz = Math.cos(state.h);        // the car's forward and left (physics.js conventions)
  const along = dx * fx + dz * fz, left = dx * fz - dz * fx;
  const w = { front: Math.max(0, along) ** 2, rear: Math.max(0, -along) ** 2, left: Math.max(0, left) ** 2, right: Math.max(0, -left) ** 2 };
  const sum = w.front + w.rear + w.left + w.right || 1;
  for (const p of DAMAGE.parts) d.parts[p] = Math.min(d.cap, d.parts[p] + amount * w[p] / sum);
  update(d);
  return amount;
}

// What the damage does (physics.js), and whether the car is out
function update(d) {
  const P = d.parts, E = DAMAGE.effect;
  d.fx.grip = 1 - E.frontGrip * P.front - E.sideGrip * (P.left + P.right);
  d.fx.aero = 1 - d.frontAero * P.front - E.rearAero * P.rear;
  d.fx.power = 1 - E.rearPower * P.rear;
  d.fx.pull = E.pull * (P.left - P.right);   // + = pulls left
  d.total = P.front + P.rear + P.left + P.right;
  if (d.retire && !d.out) {
    for (const p of ['rear', 'left', 'right']) if (P[p] >= DAMAGE.out[p]) { d.out = p; break; }
    if (!d.out && d.total >= DAMAGE.out.total) d.out = DAMAGE.parts.reduce((a, b) => (P[b] > P[a] ? b : a));
  }
  d.changed = true;
}

export function needsRepair(state) {
  const P = state.damage?.parts;
  return !!P && DAMAGE.parts.some((p) => P[p] >= DAMAGE.pitAt);
}
export function repairTime(state) {
  const P = state.damage?.parts; if (!P) return 0;
  return DAMAGE.parts.reduce((t, p) => t + (P[p] >= DAMAGE.fixFrom ? DAMAGE.repair[p] * clamp01(P[p]) : 0), 0);
}
export function repair(state) {
  const d = state.damage; if (!d || d.out) return;
  for (const p of DAMAGE.parts) d.parts[p] = 0;
  d.warned = {}; update(d);
}