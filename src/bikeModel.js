// How a bike looks (src/cars/motogp.js): the bike's 3D model with a rider on it, leaning into the corners.
//
// The model (public/models/motogp_gp26.glb, made with tools/prepare-bike.mjs) is the bike alone; the rider is built
// here, in each team's colours, so every bike on the grid has its own. In a corner the bike leans (state.lean,
// physics.js) about the line where its tyres touch the road, and the rider hangs off on the inside; on the power the
// front wheel lifts (state.wheelie), and under hard braking the rear goes light.
// Far away (GRAPHICS.detailDistance, carLod.js) a bike is drawn as one light mesh (the model's 'far' copy, in flat
// colours) with its rider: the full bike is ~70k triangles, ten of them, and the far one ~6k in a single draw.
//
//   makeBike(template, team)   a bike (a copy of the loaded model) with its rider (carModel.js createCarModel)
//   syncBike(model, state)     place it for this frame (carModel.js syncCarModel)
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const BIKE = {
  rearAxle: -0.743,   // z of the rear and front axles (the model's; their middle is at 0)
  frontAxle: 0.720,
  hangOff: 0.22,      // m the rider's body moves to the inside at full lean
  hangRoll: 0.3,      // … and how much further he tips in (rad)
  maxSpinPerFrame: 0.6,
};

// ---------- the rider ----------
const MATS = new Map(), shared = {};
function mats(team) {
  const key = `${team.color ?? 0xe10600}|${team.accent ?? 0xffffff}`;
  if (!MATS.has(key)) {
    MATS.set(key, {
      suit: new THREE.MeshStandardMaterial({ color: team.color ?? 0xe10600, roughness: 0.6, metalness: 0.05 }),
      trim: new THREE.MeshStandardMaterial({ color: team.accent ?? 0xffffff, roughness: 0.55, metalness: 0.05 }),
      helmet: new THREE.MeshStandardMaterial({ color: team.accent ?? 0xffffff, roughness: 0.25, metalness: 0.15 }),
    });
  }
  shared.black ??= new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.75 });
  shared.visor ??= new THREE.MeshStandardMaterial({ color: 0x0b0e15, roughness: 0.06, metalness: 0.7 });
  return { ...MATS.get(key), black: shared.black, visor: shared.visor };
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0), tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();
// a rounded limb from a to b (radius r, squashed by sx / sz across it), as geometry in place
function limb(a, b, r, sx = 1, sz = 1) {
  const len = a.distanceTo(b), g = new THREE.CapsuleGeometry(r, Math.max(len - 2 * r, 0.001), 4, 10); // (end to end: len)
  tmpQ.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  return g.applyMatrix4(tmpM.compose(a.clone().add(b).multiplyScalar(0.5), tmpQ, tmpS.set(sx, 1, sz)));
}
function ball(c, r, sx = 1, sy = 1, sz = 1, part = null) {
  const g = part ? new THREE.SphereGeometry(r, 18, 12, ...part) : new THREE.SphereGeometry(r, 18, 12);
  return g.applyMatrix4(tmpM.compose(c, tmpQ.identity(), tmpS.set(sx, sy, sz)));
}
// The rider's shape, tucked in on the bike: hips on the seat, chest on the tank, chin behind the screen, hands on the
// clip-ons, knees in, boots on the pegs. Coordinates in the bike's model (metres), relative to the hips. Built once: a
// geometry per colour (suit, trim, helmet, black, visor), shared by every rider.
let SHAPE = null;
function riderShape() {
  if (SHAPE) return SHAPE;
  const hip = V(0, 0.88, -0.3), at = (x, y, z) => V(x, y, z).sub(hip);
  const suit = [], trim = [], helmet = [], black = [], visor = [];
  // body: pelvis on the seat, a flat back down along the tank, shoulders over it
  suit.push(ball(at(0, 0.9, -0.3), 0.13, 1.2, 0.85, 1.15));
  suit.push(limb(at(0, 0.92, -0.27), at(0, 0.97, 0.07), 0.13, 1.3, 0.72));
  suit.push(ball(at(0, 0.965, 0.08), 0.13, 1.4, 0.7, 0.9));
  trim.push(limb(at(0, 1.0, -0.2), at(0, 1.03, -0.02), 0.055, 1.4, 0.7)); // the aero hump on the back
  suit.push(limb(at(0, 0.97, 0.12), at(0, 1.0, 0.2), 0.05)); // neck
  // head down behind the screen
  const head = at(0, 1.02, 0.27);
  helmet.push(ball(head, 0.125, 0.95, 0.92, 1.12));
  helmet.push(limb(at(0, 1.05, 0.16), at(0, 1.075, 0.08), 0.03, 1.2, 0.8)); // spoiler on the back of the helmet
  visor.push(ball(head.clone().add(V(0, 0.004, 0.01)), 0.127, 0.96, 0.93, 1.12, [-Math.PI * 0.3, Math.PI * 0.6, Math.PI * 0.38, Math.PI * 0.2]));
  for (const s of [-1, 1]) {
    // arms: shoulders → elbows tucked in → hands on the bars
    const sh = at(s * 0.16, 0.96, 0.1), el = at(s * 0.21, 0.84, 0.21), hand = at(s * 0.245, 0.88, 0.42);
    suit.push(limb(sh, el, 0.045), limb(el, hand, 0.04));
    trim.push(ball(el, 0.042)); // elbow pads
    black.push(ball(hand, 0.04, 1, 0.85, 1.35)); // gloves
    // legs: hips → knees in against the tank → boots on the pegs
    const hp = at(s * 0.11, 0.88, -0.29), kn = at(s * 0.19, 0.69, -0.03), ft = at(s * 0.16, 0.43, -0.32);
    suit.push(limb(hp, kn, 0.065), limb(kn, ft, 0.05));
    trim.push(ball(kn.clone().add(V(s * 0.05, -0.02, 0.03)), 0.038, 0.7, 1, 1.2)); // knee sliders
    black.push(limb(ft, ft.clone().add(V(0, -0.03, 0.15)), 0.042)); // boots
  }
  const merge = (list) => { const g = mergeGeometries(list.map((x) => (x.index ? x.toNonIndexed() : x))); list.forEach((x) => x.dispose()); return g; };
  SHAPE = { hip, suit: merge(suit), trim: merge(trim), helmet: merge(helmet), black: merge(black), visor: merge(visor) };
  return SHAPE;
}
function makeRider(team) {
  const S = riderShape(), M = mats(team), g = new THREE.Group();
  g.name = 'rider';
  for (const k of ['suit', 'trim', 'helmet', 'black', 'visor']) {
    const m = new THREE.Mesh(S[k], M[k]); m.castShadow = k !== 'visor'; m.receiveShadow = true; g.add(m);
  }
  g.position.copy(S.hip);
  g.userData.hip = S.hip;
  return g;
}

// ---------- far away: the model's light copy, in flat colours, as one mesh (made once per model) ----------
const FAR_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 });
const farGeo = new WeakMap();
function averageColour(tex) {
  let c = null; const img = tex?.image;
  try {
    if (img && (img.width ?? 0) > 0) {
      const N = 32, cv = document.createElement('canvas'); cv.width = cv.height = N; // (averaged over 32 × 32 samples)
      const x = cv.getContext('2d'); x.drawImage(img, 0, 0, N, N);
      const d = x.getImageData(0, 0, N, N).data; let r = 0, gg = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      const n = (d.length / 4) * 255;
      c = new THREE.Color().setRGB(r / n, gg / n, b / n, THREE.SRGBColorSpace);
    }
  } catch { /* not a picture we can read */ }
  return c;
}
function farGeometry(template) {
  if (farGeo.has(template)) return farGeo.get(template);
  const src = template.getObjectByName('far');
  let geo = null;
  if (src) {
    template.updateMatrixWorld(true);
    const inv = template.matrixWorld.clone().invert(), rel = new THREE.Matrix4(), parts = [], c = new THREE.Color();
    src.traverse((o) => {
      if (!o.isMesh) return;
      // (positions as plain floats first: the file's are packed into small integers, which can't hold them once moved)
      const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry, P = src.attributes.position, f = new Float32Array(P.count * 3);
      for (let k = 0; k < P.count; k++) { f[k * 3] = P.getX(k); f[k * 3 + 1] = P.getY(k); f[k * 3 + 2] = P.getZ(k); }
      if (src !== o.geometry) src.dispose();
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(f, 3));
      g.applyMatrix4(rel.multiplyMatrices(inv, o.matrixWorld));
      g.computeVertexNormals();
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      c.copy(m?.color ?? c.set(0xffffff));
      if (m?.map) { const t = averageColour(m.map); if (t) c.multiply(t); }
      const n = g.attributes.position.count, col = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(g);
    });
    if (parts.length) { geo = mergeGeometries(parts); parts.forEach((g) => g.dispose()); }
  }
  farGeo.set(template, geo);
  return geo;
}

// A bike for a team: the model (geometry and textures shared) on a pivot for wheelies, with its rider; and its far copy
export function makeBike(template, team = {}) {
  const car = new THREE.Group();
  car.rotation.order = 'YXZ'; // yaw, then pitch (hills), then the lean
  const pitch = new THREE.Group(); pitch.name = 'bike_pitch'; // wheelies turn about the rear tyre, stoppies the front
  const body = template.clone();
  const farSrc = body.getObjectByName('far'); if (farSrc) farSrc.visible = false; // (only the merged one below is drawn)
  pitch.add(body);
  const rider = makeRider(team);
  pitch.add(rider);
  car.add(pitch);
  const wheels = [];
  body.traverse((o) => { if (o.name === 'wheel_F' || o.name === 'wheel_R') wheels.push(o); });
  // far away: the light bike and the same rider (carLod.js swaps them in: userData.lodFar)
  const g = farGeometry(template);
  let far = null;
  if (g) {
    far = new THREE.Group(); far.name = 'far'; far.visible = false;
    const m = new THREE.Mesh(g, FAR_MAT); m.castShadow = true; m.receiveShadow = true;
    const r2 = makeRider(team);
    far.add(m, r2);
    car.add(far);
    far.userData.rider = r2;
  }
  car.userData = { bike: true, pitch, rider, wheels, far, spinVis: 0, lastSpin: null, hang: 0, cams: null };
  if (far) car.userData.lodFar = { near: [pitch], far, on: false };
  return car;
}

const smooth = (a, b, k) => a + (b - a) * k;
export function syncBike(model, state, cfg) {
  const u = model.userData;
  model.position.set(state.x, state.y ?? 0, state.z);
  model.rotation.y = state.h;
  model.rotation.x = -(state.pitch ?? 0);
  const lean = state.lean ?? 0;
  model.rotation.z = (state.roll ?? 0) - lean; // (+ lean = to the left: a turn about −Z in the bike's frame)
  if (u.lodFar?.on) { // far away: just the lean (and the rider hanging off)
    hang(u.far.userData.rider, u, lean);
    return;
  }
  // wheels: the real rotation, capped per frame so they never strobe backwards
  const max = cfg?.maxSpinPerFrame ?? BIKE.maxSpinPerFrame;
  const spin = state.wheelSpin ?? 0, d = u.lastSpin == null ? 0 : spin - u.lastSpin; u.lastSpin = spin;
  u.spinVis += THREE.MathUtils.clamp(d, -max, max);
  for (const w of u.wheels) w.rotation.x = u.spinVis;
  // wheelie (+) about the rear tyre's contact patch, stoppie (−) about the front's
  const w = state.wheelie ?? 0, pz = w >= 0 ? BIKE.rearAxle : BIKE.frontAxle;
  u.pitch.position.set(0, 0, pz);
  for (const c of u.pitch.children) c.position.z = (c === u.rider ? c.userData.hip.z : 0) - pz;
  u.pitch.rotation.x = -w;
  hang(u.rider, u, lean);
}
// the rider hangs off to the inside of the corner and tips in
function hang(r, u, lean) {
  const k = THREE.MathUtils.clamp(Math.abs(lean) / 0.9, 0, 1) * Math.sign(lean);
  u.hang = smooth(u.hang, k, 0.25);
  r.position.x = u.hang * BIKE.hangOff;
  r.rotation.z = -u.hang * BIKE.hangRoll;
  r.position.y = r.userData.hip.y - Math.abs(u.hang) * 0.05;
}