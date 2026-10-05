// The built-in Hypercar and GT3 bodies (carModel.js BODIES.proto and BODIES.gt): the AI cars in those classes,
// in their team's colours, and your car too if its 3D model can't be loaded. They aren't copies of your car:
// a generic Le Mans Hypercar and a generic GT3, made from code.
//
// How the bodywork is made: the car is sliced into cross-sections every few centimetres from the nose to the
// tail. Each slice runs from the middle of the roof over the top of the car (worked out from a height map: the
// low deck plus smooth humps for the fenders over the wheels, the cockpit, the engine cover), rounds the
// shoulder, goes down the side and back in underneath. Over each wheel the side stops at the wheel arch (a circle
// round the axle) and turns in to make the inside of the wheel well. Joining the slices gives one smooth skin;
// each strip of it is painted, glass, carbon or black depending on where it is (windscreen, side windows,
// lower body, vents). Wings, splitter, diffuser, mirrors, lights and the shark fin are added as separate parts.
//
// The shapes are built once per kind of car and shared by every car of that kind (only the paint differs).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------- small maths ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
// smooth maximum: like Math.max but rounds the crease where two shapes meet (k = how far, in metres)
const smax = (a, b, k) => { const h = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1); return lerp(b, a, h) + k * h * (1 - h); };
// a smooth curve through [z, value] points (monotone cubic: no overshoot between them)
function curve(points) {
  const P = [...points].sort((a, b) => a[0] - b[0]), n = P.length;
  const d = P.slice(0, -1).map((p, i) => (P[i + 1][1] - p[1]) / (P[i + 1][0] - p[0]));
  const m = P.map((p, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= P[0][0]) return P[0][1];
    if (x >= P[n - 1][0]) return P[n - 1][1];
    let i = 0; while (x > P[i + 1][0]) i++;
    const h = P[i + 1][0] - P[i][0], t = (x - P[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * P[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * P[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}
// a rounded dome over a footprint: centre (x, z), half-sizes (ax, az), from height `base` up to `top`
function dome(x, z, d) {
  const u = Math.abs(x - d.x) / d.ax, v = Math.abs(z - d.z) / (z > d.z ? d.azF ?? d.az : d.azR ?? d.az);
  const s = 1 - u ** (d.px ?? 2.6) - v ** (d.pz ?? 2.2);
  return s <= 0 ? -1 : d.top * s ** (d.round ?? 0.35);
}

// ---------- the skin ----------
// def: stations (z of each slice), W(z) half-width, top(x, z) height, bottom(z) lowest point of the side (the
// floor, or the wheel arch), columns(z): [[x, points, material]...] how the top is divided across (material:
// key or (z, x, y) → key), side(z, x, y) → material of the side, splits: heights where the side changes colour,
// floor y, liner: depth of the wheel wells
function skin(def) {
  const rows = [];
  const sorted = [...new Set(def.stations.map((z) => +z.toFixed(4)))].sort((a, b) => b - a); // nose first
  const half = (z) => { // the right half of a slice, from the middle of the top to the middle underneath
    const W = def.W(z), rs = def.shoulder, xe = W - rs, pts = [];
    for (const [x0, x1, count, mat] of def.columns(z, xe)) {
      for (let k = 0; k < count; k++) { const x = lerp(x0, x1, k / count); pts.push({ x, y: def.top(x, z), m: mat }); }
    }
    const ye = def.top(xe, z), yb = def.bottom(z), tumble = def.tumble ?? 0.04;
    for (let k = 0; k <= 4; k++) { const a = (k / 4) * Math.PI / 2; pts.push({ x: xe + rs * Math.sin(a), y: ye - rs + rs * Math.cos(a), m: def.side }); }
    // the side, with points exactly at the heights where its colour changes (def.splits, highest first)
    const ys = ye - rs, levels = [ys, ...(def.splits ?? []).map((y) => clamp(y, yb, ys)), yb];
    for (let l = 0; l < levels.length - 1; l++) {
      const count = l === 0 ? 3 : 2;
      for (let k = 1; k <= count; k++) { const y = lerp(levels[l], levels[l + 1], k / count); pts.push({ x: W - tumble * (ys - y) / Math.max(ys - yb, 0.01), y, m: def.side }); }
    }
    const xl = W - def.liner;
    pts.push({ x: xl, y: yb, m: 'dark' }, { x: xl, y: def.floor, m: 'dark' }, { x: 0, y: def.floor, m: 'dark' });
    return pts;
  };
  for (const z of sorted) rows.push({ z, pts: half(z) });
  // the nose and the tail end in a slightly smaller slice, closed by a flat face (see the end caps below)
  const bevel = (row, dir) => { const cy = row.pts.reduce((a, p) => a + p.y, 0) / row.pts.length;
    return { z: row.z + dir * 0.006, pts: row.pts.map((p) => ({ ...p, x: p.x * 0.97, y: cy + (p.y - cy) * 0.97 })), cy }; };
  const all = [bevel(rows[0], 1), ...rows, bevel(rows[rows.length - 1], -1)];
  // full rings: left half mirrored, then the right half
  const n = all[0].pts.length, ring = (r) => [...r.pts.slice(1).reverse().map((p) => ({ ...p, x: -p.x, mirror: true })), ...r.pts];
  const buckets = {};
  const B = (key) => (buckets[key] ??= { pos: [], uv: [], idx: [], map: new Map() });
  const vert = (b, k, i, p, z) => {
    const key = k * 1000 + i;
    if (!b.map.has(key)) { b.map.set(key, b.pos.length / 3); b.pos.push(p.x, p.y, z); b.uv.push(p.x * 1.6, z * 1.6); }
    return b.map.get(key);
  };
  for (let k = 0; k < all.length - 1; k++) {
    const A = ring(all[k]), C = ring(all[k + 1]), za = all[k].z, zc = all[k + 1].z;
    for (let i = 0; i < A.length - 1; i++) {
      const src = i < n - 1 ? A[i + 1] : A[i];                 // the point whose strip this is (on the left: mirrored)
      const xm = (A[i].x + A[i + 1].x + C[i].x + C[i + 1].x) / 4, ym = (A[i].y + A[i + 1].y + C[i].y + C[i + 1].y) / 4;
      const m = typeof src.m === 'function' ? src.m((za + zc) / 2, Math.abs(xm), ym) : src.m;
      const b = B(m);
      const a0 = vert(b, k, i, A[i], za), a1 = vert(b, k, i + 1, A[i + 1], za), c0 = vert(b, k + 1, i, C[i], zc), c1 = vert(b, k + 1, i + 1, C[i + 1], zc);
      b.idx.push(a0, a1, c0, a1, c1, c0);
    }
  }
  // end caps: a flat face from the last slice to its middle (painted, or carbon low down; def.cap can say otherwise)
  for (const [row, front] of [[all[0], true], [all[all.length - 1], false]]) {
    const R = ring(row), z = row.z, key = front ? 900000 : 910000;
    for (let i = 0; i < R.length - 1; i++) {
      const xm = (R[i].x + R[i + 1].x) / 3, ym = (R[i].y + R[i + 1].y + row.cy) / 3;
      const low = def.splits?.[def.splits.length - 1] ?? 0, m = def.cap ? def.cap(Math.abs(xm), ym, front) : ym < low ? 'carbon' : 'body', b = B(m);
      const c = vert(b, key, 999, { x: 0, y: row.cy }, z), p = vert(b, key, i, R[i], z), q = vert(b, key, i + 1, R[i + 1], z);
      b.idx.push(...(front ? [q, p, c] : [p, q, c]));
    }
  }
  const out = {};
  for (const [key, b] of Object.entries(buckets)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setIndex(b.idx); g.computeVertexNormals();
    out[key] = g;
  }
  return out;
}

// ---------- parts ----------
const prep = (g) => { const h = g.index ? g.toNonIndexed() : g; for (const a of Object.keys(h.attributes)) if (!['position', 'normal', 'uv'].includes(a)) h.deleteAttribute(a); if (!h.attributes.uv) h.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(h.attributes.position.count * 2), 2)); return h; };
const box = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z); return g; };
// a wing element: span along x, chord along z, thickness profile (rounded nose), pitched (nose down = +)
function wingEl(span, chord, thick, x, y, z, pitch) {
  const s = new THREE.Shape(), N = 14;
  for (let k = 0; k <= N; k++) { const t = k / N, th = thick * (1.2 * Math.sqrt(t) - 1.1 * t + 0.25 * t * t); s.lineTo(-t * chord, th * 0.6); }
  for (let k = N; k >= 0; k--) { const t = k / N, th = thick * (1.2 * Math.sqrt(t) - 1.1 * t + 0.25 * t * t); s.lineTo(-t * chord, -th * 0.4); }
  const g = new THREE.ExtrudeGeometry(s, { depth: span, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -span / 2); g.rotateY(-Math.PI / 2);   // span along x, chord towards −z (leading edge at the front)
  g.rotateX(pitch); g.translate(x, y, z + chord / 2);
  return g;
}
// a flat plate from a side outline [[z, y]...], `thick` wide, at x
function plate(outline, thick, x) {
  const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(-z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  g.rotateY(Math.PI / 2); g.translate(x - thick / 2, 0, 0);
  return g;
}
function rod(a, b, r, seg = 8) {
  const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b), g = new THREE.CylinderGeometry(r, r, A.distanceTo(Bv), seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), Bv.clone().sub(A).normalize()));
  g.translate((A.x + Bv.x) / 2, (A.y + Bv.y) / 2, (A.z + Bv.z) / 2);
  return g;
}
// a thin panel lying on the body at (x, z), following its height (top(x, z)), w across × d along, raised by `lift`
function onBody(top, x, z, w, d, lift, thick = 0.012, yaw = 0) {
  const g = new THREE.PlaneGeometry(w, d, 6, 6); g.rotateX(-Math.PI / 2); g.rotateY(yaw);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const px = p.getX(i) + x, pz = p.getZ(i) + z; p.setXYZ(i, px, top(Math.abs(px), pz) + lift, pz); }
  g.computeVertexNormals();
  if (thick > 0) { const g2 = g.clone(); g2.translate(0, -thick, 0); g2.scale(1, 1, 1); return mergeGeometries([prep(g), prep(g2)]); }
  return g;
}
// a mirror on a stalk: the housing faces backwards, glass on its back
function mirror(parts, x, y, z, s) {
  parts.body.push(box(0.17, 0.08, 0.07, x, y, z, 0, s * 0.12, 0));
  parts.glass.push(box(0.15, 0.065, 0.005, x, y, z - 0.036, 0, s * 0.12, 0));
  parts.carbon.push(rod([x - s * 0.07, y - 0.02, z + 0.01], [x - s * 0.17, y - 0.09, z + 0.05], 0.012));
}
const both = (fn) => { for (const s of [-1, 1]) fn(s); };

// ---------- Le Mans Hypercar ----------
// 5.0 m long, 2.0 m wide, 1.15 m to the roof; wheels ±1.575 m (wheelbase 3.15), track 1.64 m, tyres Ø 0.71 m
function hypercar() {
  const WZ = 1.575, WX = 0.82, R = 0.355, ARCH = R + 0.07, FLOOR = 0.075, NOSE = 2.52, TAIL = -2.5;
  const W = (z) => 1.0 - 0.17 * smooth(2.05, NOSE, z) ** 1.6 - 0.04 * smooth(-2.1, TAIL, z) - 0.03 * smooth(0.8, 0.1, z) * smooth(-0.9, -0.2, z);
  // the deck: nose low between the fenders, the sidepods beside the cockpit, the engine cover rising behind it
  const deckC = curve([[NOSE, 0.33], [2.3, 0.4], [1.9, 0.47], [1.4, 0.53], [0.95, 0.6], [0.5, 0.6], [-0.2, 0.62], [-0.9, 0.72], [-1.5, 0.8], [-2.1, 0.8], [TAIL, 0.72]]);
  const deckS = curve([[NOSE, 0.3], [2.2, 0.36], [1.0, 0.42], [0.6, 0.5], [0.0, 0.52], [-0.6, 0.55], [-1.2, 0.62], [-2.0, 0.66], [TAIL, 0.62]]); // at the sides
  const roof = curve([[1.02, 0.6], [0.8, 0.78], [0.55, 0.94], [0.3, 1.05], [0.05, 1.11], [-0.25, 1.13], [-0.55, 1.1], [-0.9, 1.0], [-1.3, 0.9], [-1.8, 0.84], [-2.3, 0.82]]);
  const canW = curve([[1.02, 0.28], [0.7, 0.4], [0.35, 0.46], [0.0, 0.48], [-0.4, 0.46], [-0.8, 0.38], [-1.2, 0.27], [-1.8, 0.2], [-2.4, 0.16]]);
  const FF = { x: WX + 0.02, z: WZ + 0.05, ax: 0.42, azF: 0.92, azR: 0.95, top: 0.89, px: 3, pz: 2.4, round: 0.32 };
  const RF = { x: WX + 0.02, z: -WZ - 0.02, ax: 0.44, azF: 0.98, azR: 0.95, top: 0.91, px: 3, pz: 2.2, round: 0.3 };
  const top = (x, z) => {
    const deck = lerp(deckC(z), deckS(z), smooth(0.25, 0.95, x));
    let y = smax(deck, dome(x, z, FF), 0.07);
    y = smax(y, dome(x, z, RF), 0.07);
    const cw = canW(z), u = x / cw;
    if (u < 1 && z < 1.02) y = smax(y, deck + (roof(z) - deck) * Math.max(0, 1 - u ** 2.4) ** 0.5, 0.04);
    return y;
  };
  const arch = (z) => { for (const zw of [WZ, -WZ]) { const dz = z - zw; if (Math.abs(dz) < ARCH) return R + Math.sqrt(ARCH * ARCH - dz * dz); } return FLOOR + 0.03; };
  // what each strip of the top is: windscreen and side windows on the canopy, vents on the deck
  const inZ = (z, a, b) => z <= a && z >= b;
  const canopy = (z) => (inZ(z, 1.0, 0.2) ? 'glass' : 'body');
  const sideWin = (z) => (inZ(z, 0.26, -0.5) ? 'glass' : 'body');
  const deckMat = (z, x) => (inZ(z, 0.45, -0.35) && x > 0.62 && x < 0.86 ? 'dark' : 'body'); // radiator outlets on the sidepods
  const columns = (z, xe) => {
    const cw = Math.min(canW(z), xe - 0.05);
    return [[0, cw * 0.62, 6, canopy], [cw * 0.62, cw * 0.8, 2, canopy],
      [cw * 0.8, cw * 0.97, 3, (zz) => (inZ(zz, 1.0, 0.2) ? 'body' : sideWin(zz))], [cw * 0.97, 0.62, 3, 'body'], [0.62, 0.86, 3, deckMat], [0.86, xe, 5, 'body']];
  };
  const side = (z, x, y) => (y < 0.27 ? 'carbon' : inZ(z, 0.95, 0.2) && y < 0.5 ? 'dark' : 'body'); // carbon lower body, the outlet behind the front wheel
  const st = [];
  for (let z = NOSE; z >= TAIL; z -= 0.065) st.push(z);
  for (const zw of [WZ, -WZ]) for (let k = 0; k <= 24; k++) st.push(zw + ARCH * Math.cos((k / 24) * Math.PI)); // closer together where the arch is steep
  for (const zw of [WZ, -WZ]) st.push(zw + ARCH + 0.001, zw - ARCH - 0.001, zw + ARCH - 0.002, zw - ARCH + 0.002);
  st.push(1.0, 0.2, 0.26, -0.5, 0.95, 0.45, -0.35);
  const parts = { body: [], accent: [], carbon: [], dark: [], glass: [], light: [], head: [] };
  const S = skin({ stations: st, W, top, bottom: arch, columns, side, splits: [0.5, 0.27], shoulder: 0.07, floor: FLOOR, liner: 0.42, tumble: 0.05 });
  for (const [k, g] of Object.entries(S)) (parts[k] ??= []).push(g);

  // floor, splitter, diffuser
  parts.carbon.push(box(1.7, 0.03, 4.0, 0, FLOOR, 0));
  parts.carbon.push(box(1.96, 0.022, 0.42, 0, 0.055, NOSE - 0.12));
  for (const s of [-1, 1]) parts.carbon.push(box(0.012, 0.09, 0.36, s * 0.97, 0.1, NOSE - 0.16)); // splitter fences
  const dif = box(1.5, 0.02, 0.6, 0, 0.17, TAIL + 0.32, -0.28); parts.carbon.push(dif);
  for (const x of [-0.6, -0.3, 0, 0.3, 0.6]) parts.carbon.push(box(0.012, 0.17, 0.55, x, 0.2, TAIL + 0.3, -0.28));
  // canards on the nose corners
  both((s) => { parts.carbon.push(box(0.2, 0.012, 0.16, s * 0.86, 0.36, NOSE - 0.2, 0, 0, -s * 0.12)); });
  // headlights: thin light bars across the front of each fender, and the lamps under them
  both((s) => {
    parts.head.push(onBody(top, s * 0.78, NOSE - 0.34, 0.34, 0.05, 0.004, 0.006, s * 0.25));
    parts.head.push(box(0.16, 0.05, 0.03, s * 0.8, 0.52, NOSE - 0.2, -0.3, 0, 0));
    parts.dark.push(box(0.26, 0.11, 0.025, s * 0.72, 0.38, NOSE - 0.12, -0.2, s * 0.2, 0)); // intakes in the nose
  });
  // tail: light bar across the back and the rear fender lights, rain light
  parts.light.push(box(1.7, 0.035, 0.02, 0, 0.74, TAIL - 0.017));
  both((s) => parts.light.push(box(0.03, 0.2, 0.02, s * 0.9, 0.62, TAIL - 0.017)));
  parts.light.push(box(0.12, 0.05, 0.02, 0, 0.3, TAIL - 0.03));
  parts.dark.push(box(1.1, 0.3, 0.02, 0, 0.42, TAIL - 0.017));   // the open back: gearbox and exhaust area
  // roof scoop, shark fin, rear wing on swan-neck pylons with endplates
  parts.dark.push(box(0.18, 0.07, 0.25, 0, roof(0.15) + 0.03, 0.15));
  parts.accent.push(plate([[-0.3, 1.12], [-2.15, 1.07], [-2.2, 0.82], [-1.0, 0.86], [-0.45, 1.0]], 0.014, 0));
  parts.carbon.push(wingEl(1.84, 0.34, 0.05, 0, 1.03, -2.14, 0.16));
  parts.accent.push(wingEl(1.84, 0.15, 0.025, 0, 1.1, -2.45, 0.55));
  both((s) => {
    parts.carbon.push(plate([[-1.94, 0.62], [-2.54, 0.62], [-2.58, 1.17], [-2.02, 1.17], [-1.96, 0.95]], 0.018, s * 0.93));
    parts.carbon.push(plate([[-2.22, 1.08], [-2.45, 1.08], [-2.32, 0.83], [-2.12, 0.85]], 0.02, s * 0.3)); // swan neck
  });
  // mirrors on the fenders, beside the windscreen
  both((s) => mirror(parts, s * 0.7, 0.9, 0.98, s));
  // front fender louvres (vents over the front wheels)
  both((s) => { for (let k = 0; k < 4; k++) parts.dark.push(onBody(top, s * (0.6 + k * 0.06), WZ + 0.05, 0.035, 0.42, 0.003, 0.004)); });
  const numbers = [];
  both((s) => {
    numbers.push({ pos: [s * 0.009, 0.95, -1.15], rotY: s * Math.PI / 2, w: 0.36, h: 0.17 });            // on the fin
    numbers.push({ pos: [s * 1.004, 0.4, -0.3], rotY: s * Math.PI / 2, w: 0.36, h: 0.22 });              // on the sides
  });
  return {
    parts, numbers,
    wheels: [[-WX, WZ, 0.31, true], [WX, WZ, 0.31, true], [-WX, -WZ, 0.34, false], [WX, -WZ, 0.34, false]],
    tyre: { R, rim: 0.235, spokes: 10, rimColour: 0x1b1d21, caliper: 0xd8a21c },
    cams: { tcam: { z: 0.05, y: 1.3, tilt: -2 }, cockpit: { z: 0.12, y: 0.86, tilt: -2 } },
  };
}

// ---------- GT3 ----------
// 4.7 m long, 2.05 m wide, 1.26 m to the roof; wheels ±1.315 m (wheelbase 2.63), track 1.66 m, tyres Ø 0.68 m
function gt3() {
  const WZ = 1.315, WX = 0.83, R = 0.34, ARCH = R + 0.07, FLOOR = 0.085, NOSE = 2.32, TAIL = -2.4;
  const W = (z) => {
    const base = curve([[NOSE, 0.84], [2.15, 0.94], [1.8, 0.985], [1.3, 1.0], [0.75, 0.975], [0.1, 0.95], [-0.55, 0.97], [-1.3, 1.025], [-1.9, 1.01], [-2.25, 0.97], [TAIL, 0.9]]);
    return base(z);
  };
  // body heights: bonnet in the middle, the fender line and the shoulders at the sides, the rear deck
  const midC = curve([[NOSE, 0.5], [2.15, 0.6], [1.8, 0.68], [1.3, 0.75], [0.9, 0.8], [0.7, 0.83], [0.3, 0.86], [-0.5, 0.9], [-1.2, 0.93], [-1.7, 0.95], [-2.2, 0.93], [TAIL, 0.86]]);
  const shoulder = curve([[NOSE, 0.48], [2.1, 0.62], [1.8, 0.74], [1.3, 0.84], [0.85, 0.82], [0.4, 0.84], [-0.4, 0.88], [-1.0, 0.93], [-1.4, 0.95], [-1.9, 0.94], [-2.25, 0.9], [TAIL, 0.84]]);
  const FF = { x: WX, z: WZ, ax: 0.32, azF: 0.68, azR: 0.62, top: 0.87, px: 2.4, pz: 2.2, round: 0.4 };
  const RF = { x: WX + 0.04, z: -WZ, ax: 0.36, azF: 0.75, azR: 0.75, top: 0.96, px: 2.4, pz: 2.0, round: 0.35 };
  // the cabin: windscreen, roof and fastback rear window, narrower at the top (tumblehome)
  const roof = curve([[0.82, 0.83], [0.6, 0.97], [0.35, 1.12], [0.12, 1.21], [-0.2, 1.25], [-0.55, 1.23], [-0.85, 1.16], [-1.2, 1.06], [-1.55, 0.98], [-1.8, 0.95]]);
  const belt = curve([[0.82, 0.62], [0.5, 0.78], [0.0, 0.82], [-0.6, 0.8], [-1.1, 0.7], [-1.55, 0.55], [-1.8, 0.45]]);   // cabin half-width at the waist
  const roofW = curve([[0.82, 0.45], [0.4, 0.5], [0.0, 0.54], [-0.6, 0.53], [-1.1, 0.47], [-1.55, 0.4], [-1.8, 0.36]]);  // … at the roof edge
  const beltY = curve([[0.82, 0.84], [0.0, 0.92], [-0.8, 0.95], [-1.8, 0.96]]);
  const top = (x, z) => {
    let y = lerp(midC(z), shoulder(z), smooth(0.35, 0.9, x));
    y = smax(y, dome(x, z, FF), 0.06);
    y = smax(y, dome(x, z, RF), 0.08);
    if (z < 0.82 && z > -1.8) {
      const bw = belt(z), rw = Math.min(roofW(z), bw - 0.02), r = roof(z), by = beltY(z);
      let c = -1;
      if (x <= rw) c = r - 0.04 * (x / rw) ** 2;                                            // the roof, slightly domed
      else if (x < bw) { const t = (x - rw) / (bw - rw); c = lerp(r - 0.04, by, t ** 1.15); } // the side glass sloping out
      if (c > 0) y = smax(y, c, 0.025);
    }
    return y;
  };
  const arch = (z) => { for (const zw of [WZ, -WZ]) { const dz = z - zw; if (Math.abs(dz) < ARCH) return R + Math.sqrt(ARCH * ARCH - dz * dz); } return FLOOR + 0.03; };
  const inZ = (z, a, b) => z <= a && z >= b;
  const WS = [0.8, 0.13], ROOF = [0.13, -0.6], RW = [-0.6, -1.5], SW = [0.6, -0.72];
  const columns = (z, xe) => {
    const cab = z < 0.82 && z > -1.8; // (outside the cabin its columns shrink to the middle of the bonnet / deck)
    const bw = cab ? Math.min(belt(z), xe - 0.05) : 0.3, rw = cab ? Math.min(roofW(z), bw - 0.03) : 0.26;
    const s3 = bw * 0.985, s4 = Math.max(s3, 0.42), s5 = Math.max(s4, 0.66);
    const inner = (zz) => (inZ(zz, ...WS) ? 'glass' : inZ(zz, ...RW) ? 'glass' : 'body');   // windscreen / roof / rear window
    const pillar = 'body';                                                                    // A and C pillars along the roof edge
    const sideGlass = (zz) => (inZ(zz, ...SW) ? 'glass' : 'body');
    const bonnet = (zz, x) => (inZ(zz, 1.62, 1.05) && x > 0.42 && x < 0.66 ? 'dark' : 'body'); // vents in the bonnet over the wheels
    return [[0, rw * 0.88, 6, inner], [rw * 0.88, rw * 1.02, 2, pillar], [rw * 1.02, s3, 4, sideGlass], [s3, s4, 3, 'body'],
      [s4, s5, 3, bonnet], [s5, xe, 5, 'body']];
  };
  const side = (z, x, y) => (y < 0.25 ? 'carbon' : inZ(z, 0.92, 0.62) && y < 0.62 ? 'dark' : 'body'); // carbon sills, the vent behind the front wheel
  const st = [];
  for (let z = NOSE; z >= TAIL; z -= 0.065) st.push(z);
  for (const zw of [WZ, -WZ]) for (let k = 0; k <= 24; k++) st.push(zw + ARCH * Math.cos((k / 24) * Math.PI)); // closer together where the arch is steep
  for (const zw of [WZ, -WZ]) st.push(zw + ARCH + 0.001, zw - ARCH - 0.001, zw + ARCH - 0.002, zw - ARCH + 0.002);
  st.push(...WS, ...ROOF, ...RW, ...SW, 1.62, 1.05, 0.92, 0.62);
  const parts = { body: [], accent: [], carbon: [], dark: [], glass: [], light: [], head: [] };
  const S = skin({ stations: st, W, top, bottom: arch, columns, side, splits: [0.62, 0.25], shoulder: 0.06, floor: FLOOR, liner: 0.42, tumble: 0.06 });
  for (const [k, g] of Object.entries(S)) (parts[k] ??= []).push(g);

  parts.carbon.push(box(1.7, 0.03, 3.9, 0, FLOOR, -0.05));
  parts.carbon.push(box(1.9, 0.024, 0.36, 0, 0.065, NOSE - 0.1));                     // splitter
  both((s) => parts.carbon.push(box(0.2, 0.012, 0.13, s * 0.8, 0.33, NOSE - 0.12, 0.05, 0, -s * 0.18))); // dive planes
  parts.dark.push(box(1.05, 0.2, 0.025, 0, 0.3, NOSE + 0.02, 0.2));                    // grille
  both((s) => parts.dark.push(box(0.28, 0.13, 0.025, s * 0.62, 0.27, NOSE - 0.1, 0.2, s * 0.25, 0)));
  // headlights in the front corners, tail lights across the back
  both((s) => {
    parts.head.push(onBody(top, s * 0.7, NOSE - 0.28, 0.3, 0.16, 0.006, 0.008, s * 0.35));
    parts.light.push(box(0.5, 0.05, 0.02, s * 0.6, 0.8, TAIL - 0.017));
  });
  parts.light.push(box(0.12, 0.05, 0.02, 0, 0.3, TAIL - 0.046));                        // rain light
  parts.dark.push(box(1.3, 0.22, 0.02, 0, 0.5, TAIL - 0.017));                           // the back panel
  parts.carbon.push(box(1.84, 0.3, 0.03, 0, 0.24, TAIL - 0.02));                          // the rear bumper, round the diffuser
  parts.carbon.push(box(1.7, 0.16, 0.03, 0, 0.17, NOSE + 0.012));                          // the front bumper's lip
  both((s) => parts.dark.push(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 14).rotateX(Math.PI / 2).translate(s * 0.25, 0.27, TAIL - 0.05))); // exhausts
  const dif = box(1.55, 0.02, 0.5, 0, 0.17, TAIL + 0.28, -0.26); parts.carbon.push(dif);
  for (const x of [-0.55, -0.2, 0.2, 0.55]) parts.carbon.push(box(0.012, 0.15, 0.46, x, 0.2, TAIL + 0.27, -0.26));
  // rear wing on swan-neck mounts, with endplates; a gurney flap
  parts.carbon.push(wingEl(1.84, 0.34, 0.05, 0, 1.3, -1.98, 0.14));
  parts.carbon.push(box(1.84, 0.03, 0.01, 0, 1.29, -2.33));
  both((s) => {
    parts.carbon.push(plate([[-1.9, 1.17], [-2.4, 1.17], [-2.42, 1.42], [-1.95, 1.42]], 0.018, s * 0.93));
    parts.accent.push(plate([[-2.0, 1.32], [-2.25, 1.32], [-2.18, 0.94], [-2.02, 0.94]], 0.022, s * 0.36)); // swan necks
  });
  // mirrors on the doors, door number panels, side intake ahead of the rear wheels
  both((s) => mirror(parts, s * 0.98, 0.98, 0.56, s));
  const numbers = [];
  both((s) => numbers.push({ pos: [s * 0.97, 0.56, -0.05], rotY: s * Math.PI / 2, w: 0.42, h: 0.32 }));
  numbers.push({ pos: [0, 0.001 + top(0, 1.6), 1.6], rotX: -Math.PI / 2 - 0.25, w: 0.3, h: 0.3, flat: true }); // on the bonnet
  return {
    parts, numbers,
    wheels: [[-WX, WZ, 0.3, true], [WX, WZ, 0.3, true], [-WX, -WZ, 0.32, false], [WX, -WZ, 0.32, false]],
    tyre: { R, rim: 0.23, spokes: 5, rimColour: 0x23252a, caliper: 0xc81e1e },
    cams: { tcam: { z: -0.35, y: 1.38, tilt: -1.5 }, cockpit: { z: -0.75, y: 0.92, tilt: -2 } },
  };
}

// Build a kind of body once ('proto' | 'gt'): merged geometry per material, number panels, wheels, cameras
const cache = new Map();
export function bodyFor(kind) {
  if (!cache.has(kind)) {
    const b = kind === 'gt' ? gt3() : hypercar();
    const merged = {};
    for (const [k, list] of Object.entries(b.parts)) if (list.length) merged[k] = mergeGeometries(list.map(prep));
    cache.set(kind, { ...b, merged });
  }
  return cache.get(kind);
}
export const NEW_BODIES = ['proto', 'gt'];

// A multi-spoke rim face (shared): spokes from the hub to the rim, a centre-lock nut. Axle along x.
const rimCache = new Map();
export function rimGeometry(R, rim, spokes, width) {
  const key = [R, rim, spokes, width].join();
  if (!rimCache.has(key)) {
    const g = [], face = width / 2 - 0.035;
    for (let k = 0; k < spokes; k++) {
      const a = (k / spokes) * Math.PI * 2, sp = new THREE.BoxGeometry(0.03, rim * 0.78, spokes > 6 ? 0.03 : 0.055);
      sp.translate(0, rim * 0.5, 0); sp.rotateX(a); g.push(sp);
      if (spokes <= 6) { const sp2 = new THREE.BoxGeometry(0.026, rim * 0.6, 0.03); sp2.translate(0, rim * 0.55, 0); sp2.rotateX(a + Math.PI / spokes); g.push(sp2); }
    }
    const hub = new THREE.CylinderGeometry(rim * 0.24, rim * 0.28, 0.05, 16); hub.rotateZ(Math.PI / 2); g.push(hub);
    const nut = new THREE.CylinderGeometry(0.045, 0.045, 0.06, 6); nut.rotateZ(Math.PI / 2); nut.translate(0.02, 0, 0); g.push(nut);
    const lip = new THREE.TorusGeometry(rim * 0.98, 0.012, 6, 40); lip.rotateY(Math.PI / 2); g.push(lip);
    const faceG = mergeGeometries(g.map(prep));
    const disc = new THREE.CylinderGeometry(rim * 0.95, rim * 0.95, width - 0.03, 28, 1, true); disc.rotateZ(Math.PI / 2); // the barrel
    const backing = new THREE.CircleGeometry(rim * 0.96, 28); backing.rotateY(Math.PI / 2); backing.translate(-0.03, 0, 0);
    rimCache.set(key, { face: faceG, faceX: face, barrel: prep(disc), backing: prep(backing) });
  }
  return rimCache.get(key);
}