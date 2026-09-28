// Ground that follows the circuit's hills.
// A height-field mesh: right next to the track it sits just under the road,
// further out it blends into a smooth valley shape and gentle rolling hills,
// and at the edges it flattens out to the circuit's average height (0).
import * as THREE from 'three';
import { WALL_OFFSET } from './track.js';

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Cheap smooth noise for distant hills.
function hills(x, z) {
  return Math.sin(x * 0.0021 + 1.3) * Math.cos(z * 0.0017 - 0.4) * 0.6
    + Math.sin((x + z) * 0.0043) * 0.3 + Math.cos((x - z) * 0.0071 + 2.1) * 0.1;
}

export function buildTerrain(track, material) {
  const { n } = track;
  const h = track.h ?? new Float32Array(n);
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < n; i++) { hMin = Math.min(hMin, h[i]); hMax = Math.max(hMax, h[i]); }
  const hillAmp = Math.min(25, (hMax - hMin) * 0.35); // hilly circuits get hilly surroundings

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

  function heightAt(x, z) {
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
    const edge = WALL_OFFSET + 6;
    // Just under the road at the track, blending to the local average, then the valley
    let y = d < edge ? hNear : hNear + (local - hNear) * smoothstep(edge, edge + 60, d);
    y += (valley - y) * smoothstep(250, 700, d);
    y += hills(x, z) * hillAmp * smoothstep(120, 600, d);   // rolling hills away from the track
    y *= 1 - smoothstep(1800, 3200, d);                      // flatten out at the horizon
    return y - 0.6;
  }

  // Grid: 20 m cells around the circuit, getting coarser towards the horizon
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
  let p = 0, q = 0;
  for (const z of zs) for (const x of xs) {
    pos[p++] = x; pos[p++] = heightAt(x, z); pos[p++] = z;
    uv[q++] = x / 22.5; uv[q++] = z / 22.5;
  }
  const idx = [], W = xs.length;
  for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return { mesh, heightAt };
}
