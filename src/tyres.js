// Tyres: three compounds (soft, medium, hard) and tyre wear. No rendering here: physics.js wears them every step and
// takes their grip, pitstop.js fits new ones, the HUD shows them (hud.js), the car models colour the F1 car's stripe.
//
//   fitTyres(state, compound, race)  a fresh set (the start, a pit stop)
//   tyreStep(state, dt, use)         wear them (physics.js): use = { lat, brake, throttle, slip, lock, dist }
//   state.tyres = { compound, wear: [FL, FR, RL, RR] (0 fresh … 1 worn out), laps, life }, state.tyreGrip (× grip)
//   lifeLaps(compound, race)         laps a set lasts (to 100% worn) in this race
//   chooseCompound(race, car, lapsLeft, used)  the softest set that lasts the laps left (the AI; your suggestion)
export const TYRES = {
  compounds: {
    soft:   { name: 'Soft',   letter: 'S', colour: 0xe8261f, grip: 1.04,  life: 18 },
    medium: { name: 'Medium', letter: 'M', colour: 0xffd12a, grip: 1.0,   life: 28 },
    hard:   { name: 'Hard',   letter: 'H', colour: 0xf2f2f2, grip: 0.965, life: 40 },
  },
  // life: laps to 100% worn over a full Grand Prix (305 km). A shorter race wears them faster in proportion, so the
  // choice matters in a short race too, but a set always lasts at least minLife laps.
  order: ['soft', 'medium', 'hard'],
  minLife: { soft: 2, medium: 3, hard: 4 },
  gpDistance: 305000,
  wornGrip: 0.1,          // grip lost by the time a set is 100% worn (gradually) …
  cliff: 0.75,            // … and past this the grip falls away: up to cliffGrip more at 100%
  cliffGrip: 0.1,
  maxWear: 1.15,          // (driving on beyond worn out: no worse than this)
  start: 'medium',        // your tyres at the start unless you pick (1 / 2 / 3 on the grid)
  twoCompounds: 4,        // races this many laps or longer: everyone must use two compounds (the AI does)
  norm: 0.96,             // what tyreStep's load averages over a typical lap (measured with the sim), so a set lasts `life` laps
};
export const COMPOUND_KEYS = TYRES.order;

const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// Laps a set lasts here (to 100% worn): the compound's life in a full Grand Prix, in proportion to this race's length.
// race: { laps, track.length, carDef } (race.js)
export function lifeLaps(compound, race) {
  const c = TYRES.compounds[compound] ?? TYRES.compounds.medium;
  const gp = Math.max(1, Math.ceil(TYRES.gpDistance / race.track.length));
  const scale = Math.min(1, Math.max(0.05, race.laps / gp));
  return Math.max(TYRES.minLife[compound] ?? 2, c.life * scale) * (race.carDef?.tyreLife ?? 1);
}

export function fitTyres(state, compound, race) {
  compound = TYRES.compounds[compound] ? compound : TYRES.start;
  const used = state.tyres?.used ?? new Set();
  used.add(compound);
  state.tyres = { compound, wear: [0, 0, 0, 0], laps: 0, life: lifeLaps(compound, race), used, dist: 0 };
  state.tyreGrip = TYRES.compounds[compound].grip;
  state.tyresFitted = (state.tyresFitted ?? 0) + 1; // (the HUD flips its tyres when this changes)
}

// Grip from a set's wear: the worst tyre counts as much as the average
export function gripOf(t) {
  if (!t) return 1;
  const w = t.wear, avg = (w[0] + w[1] + w[2] + w[3]) / 4, worst = Math.max(...w), x = Math.min(TYRES.maxWear, (avg + worst) / 2);
  return TYRES.compounds[t.compound].grip * (1 - TYRES.wornGrip * Math.pow(x, 1.5) - TYRES.cliffGrip * smooth((x - TYRES.cliff) / (1 - TYRES.cliff)));
}

// Wear for one physics step. Each tyre's load: rolling, cornering (the outside tyres more), braking (the fronts),
// traction (the rears, more out of slow corners), sliding and lock-ups. Worn at 1 / (life × lap length) per metre at a
// typical load, so a set lasts about `life` laps driven normally, less if you slide it about.
export function tyreStep(state, dt, { lat = 0, brake = 0, throttle = 0, slip = 0, lock = false, dist = 0, length = 5000 }) {
  const t = state.tyres;
  if (!t || dist <= 0) return;
  const outsideLeft = state.yawRate < 0; // turning right: the left tyres are on the outside
  const per = dist / (t.life * length * TYRES.norm);
  const slide = Math.max(0, slip - 1) * 0.12, low = state.vf < 40 ? 1.5 : 1;
  for (let k = 0; k < 4; k++) {
    const front = k < 2, left = k % 2 === 0;
    const corner = lat * 0.9 * (left === outsideLeft ? 1.24 : 0.76);
    const load = 0.5 + corner + (front ? brake * 0.6 + (lock ? 1.5 : 0) : throttle * 0.35 * low) + slide;
    t.wear[k] = Math.min(TYRES.maxWear, t.wear[k] + per * load);
  }
  t.dist += dist;
  state.tyreGrip = gripOf(t);
}

// The softest compound that lasts the laps left (with a margin), and a different one from those used so far if the
// race needs two compounds and only one has been used
export function chooseCompound(race, lapsLeft, used = new Set()) {
  const needOther = race.laps >= TYRES.twoCompounds && used.size === 1;
  const ok = TYRES.order.filter((c) => !(needOther && used.has(c)));
  return ok.find((c) => lifeLaps(c, race) * 0.85 >= lapsLeft) ?? ok[ok.length - 1] ?? 'hard';
}