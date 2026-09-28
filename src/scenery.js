// Everything you see that isn't a car: sky, light, ground, the circuit
// surface, kerbs, barriers, start gantry, grandstands, trees, hills.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { HALF_WIDTH, KERB_WIDTH, WALL_OFFSET } from './track.js';

// ---------- procedural canvas textures ----------
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

const asphaltTex = () => canvasTexture(256, 512, (x, w, h) => {
  noise(x, w, h, '#3a3b3e', 0.16, 26000, 2);
  x.fillStyle = '#f2f2f2'; // white edge lines
  x.fillRect(0, 0, 7, h); x.fillRect(w - 7, 0, 7, h);
  x.fillStyle = 'rgba(0,0,0,0.12)'; // darker racing-line rubber in the middle
  x.fillRect(w * 0.3, 0, w * 0.4, h);
});

const kerbTex = () => canvasTexture(64, 128, (x, w, h) => {
  x.fillStyle = '#d61f1f'; x.fillRect(0, 0, w, h / 2);
  x.fillStyle = '#f4f4f4'; x.fillRect(0, h / 2, w, h / 2);
});

const grassTex = () => canvasTexture(512, 512, (x, w, h) => {
  noise(x, w, h, '#4f7a32', 0.18, 60000, 2);
  for (let i = 0; i < 8; i++) { // mowing stripes
    x.fillStyle = i % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.035)';
    x.fillRect(0, (i * h) / 8, w, h / 8);
  }
});

const wallTex = () => canvasTexture(512, 64, (x, w, h) => {
  const cols = ['#1d3fbf', '#f2f2f2', '#d61f1f', '#f2f2f2'];
  for (let i = 0; i < 4; i++) { x.fillStyle = cols[i]; x.fillRect((i * w) / 4, 0, w / 4, h); }
  x.fillStyle = 'rgba(0,0,0,0.25)'; x.font = 'bold 34px system-ui, sans-serif'; x.textBaseline = 'middle';
  x.fillText('APEX', 20, h / 2 + 2); x.fillText('CIRCUIT', w / 2 + 14, h / 2 + 2);
});

const checkerTex = () => canvasTexture(128, 32, (x, w, h) => {
  const s = 8;
  for (let i = 0; i < w / s; i++) for (let j = 0; j < h / s; j++) {
    x.fillStyle = (i + j) % 2 ? '#111' : '#f5f5f5'; x.fillRect(i * s, j * s, s, s);
  }
}, false);

// ---------- ribbon helper: a strip following the track between two offsets ----------
function ribbon(track, inner, outer, y, vScale, include = null, uRange = [0, 1]) {
  if (inner > outer) { [inner, outer] = [outer, inner]; uRange = [uRange[1], uRange[0]]; } // keep faces pointing up
  const pos = [], uv = [], idx = [];
  const n = track.n;
  let vert = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (include && !(include[i] && include[j])) continue;
    const quad = [[i, inner], [i, outer], [j, inner], [j, outer]];
    for (const [k, off] of quad) {
      pos.push(track.cx[k] + track.nx[k] * off, y, track.cz[k] + track.nz[k] * off);
    }
    const v0 = (i * track.ds) / vScale, v1 = ((i + 1) * track.ds) / vScale;
    uv.push(uRange[0], v0, uRange[1], v0, uRange[0], v1, uRange[1], v1);
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

function wallGeometry(track, offset, height) {
  const pos = [], uv = [], idx = [];
  const n = track.n;
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    const x = track.cx[k] + track.nx[k] * offset, z = track.cz[k] + track.nz[k] * offset;
    pos.push(x, 0, z, x, height, z);
    const v = (i * track.ds) / 16;
    uv.push(v, 0, v, 1);
    if (i < n) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// Minimum distance from (x,z) to the centreline (coarse, for placing props).
function distToTrack(track, x, z) {
  let best = Infinity;
  for (let i = 0; i < track.n; i += 3) {
    const d = (x - track.cx[i]) ** 2 + (z - track.cz[i]) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

export function buildScenery(scene, renderer, track) {
  // ----- sky + sun -----
  const sky = new Sky();
  sky.scale.setScalar(5000);
  const u = sky.material.uniforms;
  u.turbidity.value = 3; u.rayleigh.value = 1.2; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.85;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(210));
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

  scene.fog = new THREE.Fog(0xbfd4e6, 250, 2600);
  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x4a5a30, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2de, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
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

  // ----- ground -----
  const gt = grassTex(); gt.repeat.set(400, 400);
  // Subdivided + polygonOffset so the huge plane never z-fights with the road.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000, 80, 80),
    new THREE.MeshStandardMaterial({ map: gt, roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.3; ground.receiveShadow = true;
  scene.add(ground);

  // ----- run-off (lighter strip between kerb and wall) -----
  const runoffMat = new THREE.MeshStandardMaterial({ color: 0x6d8f47, roughness: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
  for (const s of [-1, 1]) {
    const g = ribbon(track, s * HALF_WIDTH, s * WALL_OFFSET, 0.0, 20);
    const m = new THREE.Mesh(g, runoffMat); m.receiveShadow = true; scene.add(m);
  }

  // ----- tarmac -----
  const at = asphaltTex();
  const road = new THREE.Mesh(ribbon(track, -HALF_WIDTH, HALF_WIDTH, 0.06, 24),
    new THREE.MeshStandardMaterial({ map: at, roughness: 0.92, metalness: 0.0 }));
  road.receiveShadow = true; scene.add(road);

  // ----- kerbs only where the track bends -----
  const bend = new Uint8Array(track.n);
  for (let i = 0; i < track.n; i++) if (Math.abs(track.curv[i]) > 0.006) {
    for (let k = -12; k <= 12; k++) bend[(i + k + track.n) % track.n] = 1;
  }
  const kt = kerbTex();
  const kerbMat = new THREE.MeshStandardMaterial({ map: kt, roughness: 0.7 });
  for (const s of [-1, 1]) {
    const g = ribbon(track, s * HALF_WIDTH, s * (HALF_WIDTH + KERB_WIDTH), 0.08, 3.5, bend);
    const m = new THREE.Mesh(g, kerbMat); m.receiveShadow = true; scene.add(m);
  }

  // ----- barriers -----
  const wt = wallTex();
  const wallMat = new THREE.MeshStandardMaterial({ map: wt, roughness: 0.8, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(wallGeometry(track, s * WALL_OFFSET, 1.1), wallMat);
    w.castShadow = true; w.receiveShadow = true; scene.add(w);
  }

  // ----- start/finish line + gantry with start lights -----
  const startLine = new THREE.Mesh(new THREE.PlaneGeometry(HALF_WIDTH * 2, 1.6),
    new THREE.MeshStandardMaterial({ map: checkerTex(), roughness: 0.8 }));
  startLine.rotation.x = -Math.PI / 2;
  startLine.rotation.z = Math.atan2(track.tx[0], track.tz[0]);
  startLine.position.set(track.cx[0], 0.09, track.cz[0]);
  scene.add(startLine);

  const gantry = new THREE.Group();
  gantry.position.set(track.cx[0], 0, track.cz[0]);
  gantry.rotation.y = Math.atan2(track.tx[0], track.tz[0]);
  const steel = new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.7, roughness: 0.4 });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), steel);
    post.position.set(s * (HALF_WIDTH + 2.5), 3.75, 0); post.castShadow = true; gantry.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(HALF_WIDTH * 2 + 5.5, 1.2, 0.6), steel);
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
  scene.add(gantry);

  // ----- grandstands along the main straight (driver's right) -----
  const standMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.8 });
  const seatCols = [0xd61f1f, 0x1d3fbf, 0xf2f2f2, 0xffc400];
  for (let k = 0; k < 4; k++) {
    const s = 30 + k * 60;
    const i = Math.round(s / track.ds);
    const stand = new THREE.Group();
    const off = -(WALL_OFFSET + 9);
    stand.position.set(track.cx[i] + track.nx[i] * off, 0, track.cz[i] + track.nz[i] * off);
    stand.rotation.y = Math.atan2(track.tx[i], track.tz[i]) - Math.PI / 2; // local +Z points away from the track
    for (let r = 0; r < 7; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 2), r % 2 ? standMat :
        new THREE.MeshStandardMaterial({ color: seatCols[k], roughness: 0.7 }));
      step.position.set(0, 0.5 + r, r * 2); step.castShadow = step.receiveShadow = true; stand.add(step);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(50, 9, 1), standMat);
    back.position.set(0, 4.5, 14); back.castShadow = true; stand.add(back);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(52, 0.4, 16), steel);
    roof.position.set(0, 10, 7); roof.castShadow = true; stand.add(roof);
    scene.add(stand);
  }
  // Pit building on the other side
  const pits = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 220), new THREE.MeshStandardMaterial({ color: 0xe6e8ec, roughness: 0.6 }));
  const pi = Math.round(120 / track.ds), poff = WALL_OFFSET + 12;
  pits.position.set(track.cx[pi] + track.nx[pi] * poff, 3, track.cz[pi] + track.nz[pi] * poff);
  pits.rotation.y = Math.atan2(track.tx[pi], track.tz[pi]); pits.castShadow = true; pits.receiveShadow = true;
  scene.add(pits);

  // ----- trees (instanced: thousands for the cost of two draw calls) -----
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.cx[i]); maxX = Math.max(maxX, track.cx[i]);
    minZ = Math.min(minZ, track.cz[i]); maxZ = Math.max(maxZ, track.cz[i]);
  }
  const TREES = 100;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 3, 6),
    new THREE.MeshStandardMaterial({ color: 0x5b3b22, roughness: 1 }), TREES);
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 7, 7),
    new THREE.MeshStandardMaterial({ color: 0x2f5a2a, roughness: 0.9, flatShading: true }), TREES);
  crowns.castShadow = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  const col = new THREE.Color();
  let placed = 0, tries = 0;
  while (placed < TREES && tries < TREES * 20) {
    tries++;
    const x = minX - 300 + Math.random() * (maxX - minX + 600);
    const z = minZ - 300 + Math.random() * (maxZ - minZ + 600);
    if (distToTrack(track, x, z) < WALL_OFFSET + 14) continue;
    const s = 0.7 + Math.random() * 0.9;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI);
    m.compose(pv.set(x, 1.5 * s, z), q, sv.set(s, s, s)); trunks.setMatrixAt(placed, m);
    m.compose(pv.set(x, (3 + 3.2) * s, z), q, sv.set(s, s, s)); crowns.setMatrixAt(placed, m);
    crowns.setColorAt(placed, col.setHSL(0.26 + Math.random() * 0.08, 0.45, 0.2 + Math.random() * 0.12));
    placed++;
  }
  trunks.count = crowns.count = placed;
  scene.add(trunks, crowns);

  // ----- distant hills -----
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x5f7d55, roughness: 1, flatShading: true });
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2 + Math.random() * 0.1;
    const r = 1700 + Math.random() * 500, h = 120 + Math.random() * 260;
    const hill = new THREE.Mesh(new THREE.ConeGeometry(200 + Math.random() * 250, h, 7), hillMat);
    hill.position.set(cx + Math.cos(a) * r, h / 2 - 5, cz + Math.sin(a) * r);
    hill.rotation.y = Math.random() * Math.PI;
    scene.add(hill);
  }

  return { sun, sunDir, sky, lights };
}
