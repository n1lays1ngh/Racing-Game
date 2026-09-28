// Track data: the circuit is a closed spline sampled every ~2 m.
// Everything else (physics, AI, lap counting, minimap, meshes) is built
// from these samples, so changing TRACK_POINTS gives you a new circuit.
import { CatmullRomCurve3, Vector3 } from 'three';

// Silverstone GP layout (~5.88 km), clockwise. x = west, z = north, metres.
// Source: bacinger/f1-circuits (MIT), GPS converted to metres.
export const TRACK_POINTS = [
  [-68, 775], [-255, 791], [-288, 789], [-314, 780], [-330, 769], [-350, 746], [-363, 720], [-373, 687],
  [-387, 631], [-401, 576], [-410, 515], [-414, 477], [-418, 384], [-420, 305], [-424, 274], [-435, 245],
  [-458, 205], [-467, 182], [-467, 164], [-462, 144], [-431, 61], [-429, 27], [-434, 3], [-445, -17],
  [-476, -61], [-484, -81], [-484, -104], [-479, -126], [-460, -149], [-436, -167], [-403, -186], [-377, -201],
  [-359, -219], [-338, -254], [-296, -332], [-69, -750], [5, -865], [26, -894], [43, -909], [63, -919],
  [84, -924], [103, -923], [124, -918], [141, -910], [157, -897], [171, -877], [175, -870], [195, -826],
  [218, -786], [242, -754], [258, -734], [277, -713], [310, -680], [383, -592], [390, -588], [400, -587],
  [410, -591], [441, -619], [452, -623], [462, -622], [471, -618], [484, -606], [497, -592], [514, -570],
  [526, -547], [534, -523], [542, -495], [542, -484], [540, -473], [534, -463], [520, -440], [296, -148],
  [246, -84], [236, -72], [218, -60], [196, -55], [178, -54], [153, -56], [84, -67], [62, -69],
  [38, -70], [12, -67], [-13, -60], [-34, -48], [-177, 65], [-186, 71], [-198, 77], [-209, 78],
  [-218, 75], [-226, 67], [-231, 59], [-255, -26], [-263, -38], [-273, -45], [-284, -46], [-297, -40],
  [-306, -29], [-311, -18], [-321, 9], [-329, 33], [-335, 56], [-338, 78], [-340, 102], [-339, 127],
  [-334, 138], [-321, 152], [140, 573], [153, 581], [170, 590], [192, 593], [214, 591], [237, 580],
  [245, 570], [250, 555], [260, 478], [265, 463], [276, 450], [293, 442], [312, 439], [332, 444],
  [347, 454], [356, 466], [363, 479], [364, 494], [361, 510], [350, 536], [290, 653], [271, 676],
  [253, 695], [226, 718], [204, 733], [177, 745], [153, 753], [102, 759],
];

export const START_POS = [-160, 783]; // start/finish line sits on the main straight
export const HALF_WIDTH = 9;          // tarmac is 14 m wide
export const KERB_WIDTH = 3;        // kerb strip outside the white line
export const WALL_OFFSET = 28;        // barrier distance from the centreline

export function buildTrack(points = TRACK_POINTS, spacing = 2) {
  const curve = new CatmullRomCurve3(
    points.map(([x, z]) => new Vector3(x, 0, z)), true, 'centripetal');
  const length = curve.getLength();
  const n = Math.round(length / spacing);
  const pts = curve.getSpacedPoints(n);
  pts.pop(); // last point duplicates the first on a closed curve

  // Rotate so sample 0 is the start/finish line.
  let start = 0, best = Infinity;
  pts.forEach((p, i) => {
    const d = (p.x - START_POS[0]) ** 2 + (p.z - START_POS[1]) ** 2;
    if (d < best) { best = d; start = i; }
  });
  const ordered = pts.slice(start).concat(pts.slice(0, start));

  const t = {
    n, length, ds: length / n,
    cx: new Float32Array(n), cz: new Float32Array(n), // centreline
    tx: new Float32Array(n), tz: new Float32Array(n), // unit tangent
    nx: new Float32Array(n), nz: new Float32Array(n), // unit normal (points to driver's left)
    curv: new Float32Array(n),                         // signed curvature, + = left turn
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
    // Heading increases when turning left in our convention (see physics.js)
    t.curv[i] = -Math.atan2(cross, dot) / t.ds;
  }
  smoothInPlace(t.curv, 6);

  computeRacingLine(t);
  return t;
}

function smoothInPlace(arr, radius) {
  const n = arr.length, src = Float32Array.from(arr);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += src[(i + k + n) % n];
    arr[i] = s / (2 * radius + 1);
  }
}

// Racing line: first pull the line tight through the corners (shortest path),
// then smooth out the sharp kinks that leaves at each apex so the line
// follows proper arcs. The AI's corner speeds come from this line.
function computeRacingLine(t) {
  const { n } = t;
  const lim = HALF_WIDTH - 1.2; // how close to the track edge the AI may go
  const o = t.ro;
  const px = new Float32Array(n), pz = new Float32Array(n);
  for (let iter = 0; iter < 600; iter++) {
    for (let i = 0; i < n; i++) { px[i] = t.cx[i] + t.nx[i] * o[i]; pz[i] = t.cz[i] + t.nz[i] * o[i]; }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const mx = (px[a] + px[b]) / 2 - t.cx[i];
      const mz = (pz[a] + pz[b]) / 2 - t.cz[i];
      const target = mx * t.nx[i] + mz * t.nz[i];
      o[i] = Math.max(-lim, Math.min(lim, o[i] + (target - o[i]) * 0.9));
    }
  }
  // Smooth the apex kinks into arcs (radius is in 2 m samples).
  for (const radius of [15, 10, 6]) {
    smoothInPlace(o, radius);
    for (let i = 0; i < n; i++) o[i] = Math.max(-lim, Math.min(lim, o[i]));
  }
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
  s = ((s % t.length) + t.length) % t.length;
  const i = Math.floor(s / t.ds) % t.n;
  const j = (i + 1) % t.n, f = s / t.ds - Math.floor(s / t.ds);
  const x = t.cx[i] + (t.cx[j] - t.cx[i]) * f, z = t.cz[i] + (t.cz[j] - t.cz[i]) * f;
  return {
    x: x + t.nx[i] * lateral, z: z + t.nz[i] * lateral,
    heading: Math.atan2(t.tx[i], t.tz[i]), index: i,
  };
}