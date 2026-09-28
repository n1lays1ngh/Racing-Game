// Everything you see that isn't a car.
//   buildWorld()   – sky, sun, lights, ground: built once.
//   buildCircuit() – tarmac, kerbs, gravel, barriers, fences, start gantry,
//                    grandstands, pit buildings and trees for one circuit.
//                    Rebuilt whenever you pick a different track.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sampleAt, SURFACES } from './track.js';
import { buildTerrain } from './terrain.js';
import { bankLift } from './banking.js';
import { TIMES, buildFloodlights, darkenAwayFromTrack } from './lighting.js';
import { GRAPHICS } from './settings.js';

// ---------- procedural canvas textures (made once, shared by all circuits) ----------
function canvasTexture(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function noise(ctx, w, h, base, spread, count, size = 1) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const v = (Math.random() - 0.5) * spread;
    ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v)})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
}

let MATS = null;
function materials() {
  if (MATS) return MATS;
  const asphalt = canvasTexture(256, 512, (x, w, h) => {
    noise(x, w, h, '#3a3b3e', 0.16, 26000, 2);
    x.fillStyle = '#f2f2f2'; // white edge lines
    x.fillRect(0, 0, 7, h); x.fillRect(w - 7, 0, 7, h);
    x.fillStyle = 'rgba(0,0,0,0.12)'; // darker racing-line rubber in the middle
    x.fillRect(w * 0.3, 0, w * 0.4, h);
  });
  const kerb = canvasTexture(64, 128, (x, w, h) => {
    x.fillStyle = '#d61f1f'; x.fillRect(0, 0, w, h / 2);
    x.fillStyle = '#f4f4f4'; x.fillRect(0, h / 2, w, h / 2);
  });
  const grass = canvasTexture(512, 512, (x, w, h) => {
    noise(x, w, h, '#4f7a32', 0.18, 60000, 2);
    for (let i = 0; i < 8; i++) { // mowing stripes
      x.fillStyle = i % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.035)';
      x.fillRect(0, (i * h) / 8, w, h / 8);
    }
  });
  const gravel = canvasTexture(256, 256, (x, w, h) => noise(x, w, h, '#b9a888', 0.35, 30000, 2));
  const wall = canvasTexture(512, 64, (x, w, h) => {
    const cols = ['#1d3fbf', '#f2f2f2', '#d61f1f', '#f2f2f2'];
    for (let i = 0; i < 4; i++) { x.fillStyle = cols[i]; x.fillRect((i * w) / 4, 0, w / 4, h); }
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.font = 'bold 34px system-ui, sans-serif'; x.textBaseline = 'middle';
    x.fillText('APEX', 20, h / 2 + 2); x.fillText('CIRCUIT', w / 2 + 14, h / 2 + 2);
  });
  const fence = canvasTexture(64, 64, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    x.strokeStyle = 'rgba(40,44,50,0.9)'; x.lineWidth = 2;
    for (let i = 0; i <= 64; i += 8) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i - 32, h); x.stroke(); x.beginPath(); x.moveTo(i - 32, 0); x.lineTo(i, h); x.stroke(); }
    x.fillStyle = '#2a2d33'; x.fillRect(0, 0, 3, h); // post
  });
  const checker = canvasTexture(128, 32, (x, w, h) => {
    const s = 8;
    for (let i = 0; i < w / s; i++) for (let j = 0; j < h / s; j++) {
      x.fillStyle = (i + j) % 2 ? '#111' : '#f5f5f5'; x.fillRect(i * s, j * s, s, s);
    }
  }, false);
  const crowd = canvasTexture(256, 64, (x, w, h) => {
    x.fillStyle = '#3b3f47'; x.fillRect(0, 0, w, h);
    const shirts = ['#e10600', '#ffffff', '#1e41ff', '#ff8000', '#ffd400', '#00a19b', '#111111', '#e8e8e8', '#6b2fb3'];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 64; c++) {
      if (Math.random() < 0.15) continue; // empty seat
      const px = c * 4 + Math.random(), py = r * 16 + 5;
      x.fillStyle = shirts[(Math.random() * shirts.length) | 0]; x.fillRect(px, py + 3, 3, 6);
      x.fillStyle = ['#f1c9a5', '#c68e62', '#8d5a3b', '#3d2a1e'][(Math.random() * 4) | 0]; x.fillRect(px + 0.5, py, 2, 3);
    }
  });
  const garage = canvasTexture(256, 128, (x, w, h) => {
    x.fillStyle = '#e4e7eb'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#20242b'; for (let i = 0; i < 4; i++) x.fillRect(8 + i * 62, 60, 50, 68); // garage doors
    x.fillStyle = '#6fa8dc'; x.fillRect(0, 14, w, 26);                                   // windows
    x.fillStyle = 'rgba(255,255,255,0.35)'; for (let i = 0; i < w; i += 16) x.fillRect(i, 14, 2, 26);
  });

  const tarmacPlain = canvasTexture(256, 256, (x, w, h) => noise(x, w, h, '#4a4c50', 0.14, 20000, 2));
  const concreteWall = canvasTexture(512, 64, (x, w, h) => {
    noise(x, w, h, '#c9ccd0', 0.12, 6000, 2);                       // concrete blocks
    x.fillStyle = 'rgba(0,0,0,0.25)'; for (let i = 0; i < w; i += 64) x.fillRect(i, 0, 2, h); // block joints
    x.fillStyle = '#1d3fbf'; x.fillRect(320, 10, 150, 44);            // one sponsor board per few blocks
    x.fillStyle = '#fff'; x.font = 'bold 28px system-ui, sans-serif'; x.textBaseline = 'middle'; x.fillText('APEX', 358, 33);
  });
  const sand = canvasTexture(512, 512, (x, w, h) => noise(x, w, h, '#cdb58a', 0.16, 50000, 2));
  const city = canvasTexture(512, 512, (x, w, h) => {
    noise(x, w, h, '#8d9096', 0.12, 40000, 2);
    x.strokeStyle = 'rgba(0,0,0,0.15)'; x.lineWidth = 2;               // paving slabs
    for (let i = 0; i <= w; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(w, i); x.stroke(); }
  });
  const lit = [];                                                     // which windows have the lights on at night
  const facade = canvasTexture(128, 256, (x, w, h) => {
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h);                  // tinted per building
    for (let r = 0; r < 20; r++) for (let c = 0; c < 8; c++) {
      x.fillStyle = Math.random() < 0.15 ? '#9fb3c8' : '#3b4656';      // windows (a few lit by the sky)
      x.fillRect(c * 16 + 3, r * 12.8 + 3, 10, 7);
      if (Math.random() < 0.4) lit.push([c * 16 + 3, r * 12.8 + 3]);
    }
  }, false);
  const windowsLit = canvasTexture(128, 256, (x, w, h) => {
    x.fillStyle = '#000000'; x.fillRect(0, 0, w, h);
    for (const [wx, wy] of lit) { x.fillStyle = ['#ffd9a0', '#fff1d0', '#cfe3ff'][(Math.random() * 3) | 0]; x.fillRect(wx, wy, 10, 7); }
  }, false);

  const std = (o) => new THREE.MeshStandardMaterial(o);
  MATS = {
    road: std({ map: asphalt, roughness: 0.92 }),
    kerb: std({ map: kerb, roughness: 0.7 }),
    grass: std({ map: grass, roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 }),
    runoff: std({ color: 0x6d8f47, roughness: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 }),
    runoffTarmac: std({ map: tarmacPlain, roughness: 0.95 }),
    wallConcrete: std({ map: concreteWall, roughness: 0.85, side: THREE.DoubleSide }),
    building: std({ map: facade, roughness: 0.75, metalness: 0.1, emissiveMap: windowsLit, emissive: 0xffffff, emissiveIntensity: 0 }),
    gravel: std({ map: gravel, roughness: 1 }),
    wall: std({ map: wall, roughness: 0.8, side: THREE.DoubleSide }),
    fence: std({ map: fence, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.8 }),
    checker: std({ map: checker, roughness: 0.8 }),
    steel: std({ color: 0x2a2d33, metalness: 0.7, roughness: 0.4 }),
    concrete: std({ color: 0xb4b8be, roughness: 0.85 }),
    crowd: std({ map: crowd, roughness: 0.9 }),
    roof: std({ color: 0xa9b1bb, metalness: 0.5, roughness: 0.45, side: THREE.DoubleSide }),
    garage: std({ map: garage, roughness: 0.6 }),
    trunk: std({ color: 0x5b3b22, roughness: 1 }),
    crown: std({ color: 0x2f5a2a, roughness: 0.9, flatShading: true }),
  };
  MATS.grass.map.repeat.set(400, 400);
  const terrainTex = MATS.grass.map.clone(); terrainTex.repeat.set(1, 1); terrainTex.needsUpdate = true;
  const ground = (map) => std({ map, roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
  MATS.terrains = { grass: ground(terrainTex), sand: ground(sand), city: ground(city) }; // scenery.ground
  return MATS;
}

// ---------- geometry helpers ----------
const at = (v, i) => (typeof v === 'function' ? v(i) : v);
// Road height at sample i and `lateral` metres from the centreline (hills + banking)
const hAt = (track, i, lateral = 0) => (track.h ? track.h[i] : 0) + bankLift(track, i, lateral);

// A strip following the track between two lateral offsets (numbers or per-sample functions).
function ribbon(track, inner, outer, y, vScale, include = null) {
  const pos = [], uv = [], idx = [];
  const n = track.n;
  let vert = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (include && !(include[i] || include[j])) continue;
    let ai = at(inner, i), bi = at(outer, i), aj = at(inner, j), bj = at(outer, j);
    let u0 = 0, u1 = 1;
    if (ai > bi) { [ai, bi, aj, bj] = [bi, ai, bj, aj]; [u0, u1] = [1, 0]; } // keep faces pointing up
    // follow the hills and banking
    pos.push(track.cx[i] + track.nx[i] * ai, y + hAt(track, i, ai), track.cz[i] + track.nz[i] * ai);
    pos.push(track.cx[i] + track.nx[i] * bi, y + hAt(track, i, bi), track.cz[i] + track.nz[i] * bi);
    pos.push(track.cx[j] + track.nx[j] * aj, y + hAt(track, j, aj), track.cz[j] + track.nz[j] * aj);
    pos.push(track.cx[j] + track.nx[j] * bj, y + hAt(track, j, bj), track.cz[j] + track.nz[j] * bj);
    const v0 = (i * track.ds) / vScale, v1 = ((i + 1) * track.ds) / vScale;
    uv.push(u0, v0, u1, v0, u0, v1, u1, v1);
    idx.push(vert, vert + 2, vert + 1, vert + 1, vert + 2, vert + 3);
    vert += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A vertical strip (barrier or fence) at a per-sample lateral offset.
// groundBottom: the bottom edge ignores banking, so barriers on a raised
// banked corner reach down to the ground like a retaining wall.
function wallStrip(track, offset, y0, y1, uScale, groundBottom = false) {
  const pos = [], uv = [], idx = [];
  const n = track.n;
  for (let i = 0; i <= n; i++) {
    const k = i % n, off = at(offset, k);
    const x = track.cx[k] + track.nx[k] * off, z = track.cz[k] + track.nz[k] * off;
    const yb = y0 + hAt(track, k, groundBottom ? 0 : off), yt = y1 + hAt(track, k, off);
    pos.push(x, yb, z, x, yt, z);
    const u = (i * track.ds) / uScale;
    uv.push(u, 1 - (yt - yb) / (y1 - y0), u, 1); // tall retaining walls repeat the boards instead of stretching them
    if (i < n) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// Box with its UVs stretched so a texture repeats every `tile` metres along X.
function box(w, h, d, tile = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tile) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (w / tile)); }
  return g;
}

function nearestTrack(track, x, z) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < track.n; i += 3) {
    const d = (x - track.cx[i]) ** 2 + (z - track.cz[i]) ** 2;
    if (d < best) { best = d; bi = i; }
  }
  return { d: Math.sqrt(best), i: bi };
}

// Local frame at sample i on one side: X along the track, Z away from the track.
function sideFrame(track, i, side, offset) {
  const dx = track.nx[i] * side, dz = track.nz[i] * side;
  const m = new THREE.Matrix4().makeRotationY(Math.atan2(dx, dz));
  m.setPosition(track.cx[i] + dx * offset, hAt(track, i, side * offset) - 0.7, track.cz[i] + dz * offset);
  return m;
}

// Is a building footprint (local X ±halfLen, Z 0..depth) clear of other parts of the circuit?
function footprintClear(track, m, halfLen, depth, i, minDist) {
  const p = new THREE.Vector3();
  for (const lx of [-halfLen, 0, halfLen]) for (const lz of [0, depth / 2, depth]) {
    p.set(lx, 0, lz).applyMatrix4(m);
    const near = nearestTrack(track, p.x, p.z);
    let di = Math.abs(near.i - i); di = Math.min(di, track.n - di);
    if (near.d < minDist && di * track.ds > 40) return false;
    if (near.d < track.hw[near.i] + track.kerb + 2) return false;
  }
  return true;
}

function mergedMesh(list, material, shadows = true) {
  if (!list.length) return null;
  const geos = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const mesh = new THREE.Mesh(mergeGeometries(geos), material);
  mesh.castShadow = shadows; mesh.receiveShadow = true;
  return mesh;
}

// ---------- once: sky, sun, ground ----------
export function buildWorld(scene, renderer) {
  const sky = new Sky();
  sky.scale.setScalar(5000);
  const u = sky.material.uniforms;
  u.turbidity.value = 3; u.rayleigh.value = 1.2; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.85;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(210));
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

  scene.fog = new THREE.Fog(0xbfd4e6, 300, 3200);
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4a5a30, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2de, 2.6);
  sun.castShadow = GRAPHICS.shadows;
  sun.shadow.mapSize.set(GRAPHICS.shadowMapSize, GRAPHICS.shadowMapSize);
  const sc = sun.shadow.camera; sc.left = sc.bottom = -45; sc.right = sc.top = 45; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // Environment map from the sky so cars get nice reflections.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); const envSky = new Sky(); envSky.scale.setScalar(1000);
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envSky.material.uniforms.showSunDisc.value = 0;
  envScene.add(envSky);
  scene.environment = pmrem.fromScene(envScene).texture;
  scene.environmentIntensity = 0.6;

  const M = materials();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000, 90, 90), M.grass);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -150; // hidden in the haze beyond each circuit's terrain
  ground.receiveShadow = true;
  scene.add(ground);

  return { sun, sunDir, sky, hemi, scene, renderer }; // lighting.js changes these for dusk and night races
}

// ---------- per circuit ----------
export function buildCircuit(track) {
  const M = materials();
  const group = new THREE.Group();
  const add = (mesh) => { if (mesh) group.add(mesh); return mesh; };
  const wallL = (i) => track.wallL[i], wallR = (i) => -track.wallR[i];
  const hwL = (i) => track.hw[i], hwR = (i) => -track.hw[i];   // tarmac edges (width can vary)
  const n = track.n;

  // Ground that follows the hills (grass, desert sand or city paving)
  const terrain = buildTerrain(track, M.terrains[track.scenery.ground] ?? M.terrains.grass);
  add(terrain.mesh);

  // Run-off between the tarmac and the barriers: grass, tarmac or gravel (from the circuit file)
  const looks = [[SURFACES.grass, M.runoff, 0.0, 20], [SURFACES.tarmac, M.runoffTarmac, 0.01, 12], [SURFACES.gravel, M.gravel, 0.02, 12]];
  for (const [code, mat, y, vScale] of looks) {
    for (const [surf, inner, outer] of [[track.surfL, hwL, wallL], [track.surfR, hwR, wallR]]) {
      const mask = surf.map((v) => (v === code ? 1 : 0));
      if (mask.some((v) => v)) add(new THREE.Mesh(ribbon(track, inner, outer, y, vScale, mask), mat)).receiveShadow = true;
    }
  }

  // Tarmac
  add(new THREE.Mesh(ribbon(track, hwR, hwL, 0.06, 24), M.road)).receiveShadow = true;

  // Kerbs where the track bends
  const bend = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (Math.abs(track.curv[i]) > 0.006) for (let d = -12; d <= 12; d++) bend[(i + d + n) % n] = 1;
  }
  for (const s of [-1, 1]) {
    add(new THREE.Mesh(ribbon(track, (i) => s * track.hw[i], (i) => s * (track.hw[i] + track.kerb), 0.08, 3.5, bend), M.kerb)).receiveShadow = true;
  }

  // Barriers (advertising boards or street-circuit concrete), and catch fences above them
  const barrier = track.barrier === 'concrete' ? M.wallConcrete : M.wall;
  for (const off of [wallL, wallR]) {
    const w = add(new THREE.Mesh(wallStrip(track, off, -0.9, 1.1, 16, true), barrier));
    w.castShadow = true; w.receiveShadow = true;
    add(new THREE.Mesh(wallStrip(track, off, 1.1, 3.6, 4), M.fence));
  }

  // Start/finish line and gantry with the five start lights
  const h0 = Math.atan2(track.tx[0], track.tz[0]);
  const hw0 = track.hw[0];
  const line = add(new THREE.Mesh(new THREE.PlaneGeometry(hw0 * 2, 1.6), M.checker));
  line.rotation.x = -Math.PI / 2; line.rotation.z = h0;
  line.position.set(track.cx[0], 0.09 + hAt(track, 0), track.cz[0]);

  const gantry = new THREE.Group();
  gantry.position.set(track.cx[0], hAt(track, 0), track.cz[0]);
  gantry.rotation.y = h0;
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), M.steel);
    post.position.set(s * (hw0 + 2.5), 3.75, 0); post.castShadow = true; gantry.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(hw0 * 2 + 5.5, 1.2, 0.6), M.steel);
  beam.position.y = 7; beam.castShadow = true; gantry.add(beam);
  const lights = [];
  for (let i = 0; i < 5; i++) {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.8, 0.4), new THREE.MeshStandardMaterial({ color: 0x0b0b0b }));
    housing.position.set((i - 2) * 1.2, 5.6, -0.35); gantry.add(housing);
    for (const dy of [0.4, -0.4]) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1010, emissiveIntensity: 0 });
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.28, 20), mat);
      lamp.position.set((i - 2) * 1.2, 5.6 + dy, -0.56); lamp.rotation.y = Math.PI; gantry.add(lamp);
      lights.push({ index: i, mat });
    }
  }
  group.add(gantry);

  // Grandstands at their real corners (positions in the circuit file), curving with the track
  const crowdG = [], concreteG = [], roofG = [];
  const blocked = []; // keep trees away from buildings
  for (const st of track.stands) {
    const chunks = Math.max(1, Math.round(st.len / 12));
    const clen = st.len / chunks;
    const rows = st.len >= 100 ? 9 : 6;
    for (let c = 0; c < chunks; c++) {
      const i = sampleAt(track, st.s - st.len / 2 + (c + 0.5) * clen);
      const wall = st.side > 0 ? track.wallL[i] : track.wallR[i];
      const m = sideFrame(track, i, st.side, wall + 3);
      const depth = rows * 1.5 + 1;
      if (!footprintClear(track, m, clen / 2, depth, i, wall + 4)) continue;
      for (let r = 0; r < rows; r++) {
        const h = 0.6 + r * 0.75;
        const g = box(clen + 0.4, h, 1.5, 4); g.translate(0, h / 2, r * 1.5 + 0.75); g.applyMatrix4(m); crowdG.push(g);
      }
      const back = box(clen + 0.4, rows * 0.75 + 3.5, 0.6); back.translate(0, (rows * 0.75 + 3.5) / 2, rows * 1.5 + 0.3); back.applyMatrix4(m); concreteG.push(back);
      if (st.len >= 70) {
        const roof = box(clen + 0.4, 0.25, rows * 1.5 + 2); roof.rotateX(-0.08);
        roof.translate(0, rows * 0.75 + 4, (rows * 1.5) / 2); roof.applyMatrix4(m); roofG.push(roof);
        for (const lx of [-clen / 2, clen / 2]) {
          const col = box(0.3, rows * 0.75 + 4, 0.3); col.translate(lx, (rows * 0.75 + 4) / 2, rows * 1.5 + 0.2); col.applyMatrix4(m); concreteG.push(col);
        }
      }
      const e = new THREE.Vector3(0, 0, depth / 2).applyMatrix4(m); blocked.push([e.x, e.z, clen + depth]);
      // On a raised banked corner, stand the grandstand on a concrete base
      const lift = e.y - terrain.heightAt(e.x, e.z);
      if (lift > 0.6) { const base = box(clen + 0.4, lift + 0.5, depth); base.translate(0, -(lift + 0.5) / 2 + 0.2, depth / 2); base.applyMatrix4(m); concreteG.push(base); }
    }
  }

  // Pit buildings on the infield side
  const garageG = [];
  for (const pit of track.pits) {
    const chunks = Math.max(1, Math.round(pit.len / 14)), clen = pit.len / chunks;
    for (let c = 0; c < chunks; c++) {
      const i = sampleAt(track, pit.s + (c + 0.5) * clen);
      const wall = track.infield > 0 ? track.wallL[i] : track.wallR[i];
      const m = sideFrame(track, i, track.infield, wall + 6);
      if (!footprintClear(track, m, clen / 2, 18, i, wall + 6)) continue;
      const b = box(clen + 0.3, 9, 18, 14); b.translate(0, 4.5, 9); b.applyMatrix4(m); garageG.push(b);
      const roof = box(clen + 0.3, 0.4, 22); roof.translate(0, 9.2, 8); roof.applyMatrix4(m); roofG.push(roof);
      const e = new THREE.Vector3(0, 0, 9).applyMatrix4(m); blocked.push([e.x, e.z, clen + 20]);
    }
  }
  add(mergedMesh(crowdG, M.crowd));
  add(mergedMesh(concreteG, M.concrete));
  add(mergedMesh(roofG, M.roof));
  add(mergedMesh(garageG, M.garage));

  // Trees (instanced: hundreds for the cost of two draw calls)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, track.cx[i]); maxX = Math.max(maxX, track.cx[i]);
    minZ = Math.min(minZ, track.cz[i]); maxZ = Math.max(maxZ, track.cz[i]);
  }
  const TREES = Math.round((track.scenery.trees ?? 350) * GRAPHICS.trees);   // GRAPHICS in settings.js
  const clearOfTrack = (x, z, extra) => { // beyond the barriers by `extra` metres?
    const near = nearestTrack(track, x, z);
    return near.d > Math.max(track.wallL[near.i], track.wallR[near.i]) + extra;
  };
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 3, 6), M.trunk, TREES);
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 7, 7), M.crown, TREES);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  const col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  let placed = 0, tries = 0;
  while (placed < TREES && tries < TREES * 30) {
    tries++;
    const x = minX - 250 + Math.random() * (maxX - minX + 500);
    const z = minZ - 250 + Math.random() * (maxZ - minZ + 500);
    if (!clearOfTrack(x, z, 10)) continue;
    if (blocked.some(([bx, bz, r]) => (x - bx) ** 2 + (z - bz) ** 2 < r * r)) continue;
    const s = 0.7 + Math.random() * 0.9;
    q.setFromAxisAngle(up, Math.random() * Math.PI);
    const gy = terrain.heightAt(x, z);
    mtx.compose(pv.set(x, gy + 1.5 * s, z), q, sv.set(s, s, s)); trunks.setMatrixAt(placed, mtx);
    mtx.compose(pv.set(x, gy + 6.2 * s, z), q, sv.set(s, s, s)); crowns.setMatrixAt(placed, mtx);
    crowns.setColorAt(placed, col.setHSL(0.26 + Math.random() * 0.08, 0.45, 0.2 + Math.random() * 0.12));
    placed++;
  }
  trunks.count = crowns.count = placed;
  group.add(trunks, crowns);

  // City buildings for street circuits (instanced boxes, tinted, lined up with the nearest street)
  const BUILDINGS = Math.round((track.scenery.buildings ?? 0) * GRAPHICS.buildings);
  if (BUILDINGS > 0) {
    const unit = new THREE.BoxGeometry(1, 1, 1); unit.translate(0, 0.5, 0);
    const blocks = new THREE.InstancedMesh(unit, M.building, BUILDINGS);
    blocks.castShadow = true; blocks.receiveShadow = true;
    const tints = [0xe6e0d2, 0xd4d8de, 0xc9b9a0, 0xa9b4c2, 0x8f9aa6, 0x7d9ab8, 0xefe9dc, 0xb7a58c];
    const tall = track.scenery.ground === 'city' ? 70 : 25;
    let built = 0; tries = 0;
    while (built < BUILDINGS && tries < BUILDINGS * 40) {
      tries++;
      const x = minX - 400 + Math.random() * (maxX - minX + 800);
      const z = minZ - 400 + Math.random() * (maxZ - minZ + 800);
      const w = 14 + Math.random() * 26, d = 14 + Math.random() * 26;
      if (!clearOfTrack(x, z, 6 + Math.max(w, d) * 0.6)) continue;
      if (blocked.some(([bx, bz, r]) => (x - bx) ** 2 + (z - bz) ** 2 < (r + w) * (r + w))) continue;
      const near = nearestTrack(track, x, z);
      const h = 10 + Math.random() ** 2 * tall;
      q.setFromAxisAngle(up, Math.atan2(track.tx[near.i], track.tz[near.i]));
      mtx.compose(pv.set(x, terrain.heightAt(x, z) - 1, z), q, sv.set(w, h, d));
      blocks.setMatrixAt(built, mtx);
      blocks.setColorAt(built, col.setHex(tints[(Math.random() * tints.length) | 0]));
      blocked.push([x, z, Math.max(w, d) * 0.6]);
      built++;
    }
    blocks.count = built;
    group.add(blocks);
    if (track.time === 'night') darkenAwayFromTrack(track, [blocks], 20, 120, 0.3); // lit mostly by their windows
  }

  // Dusk and night races: floodlights, lit windows, and dark surroundings away from the track (lighting.js)
  M.building.emissiveIntensity = (TIMES[track.time] ?? TIMES.day).windows;
  if (track.time === 'dusk' || track.time === 'night') add(buildFloodlights(track, terrain.heightAt));
  if (track.time === 'night') darkenAwayFromTrack(track, [terrain.mesh, trunks, crowns]);

  return { group, lights };
}

// Free GPU memory when switching circuits (materials/textures are shared, so keep them).
export function disposeCircuit(circuit) {
  circuit.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of o.userData.ownMaterials ?? []) m.dispose(); // per-circuit copies (night lighting)
  });
  circuit.group.removeFromParent();
}
