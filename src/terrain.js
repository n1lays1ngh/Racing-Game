// Ground that follows the circuit's hills.
// A height-field mesh: right next to the track it sits just under the road,
// further out it blends into a smooth valley shape and gentle rolling hills,
// and at the edges it flattens out to the circuit's average height (0).
// A circuit file with a `terrain` grid (the real ground, from elevation data) gets that instead of the
// made-up valley and hills: the ground blends from the road into the real hillsides, and levels out beyond
// the edge of the grid.
// land(x, z) (optional, forest.js): [lift, r, g, b] lifts the mesh (not heightAt: trees stand on the real
// ground) into a forest canopy and tints it.
import * as THREE from 'three';
import { WALL_OFFSET } from './track.js';

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Cheap smooth noise for distant hills.
function hills(x, z) {
  return Math.sin(x * 0.0021 + 1.3) * Math.cos(z * 0.0017 - 0.4) * 0.6
    + Math.sin((x + z) * 0.0043) * 0.3 + Math.cos((x - z) * 0.0071 + 2.1) * 0.1;
}

// The circuit's real ground: track.terrain = { x0, z0, step, cols, rows, heights, offset } (heights row by row
// from z0, each row from x0, in the same metres as the circuit's `elevation`; offset = what track.js took off
// those). Outside the grid it levels out to the grid's average height over a couple of kilometres.
function realGround(dem) {
  const { x0, z0, step, cols, rows, heights, offset } = dem;
  let avg = 0;
  for (const v of heights) avg += v;
  avg = avg / heights.length - offset;
  return (x, z) => {
    let fx = (x - x0) / step, fz = (z - z0) / step;
    const out = Math.hypot(Math.max(0, -fx, fx - (cols - 1)), Math.max(0, -fz, fz - (rows - 1))) * step; // metres outside
    fx = Math.min(cols - 1.0001, Math.max(0, fx)); fz = Math.min(rows - 1.0001, Math.max(0, fz));
    const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r, k = r * cols + c;
    const h = (heights[k] * (1 - u) + heights[k + 1] * u) * (1 - v) + (heights[k + cols] * (1 - u) + heights[k + cols + 1] * u) * v - offset;
    return h + (avg - h) * smoothstep(300, 2500, out);
  };
}

// How high the ground is anywhere round the circuit: heightAt(x, z) (a spatial hash of the track, built once)
export function makeHeightAt(track) {
  const { n } = track;
  const h = track.h ?? new Float32Array(n);
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < n; i++) { hMin = Math.min(hMin, h[i]); hMax = Math.max(hMax, h[i]); }
  const hillAmp = Math.min(25, (hMax - hMin) * 0.35); // hilly circuits get hilly surroundings
  const real = track.terrain ? realGround(track.terrain) : null;

  // Spatial hash of track samples for fast "what's the track doing near here?" queries.
  const CELL = 60, grid = new Map(), STEP = 3;
  const key = (cx, cz) => cx * 100003 + cz;
  for (let i = 0; i < n; i += STEP) {
    const k = key(Math.floor(track.cx[i] / CELL), Math.floor(track.cz[i] / CELL));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const coarse = []; // every ~50 m, for far-away valley shape
  for (let i = 0; i < n; i += 25) coarse.push(i);

  return function heightAt(x, z) {
    // Near field: nearest sample + inverse-distance average within 300 m
    let dMin = Infinity, hNear = 0, wSum = 0, hSum = 0;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), R = 5;
    for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
      const list = grid.get(key(cx + a, cz + b));
      if (!list) continue;
      for (const i of list) {
        const d2 = (x - track.cx[i]) ** 2 + (z - track.cz[i]) ** 2;
        if (d2 < dMin) { dMin = d2; hNear = h[i]; }
        const w = 1 / (d2 + 400); wSum += w; hSum += w * h[i];
      }
    }
    const edge = WALL_OFFSET + 6;
    if (real) { // the real ground, with the road's own height close to the track
      const g = real(x, z);
      if (dMin === Infinity) return g - 0.6;
      const d = Math.sqrt(dMin);
      return (d < edge ? hNear : hNear + (g - hNear) * smoothstep(edge, edge + 110, d)) - 0.6;
    }
    // Far field: smooth average over the whole circuit
    let cw = 0, ch = 0, dFar = Infinity;
    for (const i of coarse) {
      const d2 = (x - track.cx[i]) ** 2 + (z - track.cz[i]) ** 2;
      dFar = Math.min(dFar, d2);
      const w = 1 / (d2 + 200 * 200); cw += w; ch += w * h[i];
    }
    const d = Math.sqrt(Math.min(dMin, dFar));
    const valley = ch / cw;
    const local = wSum > 0 ? hSum / wSum : valley;
    // Just under the road at the track, blending to the local average, then the valley
    let y = d < edge ? hNear : hNear + (local - hNear) * smoothstep(edge, edge + 60, d);
    y += (valley - y) * smoothstep(250, 700, d);
    y += hills(x, z) * hillAmp * smoothstep(120, 600, d);   // rolling hills away from the track
    y *= 1 - smoothstep(1800, 3200, d);                      // flatten out at the horizon
    return y - 0.6;
  };
}

// The ground mesh's numbers: a grid of 20 m cells around the circuit, getting coarser towards the horizon, with its
// heights (and, with `land`, the forest canopy's lift and tint), texture coordinates, triangles and normals.
// Only number crunching (the slow part of the ground), so it also runs in a worker (trackWorker.js) while the menu
// carries on. → { pos, uv, col (or null), index, normal, lowest }: typed arrays
export function terrainGrid(track, land = null, heightAt = makeHeightAt(track)) {
  const { n } = track;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, track.cx[i]); maxX = Math.max(maxX, track.cx[i]);
    minZ = Math.min(minZ, track.cz[i]); maxZ = Math.max(maxZ, track.cz[i]);
  }
  const axis = (lo, hi) => {
    const out = [];
    for (let v = lo - 3500; v < lo - 300; v += 150) out.push(v);
    for (let v = lo - 300; v < hi + 300; v += 20) out.push(v);
    for (let v = hi + 300; v <= hi + 3500; v += 150) out.push(v);
    return out;
  };
  const xs = axis(minX, maxX), zs = axis(minZ, maxZ);
  const pos = new Float32Array(xs.length * zs.length * 3), uv = new Float32Array(xs.length * zs.length * 2);
  const col = land ? new Float32Array(xs.length * zs.length * 3) : null;
  let p = 0, q = 0, lowest = Infinity;
  for (const z of zs) for (const x of xs) {
    let y = heightAt(x, z);
    if (land) { const L = land(x, z); y += L[0]; col[p] = L[1]; col[p + 1] = L[2]; col[p + 2] = L[3]; }
    lowest = Math.min(lowest, y);
    pos[p++] = x; pos[p++] = y; pos[p++] = z;
    uv[q++] = x / 22.5; uv[q++] = z / 22.5;
  }
  const W = xs.length, index = new Uint32Array((W - 1) * (zs.length - 1) * 6);
  let t = 0;
  for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    index[t++] = a; index[t++] = c; index[t++] = b; index[t++] = b; index[t++] = c; index[t++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  return { pos, uv, col, index, normal: geo.getAttribute('normal').array, lowest };
}

// The ground mesh. grid: terrainGrid()'s numbers if they're already worked out (in the worker), else worked out here.
// → { mesh, heightAt, lowest }
export function buildTerrain(track, material, land = null, grid = null) {
  const heightAt = makeHeightAt(track);
  const g = grid ?? terrainGrid(track, land, heightAt);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
  geo.setIndex(new THREE.BufferAttribute(g.index, 1));
  const mesh = new THREE.Mesh(geo, material);
  if (g.col) { // its own copy of the ground material, coloured per vertex (keeps the ground shader)
    geo.setAttribute('color', new THREE.BufferAttribute(g.col, 3));
    const m = material.clone();
    Object.assign(m, { vertexColors: true, onBeforeCompile: material.onBeforeCompile, customProgramCacheKey: material.customProgramCacheKey });
    mesh.material = m;
    mesh.userData.ownMaterials = [m];
  }
  mesh.receiveShadow = true;
  return { mesh, heightAt, lowest: g.lowest };
}