// Builds a playable track from a circuit file (see src/circuits/).
// The circuit is a closed spline sampled every ~2 m; everything else
// (physics, AI, lap counting, minimap, scenery) reads these samples.
import { CatmullRomCurve3, Vector3 } from 'three';
import { CIRCUITS } from './circuits/index.js';
import { applyElevation } from './elevation.js';
import { applyBanking } from './banking.js';
import { layoutPitLane } from './pitlane.js';

export const TRACKS = CIRCUITS;
export const HALF_WIDTH = 7;     // default half-width (permanent circuits are 14 m wide)
export const KERB_WIDTH = 1.5;   // default kerb width
export const WALL_OFFSET = 24;   // widest barrier distance used anywhere (for scenery spacing)

// Defaults for each kind of circuit. Anything set in a circuit file wins.
export const CIRCUIT_DEFAULTS = {
  permanent: { time: 'day', width: 14, kerbWidth: 1.5, runoff: 15.5, surface: 'grass', gravel: 'auto', barrier: 'ads',
    scenery: { ground: 'grass', trees: 350, buildings: 0 } },
  street: { time: 'day', width: 11, kerbWidth: 1.0, runoff: 1.5, surface: 'tarmac', gravel: 'none', barrier: 'concrete',
    scenery: { ground: 'city', trees: 40, buildings: 400 } },
};
export const SURFACES = { grass: 0, tarmac: 1, gravel: 2 }; // run-off surface codes (t.surfL / t.surfR)

const mod = (v, m) => ((v % m) + m) % m;

export function getTrackDef(id) {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}

// Fill in anything a circuit file leaves out.
export function resolveCircuit(def) {
  const base = CIRCUIT_DEFAULTS[def.type] ?? CIRCUIT_DEFAULTS.permanent;
  return {
    ...base, ...def,
    scenery: { ...base.scenery, ...(def.scenery ?? {}) },
    widths: def.widths ?? [], runoffSections: def.runoffSections ?? [],
    stands: def.stands ?? [], pits: def.pits ?? [], banking: def.banking ?? [], elevation: def.elevation ?? [],
    forest: def.forest ?? [], meadows: def.meadows ?? [], terrain: def.terrain ?? null,
  };
}

export function buildTrack(circuit = TRACKS[0], spacing = 2) {
  const def = resolveCircuit(circuit);
  const curve = new CatmullRomCurve3(
    def.points.map(([x, z]) => new Vector3(x, 0, z)), true, 'centripetal');
  // Accurate arc length, otherwise samples bunch up on long straights.
  curve.arcLengthDivisions = 20000;
  const length = curve.getLength();
  const n = Math.round(length / spacing);
  const pts = curve.getSpacedPoints(n);
  pts.pop(); // last point duplicates the first on a closed curve
  const ds = length / n;

  // Rotate so sample 0 is the start/finish line.
  const start = mod(Math.round((def.startAt ?? 0) / ds), n);
  const ordered = pts.slice(start).concat(pts.slice(0, start));
  const startAt = start * ds; // actual distance used, for converting positions in the circuit file
  const toS = (at) => mod(at - startAt, length); // circuit-file distance → distance from the start line

  const t = {
    id: def.id, name: def.name, country: def.country, type: def.type ?? 'permanent', time: def.time,
    n, length, ds,
    kerb: def.kerbWidth, barrier: def.barrier, scenery: def.scenery,
    cx: new Float32Array(n), cz: new Float32Array(n), // centreline
    tx: new Float32Array(n), tz: new Float32Array(n), // unit tangent
    nx: new Float32Array(n), nz: new Float32Array(n), // unit normal (points to driver's left)
    curv: new Float32Array(n),                         // signed curvature, + = left turn
    hw: new Float32Array(n),                           // half-width of the tarmac
    wallL: new Float32Array(n), wallR: new Float32Array(n), // barrier distance from the centreline
    surfL: new Uint8Array(n), surfR: new Uint8Array(n),     // run-off surface each side (SURFACES)
    ro: new Float32Array(n),                           // racing-line lateral offset
    rx: new Float32Array(n), rz: new Float32Array(n), // racing-line points
    rcurv: new Float32Array(n),                        // |curvature| of racing line
  };

  for (let i = 0; i < n; i++) { t.cx[i] = ordered[i].x; t.cz[i] = ordered[i].z; }
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    let dx = t.cx[b] - t.cx[a], dz = t.cz[b] - t.cz[a];
    const l = Math.hypot(dx, dz); dx /= l; dz /= l;
    t.tx[i] = dx; t.tz[i] = dz;
    t.nx[i] = dz; t.nz[i] = -dx; // left of the direction of travel
  }
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n;
    const cross = t.tx[i] * t.tz[b] - t.tz[i] * t.tx[b];
    const dot = t.tx[i] * t.tx[b] + t.tz[i] * t.tz[b];
    t.curv[i] = -Math.atan2(cross, dot) / t.ds; // + = left turn
  }
  smoothInPlace(t.curv, 6);

  // Clockwise circuits have the infield on the driver's right.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += (-t.cx[i]) * t.cz[j] - (-t.cx[j]) * t.cz[i]; // x is west, so east = -x
  }
  t.clockwise = area < 0;
  t.infield = t.clockwise ? -1 : 1; // -1 = right, +1 = left

  // Walks the samples covered by a circuit-file range [from, to].
  const forRange = (from, to, fn) => {
    const s0 = toS(from), len = mod(to - from, length) || length;
    for (let d = 0; d <= len; d += ds / 2) fn(Math.floor(mod(s0 + d, length) / ds) % n);
  };

  // Track width (with narrower / wider sections)
  t.hw.fill(def.width / 2);
  for (const w of def.widths) forRange(w.from, w.to, (i) => { t.hw[i] = w.width / 2; });
  smoothInPlace(t.hw, 8); // blend width changes over ~16 m

  // Run-off width → barrier distance, with escape roads / tighter sections
  const runL = new Float32Array(n).fill(def.runoff), runR = new Float32Array(n).fill(def.runoff);
  for (const r of def.runoffSections) forRange(r.from, r.to, (i) => {
    if (r.side !== 'R') runL[i] = r.runoff;
    if (r.side !== 'L') runR[i] = r.runoff;
  });
  smoothInPlace(runL, 5); smoothInPlace(runR, 5);
  for (let i = 0; i < n; i++) {
    t.wallL[i] = t.hw[i] + t.kerb + runL[i];
    t.wallR[i] = t.hw[i] + t.kerb + runR[i];
  }

  // Stretches through the woods (`forest` in the circuit file, like the Nordschleife): trees right up to a
  // steel guardrail, nothing else (no gravel, grandstands, sponsor walls or braking boards; see forest.js).
  // woodsL / woodsR: how wooded each side is there (1 = forest; `meadows` = open fields, trees further back).
  t.forest = new Uint8Array(n);
  t.woodsL = new Float32Array(n); t.woodsR = new Float32Array(n);
  for (const f of def.forest) forRange(f.from, f.to, (i) => { t.forest[i] = 1; t.woodsL[i] = t.woodsR[i] = 1; });
  for (const m of def.meadows) forRange(m.from, m.to, (i) => {
    if (!t.forest[i]) return;
    if (m.side !== 'R') t.woodsL[i] = m.woods ?? 0.3;
    if (m.side !== 'L') t.woodsR[i] = m.woods ?? 0.3;
  });

  // Run-off surface: base surface everywhere, gravel traps on top
  const base = SURFACES[def.surface] ?? 0;
  t.surfL.fill(base); t.surfR.fill(base);
  if (def.gravel === 'auto') {
    for (let i = 0; i < n; i++) {
      const k = t.curv[i];
      if (Math.abs(k) < 1 / 130 || t.forest[i]) continue; // (grass verges in the woods)
      const g = k > 0 ? t.surfR : t.surfL; // outside of the corner
      for (let d = -5; d <= 35; d++) if (!t.forest[(i + d + n) % n]) g[(i + d + n) % n] = SURFACES.gravel; // extends past the exit
    }
  } else if (Array.isArray(def.gravel)) {
    for (const g of def.gravel) forRange(g.from, g.to, (i) => {
      if (g.side !== 'R') t.surfL[i] = SURFACES.gravel;
      if (g.side !== 'L') t.surfR[i] = SURFACES.gravel;
    });
  }

  limitWalls(t);
  computeRacingLine(t);
  applyElevation(t, def.elevation, startAt);  // hills: t.h, t.grade, t.vcurv
  applyBanking(t, def.banking, startAt);      // banked corners: t.bank
  // The real ground around the circuit, if the file has it (terrain.js): same heights as `elevation`, so
  // shifted by the same amount (t.h is relative to the lap's average height).
  t.terrain = def.terrain ? { ...def.terrain, offset: t.hMean ?? 0 } : null;

  // Grandstands and pit buildings, converted to distance from the start line.
  t.stands = def.stands.map((st) => {
    const s = toS(st.at);
    let side = st.side === 'L' ? 1 : st.side === 'R' ? -1 : 0;
    if (side === 0) { // outside of the corner here
      let k = 0;
      for (let d = -30; d <= 30; d += 2) k += t.curv[sampleAt(t, s + d)];
      side = k > 0 ? -1 : 1;
    }
    return { s, len: st.len, side, name: st.name };
  });
  t.pits = def.pits.map((p) => ({ s: toS(p.from), len: mod(p.to - p.from, length) || length }));
  t.pitLane = layoutPitLane(t, def, toS);    // the pit lane alongside the main pit building (pitlane.js)
  return t;
}

export function sampleAt(t, s) {
  return mod(Math.floor(mod(s, t.length) / t.ds), t.n);
}

function smoothInPlace(arr, radius) {
  const n = arr.length, src = Float32Array.from(arr);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += src[(i + k + n) % n];
    arr[i] = s / (2 * radius + 1);
  }
}

function minFilterInPlace(arr, radius) {
  const n = arr.length, src = Float32Array.from(arr);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let k = -radius; k <= radius; k++) m = Math.min(m, src[(i + k + n) % n]);
    arr[i] = m;
  }
}

// Barriers come closer where another part of the circuit runs nearby,
// and on the inside of tight corners, so they never overlap.
function limitWalls(t) {
  const { n, ds } = t;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j += 2) {
      const dx = t.cx[j] - t.cx[i], dz = t.cz[j] - t.cz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 > 70 * 70) continue;
      let di = Math.abs(i - j); di = Math.min(di, n - di);
      const d = Math.sqrt(d2);
      if (di * ds < 1.6 * d + 30) continue; // same bit of track
      const w = d / 2 - 1; // meet the other section's barrier halfway
      if (dx * t.nx[i] + dz * t.nz[i] > 0) t.wallL[i] = Math.min(t.wallL[i], w);
      else t.wallR[i] = Math.min(t.wallR[i], w);
    }
    const k = t.curv[i];
    if (k > 1e-4) t.wallL[i] = Math.min(t.wallL[i], 0.85 / k);  // inside of a left-hander
    if (k < -1e-4) t.wallR[i] = Math.min(t.wallR[i], 0.85 / -k); // inside of a right-hander
  }
  const minWall = new Float32Array(n);
  for (let i = 0; i < n; i++) minWall[i] = t.hw[i] + t.kerb + 0.6;
  for (const w of [t.wallL, t.wallR]) {
    minFilterInPlace(w, 12);
    smoothInPlace(w, 10);
    for (let i = 0; i < n; i++) w[i] = Math.max(minWall[i], w[i]);
  }
}

// Racing line: first pull the line tight through the corners (shortest path),
// then smooth out the sharp kinks that leaves at each apex so the line
// follows proper arcs. The AI's corner speeds come from this line.
function computeRacingLine(t) {
  const { n } = t;
  const lim = (i) => Math.max(t.hw[i] - 1.2, 0.5); // how close to the track edge the AI may go
  const o = t.ro;
  const px = new Float32Array(n), pz = new Float32Array(n);
  // Minimum-curvature line: straighten the path as much as the track width allows, which gives the
  // classic outside–apex–outside line through every corner. Each point moves toward where a smooth
  // curve through its neighbours would put it. Coarse to fine (k = spacing in samples) so long
  // corners settle too; updated in place with a small step so it stays stable.
  for (const [k, iters] of [[16, 120], [8, 160], [4, 200], [2, 250], [1, 300]]) {
    for (let iter = 0; iter < iters; iter++) {
      for (let i = 0; i < n; i++) { px[i] = t.cx[i] + t.nx[i] * o[i]; pz[i] = t.cz[i] + t.nz[i] * o[i]; }
      for (let i = 0; i < n; i++) {
        const a2 = (i - 2 * k + 2 * n) % n, a = (i - k + n) % n, b = (i + k) % n, b2 = (i + 2 * k) % n;
        const tx = (-px[a2] + 4 * px[a] + 4 * px[b] - px[b2]) / 6, tz = (-pz[a2] + 4 * pz[a] + 4 * pz[b] - pz[b2]) / 6;
        const target = (tx - t.cx[i]) * t.nx[i] + (tz - t.cz[i]) * t.nz[i];
        o[i] = Math.max(-lim(i), Math.min(lim(i), o[i] + (target - o[i]) * 0.4));
        px[i] = t.cx[i] + t.nx[i] * o[i]; pz[i] = t.cz[i] + t.nz[i] * o[i];
      }
    }
  }
  smoothInPlace(o, 4); // iron out any small wiggles
  for (let i = 0; i < n; i++) o[i] = Math.max(-lim(i), Math.min(lim(i), o[i]));
  for (let i = 0; i < n; i++) { t.rx[i] = t.cx[i] + t.nx[i] * o[i]; t.rz[i] = t.cz[i] + t.nz[i] * o[i]; }
  // Curvature from the circle through points 10 m either side (less noisy).
  const k = 5;
  for (let i = 0; i < n; i++) {
    const a = (i - k + n) % n, b = (i + k) % n;
    const ax = t.rx[a], az = t.rz[a], bx = t.rx[i], bz = t.rz[i], cx = t.rx[b], cz = t.rz[b];
    const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz);
    const cross = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
    t.rcurv[i] = (2 * cross) / Math.max(ab * bc * ca, 1e-6);
  }
  smoothInPlace(t.rcurv, 4);
}

// Find where a world position is relative to the track.
// hint = last known sample index (cheap local search); pass -1 for a full search.
export function projectOnTrack(t, x, z, hint = -1) {
  let best = -1, bestD = Infinity;
  if (hint >= 0) {
    for (let k = -30; k <= 30; k++) {
      const i = (hint + k + t.n) % t.n;
      const d = (x - t.cx[i]) ** 2 + (z - t.cz[i]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  if (best < 0 || bestD > 40 * 40) {
    for (let i = 0; i < t.n; i++) {
      const d = (x - t.cx[i]) ** 2 + (z - t.cz[i]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  const dx = x - t.cx[best], dz = z - t.cz[best];
  const along = dx * t.tx[best] + dz * t.tz[best];
  const lateral = dx * t.nx[best] + dz * t.nz[best];
  let s = best * t.ds + along;
  if (s < 0) s += t.length; else if (s >= t.length) s -= t.length;
  return { i: best, s, lateral };
}

// Sample the centreline at distance s (wraps), with a lateral offset.
export function pointAt(t, s, lateral = 0) {
  s = mod(s, t.length);
  const i = Math.floor(s / t.ds) % t.n;
  const j = (i + 1) % t.n, f = s / t.ds - Math.floor(s / t.ds);
  const x = t.cx[i] + (t.cx[j] - t.cx[i]) * f, z = t.cz[i] + (t.cz[j] - t.cz[i]) * f;
  return {
    x: x + t.nx[i] * lateral, z: z + t.nz[i] * lateral,
    heading: Math.atan2(t.tx[i], t.tz[i]), index: i,
  };
}