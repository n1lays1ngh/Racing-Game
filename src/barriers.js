// Trackside barriers like the ones at a modern F1 circuit: a solid barrier about a metre high with a
// rounded top, wrapped in a sponsor's livery (long runs of one sponsor, the logo repeating every 4 m),
// and a tall debris fence standing just behind it on steel posts.
//   buildBarriers(track) → a THREE.Group that scenery.js adds to the circuit (with the pit wall and the
//                          barrier along the pit lane, from track.pitLane: see pitlane.js)
//
// On street circuits ('concrete') some stretches are bare concrete instead. The sponsors are made up.
// Through the woods (forest stretches, forest.js: the Nordschleife) it's a steel guardrail instead (ARMCO below):
// two W-shaped beams on posts, no sponsors and no fence.
// Everything is drawn in code when the game starts (no image files).
import * as THREE from 'three';
import { bankLift } from './banking.js';
import { withLightPools } from './lighting.js';

export const BARRIER = {
  block: 4,           // metres per logo repeat (and between fence posts)
  run: 48,            // metres of one sponsor before the next
  bare: { ads: 0, concrete: 0.35 }, // share of stretches that are bare concrete, per barrier type
  depth: 0.8,         // how deep the barrier is (away from the track), metres
  fenceGap: 0.35,     // gap between the back of the barrier and the fence, metres
  fence: 3.8,         // fence height above the ground, metres
};

// The guardrail in the woods: double Armco, the beams one above the other, bolted to posts.
export const ARMCO = {
  beams: [0.4, 0.72], // height of each beam's bottom edge above the road (m); a beam is 31 cm tall
  post: 2,            // metres between posts
  chunk: 250,         // metres of guardrail per piece: pieces far from the camera aren't drawn …
  draw: 0.3,          // … beyond this share of the view distance (settings.js)
};
// A W-beam seen end on: [metres back from its face (away from the track), height above its bottom edge].
const BEAM = [[0.08, 0], [0.005, 0.07], [0.065, 0.155], [0.005, 0.24], [0.08, 0.31]];

// Cross-section: [metres out from the wall line (away from the track), height]; the first point is buried.
// A vertical face, a rounded top edge (25 cm radius), a flat top and a rounded back edge.
const R = 0.25, H = 1.03, D = BARRIER.depth, arc = (cx, cy, from, to) => Array.from({ length: 4 }, (_, k) => {
  const a = ((from + ((to - from) * k) / 3) * Math.PI) / 180; return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
});
const FACE = [[0, -0.9], [0, 0.02], [0, H - R], ...arc(R, H - R, 180, 90).slice(1), [D - R, H]]; // wrapped in the livery
const BACK = [[D - R, H], ...arc(D - R, H - R, 90, 0).slice(1), [D, -0.9]];                        // plain

const hAt = (track, i, lateral = 0) => (track.h ? track.h[i] : 0) + bankLift(track, i, lateral);

// ---------- textures, drawn once ----------
let seed = 1;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
function valueNoise(w, h, cx, cy, s) { // smooth noise that tiles, cx × cy cells
  seed = s; const g = Array.from({ length: cx * cy }, rand), out = new Float32Array(w * h), sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < h; y++) {
    const fy = (y / h) * cy, y0 = Math.floor(fy), ty = sm(fy - y0), y1 = (y0 + 1) % cy;
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * cx, x0 = Math.floor(fx), tx = sm(fx - x0), x1 = (x0 + 1) % cx;
      const a = g[y0 * cx + x0], b = g[y0 * cx + x1], c = g[y1 * cx + x0], d = g[y1 * cx + x1];
      out[y * w + x] = a + (b - a) * tx + (c - a + (a - b - c + d) * tx) * ty;
    }
  }
  return out;
}

// One 4 m concrete block, 1024 × 272 px (about 4 mm a pixel): mottled grey concrete with pores, rain
// streaks from the top, road grime and black tyre scuffs low down, and the joint at each end.
function concreteTextures() {
  const W = 1024, H = 272, n = W * H;
  const big = valueNoise(W, H, 8, 2, 11), mid = valueNoise(W, H, 40, 10, 12), fine = valueNoise(W, H, 200, 52, 13);
  const streak = valueNoise(W, H, 90, 2, 14);
  const v = new Float32Array(n), hgt = new Float32Array(n);
  seed = 21;
  const scuffs = Array.from({ length: 7 }, () => ({ x: rand() * W, len: 60 + rand() * 260, y: H - 8 - rand() * 70, k: 0.3 + rand() * 0.5 }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, fromTop = y / H;
    let c = 0.66 + (big[i] - 0.5) * 0.1 + (mid[i] - 0.5) * 0.08 + (fine[i] - 0.5) * 0.07;
    c -= Math.max(0, streak[i] - 0.55) * 0.35 * (1 - fromTop) ** 0.5;        // rain streaks from the top edge
    c -= Math.max(0, fromTop - 0.72) * 0.35 * (0.6 + big[i] * 0.8);          // road grime near the ground
    for (const s of scuffs) {                                                // black tyre scuffs
      const dx = (x - s.x) / s.len, dy = (y - s.y) / 5;
      if (dx > 0 && dx < 1) c -= s.k * Math.exp(-dy * dy) * Math.sin(Math.PI * dx) * (0.6 + fine[i] * 0.8);
    }
    hgt[i] = fine[i] * 0.5 + mid[i] * 0.5;
    v[i] = c;
  }
  for (let k = 0; k < 2600; k++) { // pores and small chips
    const x = Math.floor(rand() * W), y = Math.floor(rand() * H), r = rand() < 0.9 ? 1 : 2;
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      const xx = (x + a + W) % W, yy = Math.min(H - 1, Math.max(0, y + b)), i = yy * W + xx;
      v[i] -= 0.14; hgt[i] -= 0.5;
    }
  }
  for (let y = 0; y < H; y++) for (const [x, d] of [[0, 0.45], [1, 0.3], [2, 0.12], [W - 1, 0.45], [W - 2, 0.3], [W - 3, 0.12]]) { // joints
    v[y * W + x] -= d; hgt[y * W + x] -= d * 3;
  }
  for (let x = 0; x < W; x++) for (let y = 0; y < 5; y++) v[y * W + x] += 0.05 * (1 - y / 5); // worn top edge
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const cx = c.getContext('2d'), img = cx.createImageData(W, H);
  for (let i = 0; i < n; i++) {
    const g = Math.max(0, Math.min(1, v[i])) * 255;
    img.data[i * 4] = g * 1.0; img.data[i * 4 + 1] = g * 0.995; img.data[i * 4 + 2] = g * 0.97; img.data[i * 4 + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  const nc = document.createElement('canvas'); nc.width = W; nc.height = H;
  const nx = nc.getContext('2d'), nimg = nx.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, l = hgt[y * W + (x + W - 1) % W], r = hgt[y * W + (x + 1) % W];
    const u = hgt[Math.max(0, y - 1) * W + x], d = hgt[Math.min(H - 1, y + 1) * W + x];
    let ax = (l - r) * 2.5, ay = (d - u) * 2.5; const len = Math.hypot(ax, ay, 1);
    nimg.data[i * 4] = (ax / len * 0.5 + 0.5) * 255; nimg.data[i * 4 + 1] = (ay / len * 0.5 + 0.5) * 255;
    nimg.data[i * 4 + 2] = (1 / len * 0.5 + 0.5) * 255; nimg.data[i * 4 + 3] = 255;
  }
  nx.putImageData(nimg, 0, 0);
  const map = new THREE.CanvasTexture(c), normalMap = new THREE.CanvasTexture(nc);
  map.colorSpace = THREE.SRGBColorSpace;
  for (const t of [map, normalMap]) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8; }
  return { map, normalMap };
}

// Made-up sponsors. Each is a 4 m tile of the wrap (1024 × 240 px) in a 2048 × 1024 atlas, 2 across and
// 4 down; the colour at the top of the tile carries on over the top of the barrier. weight = how often.
const LIVERIES = [
  { bg: '#f5cf0f', text: 'CORSA', color: '#d0141b', stroke: '#1a1a1a', font: 'italic 900 150px "Arial Black", Impact, sans-serif', sub: 'TYRES', subColor: '#1a1a1a', weight: 4 },
  { bg: '#0c2344', text: 'ORION', color: '#ffffff', font: '700 150px Futura, "Trebuchet MS", Arial, sans-serif', sub: 'ENERGY', subColor: '#ff7a1a', weight: 1.5 },
  { bg: '#b3121b', text: 'VELOCITÀ', color: '#ffffff', font: 'italic 900 140px "Arial Black", Impact, sans-serif', weight: 1.2 },
  { bg: '#f4f4f1', text: 'APEX', color: '#c8102e', font: 'italic 900 160px "Arial Black", Arial, sans-serif', sub: 'CIRCUIT', subColor: '#111111', weight: 1.2 },
  { bg: '#141516', text: 'MERIDIAN', color: '#c9a55b', font: '400 140px Didot, Georgia, serif', sub: 'GENÈVE', subColor: '#c9a55b', weight: 1 },
  { bg: '#006b5e', text: 'NORDA', color: '#ffffff', font: '700 150px Georgia, "Times New Roman", serif', sub: 'BANK', subColor: '#9fe0d3', weight: 1 },
  { bg: '#1b5fa8', text: 'HALCYON', color: '#ffffff', font: 'italic 700 140px "Helvetica Neue", Arial, sans-serif', sub: 'AIR', subColor: '#ffffff', weight: 1 },
  { bg: '#1d1238', text: 'AXIS', color: '#ffffff', font: '900 160px "Arial Black", Arial, sans-serif', sub: 'TELECOM', subColor: '#e0418f', weight: 1 },
];
function liveryAtlas() {
  const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
  const x = c.getContext('2d');
  LIVERIES.forEach((L, k) => {
    const ox = (k % 2) * 1024, oy = Math.floor(k / 2) * 256, W = 1024, TH = 256;
    x.save(); x.translate(ox, oy);
    x.fillStyle = L.bg; x.fillRect(0, 0, W, TH);                   // the whole cell, so edges blend into the same colour
    x.translate(0, 8);                                              // the tile proper: rows 8..248 of the cell
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const cy = 132, big = L.sub ? -10 : 0;                          // logo on the vertical face (lower two thirds)
    x.font = L.font; if ('letterSpacing' in x) x.letterSpacing = '4px';
    if (L.stroke) { x.lineWidth = 10; x.strokeStyle = L.stroke; x.lineJoin = 'round'; x.strokeText(L.text, W / 2 - (L.sub ? 70 : 0), cy + big, 760); }
    x.fillStyle = L.color; x.fillText(L.text, W / 2 - (L.sub ? 70 : 0), cy + big, 760);
    if (L.sub) {
      const wText = Math.min(760, x.measureText(L.text).width);
      x.font = '800 54px "Helvetica Neue", Arial, sans-serif'; if ('letterSpacing' in x) x.letterSpacing = '8px';
      x.fillStyle = L.subColor; x.textAlign = 'left'; x.fillText(L.sub, W / 2 - 70 + wText / 2 + 26, cy + 26);
    }
    x.restore();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function fenceTexture() { // one 4 m fence panel, 3.8 m high: fine diamond mesh between three rails
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const x = c.getContext('2d');
  x.strokeStyle = 'rgba(120,125,132,0.4)'; x.lineWidth = 1;
  for (let i = -512; i < 1024; i += 8) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 512, 512); x.stroke();
    x.beginPath(); x.moveTo(i, 512); x.lineTo(i + 512, 0); x.stroke();
  }
  for (const [y, h] of [[0, 9], [250, 7], [500, 12]]) { // rails: top, middle, bottom
    const g = x.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#d4d8dd'); g.addColorStop(0.5, '#9aa0a8'); g.addColorStop(1, '#6d737b');
    x.fillStyle = g; x.fillRect(0, y, 512, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

// Pick a livery for each stretch: the tyre supplier's yellow most often.
function liveryWeights() {
  const total = LIVERIES.reduce((a, L) => a + L.weight, 0);
  let acc = 0;
  return LIVERIES.map((L) => (acc += L.weight / total));
}

// ---------- materials, made once ----------
let MATS = null;
function materials() {
  if (MATS) return MATS;
  const concrete = concreteTextures(), atlas = liveryAtlas(), B = BARRIER;
  const cum = liveryWeights(), shared = { tLivery: { value: atlas }, uBare: { value: 0 } };
  // The side you see: the sponsor's wrap (or bare concrete), with a little grime and the odd tyre scuff.
  const face = new THREE.MeshStandardMaterial({ map: concrete.map, normalMap: concrete.normalMap, roughness: 0.9, normalScale: new THREE.Vector2(0.8, 0.8) });
  face.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vWall;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = uv;'); // metres along, metres up and over the top
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        uniform sampler2D tLivery;
        uniform float uBare;
        varying vec2 vWall;
        float gWrap;
        float hash1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }`)
      .replace('#include <map_fragment>', `
        float tu = fract(vWall.x / ${B.block.toFixed(1)});
        vec2 cuv = vec2(tu, clamp(vWall.y / ${H.toFixed(2)}, 0.0, 1.0));
        vec4 conc = texture2D(map, cuv);
        float run = floor(vWall.x / ${B.block.toFixed(1)} / ${(B.run / B.block).toFixed(1)});
        float pick = hash1(run * 7.13 + 2.0);
        float idx = ${cum.slice(0, -1).map((c) => `step(${c.toFixed(4)}, pick)`).join(' + ')};
        float lv = clamp(vWall.y / 1.05, 0.0, 1.0);                  // up the face; the top edge colour carries on over the top
        vec2 luv = vec2((mod(idx, 2.0) + 0.004 + tu * 0.992) * 0.5, 1.0 - (floor(idx / 2.0) * 256.0 + 8.0 + (1.0 - lv) * 240.0) / 1024.0);
        vec4 liv = texture2D(tLivery, luv);
        liv.rgb *= mix(vec3(1.0), conc.rgb / 0.66, 0.35);            // grime, scuffs and the seams between sections
        gWrap = 1.0 - step(hash1(run * 1.37 + 0.5), uBare);
        diffuseColor *= mix(conc, liv, gWrap);`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.5, gWrap);')
      .replace('#include <normal_fragment_maps>', `
        vec3 mapN = texture2D(normalMap, cuv).xyz * 2.0 - 1.0;
        mapN.xy *= normalScale * (1.0 - 0.7 * gWrap);
        normal = normalize(tbn * mapN);`);
  };
  face.customProgramCacheKey = () => 'apex-barrier-wrap';
  const back = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.85 }); // the back: plain dark covers
  MATS = {
    face: withLightPools(face), back: withLightPools(back), shared,
    fence: new THREE.MeshStandardMaterial({ map: fenceTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.45, metalness: 0.6 }),
    post: new THREE.MeshStandardMaterial({ color: 0xb4b9bf, metalness: 0.65, roughness: 0.4 }),
    // galvanised steel guardrail (forest stretches)
    armco: withLightPools(new THREE.MeshStandardMaterial({ color: 0xb2b7bc, metalness: 0.6, roughness: 0.42, side: THREE.DoubleSide })),
    armcoPost: withLightPools(new THREE.MeshStandardMaterial({ color: 0x8a8f95, metalness: 0.5, roughness: 0.55 })),
  };
  return MATS;
}

// ---------- geometry ----------
// The barrier along one side. off(i) = lateral position of the wall line (positive = left of the track).
// Two smooth-shaded skins: the wrapped face (group 0) and the back (group 1).
// include (optional): the samples it runs past; where a run stops (the pit lane) its end is closed off.
// shift: added to the distance along, so a separate run gets its own sponsors.
function barrierGeometry(track, off, include = null, shift = 0) {
  const { n, ds } = track, B = BARRIER, pos = [], uv = [], idx = [], g = new THREE.BufferGeometry();
  const seg = (k) => !include || !!(include[k % n] && include[(k + 1) % n]); // barrier from sample k to k + 1?
  const used = (k) => (k < n && seg(k)) || (k > 0 && seg(k - 1));
  const point = (i, o, sgn, p) => {
    const lat = o + sgn * p[0];
    const y = p[1] < 0 ? p[1] + hAt(track, i, 0) : p[1] + hAt(track, i, lat); // the foot reaches the ground on banking
    return [track.cx[i] + track.nx[i] * lat, y, track.cz[i] + track.nz[i] * lat];
  };
  const skin = (P, wrapped) => {
    const C = P.length, row = new Int32Array(n + 1).fill(-1);
    const len = [0]; for (let j = 1; j < C; j++) len.push(len[j - 1] + Math.hypot(P[j][0] - P[j - 1][0], Math.max(0, P[j][1]) - Math.max(0, P[j - 1][1])));
    for (let k = 0; k <= n; k++) {
      if (!used(k)) continue;
      row[k] = pos.length / 3;
      const i = k % n, o = off(i), sgn = Math.sign(o) || 1, along = k * ds + shift;
      for (let j = 0; j < C; j++) {
        pos.push(...point(i, o, sgn, P[j]));
        // wrapped face: U runs left-to-right as you look at it from the track (so logos read properly), V = metres up
        uv.push(wrapped ? (sgn > 0 ? along : -along) : along / B.block, wrapped ? len[j] : len[j] / H);
      }
    }
    const start = idx.length;
    for (let k = 0; k < n; k++) {
      if (!seg(k)) continue;
      for (let j = 0; j < C - 1; j++) {
        const a = row[k] + j, b = a + 1, c = row[k + 1] + j, d = c + 1;
        if (Math.sign(off(k)) > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c); // faces point out
      }
    }
    g.addGroup(start, idx.length - start, wrapped ? 0 : 1);
  };
  skin(FACE, true);
  skin(BACK, false);
  if (include) { // close the ends of each run with a plain cap (both ways round, so it shows from either side)
    const start = idx.length, P = [...FACE, ...BACK.slice(1)];
    const cap = (i) => {
      const o = off(i), sgn = Math.sign(o) || 1;
      for (const flip of [false, true]) {
        const base = pos.length / 3;
        for (const p of P) { pos.push(...point(i, o, sgn, p)); uv.push(0, 0); }
        for (let j = 1; j < P.length - 1; j++) flip ? idx.push(base, base + j + 1, base + j) : idx.push(base, base + j, base + j + 1);
      }
    };
    for (let k = 0; k < n; k++) {
      if (!seg(k)) continue;
      if (!seg((k + n - 1) % n)) cap(k);
      if (!seg((k + 1) % n)) cap((k + 1) % n);
    }
    if (idx.length > start) g.addGroup(start, idx.length - start, 1);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// The debris fence: straight up from the ground just behind the barrier (include: as above).
function fenceGeometry(track, at, include = null) {
  const { n, ds } = track, B = BARRIER, pos = [], uv = [], idx = [], row = new Int32Array(n + 1).fill(-1);
  const seg = (k) => !include || !!(include[k % n] && include[(k + 1) % n]);
  for (let k = 0; k <= n; k++) {
    if (!((k < n && seg(k)) || (k > 0 && seg(k - 1)))) continue;
    row[k] = pos.length / 3;
    const i = k % n, lat = at(i), y = hAt(track, i, lat);
    pos.push(track.cx[i] + track.nx[i] * lat, y - 0.1, track.cz[i] + track.nz[i] * lat);
    pos.push(track.cx[i] + track.nx[i] * lat, y + B.fence, track.cz[i] + track.nz[i] * lat);
    uv.push((k * ds) / B.block, 0, (k * ds) / B.block, 1);
  }
  for (let k = 0; k < n; k++) { if (!seg(k)) continue; const a = row[k], c = row[k + 1]; idx.push(a, c, a + 1, a + 1, c, c + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// The guardrail along one side of samples c0..c1 where the track runs through the woods (track.forest):
// both beams, each a strip with the W profile, at the barrier line.
function armcoGeometry(track, side, c0, c1) {
  const { n } = track, W = side > 0 ? track.wallL : track.wallR, C = BEAM.length, pos = [], idx = [], rows = new Map();
  const on = (k) => track.forest[k % n] && track.forest[(k + 1) % n];          // a beam from sample k to k + 1?
  const row = (k) => {                                                           // vertices across both beams at sample k
    if (rows.has(k)) return rows.get(k);
    const i = k % n, base = pos.length / 3, face = W[i], y = hAt(track, i, side * face);
    for (const b of ARMCO.beams) for (const [back, up] of BEAM) {
      const lat = side * (face + back);
      pos.push(track.cx[i] + track.nx[i] * lat, y + b + up, track.cz[i] + track.nz[i] * lat);
    }
    rows.set(k, base);
    return base;
  };
  for (let k = c0; k < c1; k++) {
    if (!on(k)) continue;
    const a = row(k), c = row(k + 1);
    for (let b = 0; b < ARMCO.beams.length; b++) for (let j = 0; j < C - 1; j++) {
      const v0 = a + b * C + j, v1 = v0 + 1, w0 = c + b * C + j, w1 = w0 + 1;
      if (side > 0) idx.push(v0, w0, v1, v1, w0, w1); else idx.push(v0, v1, w0, v1, w1, w0); // fronts face the track
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}

// Guardrail through the woods, in pieces of ARMCO.chunk metres (each drawn only near the camera: scenery.js).
function buildArmco(track, M, group) {
  const { n, ds } = track, CH = Math.max(1, Math.round(ARMCO.chunk / ds)), cull = { from: 0, to: ARMCO.draw };
  const top = ARMCO.beams[ARMCO.beams.length - 1] + 0.33, postGeo = new THREE.BoxGeometry(0.11, top + 0.3, 0.11).translate(0, (top + 0.3) / 2, 0);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  for (let c0 = 0; c0 < n; c0 += CH) for (const side of [1, -1]) {
    const c1 = Math.min(n, c0 + CH), geo = armcoGeometry(track, side, c0, c1);
    if (!geo) continue;
    const rail = new THREE.Mesh(geo, M.armco);
    rail.castShadow = true; rail.receiveShadow = true; rail.userData.cull = cull; rail.visible = false;
    group.add(rail);
    const W = side > 0 ? track.wallL : track.wallR, at = [];
    for (let i = c0; i < c1; i++) {
      if (!track.forest[i] || Math.floor((i * ds) / ARMCO.post) === Math.floor(((i - 1) * ds) / ARMCO.post)) continue;
      const lat = side * (W[i] + 0.16);                                            // just behind the beams
      at.push([track.cx[i] + track.nx[i] * lat, hAt(track, i, side * W[i]) - 0.3, track.cz[i] + track.nz[i] * lat, Math.atan2(track.tx[i], track.tz[i])]);
    }
    if (!at.length) continue;
    const posts = new THREE.InstancedMesh(postGeo, M.armcoPost, at.length);
    at.forEach(([x, y, z, h], k) => posts.setMatrixAt(k, m.compose(v.set(x, y, z), q.setFromAxisAngle(up, h), one)));
    posts.receiveShadow = true; posts.computeBoundingSphere(); posts.userData.cull = cull; posts.visible = false;
    group.add(posts);
  }
}

export function buildBarriers(track) {
  const M = materials(), B = BARRIER, group = new THREE.Group(), n = track.n, lane = track.pitLane;
  M.shared.uBare.value = B.bare[track.barrier] ?? 0;
  // Runs of barrier: [wall line (signed, metres from the centreline), the samples it runs past (null = the
  // whole lap), shift (its own sponsors)]. Along the pit lane (pitlane.js) the barrier on that side gives way
  // to the pit wall between the track and the lane, and a barrier along the far side of the lane (none in
  // front of the garages); that one reaches a sample further each end, to meet the barrier it carries on from.
  // Through the woods (track.forest) the guardrail takes over (buildArmco).
  const runs = [], forest = track.forest?.some((v) => v) ? track.forest : null;
  for (const side of [1, -1]) {
    const W = side > 0 ? track.wallL : track.wallR;
    let include = lane && lane.side === side ? lane.range.map((v) => 1 - v) : null;
    if (forest) include = (include ?? new Uint8Array(n).fill(1)).map((v, i) => (v && !forest[i] ? 1 : 0));
    runs.push([(i) => side * W[i], include, 0]);
  }
  if (lane) {
    const s = lane.side, W = s > 0 ? track.wallL : track.wallR;
    const grown = lane.range.map((v, i) => (v || lane.range[(i + 1) % n] || lane.range[(i + n - 1) % n] ? 1 : 0));
    runs.push([(i) => s * (lane.wall[i] || W[i]), lane.wall.map((v) => (v > 0 ? 1 : 0)), 3000]);
    runs.push([(i) => s * (lane.outer[i] || W[i]), grown.map((v, i) => (v && !lane.building[i] ? 1 : 0)), 6000]);
  }
  const posts = [];
  for (const [off, include, shift] of runs) {
    const wall = new THREE.Mesh(barrierGeometry(track, off, include, shift), [M.face, M.back]);
    wall.castShadow = true; wall.receiveShadow = true;
    group.add(wall);
    const fenceAt = (i) => off(i) + (Math.sign(off(i)) || 1) * (B.depth + B.fenceGap);
    group.add(new THREE.Mesh(fenceGeometry(track, fenceAt, include), M.fence));
    for (let i = 0; i < n; i++) { // a post every 4 m
      if (include && !include[i]) continue;
      if (Math.floor((i * track.ds) / B.block) === Math.floor(((i - 1) * track.ds) / B.block)) continue;
      const lat = fenceAt(i) + (Math.sign(off(i)) || 1) * 0.07;
      posts.push([track.cx[i] + track.nx[i] * lat, hAt(track, i, lat) - 0.1, track.cz[i] + track.nz[i] * lat]);
    }
  }
  if (posts.length) {
    const geo = new THREE.CylinderGeometry(0.05, 0.06, B.fence + 0.25, 8).translate(0, (B.fence + 0.25) / 2, 0);
    const mesh = new THREE.InstancedMesh(geo, M.post, posts.length), m = new THREE.Matrix4();
    posts.forEach(([x, y, z], k) => mesh.setMatrixAt(k, m.makeTranslation(x, y, z)));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere();
    group.add(mesh);
  }
  if (forest) buildArmco(track, M, group);
  return group;
}