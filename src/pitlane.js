// The pit lane, on every circuit: it leaves the track before the pit building, runs past the garages
// behind the pit wall, and rejoins the track after them, like a real one. Inside it there's an 80 km/h
// speed limiter (automatic), and the lap still counts as you drive through it.
//
//   layoutPitLane(track, def, toS) → track.pitLane   (track.js; numbers only, no 3D, so races can still
//                                                     be simulated without a browser)
//   pitBounds(car, track, i, lat)  → where the barriers are for a car next to or in the pit lane (physics.js)
//   onPitLane(track, i, lat)       → is this point on the pit lane's tarmac? (physics.js: grip)
//   pitSpeedLimit(car, track)      → the speed limit (m/s) where the limiter is on, otherwise 0 (physics.js)
// The things you see are drawn elsewhere: the pit wall and the barrier along the lane in barriers.js,
// the tarmac and white lines with the pit building in venue.js, the badge on screen in hud.js.
//
// Where it is: alongside the pit building nearest the start line (track.pits, from `pits` in the circuit
// file), on the infield side. It leaves the track PITLANE.before metres before the building and rejoins
// PITLANE.after metres after it. A circuit file can set those points itself (circuit-file distances,
// like everything else there):   pitLane: { entry: -620, exit: 180 },   or turn it off: pitLane: false.

export const PITLANE = {
  // 'parallel': every circuit gets the same wide lane, parallel to the track behind a pit wall, past the garages
  // (the pit building nearest the start line, `pits` in the circuit file), with a ramp in and out.
  // 'real': laid out from the circuit file's pitLane.points / entry / exit instead.
  style: 'parallel',
  limit: 80,          // speed limit, km/h (a circuit file's pitLane.limit wins)
  width: 16,          // width alongside the garages: fast lane + working lane in front of the garages (metres)
  fastLane: 8,        // width of the fast lane (the white line between the two lanes)
  rampWidth: 8,       // width where it branches off the track and where it joins again
  wallGap: 1.5,       // 'parallel': metres from the track edge (outside the kerb) to the pit wall
  margin: 60,         // 'parallel': straight lane before the first garage and after the last
  garagePiece: 20,    // metres of pit building per piece of it: two garages (venue.js), so two pit boxes (pitstop.js)
  ramp: 180,          // metres over which the lane swings out from the track edge to behind the pit wall (and back)
  before: 220,        // 'real' without entry / exit: the lane leaves the track this far before the pit building …
  after: 200,         // … and rejoins it this far after the building
  limiterMargin: 40,  // the limiter starts this far before the first garage and ends this far after the last
  slowdown: 28,       // m/s²: how hard the limiter slows you if you come in too fast
};

const GAP = 1.2;   // the pit wall (0.8 m deep) and its fence: the lane starts this far behind the wall line
const R = 1.1;     // half a car's width (the same margin physics.js keeps from every barrier)
const mod = (v, m) => ((v % m) + m) % m;
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// ---------- layout (once per circuit) ----------
// Per sample i of the track (all distances on the infield side, metres from the centreline):
//   range  1 from where the lane leaves the track to where it rejoins it
//   inner  the lane's inner edge, out its outer edge (in front of the garages: the garage fronts)
//   wall   the pit wall's line (its face towards the track), 0 = no wall here (where the lane opens to the track)
//   outer  the barrier on the far side of the lane (or the garages)
//   limit  1 where the speed limiter is on, building 1 in front of the garages
export function layoutPitLane(t, def, toS) {
  if (def.pitLane === false || !t.pits.length) return null;
  const { n, ds, length } = t, P = PITLANE;
  // the real lane (pitLane.points in the circuit file, from OpenStreetMap): its own entry, exit and side
  const parallel = P.style === 'parallel';
  const real = !parallel && def.pitLane?.points?.length > 1 ? fromPoints(t, def.pitLane.points) : null;
  const side = real ? real.side : t.infield;
  // the pit building nearest the start line: that's where the pit lane is at real circuits
  const fromStart = (p) => (mod(-p.s, length) <= p.len ? 0 : Math.min(mod(p.s, length), mod(-(p.s + p.len), length)));
  const pit = t.pits.reduce((a, b) => (fromStart(b) < fromStart(a) ? b : a));
  const entry = parallel ? mod(pit.s - P.margin - P.ramp, length) : real ? real.entry
    : def.pitLane?.entry != null ? toS(def.pitLane.entry) : mod(pit.s - P.before, length);
  const exit = parallel ? mod(pit.s + pit.len + P.margin + P.ramp, length) : real ? real.exit
    : def.pitLane?.exit != null ? toS(def.pitLane.exit) : mod(pit.s + pit.len + P.after, length);
  const total = mod(exit - entry, length);
  if (total < 120 || total > length * 0.6) { console.warn(`Pit lane: entry/exit don't make sense on ${t.name}`); return null; }

  const steps = Math.round(total / ds), i0 = Math.floor(entry / ds) % n;
  const uB0 = Math.min(mod(pit.s - entry, length), total), uB1 = Math.min(uB0 + pit.len, total); // the building, from the entry
  const rIn = parallel ? P.ramp : Math.max(40, Math.min(P.ramp, uB0 + 30, total / 2 - 10));
  const rOut = parallel ? P.ramp : Math.max(40, Math.min(P.ramp, total - uB1 + 30, total / 2 - 10));
  const lane = {
    side, entry, exit, total, i0, steps, pit,   // pit: the building it runs past ({ s, len })
    real: !!real, limitKmh: def.pitLane?.limit ?? P.limit, // real: laid out from the circuit file's points
    range: new Uint8Array(n), limit: new Uint8Array(n), building: new Uint8Array(n),
    inner: new Float32Array(n), out: new Float32Array(n), wall: new Float32Array(n), outer: new Float32Array(n),
  };
  const room = real ? null : laneRoom(t, side, i0, steps);
  const wallOf = (i) => (side > 0 ? t.wallL[i] : t.wallR[i]);
  const ok = [];
  for (let k = 0; k <= steps; k++) {
    const i = (i0 + k) % n, u = k * ds;
    const E = t.hw[i] + t.kerb, W = wallOf(i);
    let inner, out;
    if (real) { // round the real centreline: a single lane, widening to fast lane + working lane by the garages
      const g = smooth(Math.min((u - uB0 + 40) / 40, (uB1 + 40 - u) / 40)), width = P.rampWidth + (P.width - P.rampWidth) * g;
      const c = real.centre[Math.min(k, real.centre.length - 1)];
      inner = Math.max(E, c - width / 2); out = Math.max(inner + 1.5, c + width / 2);
    } else {
      const f = smooth(Math.min(u / rIn, (total - u) / rOut));          // 0 at the track edge, 1 behind the wall
      const g = smooth(Math.min((u - uB0 + P.margin) / P.margin, (uB1 + P.margin - u) / P.margin)); // 1 by the garages
      const width = parallel ? P.rampWidth + (P.width - P.rampWidth) * Math.max(g, 0) * f
        : (1 - f) * Math.min(P.rampWidth, Math.max(1.5, W - E)) + f * P.width;
      inner = E + f * ((parallel ? E + P.wallGap : W) + GAP - E); out = inner + width; // parallel: the same distance from the track all along
      if (out > room[k]) { out = room[k]; inner = Math.min(inner, out - width); }  // another part of the circuit is close
    }
    lane.range[i] = 1; lane.inner[i] = inner; lane.out[i] = out;
    ok.push(inner - GAP >= E + 0.6);                                   // room for a wall between the track and the lane?
    lane.building[i] = u >= uB0 && u <= uB1 ? 1 : 0;
  }
  // The pit wall: one unbroken wall from where the lane is clear of the track to where it comes back.
  const kA = ok.indexOf(true), kB = ok.lastIndexOf(true);
  if (kA < 0 && !real) { console.warn(`Pit lane: no room for a pit wall on ${t.name}`); return null; }
  let narrow = false;
  for (let k = Math.max(kA, 0); kA >= 0 && k <= kB; k++) {
    const i = (i0 + k) % n, E = t.hw[i] + t.kerb;
    let wall = Math.max(lane.inner[i] - GAP, E + 0.6);
    if (lane.out[i] - (wall + GAP) < 6) { wall = Math.max(E + 0.6, lane.out[i] - 6 - GAP); narrow = true; } // squeezed: wall closer to the track
    lane.wall[i] = wall; lane.inner[i] = wall + GAP;
    lane.out[i] = Math.max(lane.out[i], lane.inner[i] + 6);                    // never narrower than 6 m
  }
  if (narrow) console.warn(`Pit lane: little room on ${t.name}, the lane is narrower in places`);
  for (let k = 0; k <= steps; k++) {
    const i = (i0 + k) % n;
    lane.outer[i] = Math.max(wallOf(i), lane.out[i]);
    const u = k * ds;
    lane.limit[i] = real // the real one: from where the lane is clear of the track (the pit entry line) to where it comes back
      ? (kA >= 0 ? k >= kA && k <= kB && u >= uB0 - 300 && u <= uB1 + 300 : u >= uB0 - P.limiterMargin && u <= uB1 + P.limiterMargin) ? 1 : 0
      : u >= Math.max(rIn * 0.8, uB0 - P.limiterMargin) && u <= Math.min(total - rOut * 0.8, uB1 + P.limiterMargin) ? 1 : 0;
  }
  return lane;
}

// The real pit lane: `pitLane.points` in the circuit file ([x, z] metres, in the same frame as the circuit's points, from
// OpenStreetMap). Where it leaves the track (entry) and rejoins it (exit), which side it's on, and how far out its
// centreline is at every track sample in between (centre[k], metres from the centreline, k samples after the entry).
function fromPoints(t, pts) {
  const { n, ds, length } = t, line = [];
  for (let a = 0; a < pts.length - 1; a++) { // every metre along the lane
    const [x0, z0] = pts[a], [x1, z1] = pts[a + 1], m = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0)));
    for (let q = 0; q < m; q++) line.push([x0 + ((x1 - x0) * q) / m, z0 + ((z1 - z0) * q) / m]);
  }
  line.push(pts[pts.length - 1]);
  let hint = -1;
  const proj = line.map(([x, z]) => { const p = nearest(t, x, z, hint); hint = p.i; return p; });
  if (mod(proj[proj.length - 1].s - proj[0].s, length) > length / 2) proj.reverse(); // drawn against the driving direction
  const entry = proj[0].s, exit = proj[proj.length - 1].s, total = mod(exit - entry, length);
  if (total < 120 || total > length * 0.6) { console.warn(`Pit lane: the points don't fit ${t.name}`); return null; }
  let sum = 0; for (const p of proj) sum += p.lat;
  const side = sum >= 0 ? 1 : -1, steps = Math.round(total / ds), i0 = Math.floor(entry / ds) % n;
  const centre = new Float32Array(steps + 1).fill(NaN);
  for (const p of proj) {
    const k = mod(p.i - i0, n);
    if (k <= steps) centre[k] = Number.isNaN(centre[k]) ? p.lat * side : Math.max(centre[k], p.lat * side);
  }
  let last = -1; // fill the gaps between samples the lane's points landed on
  for (let k = 0; k <= steps; k++) {
    if (Number.isNaN(centre[k])) continue;
    if (last < 0) centre.fill(centre[k], 0, k);
    else for (let q = last + 1; q < k; q++) centre[q] = centre[last] + ((centre[k] - centre[last]) * (q - last)) / (k - last);
    last = k;
  }
  if (last < 0) return null;
  centre.fill(centre[last], last + 1);
  for (let k = 0; k <= steps; k++) centre[k] = Math.max(0, centre[k]);
  // An end that stops short of the track (the map's lane ends at a road off to the side): taper it in from the track
  // edge over 30–120 m, so you can always drive straight in and out
  const edge = (k) => t.hw[mod(i0 + k, n)] + t.kerb - 2.5;
  const taper = (c, e) => (c > e ? Math.round(Math.min(120, Math.max(30, 6 * (c - e))) / ds) : 0);
  const head = taper(centre[0], edge(0)), tail = taper(centre[steps], edge(steps));
  const out = new Float32Array(head + steps + tail + 1);
  for (let k = 0; k < head; k++) { const e = edge(k - head); out[k] = e + (centre[0] - e) * smooth(k / head); }
  out.set(centre, head);
  for (let k = 1; k <= tail; k++) { const e = edge(steps + k); out[head + steps + k] = centre[steps] + (e - centre[steps]) * smooth(k / tail); }
  return { side, entry: mod(entry - head * ds, length), exit: mod(exit + tail * ds, length), centre: out };
}

// Nearest track sample to (x, z): a local search from `hint`, the whole lap if that's far off
function nearest(t, x, z, hint) {
  let best = -1, bd = Infinity;
  const look = (i) => { const d = (x - t.cx[i]) ** 2 + (z - t.cz[i]) ** 2; if (d < bd) { bd = d; best = i; } };
  if (hint >= 0) for (let k = -30; k <= 30; k++) look((hint + k + t.n) % t.n);
  if (best < 0 || bd > 60 * 60) for (let i = 0; i < t.n; i++) look(i);
  const dx = x - t.cx[best], dz = z - t.cz[best];
  return { i: best, s: mod(best * t.ds + dx * t.tx[best] + dz * t.tz[best], t.length), lat: dx * t.nx[best] + dz * t.nz[best] };
}

// The way into the pits, when you've asked to box (main.js; racingLine.js draws it, hud.js puts it on the map): the
// racing line, then from `lead` metres before the entry over to the pit side of the track, down the fast lane, and back
// onto the racing line `tail` metres after the exit. → { offsets (like track.ro, every sample), from, len } or null.
export function pitRoute(t, lead = 260, tail = 160) {
  const p = t.pitLane;
  if (!p) return null;
  const { n, ds } = t, kL = Math.round(lead / ds), kT = Math.round(tail / ds), span = kL + p.steps + kT;
  const edge = (i) => p.side * (t.hw[i] - 1.2);
  const laneLat = (i) => p.side * (p.inner[i] + Math.min(PITLANE.fastLane, p.out[i] - p.inner[i]) / 2);
  const raw = new Float32Array(span + 1);
  for (let q = 0; q <= span; q++) {
    const k = q - kL, i = mod(p.i0 + k, n);
    raw[q] = k < 0 ? t.ro[i] + (edge(i) - t.ro[i]) * smooth(q / kL)
      : k <= p.steps ? laneLat(i)
      : edge(i) + (t.ro[i] - edge(i)) * smooth((k - p.steps) / kT);
  }
  const offsets = Float32Array.from(t.ro), R = 8; // smoothed, so it has no kinks where it joins the lane
  for (let q = 0; q <= span; q++) {
    let s = 0, w = 0;
    for (let d = -R; d <= R; d++) { const j = q + d; if (j >= 0 && j <= span) { s += raw[j]; w++; } }
    offsets[mod(p.i0 - kL + q, n)] = q < R || q > span - R ? raw[q] : s / w;
  }
  return { offsets, from: mod(p.i0 - kL, n), len: span };
}

// How far out the lane can go at each step before it gets near another part of the circuit (inside a
// hairpin, or another straight running alongside): stays 1.5 m clear of that part's barrier.
function laneRoom(t, side, i0, steps) {
  const { n, ds } = t, room = new Float32Array(steps + 1).fill(1e9);
  for (let k = 0; k <= steps; k++) {
    const i = (i0 + k) % n, ux = t.nx[i] * side, uz = t.nz[i] * side;
    for (let j = 0; j < n; j += 2) {
      const rx = t.cx[i] - t.cx[j], rz = t.cz[i] - t.cz[j], d2 = rx * rx + rz * rz;
      if (d2 > 120 * 120) continue;
      let di = Math.abs(i - j); di = Math.min(di, n - di);
      if (di * ds < 1.6 * Math.sqrt(d2) + 30) continue;                 // the same bit of track
      const r = (rx * t.nx[j] + rz * t.nz[j] > 0 ? t.wallL[j] : t.wallR[j]) + 1.5;
      const b = rx * ux + rz * uz, q = d2 - r * r, disc = b * b - q;
      if (q <= 0 || disc < 0) continue;
      const hit = -b - Math.sqrt(disc);                                // first point along the lane's direction inside it
      if (hit > 0) room[k] = Math.min(room[k], hit);
    }
  }
  // ease in and out of any narrowing, so the lane doesn't kink
  const src = Float32Array.from(room);
  for (let k = 0; k <= steps; k++) { let m = 1e9; for (let d = -8; d <= 8; d++) m = Math.min(m, src[Math.min(steps, Math.max(0, k + d))]); room[k] = m; }
  const min = Float32Array.from(room);   // (an average of those minimums never exceeds the room at that point)
  for (let k = 0; k <= steps; k++) { let s = 0; for (let d = -6; d <= 6; d++) s += Math.min(min[Math.min(steps, Math.max(0, k + d))], 1e4); room[k] = s / 13; }
  return room;
}

// ---------- while driving ----------
// Barriers for a car at sample i, `lat` metres from the centreline, when it's on the pit lane's side:
// { lo, hi } = how close to / far from the centreline it can be, or null (the normal barriers apply).
// Where the pit wall stands, a car stays on the side it's on (car.inPitLane), so the wall works both ways.
export function pitBounds(car, track, i, lat) {
  const p = track.pitLane;
  if (!p || !p.range[i] || Math.sign(lat) !== p.side) { car.inPitLane = false; return null; }
  const d = Math.abs(lat), wall = p.wall[i];
  if (!wall) { car.inPitLane = d > p.inner[i] - 0.6; return { lo: 0, hi: p.outer[i] - R }; }
  if (d > wall + 0.8 + R) car.inPitLane = true;        // clearly on the lane side
  else if (d < wall - R) car.inPitLane = false;         // clearly on the track side
  return car.inPitLane ? { lo: wall + 0.8 + R, hi: p.outer[i] - R } : { lo: 0, hi: wall - R };
}

export function onPitLane(track, i, lat) {
  const p = track.pitLane;
  if (!p || !p.range[i] || Math.sign(lat) !== p.side) return false;
  const d = Math.abs(lat);
  return d >= p.inner[i] - 0.3 && d <= p.out[i] + 0.5;
}

export function pitSpeedLimit(car, track) {
  const p = track.pitLane;
  return p && car.inPitLane && car.trackIndex >= 0 && p.limit[car.trackIndex] ? (p.limitKmh ?? PITLANE.limit) / 3.6 : 0;
}