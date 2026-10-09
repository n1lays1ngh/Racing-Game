// AI drivers. They drive with exactly the same physics as you (physics.js): same grip, same brakes, same engine
// (difficulty can give them a little extra grip: DIFFICULTY in race.js). What makes them drivers:
//
//   • A plan for the road ahead, every step: the line it will drive for the next few hundred metres (the racing
//     line, or a line beside another car), and the fastest speed at every point of it, braking from as late as the
//     car can (tyres, plus the drag and engine braking that help slow it down at speed). So it brakes late, carries
//     speed through the corners and is quick from the first corner of the race.
//   • Racecraft: it sees every car round it and where they're going (and how close they really are: on the inside of
//     a hairpin, much closer than the distance round the middle of the road). It only moves across the track where
//     the road is straight enough to do it without upsetting the car.
//       follow    a car in front on its line: keeps a safe gap and never runs into the back of it
//       side      a car beside it: leaves it a car's width, through the corners too (it never turns in on you)
//       attack    a slower car ahead: pulls out on the side with room, preferably the inside of the next corner,
//                 and waits in the tow on a long straight before it pulls out (slipstream.js)
//       defend    a car right behind before a corner: one move to cover the inside, never a weave
//       yield     about to be lapped: moves off the line on the straight to let the leader by
//       start     reacts to the lights going out like a driver (a fraction of a second, never the same twice),
//                 then keeps to its own side of the track until the first braking zone
//   • Pace: each driver has his own (race.js: the front of the grid is quickest, in the corners and on the straights),
//     so the field spreads out like a real one instead of queueing nose to tail, and it varies a little lap to lap.
//   • Car control: it feeds the power in when the rear starts to slide, and lifts when it's running wide.
// It uses its ERS battery (ers.js) out of corners and on the straights, keeping some back for attacking and defending.
import { CAR, clamp, steerLimit } from './physics.js';
import { HALF_WIDTH } from './track.js';
import { SLIPSTREAM } from './slipstream.js';

export const AI_TUNE = {
  // Hairpins and other very tight corners: the AI gets this much more steering lock than the base car
  // (like its grip bonus, see DIFFICULTY in race.js), so it takes them at a real hairpin speed instead
  // of crawling round. 1 = same lock as you; 1.2 ≈ 45–50 km/h through a Monaco-style hairpin.
  lockBonus: 1.2,
  // Corners slower than `below` (m/s; 25 = 90 km/h) are planned this much faster. 1 = off.
  slowCorners: { below: 25, boost: 1.04 },
  minWideSpeed: 9,     // when it runs wide in a tight corner it slows to no less than this (m/s) to get back on line
  edge: 0.3,           // metres between its line (the car's centre) and the edge of the track (the racing line's
                       // own: RACING_LINE_EDGE, track.js): its outside wheels go on the kerb
  moveGrip: 0.4,       // moving across the track (to pass, to defend, back to the racing line) uses at most this share
                       // of the tyres' grip, so it never has to brake for its own change of line
  reaction: 0.05,      // s: it starts braking this much before the last moment
  clearance: 0.5,      // m: room it leaves beside another car (on top of the cars' own width)
  passRoom: 1.0,       // m: … and when it pulls out to pass
  follow: { gap: 1.5, time: 0.12 }, // the least gap it keeps to the car in front: metres + seconds × speed
  tow: { gap: 0.8, time: 0.02 },     // … and sitting in its tow on a straight, waiting to pull out (right under its wing)
  attack: {
    range: 1.15,       // s: considers passing a car this close ahead (and at most 45 m)
    closing: 0.6,      // m/s: … if it's catching it at least this fast (or is the quicker driver, or is in its tow)
    slingshot: 260,    // m: in the tow with more straight than this left, it stays in the tow before pulling out
    giveUp: 9,         // s: gives up a move that hasn't worked by then
    pressure: 1.0,     // s: stuck this close behind a car …
    patience: 5,       // s: … for this long (÷ its aggression) and it tries a move at the next braking zone anyway
    dive: 3,           // m (× aggression): how far short of alongside it may be at turn-in and still go for it (it
                       // makes that up on the brakes)
  },
  // a car behind: it covers the inside if that car is within `range` s of it, or catching it fast enough to be by
  // the braking point; the move starts between `from` and `to` seconds before the braking point (at its speed)
  // (late enough that the attacker has picked its side: an early move only opens the door for a switchback)
  defend: { range: 0.75, from: 0.6, to: 2.4 },
  // Fighting (a car within `range` m ahead, or `behind` m behind): it brakes later (this much more of its braking,
  // × aggression, up to `maxBrake`) and carries a little more speed through the corners (`pace`, × aggression)
  fight: { range: 25, behind: 15, brake: 0.04, maxBrake: 1.02, pace: 0.008 },
  boxed: 0.7,          // s: squeezed out by a car level with it within this much road: it tucks in behind that car …
  yieldDrop: 0.5,      // m/s: … this much slower than it (ready to fight back on the exit)
  start: 120,          // m: off the grid each car keeps to its own side of the track (then it races: closes doors)
  scramble: 150,       // m past the first corner's apex: until then (lap 1) a car with another right ahead pulls out
                       // alongside it, so the field goes into turn 1 two and three abreast instead of in a queue
  launch: [0.1, 0.24], // s: how long it takes to react to the lights going out (each driver differs, each start)
  ers: {
    straight: 1.6,     // deploys when the road ahead is clear to accelerate for this many seconds
    reserve: [0.1, 0.4], // charge each driver keeps back (picked at random per driver) …
    attack: 45,        // … but spends it when a car is this close ahead (metres)
    defend: 40,        // … or this close behind
  },
  form: 0.0015,        // lap to lap its pace varies by up to this much either way (0.0015 ≈ ±0.1 s a lap at Monza)
  plan: 0.025,         // s: how often it plans the road ahead afresh (in between it drives the plan it has)
};
const VMAX = 120; // planned speed on straights (above what the car can reach, so the AI never lifts there)

// ---------- what the car can do (the same sums as physics.js) ----------
// Fastest it can take a bend of curvature k (1/m) at sample i: tyre grip (mu, with any grip bonus), downforce,
// dips and crests (vc), banking, and enough steering lock (with the AI's extra lock)
function cornerSpeed(k, p, mu, vc, bank) {
  const denom = k - mu * p.downforce - mu * vc;
  const bankG = p.g * (1 + 0.5 * p.mu) * Math.sin(Math.abs(bank));
  let v = denom <= 1e-5 ? VMAX : Math.min(VMAX, Math.sqrt((mu * p.g + bankG) / denom));
  if (v < AI_TUNE.slowCorners.below) v *= AI_TUNE.slowCorners.boost; // a little braver in slow corners
  const need = Math.atan(k * (p.steerBase ?? p.wheelbase)) * 1.02;     // lock this corner needs (small margin)
  if (need > 1e-6) v = Math.min(v, Math.max(p.steerFade * ((p.maxSteer * AI_TUNE.lockBonus) / need - 1), 5));
  return v;
}
// How hard it can slow down at speed v: the brakes (as much as the tyres allow) plus the air, the rolling resistance
// and the engine braking you get off the throttle, and the hill (grade + = uphill, helps). brakeUse: how much of it
// the driver plans to use (1 = all of it: the latest braking there is).
export function brakeDecel(p, v, mu, brakeUse = 1, grade = 0, vc = 0) {
  const gEff = Math.max(p.g + vc * v * v, 2);
  const tyres = Math.min(p.brake, 1.2 * mu * (gEff + p.downforce * v * v));
  return Math.max(brakeUse * (tyres + p.drag * v * v + p.roll + (p.liftOff ?? 0)) + p.g * grade, 5);
}

// Target speed at every sample of the racing line: the fastest through each corner, then a pass backwards round
// the lap so it brakes in time for the next one. grip: grip bonus (1 = the same as you); gripSafety: how close to
// the cornering limit it plans (1 = right on it); brakeUse: how much of the braking it plans to use (1 = all);
// p: the car's physics (its file in src/cars/). Also what the racing line on the track is drawn from (racingLine.js).
export function buildSpeedProfile(track, grip = 1, gripSafety = 0.97, brakeUse = 0.9, p = CAR) {
  const { n, ds } = track;
  const v = new Float32Array(n);
  const mu = p.mu * grip * gripSafety;
  const vc = (i) => (track.vcurv ? track.vcurv[i] : 0);   // + dip, − crest
  const grade = (i) => (track.grade ? track.grade[i] : 0); // + uphill
  for (let i = 0; i < n; i++) v[i] = cornerSpeed(track.rcurv[i], p, mu, vc(i), track.bank ? track.bank[i] : 0);
  for (let loop = 0; loop < 2; loop++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = v[(i + 1) % n];
      v[i] = Math.min(v[i], Math.sqrt(next * next + 2 * brakeDecel(p, next, mu, brakeUse, grade(i), vc(i)) * ds));
    }
  }
  return v;
}

// ---------- what the AI knows about a circuit (worked out once) ----------
// ratio: the racing line's smoothed curvature ÷ the same measured roughly (so a line it plans itself, measured the
// rough way, gives the same corner speeds as the racing line). corners: every corner's slowest point (apex, i), which
// way it turns there (side: +1 = left, so the inside is on the left), how slow (v), where its braking zone starts
// (brakeAt), where it turns in (turnIn) and which way that first part turns (entrySide); next: from each sample, the
// next corner.
function circuitInfo(t, profile) {
  if (!t.aiInfo) {
    const n = t.n, ratio = new Float32Array(n), K = 5;
    for (let i = 0; i < n; i++) {
      const raw = curvature(t.rx[(i - K + n) % n], t.rz[(i - K + n) % n], t.rx[i], t.rz[i], t.rx[(i + K) % n], t.rz[(i + K) % n]);
      ratio[i] = raw > 2e-4 ? clamp(t.rcurv[i] / raw, 0.5, 1.5) : 1;
    }
    const head = new Float32Array(n); // the direction of the road at each sample
    for (let i = 0; i < n; i++) head[i] = Math.atan2(t.tx[i], t.tz[i]);
    t.aiInfo = { ratio, head, byProfile: new WeakMap() };
  }
  const I = t.aiInfo;
  let c = I.byProfile.get(profile);
  if (!c) {
    const n = t.n, corners = [], W = 20;
    for (let i = 0; i < n; i++) { // the slowest point within ±40 m, and properly slow
      const vi = profile[i];
      if (vi > 85) continue;
      let min = true;
      for (let d = 1; d <= W && min; d++) min = profile[(i + d) % n] > vi - 1e-3 && profile[(i - d + n) % n] >= vi;
      if (!min) continue;
      let turn = 0; for (let d = -15; d <= 15; d++) turn += t.curv[(i + d + n) % n];
      // the braking zone: back from the apex to the fastest point before it (through a chicane's little rise in speed,
      // all the way back to the straight). Then where it turns in (the first real bend after that) and which way that
      // first bend goes: in a chicane, the side to defend or attack is the inside of the first part
      let b = i, top = vi;
      for (let d = 1; d < 400; d++) { const j = (i - d + n) % n; if (profile[j] > top) { top = profile[j]; b = j; } else if (profile[j] < top - 4) break; }
      let kmax = 0;
      for (let j = b, m = 0; m <= (i - b + n) % n; m++, j = (j + 1) % n) kmax = Math.max(kmax, Math.abs(t.curv[j]));
      let turnIn = i;
      for (let j = b, m = 0; m <= (i - b + n) % n; m++, j = (j + 1) % n) if (Math.abs(t.curv[j]) > kmax * 0.5) { turnIn = j; break; }
      let first = 0; for (let d = 0; d <= 8; d++) first += t.curv[(turnIn + d) % n];
      corners.push({ i, side: Math.sign(turn) || 1, v: vi, brakeAt: b, turnIn, entrySide: Math.sign(first) || Math.sign(turn) || 1 });
    }
    const next = new Int32Array(n).fill(0); // the next corner from each sample (after the last one: the first)
    if (corners.length) {
      let k = 0;
      for (let i = 0; i < n; i++) {
        while (k < corners.length && corners[k].i < i) k++;
        next[i] = k < corners.length ? k : 0;
      }
    }
    c = { corners, next, ratio: I.ratio, head: I.head };
    I.byProfile.set(profile, c);
  }
  return c;
}
function curvature(ax, az, bx, bz, cx, cz) { // through three points (1/m)
  const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz);
  const cross = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
  return (2 * cross) / Math.max(ab * bc * ca, 1e-6);
}
const TAU = Math.PI * 2, wrap = (a) => a - TAU * Math.round(a / TAU); // an angle, −π … π
const hermite = (x) => (x >= 1 ? 0 : x <= 0 ? 1 : (1 - x) * (1 - x) * (1 + 2 * x)); // 1 → 0, smooth at both ends
const MAXK = 200; // samples of road it plans at most (×2 m)

// When the AI runs out of steering lock and drifts wide of its line:
const WIDE = 1;         // metres outside the line before it reacts
const ROOM = 3;         // ...and less than this much tarmac left on the outside
const LOCK_BRAKE = 1.3; // needs 30% more lock than it has → brake, not just lift

// Plans made afresh just because it's time (or the line it wants moved) are spread out: at most PLAN_BUDGET of them in
// one physics step across the whole field (race.js calls newPlanStep each step); the rest wait a step (8 ms). In a
// pack at the start, 15 drivers re-planning in the same step made that step many times the usual cost: a spike.
// Plans a car can't do without (its first, or it's driven past the end of the one it has) are never held back.
const PLAN_BUDGET = 6;
let planBudget = PLAN_BUDGET;
export function newPlanStep() { planBudget = PLAN_BUDGET; }

// The line a driver holds instead of the racing line: always the same fields (see the constructor's note)
const makeLane = (kind, lat, ref = null, until = 0, side = 0) => ({ kind, lat, ref, until, side, age: 0 });

export class AIDriver {
  // car: the car state it drives; profile: the speed plan for the race's difficulty (race.js); skill: its pace (1 = on
  // the limit, 0.97 = 3% slower through the corners); grip: grip bonus. opts: brakeUse, safety (as in
  // buildSpeedProfile), power (0–1: how much of the engine it uses), defence (0–1: how readily it covers the inside),
  // start (true: it's starting from the grid)
  constructor(car, track, profile, skill = 0.93, grip = 1, opts = {}) {
    this.car = car; this.track = track; this.profile = profile;
    this.skill = skill; this.grip = grip;
    this.brakeUse = opts.brakeUse ?? 0.97; this.safety = opts.safety ?? 0.99; this.defence = opts.defence ?? 0.6;
    this.power = opts.power ?? 1;  // how much of the engine it uses (difficulty: slower drivers are slower on the straights too)
    this.p = car.spec?.physics ?? CAR;                   // the car it's driving (src/cars/)
    const [r0, r1] = AI_TUNE.ers.reserve;
    this.ersReserve = r0 + Math.random() * (r1 - r0);   // some drivers save more battery than others
    this.usesErs = skill > 0.8 && (car.spec ? !!car.spec.ers : true); // (not on your cool-down lap; not if the car has none)
    this.lane = null;              // the line it's holding instead of the racing line: { kind, lat, ref, age, until }
    // its own rhythm for thinking and planning, so 19 drivers don't all do it in the same physics step (a frame-time spike)
    this.think = Math.random() * 0.085; this.planEvery = AI_TUNE.plan * (0.85 + 0.3 * Math.random());
    this.out = { throttle: 0, brake: 0, steer: 0, boost: false, abs: true, grip: 1, lock: 1 }; // what it returns (one object, reused)
    this.odo = opts.start ? 0 : Infinity;               // metres since the start (start lanes)
    const [l0, l1] = AI_TUNE.launch;
    this.launch = opts.start ? l0 + Math.random() * (l1 - l0) : 0; // its reaction when the lights go out
    this.gridLat = car.lateral;
    this.path = new Float32Array(MAXK + 1); this.want = new Float32Array(MAXK + 1);
    this.lo = new Float32Array(MAXK + 1); this.hi = new Float32Array(MAXK + 1); this.vk = new Float32Array(MAXK + 1);
    this.near = []; this.pool = [];
    this.planI = -1; this.planAge = 0; this.planK = 0; this.planLane = null; this.planLat = null; this.squeeze = Infinity;
    this.form = 1; this.lastS = car.s;  // lap to lap a driver is never quite the same (AI_TUNE.form)
    // (every field it ever has, set here: an object that gains fields as it goes changes shape, and the browser then
    //  throws away the fast compiled code for update() and falls back to slow code that makes garbage)
    this.route = null; this.stopAt = null; this.hold = false; this.planRoute = null; this.planLat = null;
    this.blocked = null; this.towing = null; this.kDemand = -1; this.wasWide = false; this.startDone = false; this.defendedAt = -1;
    // racecraft: aggression (attack, 0–1 from the difficulty) and defence, a little different for each driver;
    // fight: racing a car right now (brakes later); stalk: seconds stuck right behind the car ahead; bu: braking it plans
    this.attack = opts.attack ?? 0.6;
    this.aggr = Math.min(1.2, this.attack * (0.75 + 0.5 * Math.random()));
    this.defence = Math.min(1, this.defence * (0.85 + 0.3 * Math.random()));
    this.fight = false; this.stalk = 0; this.bu = this.brakeUse;
    this.scrambleTo = opts.start ? -1 : 0; // odo where the lap-1 scramble ends (worked out on its first look ahead)
  }

  // others: the race's cars (race.js; or just their states)
  update(dt, others) {
    const { car, track: t, p } = this, T = AI_TUNE, n = t.n, ds = t.ds, L = t.length;
    const info = circuitInfo(t, this.profile);
    if (this.hold) return this.output(0, 0, 0, false); // in its pit box
    if (this.launch > 0) { // lights out: a moment to react, holding the revs
      this.launch -= dt;
      return this.output(0.4, 0, 0, false);
    }
    const i = car.trackIndex < 0 ? 0 : car.trackIndex;
    const v = Math.max(car.vf, 0), lat = car.lateral;
    const R = p.radius ?? 1.25, co = p.contactOffset ?? 1.4;
    const len = 2 * (co + R);         // nose to tail, centre to centre, the cars touch
    const Wc = 2 * R + T.clearance;   // side by side: the gap it keeps, centre to centre (both cars straight)
    const head = info.head, myPsi = wrap(car.h - head[i]);
    const myExt = R + co * Math.abs(Math.sin(myPsi)), myLatV = car.vx * t.nx[i] + car.vz * t.nz[i];
    const tow = car.tow ?? 0;
    const mu = p.mu * this.grip * this.safety * (1 - SLIPSTREAM.dirtyAir * tow) * (car.tyreGrip ?? 1) // (dirty air behind another car; its tyres …
      * (car.damage ? car.damage.fx.grip * (0.5 + 0.5 * car.damage.fx.aero) : 1); // … and damage: damage.js)
    this.odo += v * dt;
    if (car.s < this.lastS - L / 2) this.form = 1 + (Math.random() - 0.5) * 2 * T.form; // over the line: a new lap
    this.lastS = car.s;

    // ---- the cars round it, in track terms: metres ahead (d), lateral, speed, sideways speed ----
    if (this.me === undefined || (this.me && (this.me.state ?? this.me) !== car)) {
      this.me = null; for (const o of others) if ((o.state ?? o) === car) { this.me = o; break; }
    }
    const myProg = this.me?.progress;
    const near = this.near; near.length = 0;
    for (const o of others) {
      const st = o.state ?? o;
      if (st === car || o.dnf) continue;
      let d = st.s - car.s;
      if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
      if (d < -80 || d > 170) continue;
      const j = st.trackIndex < 0 ? 0 : st.trackIndex;
      // the distance along the road at the lines we're on: on the inside of a hairpin cars are much closer together
      // than the distance along the middle of the road says (and further apart on the outside)
      const km = (t.curv[i] + t.curv[j] + 2 * t.curv[(i + Math.round(d / 2 / ds) + n) % n]) / 4;
      d *= clamp(1 - (km * (lat + st.lateral)) / 2, 0.3, 1.7);
      const N = this.pool[near.length] ??= {};
      N.o = o; N.d = d; N.lat = st.lateral; N.v = Math.max(st.vf, 0);
      N.latV = st.vx * t.nx[j] + st.vz * t.nz[j];
      // how far it reaches across the track and along it: a car turned across the road takes up more width
      N.ext = R + co * Math.abs(Math.sin(wrap(st.h - head[j])));
      N.lapping = o.progress != null && myProg != null && o.progress - myProg > L * 0.5; // a lap or more ahead of me
      N.lapped = o.progress != null && myProg != null && myProg - o.progress > L * 0.5;
      N.skill = o.ai?.skill ?? -1; // (−1: not an AI driver)
      near.push(N);
    }

    // ---- decisions, a dozen times a second: which line to hold ----
    this.think -= dt;
    if (this.think <= 0) { this.decide(near, v, i, lat, info, len, Wc, 0.085); this.think = 0.085; }

    // ---- the plan: where it'll be across the track for the next H metres, and how fast it can go all the way along
    // it. Made afresh 40 times a second (AI_TUNE.plan), and whenever the line it wants changes; in between it drives
    // the plan it has (`off`: how many samples along it the car is now) ----
    const FT = this.fight ? T.fight : null; // racing someone: later braking, a touch more corner speed
    const pace = this.skill * this.form * (FT ? 1 + FT.pace * this.aggr : 1);
    const bu = this.bu = FT ? Math.min(FT.maxBrake, Math.max(this.brakeUse, this.brakeUse + FT.brake * this.aggr)) : this.brakeUse;
    const { path, want, lo, hi, vk } = this, edge = T.edge;
    const lane = this.lane, route = this.route, pl = route && t.pitLane; // route: into the pits (pitstop.js), its own line
    let off = (i - this.planI + n) % n, K = this.planK, squeeze = this.squeeze;
    this.planAge += dt;
    const mustPlan = this.planI < 0 || off > 8 || route !== this.planRoute;
    if (mustPlan || ((this.planAge >= this.planEvery || lane !== this.planLane || (lane && lane.lat !== this.planLat)) && planBudget > 0)) {
      if (!mustPlan) planBudget--;
      this.planI = i; this.planAge = 0; this.planLane = lane; this.planLat = lane?.lat; this.planRoute = route; off = 0;
      const H = clamp((v * v) / 36 + v * 0.6 + 40, 60, MAXK * ds);
      K = this.planK = Math.min(MAXK, Math.ceil(H / ds));
      // metres it takes to move across to a new line: no more than a share of the tyres' grip at this speed goes on
      // the move (AI_TUNE.moveGrip), so the further across and the faster, the longer it takes (a GT3 more than an F1)
      const dLat = Math.abs(lat - (route ? route[i] : lane ? lane.lat : t.ro[i])), aMax = mu * (p.g + p.downforce * v * v);
      const Bc = clamp(Math.max(v * 0.9, v * Math.sqrt((6 * dLat) / Math.max(T.moveGrip * aMax, 1))), 14, (MAXK - 5) * ds);
      for (let k = 0; k <= K; k++) {
        const j = (i + k) % n, hw = t.hw ? t.hw[j] : HALF_WIDTH;
        lo[k] = -hw + edge; hi[k] = hw - edge;
        if (pl && pl.range[j]) { const o = pl.out[j] - edge; if (pl.side > 0) hi[k] = Math.max(hi[k], o); else lo[k] = Math.min(lo[k], -o); } // the pit lane
        want[k] = route ? route[j] : lane ? clamp(lane.lat, lo[k] + 0.3, hi[k] - 0.3) : t.ro[j];
      }
      const err0 = lat - want[0];
      for (let k = 0; k <= K; k++) {
        const f = hermite((k * ds) / Bc);
        path[k] = want[k] + err0 * f;
        // off the edge right now (a kerb, a run-off): come back to the track gradually, not with a jerk
        if (lat < lo[k]) lo[k] -= (lo[k] - lat) * f;
        if (lat > hi[k]) hi[k] += (lat - hi[k]) * f;
      }
      // cars beside it (now or where its path meets them): stay on its own side of them, a car's width away
      squeeze = Infinity;
      const boxedM = Math.max(20, v * T.boxed);
      for (const N of near) {
        const sep = N.lat - lat, side = sep >= 0 ? 1 : -1;
        // the gap to keep from this car: both cars' width across the track (more when they're turned), the clearance,
        // and a little more when we're closing on each other sideways
        const closingSide = Math.max(0, (myLatV - N.latV) * side);
        const W = myExt + N.ext + T.clearance + closingSide * 0.25;
        const beside = Math.abs(sep) >= W - 0.7;
        if (!beside && (N.d > 0 || N.d < -len)) continue; // straight ahead (follow / pass) or straight behind (its job)
        // when its nose and tail overlap mine along the plan (both carrying on at their speeds)
        const rate = N.v / Math.max(v, 3) - 1;   // relative position changes by rate × (metres I've driven)
        let k0 = 0, k1 = K;
        const m = len + 1.5;
        if (Math.abs(rate) < 1e-4) { if (Math.abs(N.d) > m) continue; }
        else {
          const a = (-m - N.d) / rate / ds, b = (m - N.d) / rate / ds;
          k0 = Math.max(0, Math.ceil(Math.min(a, b))); k1 = Math.min(K, Math.floor(Math.max(a, b)));
          if (k1 < k0) continue;
        }
        // where it's heading across the track, if it's coming my way (not when I'm the one closing on it). A car behind
        // is the one that has to avoid me: I keep clear of where it is, not of where it might be going
        const towards = N.d < -len * 0.5 ? 0 : side > 0 ? Math.min(0, N.latV) : Math.max(0, N.latV);
        const yields = N.d > -len * 0.3; // boxed in by a car level with it or ahead: it drops back behind that one
        for (let k = k0; k <= k1; k++) {
          const nl = N.lat + towards * Math.min((k * ds) / Math.max(v, 3), 0.6);
          const hwk = t.hw ? t.hw[(i + k) % n] : HALF_WIDTH, tLo = -hwk + edge, tHi = hwk - edge;
          // (never past the far edge of the track: no room left means drop back, not off the road)
          if (side > 0) { const b = nl - W; if (b < Math.max(lo[k], tLo) && yields && k * ds < boxedM) squeeze = Math.min(squeeze, N.v); hi[k] = Math.min(hi[k], Math.max(b, tLo)); }
          else { const b = nl + W; if (b > Math.min(hi[k], tHi) && yields && k * ds < boxedM) squeeze = Math.min(squeeze, N.v); lo[k] = Math.max(lo[k], Math.min(b, tHi)); }
        }
      }
      // the edges of the room it has change gradually (it moves over in good time, not at the last moment)
      const slope = 0.16 * ds;
      for (let k = K - 1; k >= 0; k--) { hi[k] = Math.min(hi[k], hi[k + 1] + slope); lo[k] = Math.max(lo[k], lo[k + 1] - slope); }
      for (let k = 1; k <= K; k++) { hi[k] = Math.min(hi[k], hi[k - 1] + slope); lo[k] = Math.max(lo[k], lo[k - 1] - slope); }
      for (let k = 0; k <= K; k++) {
        if (lo[k] <= hi[k]) { path[k] = clamp(path[k], lo[k], hi[k]); continue; }
        const hwk = (t.hw ? t.hw[(i + k) % n] : HALF_WIDTH) - edge * 0.5; // boxed in: the middle of the gap, on the road
        path[k] = clamp((lo[k] + hi[k]) / 2, Math.min(-hwk, lat), Math.max(hwk, lat));
      }

      // ---- speed: the fastest it can go round that line, braking for every corner on it at the last moment ----
      // corner speed at every point of the line (its curvature through the points 10 m either side; on the racing line,
      // corrected to the racing line's own smoothed curvature; off it, as measured)
      const ratioAt = (b, dev) => { const r = info.ratio[b]; return r >= 1 ? r : r + (1 - r) * Math.min(1, dev); };
      for (let k = 5; k <= K - 5; k++) {
        const a = (i + k - 5) % n, b = (i + k) % n, c = (i + k + 5) % n;
        const kap = curvature(t.cx[a] + t.nx[a] * path[k - 5], t.cz[a] + t.nz[a] * path[k - 5], t.cx[b] + t.nx[b] * path[k],
          t.cz[b] + t.nz[b] * path[k], t.cx[c] + t.nx[c] * path[k + 5], t.cz[c] + t.nz[c] * path[k + 5]) * ratioAt(b, Math.abs(path[k] - t.ro[b]));
        const vc = t.vcurv ? t.vcurv[b] : 0, bank = t.bank ? t.bank[b] : 0;
        // never faster than the racing line itself there (the fastest way round: a line rejoining it from wide
        // looks straighter than it can really be driven)
        vk[k] = Math.min(cornerSpeed(kap, p, mu, vc, bank), cornerSpeed(t.rcurv[b], p, mu, vc, bank)) * pace;
      }
      // the first and last few metres (no points 10 m either side on the plan): the racing line's corner speed there
      const lineV = (k) => { const b = (i + k) % n; return cornerSpeed(t.rcurv[b], p, mu, t.vcurv ? t.vcurv[b] : 0, t.bank ? t.bank[b] : 0) * pace; };
      for (let k = 0; k < 5; k++) vk[k] = Math.min(vk[5], lineV(k));
      for (let k = K - 4; k <= K; k++) vk[k] = Math.min(vk[K - 5], lineV(k));
      vk[K] = Math.min(vk[K], this.profile[(i + K) % n] * pace); // and beyond the plan: the racing line's own speed
      if (pl) for (let k = 0; k <= K; k++) if (pl.limit[(i + k) % n]) vk[k] = Math.min(vk[k], (pl.limitKmh ?? 80) / 3.6 - 0.4); // the pit limiter
      for (let k = K - 1; k >= 0; k--) {
        const j = (i + k) % n, next = vk[k + 1];
        const b = brakeDecel(p, next, mu, bu, t.grade ? t.grade[j] : 0, t.vcurv ? t.vcurv[j] : 0);
        vk[k] = Math.min(vk[k], Math.sqrt(next * next + 2 * b * ds));
      }
      this.squeeze = squeeze;
    }
    const at = (k) => Math.min(K, k + off); // sample k metres/ds ahead of the car, in the plan
    const kr = Math.min(K, Math.max(1, Math.round((v * T.reaction) / ds)));
    let target = vk[at(kr)];
    if (this.stopAt) { // its pit box: stop right on it
      const d = ((this.stopAt.s - car.s + L * 1.5) % L) - L / 2;
      target = Math.min(target, Math.sqrt(2 * 5 * Math.max(0, d - 0.3)));
    }

    // ---- a car in front on its line: never closer than it can stop behind (whatever that car does) ----
    this.blocked = null;
    for (const N of near) {
      if (N.d <= 0) continue;
      const kN = Math.max(0, Math.round((N.d - len * 0.5) / ds));
      const reach = N.d / Math.max(v - N.v, 0.5), nl = N.lat + N.latV * Math.min(reach, 0.5);
      const Wf = Math.max(Wc, myExt + N.ext + T.clearance) - 0.1; // (turned across the road, as in a hairpin, a car is wider)
      if (Math.abs(nl - path[at(kN)]) >= Wf && Math.abs(N.lat - path[at(kN + 2)]) >= Wf && Math.abs(N.lat - lat) >= Wf - 0.3) continue;
      const F = N.o === this.towing ? T.tow : T.follow;
      // (a little more room in a hairpin, where both cars are turned across the road and swing about)
      const gap = N.d - len - F.gap - v * F.time - clamp((t.rcurv[i] - 0.03) * 30, 0, 1.5);
      const b = brakeDecel(p, N.v, mu, 0.85), tau = F === T.tow ? 0.03 : T.reaction + 0.05;
      const vs = -b * tau + Math.sqrt(b * b * tau * tau + N.v * N.v + 2 * b * Math.max(0, gap));
      if (vs < target) { target = vs; this.blocked = N; }
    }
    if (squeeze < Infinity) target = Math.min(target, Math.max(Math.min(squeeze, 6), squeeze - T.yieldDrop)); // boxed in: tuck in behind

    // ---- steering: aim at a point on its line a little way ahead (pure pursuit) ----
    let lookDist = 5 + v * 0.28;
    const kAhead = Math.max(t.rcurv[i], t.rcurv[(i + Math.round(lookDist / ds)) % n]);
    if (kAhead > 1e-4) lookDist = Math.min(lookDist, 1.3 / kAhead);
    lookDist = Math.max(lookDist, 5) * (this.wasWide ? 1.5 : 1);
    const kL = Math.min(K - off, Math.round(lookDist / ds)), j = (i + kL) % n;
    // (never aim across a car beside it: the aim point stays inside the room it has all the way to there)
    let aimLo = -Infinity, aimHi = Infinity;
    for (let k = off; k <= off + kL; k++) { if (lo[k] > aimLo) aimLo = lo[k]; if (hi[k] < aimHi) aimHi = hi[k]; }
    const aim = aimLo > aimHi ? (aimLo + aimHi) / 2 : clamp(path[off + kL], aimLo, aimHi);
    const tx = t.cx[j] + t.nx[j] * aim, tz = t.cz[j] + t.nz[j] * aim;
    const dx = tx - car.x, dz = tz - car.z;
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    const fwd = dx * fx + dz * fz, left = dx * fz - dz * fx;
    const curv = (2 * left) / Math.max(fwd * fwd + left * left, 1);
    const steerAngle = Math.atan(curv * (p.steerBase ?? p.wheelbase));
    const lockHere = steerLimit(v, p) * T.lockBonus;  // its steering lock at this speed
    const steer = clamp(steerAngle / lockHere, -1, 1);

    // ---- the turn it actually needs to get back onto its line: no faster than the tyres can take that turn ----
    // (off its line on the outside of a bend it needs a tighter turn than the line: it lifts until it can make it)
    const kNeed = Math.abs(curv), kLine = t.rcurv[i];
    this.kDemand = this.kDemand < 0 ? kNeed : this.kDemand + (kNeed - this.kDemand) * Math.min(1, dt * 12);
    const outside = (lat - path[off]) * -Math.sign(curv) + (lat - want[off]) * -Math.sign(curv); // > 0: wide of its line
    if (this.kDemand > kLine * 1.15 && v > 12 && outside > 0.8) {
      const vNeed = cornerSpeed(this.kDemand, p, mu, t.vcurv ? t.vcurv[i] : 0, t.bank ? t.bank[i] : 0) * pace;
      if (vNeed < target) target = Math.max(vNeed, target - 6);
    }
    // ---- running out of lock (drifting wide of its line)? lift, and if it's well past it, slow down ----
    const need = Math.abs(steerAngle), have = lockHere;
    const wide = (lat - want[off]) * Math.sign(steerAngle) < -WIDE;
    this.wasWide = wide && need > have;
    const hwHere = t.hw ? t.hw[i] : HALF_WIDTH;
    const room = hwHere + lat * Math.sign(steerAngle); // tarmac left on the outside
    const outOfLock = need > have && v > 10 && wide && room < ROOM;
    if (outOfLock && need > have * LOCK_BRAKE) {
      const fits = p.steerFade * ((p.maxSteer * T.lockBonus) / need - 1); // speed at which the lock is enough
      target = Math.min(target, Math.max(fits, T.minWideSpeed));
    }
    // off the track: no flooring it on the grass, come back on first
    const offTrack = car.surface === 'grass' || car.surface === 'gravel';
    if (offTrack) target = Math.min(target, Math.max(v, 14));

    // ---- throttle and brake ----
    // On the throttle until the plan says slow down; then exactly as hard as the plan's braking curve needs (the
    // slowing it plans for the next few metres, less what the air, the engine braking and the hill give for free).
    const err = target - v;
    let throttle = 0, brake = 0;
    if (err < 0.2) {
      const k1 = at(kr), k2 = Math.min(K, k1 + 4), vt = Math.min(vk[k2], target);
      const needDecel = vt < v ? (v * v - vt * vt) / (2 * Math.max((k2 - k1) * ds + (v - target > 0 ? 0 : 1), 1)) : 0;
      const free = p.drag * v * v + p.roll + (p.liftOff ?? 0) + p.g * (t.grade ? t.grade[i] : 0);
      const tyres = Math.min(p.brake, 1.2 * mu * (Math.max(p.g + (t.vcurv ? t.vcurv[i] : 0) * v * v, 2) + p.downforce * v * v));
      brake = clamp(((needDecel - free) / tyres) * 1.05 + Math.max(0, -err) * 0.4, 0, 1);
      if (brake < 0.04) { brake = 0; if (err > -0.3 && !outOfLock) throttle = clamp(0.3 + err, 0, 0.5); } // lifting is enough
    } else if (!outOfLock) throttle = err > 1 ? 1 : 0.4 + err * 0.6;
    if (offTrack) throttle = Math.min(throttle, 0.7);
    const slip = car.slip ?? 0; // sliding sideways (m/s): feed the power in gently until the tyres grip again
    if (slip > 0.7 && throttle > 0) throttle *= clamp(1 - (slip - 0.7) * 0.9, 0.25, 1);
    if (fwd < 0) { throttle = 0.5; brake = 0; } // facing the wrong way: drive round to the line

    // ---- ERS (ers.js) ----
    // Deploy when flat out with clear road to accelerate (out of corners, down the straights), keeping a reserve unless
    // there's a car to attack or keep behind; a full battery is always used (braking would waste the charge).
    let boost = false;
    if (this.usesErs && throttle >= 0.9 && v > 8 && !outOfLock && fwd > 0) {
      const charge = car.ers ?? 1, span = Math.round((v * T.ers.straight) / ds);
      let clear = true;
      for (let k = 0; k <= span && clear; k += 2) clear = vk[at(k)] > v + 6;
      let ahead = Infinity, behind = Infinity;
      for (const N of near) if (N.d > 0) ahead = Math.min(ahead, N.d); else behind = Math.min(behind, -N.d);
      const fight = ahead < T.ers.attack || behind < T.ers.defend || this.lane?.kind === 'pass';
      boost = clear && (charge > 0.97 || charge > (fight ? 0.02 : this.ersReserve));
    }
    // AI never locks up; `lock`: its extra steering lock (AI_TUNE.lockBonus, physics.js)
    return this.output(throttle * this.power, brake, steer, boost);
  }
  output(throttle, brake, steer, boost) {
    const o = this.out; o.throttle = throttle; o.brake = brake; o.steer = steer; o.boost = boost; o.abs = true; o.grip = this.grip; o.lock = AI_TUNE.lockBonus;
    return o;
  }

  // ---------- racecraft: which line to hold for now ----------
  decide(near, v, i, lat, info, len, Wc, dt) {
    const t = this.track, T = AI_TUNE, n = t.n, ds = t.ds, p = this.p, edge = T.edge;
    this.towing = null; // (the car whose tow it's sitting in, waiting to pull out: it follows that one closer)
    if (this.route) { this.lane = null; this.fight = false; return; } // heading into the pits: no racing
    const Wp = 2 * (p.radius ?? 1.25) + T.passRoom;
    // the narrowest the track gets over the next 100 m: the room there is to be beside someone
    let hw = Infinity;
    for (let k = 0; k <= 50; k += 5) hw = Math.min(hw, t.hw ? t.hw[(i + k) % n] : HALF_WIDTH);
    const lo = -hw + edge, hi = hw - edge;
    // the next corner: how far to its apex, which way, how far to where it brakes for it
    const C = info.corners;
    let dApex = Infinity, side = 1, dBrake = Infinity, dTurn = Infinity;
    if (C.length) {
      const c = C[info.next[i]];
      dApex = ((c.i - i + n) % n) * ds; side = c.entrySide;
      const ti = ((c.turnIn - i + n) % n) * ds; dTurn = ti > dApex ? 0 : ti; // (0: turning in already)
      const vc = c.v * this.skill;
      dBrake = dApex - Math.max(0, v * v - vc * vc) / (2 * brakeDecel(p, (v + vc) / 2, p.mu * this.grip, this.bu));
    }
    if (this.scrambleTo < 0) this.scrambleTo = Math.min(dApex, 2000) + T.scramble;
    const scramble = this.odo < this.scrambleTo; // lap 1, before the first corner: everyone wants a slot, no queueing
    // is the road straight for the next stretch (room to move across without upsetting the car)?
    let kMax = 0;
    for (let k = 0, m = Math.max(20, Math.round((v * 1.3) / ds)); k <= m; k += 2) kMax = Math.max(kMax, t.rcurv[(i + k) % n]);
    const straight = kMax < 1 / 180;
    // can it get across to `to` in good time? on a straight, yes; otherwise if the change of line (an S-bend at its
    // moveGrip share of the grip) is done before it turns in
    const aMove = T.moveGrip * p.mu * this.grip * p.g;
    const canMove = (to) => straight || Math.abs(to - lat) < 1.2 || Math.PI * v * Math.sqrt(Math.abs(to - lat) / (2 * aMove)) < dTurn;
    // racing someone close (not lapping or being lapped): it brakes later and pushes a little harder (update())
    let fight = false;
    for (const N of near) if (!N.lapping && !N.lapped && N.d < T.fight.range && N.d > -(T.fight.behind + len)) { fight = true; break; }
    this.fight = fight;
    const lane = this.lane;
    if (lane) {
      lane.age += dt;
      const R = lane.ref ? near.find((N) => N.o === lane.ref) : null;
      if (lane.kind === 'start') { if (this.odo > T.start || dBrake < 60) { this.lane = null; this.startDone = true; } else lane.lat = clamp(this.gridLat, lo, hi); }
      else if (lane.kind === 'pass') {
        if (!R || R.d < -(len + 4) || R.d > 70 || lane.age > T.attack.giveUp) this.lane = null; // done, or it got away
        // a corner coming and not alongside yet: carry on only if it'll be alongside by the time they turn in (a move
        // under braking); otherwise back in line and try again on the next straight
        // (an aggressive driver goes for it from a little further back: it makes the rest up on the brakes)
        else if (!straight && R.d - len - Math.max(0, v - R.v) * (dTurn / Math.max(v, 1)) > 1 + T.attack.dive * this.aggr) this.lane = null;
        else {
          // a car's width (and a bit) to that side of it: moving out further if it comes over, but not following it
          // back and forth across the road (only as far as it has to)
          const need = R.lat + lane.side * Wp, sd = lane.side;
          const want = clamp(sd > 0 ? Math.max(need, Math.min(lane.lat, need + 1.5)) : Math.min(need, Math.max(lane.lat, need - 1.5)), lo, hi);
          // no room left that side (it moved over, or the track got narrow) and not alongside yet: back off
          if (Math.abs(want - R.lat) < Wc - 0.2 && R.d > len * 0.6) this.lane = null;
          else lane.lat = want;
        }
      } else if (lane.kind === 'defend') {
        if (lane.age > 6 || ((lane.until - i + n) % n) * ds > L2(t) || !R || R.d < -(v * 2 + len + 10)) this.lane = null; // (2 s: as far back as a threat is seen)
      } else if (lane.kind === 'yield') {
        if (!R || R.d > len || lane.age > 8) this.lane = null;
      }
      if (this.lane) return; // one thing at a time
    }
    // ---- off the grid: keep to its own side until the field has strung out ----
    if (this.odo < T.start && dBrake > 60 && !this.startDone) { this.lane = makeLane('start', clamp(this.gridLat, lo, hi)); return; }
    // ---- about to be lapped: let the leader by on the straight ----
    const lapper = near.find((N) => N.lapping && N.d < 0 && N.d > -70);
    if (lapper && dBrake > 120) {
      const away = lapper.lat >= lat ? -1 : 1, to = away > 0 ? hi - 0.3 : lo + 0.3;
      if (canMove(to)) { this.lane = makeLane('yield', to, lapper.o); return; }
    }
    // ---- a slower car ahead: pass it ----
    let A = null;
    for (const N of near) {
      if (N.d <= 0 || N.d > Math.min(45, Math.max(14, v * T.attack.range)) || Math.abs(N.lat - lat) > Wc + 0.8) continue;
      if (!A || N.d < A.d) A = N;
    }
    // stuck right behind it: after a while (sooner for an aggressive driver) it has a go at the next braking zone anyway
    this.stalk = A && !A.lapping && A.d < Math.max(len + 4, v * T.attack.pressure) ? this.stalk + dt : Math.max(0, this.stalk - dt);
    if (A) {
      const closing = v - A.v, tow = this.car.tow ?? 0;
      const pushing = this.stalk > T.attack.patience / Math.max(this.aggr, 0.2) && dBrake < v * 3;
      const quicker = closing > T.attack.closing || A.lapped || (A.skill >= 0 && this.skill > A.skill + 0.002) || tow > 0.25 || pushing || scramble;
      // in its tow on a straight: stay in it while there's a long way to go, or while it's still too far back to get
      // alongside (the tow pulls it up to the gearbox); then pull out, nearer the braking point
      const towing = tow > 0.1 && straight && closing < 4;
      const slingshot = towing && !scramble && (dBrake > T.attack.slingshot || (A.d > len + 8 && closing < 2));
      if (quicker && slingshot) this.towing = A.o;
      if (quicker && !slingshot) {
        let best = null, bestScore = -Infinity;
        for (const s of [-1, 1]) {
          const want = A.lat + s * Wp;
          if (want < lo - 0.3 || want > hi + 0.3) continue;      // no room that side
          const at = clamp(want, lo, hi);
          if (Math.abs(at - A.lat) < Wc) continue;
          let clear = true;                                       // someone else already there?
          for (const N of near) if (N !== A && Math.abs(N.lat - at) < Wc && N.d > -len - 4 && N.d < A.d + 25) { clear = false; break; }
          if (!clear) continue;
          let score = -Math.abs(at - lat) * 0.2;
          if (dApex < 400) score += s === side ? 2 : -0.6;      // the inside of the next corner
          if (A.latV * s > 0.6) score -= 2.5;                      // it's moving that way: covering it
          if (score > bestScore) { bestScore = score; best = { s, at }; }
        }
        if (best && canMove(best.at)) { this.lane = makeLane('pass', best.at, A.o, 0, best.s); this.stalk = 0; return; }
      }
      if (quicker && A.d < 25) return; // on the attack: eyes forward, it isn't looking to defend as well
    }
    // ---- a car right behind before a corner: one move to cover the inside ----
    if (this.defence > 0) {
      // a threat: close behind already, or catching fast enough to be close by the braking point
      const tB = dBrake / Math.max(v, 1);
      let B = null;
      for (const N of near) {
        if (N.d >= -len || N.lapping || N.v < v - 0.5) continue;
        const gap = -N.d - len, near0 = gap < v * T.defend.range;
        if (!near0 && !(gap < v * 2 && gap - (N.v - v) * tB < v * T.defend.range)) continue;
        if (!B || N.d > B.d) B = N;
      }
      if (B && dBrake > Math.max(40, v * T.defend.from) && dBrake < v * T.defend.to && !(this.defendedAt === info.next[i])) {
        // it's already up the inside, or right behind and already heading there: too late to cover (no chopping across)
        const already = (B.lat - lat) * side > Wc * 0.8 || (B.latV * side > 0.8 && B.d > -(len + 6));
        const inside = side > 0 ? hi - 0.4 : lo + 0.4, ro = t.ro[i], to = ro + (inside - ro) * this.defence;
        if (!already && canMove(to)) {
          // held until it turns in: from the inside it then takes the corner its own way (the plan rejoins the line)
          this.lane = makeLane('defend', to, B.o, C[info.next[i]].turnIn);
          this.defendedAt = info.next[i]; // (once per corner)
        }
      }
    }
  }
}
const L2 = (t) => t.length / 2;