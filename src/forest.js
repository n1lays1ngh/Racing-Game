// Woods right up to the track, for circuits that run through forest (the Nürburgring's Nordschleife).
// A circuit file marks those stretches with `forest: [{ from, to }]`, and open fields along them with
// `meadows` (track.js turns them into track.forest / woodsL / woodsR). There the track gets only trees:
//   • a steel guardrail (barriers.js) a couple of metres from the white line, instead of sponsor walls and
//     debris fences; no gravel, grandstands, braking boards or floodlights (track.js, brakeBoards.js,
//     lighting.js), kerbs only at the apexes (scenery.js)
//   • right behind the guardrail: bushes, and spruces and beeches packed close together
//   • a few metres further back, the edge of the woods: a wall of foliage (a painted strip of dense forest,
//     ~24 m tall, with spruce spires and beech crowns along its top), so there are no gaps to see through
//   • behind that, cheaper trees, and the ground itself lifted into a canopy of treetops and coloured like
//     one (forestLand(), used by terrain.js), so whole hillsides read as woods from far away
// The trees are cut into 250 m chunks, and each chunk is only drawn near the camera: full trees close by,
// the same trees as cheap stand-ins further away (userData.cull, a share of the graphics preset's view
// distance; scenery.js shows and hides them). Tweak the look with FOREST below.
//
//   nearestSample(track, x, z, maxD) → { d, i }  the nearest track sample, fast (i = -1 if none within maxD)
//   forestLand(track) → (x, z) → [lift, r, g, b]  the canopy for the ground there (null: no forest here)
//   buildForest(track, { heightAt, ok, kit })    → THREE.Group (kit: scenery.js's tree shapes)
import * as THREE from 'three';
import { GRAPHICS } from './settings.js';
import { withLightPools } from './lighting.js';

export const FOREST = {
  chunk: 250,            // metres of track per chunk of trees
  near: 0.16,            // full trees within this share of the view distance (settings.js) …
  far: 0.4,              // … cheap stand-ins and the trees further back within this share
  edge: [0.6, 4.6],      // trees: metres behind the guardrail
  edgeGap: 3.2,          // metres between them along the track (High; GRAPHICS.trees thins them)
  minGap: 2.3,           // no two trunks closer than this
  spruce: 0.5,           // share of spruces (the rest beeches) …
  stands: 0.3,           // … in stands: some stretches more spruce, some more beech
  size: { spruce: [1.1, 1.95], beech: [1.15, 1.85] }, // tree scale (1 = the 11 m tree used elsewhere)
  trunk: 0.6,            // trunks thinner than the scale says (a tall forest tree isn't a fat park tree)
  overhang: 0.25,        // trees close to the guardrail are smaller: scale at most ~1 + this × metres behind it
  shrubs: 1.2,           // bushes along the guardrail, per tree
  wall: 6,               // the edge of the woods (wall of foliage): this far behind the guardrail …
  wallWobble: 1.6,       // … wandering in and out by up to this much
  wallDraw: 0.65,        // … drawn within this share of the view distance
  meadow: 70,            // open fields (meadows): the woods start up to this much further back
  farFrom: 9,            // cheaper trees: from just behind the wall of foliage …
  farTo: 200,            // … to here behind the guardrail,
  farArea: 320,          // one per this many m² (High; GRAPHICS.forest thins them)
  canopy: { height: 16, from: 16, ramp: 34 }, // the ground lifted into treetops: height, starts this far behind the guardrail, over
  canopyColour: [0.36, 0.37, 0.8], // multiplies the ground's colour: dark green treetops
  floorColour: [0.62, 0.52, 0.72], // under the trees: darker and browner
  cover: 0.38,           // the land further out: lower = more of it woods (the rest fields)
  clearOfOther: 230,     // no canopy this close to the circuit's other parts (paddock, car parks, grandstands)
};

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let seed = 1;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; // repeatable

// ---------- nearest track sample ----------
// The samples (every 4 m) in a grid of 40 m cells, searched in rings outwards from the query point.
const GRIDS = new WeakMap();
function sampleGrid(track) {
  let g = GRIDS.get(track);
  if (g) return g;
  const CELL = 40, STEP = 2, { n, cx, cz } = track;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) { x0 = Math.min(x0, cx[i]); x1 = Math.max(x1, cx[i]); z0 = Math.min(z0, cz[i]); z1 = Math.max(z1, cz[i]); }
  const cols = Math.floor((x1 - x0) / CELL) + 1, rows = Math.floor((z1 - z0) / CELL) + 1, cells = cols * rows;
  const cellOf = (i) => Math.floor((cz[i] - z0) / CELL) * cols + Math.floor((cx[i] - x0) / CELL);
  const start = new Int32Array(cells + 1);
  for (let i = 0; i < n; i += STEP) start[cellOf(i) + 1]++;
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[cells]), fill = start.slice(0, cells);
  for (let i = 0; i < n; i += STEP) items[fill[cellOf(i)]++] = i;
  g = { CELL, x0, z0, cols, rows, start, items };
  GRIDS.set(track, g);
  return g;
}

export function nearestSample(track, x, z, maxD = Infinity) {
  const g = sampleGrid(track), { CELL, cols, rows, start, items } = g, { cx, cz } = track;
  const qx = Math.floor((x - g.x0) / CELL), qz = Math.floor((z - g.z0) / CELL);
  const r0 = Math.max(0, -qx, qx - (cols - 1), -qz, qz - (rows - 1));  // the first ring that reaches the grid
  const rMax = Math.min(r0 + Math.max(cols, rows), Math.ceil(maxD / CELL) + 1);
  let best = Infinity, bi = -1;
  for (let r = r0; r <= rMax; r++) {
    for (let gz = Math.max(0, qz - r); gz <= Math.min(rows - 1, qz + r); gz++) {
      const step = gz === qz - r || gz === qz + r ? 1 : 2 * r;        // top and bottom rows whole, the sides' two cells
      for (let gx = qx - r; gx <= qx + r; gx += step) {
        if (gx < 0 || gx >= cols) continue;
        const c = gz * cols + gx;
        for (let k = start[c]; k < start[c + 1]; k++) {
          const i = items[k], d = (x - cx[i]) ** 2 + (z - cz[i]) ** 2;
          if (d < best) { best = d; bi = i; }
        }
      }
    }
    if (bi >= 0 && best <= (r * CELL) ** 2) break;                   // nothing unseen can be closer
  }
  const d = Math.sqrt(best);
  return d <= maxD ? { d, i: bi } : { d: Infinity, i: -1 };
}

// ---------- the ground: canopy and forest floor ----------
// Woods and fields far from the track: big soft patches (0..1, woods above FOREST.cover).
const region = (x, z) => 0.5 + 0.5 * (Math.sin(x * 0.0029 + 1.7) * Math.cos(z * 0.0023 - 0.6) * 0.55
  + Math.sin((x - z) * 0.0051 + 0.4) * 0.3 + Math.cos((x + 2 * z) * 0.0093 + 2.2) * 0.15);

export function forestLand(track) {
  if (!track.forest || !track.forest.some((v) => v)) return null;
  const F = FOREST, C = F.canopy, out = [0, 1, 1, 1], reach = F.clearOfOther + 320;
  return (x, z) => {
    const near = nearestSample(track, x, z, reach);
    const woodsOut = smooth(F.cover - 0.06, F.cover + 0.06, region(x, z));
    let cover = woodsOut, start = 0, beyond = Infinity, floor = 0;
    if (near.i >= 0) {
      const i = near.i, left = (x - track.cx[i]) * track.nx[i] + (z - track.cz[i]) * track.nz[i] >= 0;
      beyond = near.d - (left ? track.wallL[i] : track.wallR[i]);       // metres behind the barrier
      if (track.forest[i]) {
        const w = left ? track.woodsL[i] : track.woodsR[i];
        start = C.from + (1 - w) * F.meadow;
        cover = woodsOut + (1 - woodsOut) * (1 - smooth(260, 480, beyond)); // woods behind the trees, then the land's own mix
        floor = w * smooth(0, 4, beyond) * (1 - smooth(start - 4, start + 10, beyond));
      } else start = F.clearOfOther;                                    // around the paddock: open ground
    }
    const tint = cover * smooth(start - 4, start + C.ramp * 0.6, beyond);
    out[0] = C.height * cover * smooth(start, start + C.ramp, beyond);
    for (let k = 0; k < 3; k++) out[k + 1] = 1 + (F.canopyColour[k] - 1) * tint + (F.floorColour[k] - 1) * floor * (1 - tint);
    return out;
  };
}

// ---------- the edge of the woods: a wall of foliage ----------
// One picture of a forest edge, 48 m along and 24 m up, painted once in code: dark depths, a back row of
// tall spruces and beeches shoulder to shoulder, younger trees in front of them and bushes down to the
// ground. Transparent above the treetops, so its top edge is a ragged line of spires and crowns.
const EDGE_SIZE = [48, 24];
let EDGE_MAT = null;
function forestEdgeMaterial() {
  if (EDGE_MAT) return EDGE_MAT;
  const W = 2048, H = 1024, px = W / EDGE_SIZE[0];                      // pixels per metre (same both ways)
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  seed = 101;
  const rgb = ([r, gr, b], k = 1) => `rgb(${Math.min(255, Math.round(r * k))},${Math.min(255, Math.round(gr * k))},${Math.min(255, Math.round(b * k))})`;
  const copies = (x, half, draw) => { draw(x); if (x - half < 0) draw(x + W); if (x + half > W) draw(x - W); }; // tiles seamlessly
  const yAt = (m) => H - m * px;                                        // metres above the ground → canvas y
  const SPRUCE = [[22, 38, 26], [34, 56, 35], [56, 80, 48]], BEECH = [[34, 54, 22], [58, 88, 32], [94, 124, 50]];
  const BUSH = [[36, 58, 24], [66, 96, 36], [104, 132, 54]], BARK = [86, 84, 76], DEPTH = [16, 26, 17];
  g.lineCap = 'round';

  // a spruce: a narrow cone of drooping tiers, branches almost to the ground, lighter needles on top of each tier
  const spruce = (x, h, k) => {
    const tiers = Math.max(6, Math.round(h * 1.8)), half = h * px * (0.15 + rand() * 0.05), wl = [], wr = [];
    for (let t = 0; t <= tiers; t++) { const w = half * Math.pow(t / tiers, 0.8); wl.push(w * (0.8 + rand() * 0.35)); wr.push(w * (0.8 + rand() * 0.35)); }
    const top = yAt(h), bottom = yAt(0.4), ty = (t) => top + ((bottom - top) * t) / tiers;
    copies(x, half * 1.3, (cx) => {
      g.fillStyle = rgb(SPRUCE[0], k);
      g.beginPath(); g.moveTo(cx, top);
      for (let t = 1; t <= tiers; t++) { g.lineTo(cx + wr[t], ty(t) + 0.25 * px); g.lineTo(cx + wr[t] * 0.62, ty(t) - 0.1 * px); }
      for (let t = tiers; t >= 1; t--) { g.lineTo(cx - wl[t] * 0.62, ty(t) - 0.1 * px); g.lineTo(cx - wl[t], ty(t) + 0.25 * px); }
      g.closePath(); g.fill();
      for (let t = 1; t <= tiers; t++) for (const [s, w] of [[1, wr[t]], [-1, wl[t]]]) {
        for (let q = 0, count = Math.max(2, Math.round(w / 5)); q < count; q++) {
          const u = rand(), x0 = cx + s * w * u * 0.95, y0 = ty(t) - (1 - u) * 0.35 * px - rand() * 0.3 * px;
          g.strokeStyle = rgb(rand() < 0.3 ? SPRUCE[2] : SPRUCE[1], k * (0.75 + rand() * 0.5)); g.lineWidth = 1.2 + rand() * 1.6;
          g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + s * (3 + rand() * 7), y0 + 2 + rand() * 5); g.stroke();
        }
      }
    });
  };
  // a leafy crown (beech, or a bush with no trunk): overlapping lobes covered in leaves, lighter on top
  const leafy = (x, h, k, P, trunk) => {
    const r = h * px * (trunk ? 0.22 + rand() * 0.08 : 0.42 + rand() * 0.15), cy = trunk ? yAt(h) + r : yAt(h) + r * 0.9, lobes = [[0, 0, r * 0.75]];
    for (let q = 0; q < 7; q++) lobes.push([(rand() - 0.5) * r * 1.2, (rand() - 0.3) * r * 0.9, r * (0.45 + rand() * 0.35)]);
    copies(x, r * 1.4, (cx) => {
      if (trunk) { g.fillStyle = rgb(BARK, k * 0.8); g.fillRect(cx - 0.17 * px, cy, 0.34 * px, H - cy); }
      g.fillStyle = rgb(P[0], k);
      for (const [lx, ly, lr] of lobes) { g.beginPath(); g.arc(cx + lx, Math.min(cy + ly, H - lr * 0.3), lr, 0, Math.PI * 2); g.fill(); }
      for (let q = 0, count = Math.round((r * r) / 20); q < count; q++) {
        const [lx, ly, lr] = lobes[Math.floor(rand() * lobes.length)];
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * lr * 1.03;
        const x0 = cx + lx + Math.cos(a) * d, y0 = Math.min(cy + ly, H - lr * 0.3) + Math.sin(a) * d, up = Math.max(0, Math.min(1, 1 - (y0 - (cy - r)) / (2.2 * r)));
        g.strokeStyle = rgb(rand() < 0.2 + up * 0.4 ? P[2] : P[1], k * (0.7 + up * 0.45 + rand() * 0.15)); g.lineWidth = 2.5 + rand() * 2.5;
        const len = 2 + rand() * 4, b = rand() * Math.PI;
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + Math.cos(b) * len, y0 + Math.sin(b) * len); g.stroke();
      }
    });
  };
  const beech = (x, h, k) => leafy(x, h, k, BEECH, true), bush = (x, h, k) => leafy(x, h, k, BUSH, false);

  // the dark inside of the woods, up to ~10 m with a ragged top, so nothing is see-through low down
  g.fillStyle = rgb(DEPTH);
  g.beginPath(); g.moveTo(0, H);
  for (let x = 0; x <= W; x += 16) g.lineTo(x, yAt(8 + 2.5 * Math.sin(x * 0.011) + rand() * 1.5));
  g.lineTo(W, H); g.closePath(); g.fill();
  for (let x = 0; x < W; x += px * (2.6 + rand() * 1.6)) (rand() < 0.6 ? spruce : beech)(x, 16 + rand() * 7.5, 0.72 + rand() * 0.1); // tall, at the back
  for (let x = rand() * 40; x < W; x += px * (3 + rand() * 2.4)) (rand() < 0.5 ? spruce : beech)(x, 10 + rand() * 7, 0.86 + rand() * 0.1);
  for (let x = rand() * 40; x < W; x += px * (2.4 + rand() * 2)) (rand() < 0.35 ? spruce : bush)(x, 3 + rand() * 5, 0.98 + rand() * 0.12); // young trees
  for (let x = 0; x < W; x += px * (1.1 + rand() * 1.1)) bush(x, 1.3 + rand() * 2.2, 0.95 + rand() * 0.2); // bushes along the bottom

  // see-through pixels take the average colour, so edges don't get dark fringes when the picture is filtered
  const img = g.getImageData(0, 0, W, H), d = img.data, avg = [0, 0, 0];
  let cnt = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { avg[0] += d[i]; avg[1] += d[i + 1]; avg[2] += d[i + 2]; cnt++; }
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 0) { d[i] = avg[0] / cnt; d[i + 1] = avg[1] / cnt; d[i + 2] = avg[2] / cnt; }
  g.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace; map.wrapS = THREE.RepeatWrapping; map.wrapT = THREE.ClampToEdgeWrapping; map.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.92 });
  // lit like the trees' leaves: both sides use the same (mostly upward) normal, so it isn't dark from behind
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', `
      float faceDirection = 1.0;
      vec3 normal = normalize(vNormal);
      vec3 nonPerturbedNormal = normal;`);
  };
  m.customProgramCacheKey = () => 'apex-forest-edge';
  EDGE_MAT = withLightPools(m);
  return EDGE_MAT;
}

// The wall of foliage along one side, samples c0..c1, FOREST.wall metres behind the guardrail (further back
// in meadows, closer on the inside of tight bends). state.along carries the picture on from one piece to the next.
function edgeGeometry(track, side, c0, c1, heightAt, ok, state) {
  const F = FOREST, { n, ds } = track, W = side > 0 ? track.wallL : track.wallR, woods = side > 0 ? track.woodsL : track.woodsR;
  const pos = [], nor = [], uv = [], idx = [], [len, tall] = EDGE_SIZE;
  let prev = -1, lx = 0, lz = 0;
  for (let k = c0; k <= c1; k += 2) {
    const i = k % n, s = i * ds;
    let lat = W[i] + F.wall + (1 - woods[i]) * F.meadow + F.wallWobble * (0.6 * Math.sin(s / 23 + side * 1.3) + 0.4 * Math.sin(s / 61 + side * 2.1));
    if (track.curv[i] * side > 0) lat = Math.min(lat, 0.8 / Math.abs(track.curv[i]));   // inside of a bend: not past its middle
    const x = track.cx[i] + track.nx[i] * side * lat, z = track.cz[i] + track.nz[i] * side * lat;
    if (!track.forest[i] || lat < W[i] + 1.5 || !ok(x, z, 1)) { prev = -1; continue; }
    if (prev >= 0) state.along += Math.hypot(x - lx, z - lz);
    const y = heightAt(x, z), base = pos.length / 3, u = state.along / len;
    const nx = -side * track.nx[i] * 0.35, nz = -side * track.nz[i] * 0.35;  // facing the track, mostly up (lit like a crown)
    pos.push(x, y - 1.2, z, x, y + tall, z);
    nor.push(nx, 0.94, nz, nx, 0.94, nz);
    uv.push(u, -1.2 / tall, u, 1);
    if (prev >= 0) idx.push(prev, base, prev + 1, prev + 1, base, base + 1);
    prev = base; lx = x; lz = z;
  }
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeBoundingSphere();
  return geo;
}

// ---------- the trees ----------
let BEECH_BARK = null; // beeches have smooth grey bark
const beechBark = () => (BEECH_BARK ??= new THREE.MeshStandardMaterial({ color: 0x8e8c85, roughness: 0.8, vertexColors: true }));

// heightAt(x, z): the ground (terrain.js); ok(x, z, extra): clear of the circuit by `extra` metres beyond its
// barriers and of the buildings; kit: the tree shapes and materials (treeKit() in scenery.js).
export function buildForest(track, { heightAt, ok, kit: K }) {
  const group = new THREE.Group();
  group.name = 'forest';
  group.userData.trees = true;                        // main.js: the graphics preset can turn tree shadows off
  if (!track.forest?.some((v) => v)) return group;
  const F = FOREST, { n, ds } = track, CH = Math.max(1, Math.round(F.chunk / ds));
  const dense = GRAPHICS.trees ?? 1, thin = GRAPHICS.forest ?? 1;

  // the edge of the woods, in pieces of ~1 km per side
  const edgeMat = forestEdgeMaterial(), EC = Math.round(1000 / ds);
  for (const side of [1, -1]) {
    const state = { along: side > 0 ? 0 : 17 };
    for (let c0 = 0; c0 < n; c0 += EC) {
      const geo = edgeGeometry(track, side, c0, Math.min(n, c0 + EC), heightAt, ok, state);
      if (!geo) continue;
      const wall = new THREE.Mesh(geo, edgeMat);
      wall.castShadow = true; wall.receiveShadow = true;
      wall.userData.cull = { from: 0, to: F.wallDraw }; wall.visible = false;
      group.add(wall);
    }
  }

  seed = 29 + (Math.abs(Math.round(track.cx[0] * 3 + track.cz[0])) % 100000); // the same woods every time
  // trunks already placed, in cells of FOREST.minGap
  const taken = new Map(), G = F.minGap, key = (a, b) => a * 100003 + b;
  const free = (x, z) => {
    const a = Math.floor(x / G), b = Math.floor(z / G);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const [px, pz] of taken.get(key(a + i, b + j)) ?? []) if ((px - x) ** 2 + (pz - z) ** 2 < G * G) return false;
    }
    const k = key(a, b);
    if (!taken.has(k)) taken.set(k, []);
    taken.get(k).push([x, z]);
    return true;
  };
  const between = ([a, b]) => a + rand() * (b - a);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
  // narrow: horizontal scale (trunks thinner than the tree's scale, stand-ins slimmer)
  const addMesh = (geo, mat, list, colour, shadows, cull, narrow = 1) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((t, k) => {
      const w = t.s * (t.w ?? 1) * narrow;
      m.compose(p.set(t.x, t.y - 0.25, t.z), q.setFromAxisAngle(up, t.rot), sc.set(w * (0.92 + (k % 5) * 0.04), t.s, w * (0.92 + (k % 7) * 0.03)));
      mesh.setMatrixAt(k, m); mesh.setColorAt(k, colour(t));
    });
    mesh.castShadow = shadows; mesh.receiveShadow = true; mesh.computeBoundingSphere();
    mesh.userData.cull = cull; mesh.visible = false;   // scenery.js shows it once the camera is near enough
    group.add(mesh);
  };
  const hsl = (h, s, l) => new THREE.Color().setHSL(h, s, l);
  const colours = {
    spruce: () => hsl(0.33 + rand() * 0.05, 0.28 + rand() * 0.08, 0.1 + rand() * 0.04),
    beech: () => hsl(0.22 + rand() * 0.05, 0.42 + rand() * 0.13, 0.18 + rand() * 0.08),
    shrub: () => hsl(0.21 + rand() * 0.06, 0.42 + rand() * 0.12, 0.17 + rand() * 0.07),
    far: () => hsl(0.28 + rand() * 0.06, 0.3 + rand() * 0.06, 0.12 + rand() * 0.05),
    bark: () => hsl(0.07, 0.22, 0.6 + rand() * 0.3),
    grey: () => hsl(0.1, 0.04, 0.78 + rand() * 0.22),
  };
  const near = { from: 0, to: F.near, tight: true }, standIn = { from: F.near, to: F.far, tight: true }, back = { from: 0, to: F.far };
  let total = 0;

  for (let c0 = 0; c0 < n; c0 += CH) {
    const c1 = Math.min(n, c0 + CH);
    let wooded = 0;
    for (let i = c0; i < c1; i++) wooded += track.forest[i];
    if (!wooded) continue;
    const L = { spruce: [], beech: [], shrub: [], far: [] }, len = wooded * ds;
    for (const side of [1, -1]) {
      const W = side > 0 ? track.wallL : track.wallR, woods = side > 0 ? track.woodsL : track.woodsR;
      // `count` trees from–to metres behind the barrier (further back in meadows); kind() picks each one
      const place = (count, [from, to], kind, extra, spaced) => {
        for (let k = 0, tries = 0; k < count && tries < count * 4 + 10; tries++) {
          const i = c0 + Math.floor(rand() * (c1 - c0));
          if (!track.forest[i]) continue;
          const behind = from + rand() * (to - from), off = W[i] + (1 - woods[i]) * F.meadow + behind, along = (rand() - 0.5) * ds;
          const x = track.cx[i] + track.nx[i] * side * off + track.tx[i] * along;
          const z = track.cz[i] + track.nz[i] * side * off + track.tz[i] * along;
          if (!ok(x, z, extra)) continue;                                // not on another part of the circuit
          const k2 = kind(i);
          if (spaced && !free(x, z)) continue;
          // right behind the guardrail the trees are smaller, so their branches don't reach far over the road
          const s = k2 === 'shrub' ? 0.3 + rand() * 0.2 : k2 === 'far' ? 1.5 + rand() * 0.7
            : Math.min(between(F.size[k2]), (k2 === 'spruce' ? 1.0 : 0.9) + F.overhang * behind);
          L[k2].push({ x, z, y: heightAt(x, z), s, rot: rand() * 6.3 });
          k++;
        }
      };
      const share = (i) => Math.min(0.95, Math.max(0.05, F.spruce + F.stands * Math.sin((i * ds) / 900 + side * 1.7)));
      const tree = (i) => (rand() < share(i) ? 'spruce' : 'beech');
      const trees = Math.round((len / F.edgeGap) * dense);
      place(trees, F.edge, tree, 0.4, true);                                                       // close behind the guardrail
      place(Math.round(trees * F.shrubs), [0.3, F.wall - 0.5], () => 'shrub', 0.2, false);          // bushes among them
      place(Math.round(((len * (F.farTo - F.farFrom)) / F.farArea) * thin), [F.farFrom, F.farTo], () => 'far', F.farFrom - 2, false);
    }
    addMesh(K.pine.trunk, K.bark, L.spruce, colours.bark, true, near, F.trunk);
    addMesh(K.pine.crown, K.foliage, L.spruce, colours.spruce, true, near);
    addMesh(K.broadleaf.trunk, beechBark(), L.beech, colours.grey, true, near, F.trunk);
    addMesh(K.broadleaf.crown, K.foliage, L.beech, colours.beech, true, near);
    addMesh(K.far, K.foliage, L.shrub, colours.shrub, false, near);
    // further away the same trees as cheap stand-ins (one leafy lobe each; spruces slimmer)
    const stand = [...L.spruce.map((t) => ({ ...t, kind: 'spruce', w: 0.62 })), ...L.beech.map((t) => ({ ...t, kind: 'beech', w: 0.85 }))];
    addMesh(K.far, K.foliage, stand, (t) => colours[t.kind](), false, standIn);
    addMesh(K.far, K.foliage, L.far, colours.far, false, back);
    total += L.spruce.length + L.beech.length + L.shrub.length + L.far.length;
  }
  group.userData.count = total;
  return group;
}