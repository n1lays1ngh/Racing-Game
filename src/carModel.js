// How the cars look.
//
//  • Your car: the 3D model of the car you're racing (`model` in its file in src/cars/): the RB19
//    (public/models/rb19.glb), the Ferrari 499P (ferrari_499p.glb) or the Mercedes-AMG GT3 (amg_gt3.glb).
//    The model is rigged when it loads: the four wheels spin, the front wheels steer (with their brake
//    calipers), and the steering wheel in the cockpit turns as you steer, with a live screen on it or the dash.
//  • AI cars: a built-in car made in code, painted in each team's colours (createBuiltinCar further down), in the
//    car's own shape: an F1 car (BODIES), a Le Mans Hypercar or a GT3 (carBodies.js). Never a copy of your car.
//  • Your car is the built-in one too if its .glb can't be loaded.
//
// "Oracle Red Bull F1 Car RB19 2023" model by Redgrund
// (https://sketchfab.com/3d-models/oracle-red-bull-f1-car-rb19-2023-e4afe46f3aab4b23a418da06fc163821),
// licensed CC-BY-4.0. Prepared for the game with glTF-Transform: wheels and steering wheel split
// into their own parts around their real pivot points, compressed from 40 MB to 3.3 MB.
// "Ferrari 499p | www.vecarz.com" by vecarz and "Mercedes Benz AMG GT3 Red Bull" by toddeppe (Sketchfab,
// CC-BY-4.0): prepared with tools/prepare-car.mjs (rigged, ~430k → ~170k triangles, 5 MB each).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { steerLimit, gearbox } from './physics.js';
import { bodyFor, rimGeometry, NEW_BODIES } from './carBodies.js';
import F1 from './cars/f1.js';
import { TYRES as COMPOUND_SETS } from './tyres.js';

// The F1 car's model settings (src/cars/f1.js: `model`). Each car has its own in its file.
export const CAR_MODEL = F1.model;
const BUILTIN_CAMS = { tcam: { z: -0.35, y: 1.2, tilt: -1.15 }, cockpit: { z: 0.16, y: 0.87, tilt: -0.92 } };

// ---------- geometry helpers ----------

// Smooth body through cross-sections { z, x?, y (bottom), w (half width), h (height), p? (squareness) }.
function loft(sections, seg = 24) {
  const S = [...sections].sort((a, b) => a.z - b.z);
  const pos = [], uv = [], idx = [];
  const ring = seg + 1;
  const pt = (s, j) => {
    const a = (j / seg) * Math.PI * 2; // 0 = right side, π/2 = top
    const c = Math.cos(a), sn = Math.sin(a), e = 2 / (s.p ?? 3);
    return [(s.x ?? 0) + s.w * Math.sign(c) * Math.abs(c) ** e,
      s.y + s.h / 2 + (s.h / 2) * Math.sign(sn) * Math.abs(sn) ** e, s.z];
  };
  S.forEach((s, k) => {
    for (let j = 0; j <= seg; j++) { pos.push(...pt(s, j)); uv.push(j / seg, k / (S.length - 1)); }
  });
  for (let k = 0; k < S.length - 1; k++) for (let j = 0; j < seg; j++) {
    const a = k * ring + j, b = a + 1, c = a + ring, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  // End caps (separate vertices so edges stay crisp)
  for (const [s, front] of [[S[0], false], [S[S.length - 1], true]]) {
    const base = pos.length / 3;
    pos.push(s.x ?? 0, s.y + s.h / 2, s.z); uv.push(0.25, front ? 1 : 0);
    for (let j = 0; j <= seg; j++) { pos.push(...pt(s, j)); uv.push(0.25, front ? 1 : 0); }
    for (let j = 0; j < seg; j++) {
      if (front) idx.push(base, base + 1 + j, base + 2 + j);
      else idx.push(base, base + 2 + j, base + 1 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Flat plate from a side-profile outline [(z, y), ...], `thick` wide, centred at x.
function sidePlate(outline, thick, x) {
  const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(-z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  g.rotateY(Math.PI / 2); // shape X → world −Z, extrusion → world X
  g.translate(x - thick / 2, 0, 0);
  return g;
}

// Wing element: span along X, chord along Z, pitched (leading edge down).
function wing(span, chord, thick, x, y, z, pitch, roll = 0) {
  const g = new THREE.BoxGeometry(span, thick, chord);
  g.rotateX(pitch); g.rotateZ(roll); g.translate(x, y, z);
  return g;
}

// Round tube between two points.
function strut(a, b, r) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const g = new THREE.CylinderGeometry(r, r, A.distanceTo(B), 6);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  g.applyQuaternion(q); g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return g;
}

function tube(points, r, seg = 40) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), seg, r, 8);
}

function boxAt(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g;
}

// ---------- textures ----------
const hex = (c) => '#' + new THREE.Color(c).getHexString();

function canvasTex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Livery wraps around the lofted bodywork: u goes round (0.25 = top), v runs along the car.
function liveryTexture(color, accent) {
  return canvasTex(512, 256, (x) => {
    x.fillStyle = hex(color); x.fillRect(0, 0, 512, 256);
    const g = x.createLinearGradient(256, 0, 512, 0); // underside fades to carbon
    g.addColorStop(0, hex(color)); g.addColorStop(0.18, '#15161a'); g.addColorStop(0.82, '#15161a'); g.addColorStop(1, hex(color));
    x.fillStyle = g; x.fillRect(256, 0, 256, 256);
    x.fillStyle = hex(accent);
    x.fillRect(114, 0, 28, 256);                 // stripe along the top
    x.fillRect(100, 0, 5, 256); x.fillRect(151, 0, 5, 256);
    x.fillRect(0, 150, 256, 10);                  // band round the car
  });
}

let CARBON = null;
function carbonTexture() {
  if (CARBON) return CARBON;
  CARBON = canvasTex(64, 64, (x) => {
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      x.fillStyle = (i + j) % 2 ? '#1c1d21' : '#26282d'; x.fillRect(i * 8, j * 8, 8, 8);
    }
  }, true);
  CARBON.repeat.set(6, 6);
  return CARBON;
}

function numberTexture(num, color) {
  return canvasTex(128, 128, (x) => {
    x.fillStyle = hex(color); x.fillRect(0, 0, 128, 128);
    x.fillStyle = '#fff'; x.font = 'bold 84px system-ui, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(num), 64, 70);
  });
}

// ---------- the car ----------
const COMPOUNDS = [0xe8261f, 0xffd12a, 0xf2f2f2]; // soft / medium / hard sidewall stripe
const COMPOUND_MAT = new THREE.MeshBasicMaterial({ color: 0xffd12a }); // (the models' band, before each car has its own)

// The built-in cars: one body shape per kind of car (`builtin` in the car's model settings, src/cars/):
//   f1    open wheels, halo, wings (the F1 car), here in BODIES: it fills the material buckets (B) and says where
//         its wheels go and how big they are
//   proto a Le Mans Hypercar, and gt a GT3: made in carBodies.js (createBodyCar below), with spoked rims
const BODIES = {
  f1(B, car, M) {
    // --- Floor (with edge wings) and plank ---
    const floorShape = [
      [0.42, 1.25], [0.86, 0.72], [0.9, -1.3], [0.62, -2.05], [-0.62, -2.05], [-0.9, -1.3], [-0.86, 0.72], [-0.42, 1.25],
    ];
    const fs = new THREE.Shape(floorShape.map(([x, z]) => new THREE.Vector2(x, z)));
    const floor = new THREE.ExtrudeGeometry(fs, { depth: 0.03, bevelEnabled: false });
    floor.rotateX(Math.PI / 2); floor.translate(0, 0.1, 0);
    B.carbon.push(floor);
    for (const s of [-1, 1]) {
      B.carbon.push(sidePlate([[0.6, 0.07], [-1.3, 0.07], [-1.3, 0.17], [-0.2, 0.2], [0.6, 0.12]], 0.015, s * 0.89));
    }

    // --- Monocoque + nose (one smooth loft) ---
    B.paint.push(loft([
      { z: -0.4, y: 0.1, w: 0.4, h: 0.62 },
      { z: 0.0, y: 0.1, w: 0.4, h: 0.6 },
      { z: 0.45, y: 0.1, w: 0.37, h: 0.58 },
      { z: 0.9, y: 0.11, w: 0.31, h: 0.52 },
      { z: 1.25, y: 0.12, w: 0.25, h: 0.44 },
      { z: 1.7, y: 0.12, w: 0.18, h: 0.33 },
      { z: 2.1, y: 0.12, w: 0.13, h: 0.24 },
      { z: 2.45, y: 0.12, w: 0.09, h: 0.16 },
      { z: 2.62, y: 0.13, w: 0.05, h: 0.09, p: 2 },
    ]));

    // --- Engine cover + airbox (rises behind the driver's head) ---
    B.paint.push(loft([
      { z: -2.3, y: 0.18, w: 0.09, h: 0.24 },
      { z: -1.8, y: 0.14, w: 0.17, h: 0.4 },
      { z: -1.2, y: 0.12, w: 0.26, h: 0.58 },
      { z: -0.6, y: 0.12, w: 0.3, h: 0.78 },
      { z: -0.28, y: 0.12, w: 0.25, h: 0.87, p: 2.6 },
      { z: -0.14, y: 0.3, w: 0.18, h: 0.66, p: 2.4 },
    ]));
    B.dark.push(boxAt(0.2, 0.12, 0.02, 0, 0.88, -0.13)); // airbox intake
    B.accent.push(boxAt(0.12, 0.05, 0.1, 0, 1.01, -0.26)); // T-cam
    // Shark fin
    B.body.push(sidePlate([[-0.35, 0.95], [-1.9, 0.6], [-1.95, 0.5], [-1.2, 0.62], [-0.45, 0.86]], 0.012, 0));
    for (const s of [-1, 1]) { // number on the fin
      const num = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.2), M.number);
      num.position.set(s * 0.012, 0.8, -0.95); num.rotation.y = s * Math.PI / 2; num.userData.detail = true; car.add(num);
    }

    // --- Sidepods (downwash style) with dark inlets ---
    for (const s of [-1, 1]) {
      B.paint.push(loft([
        { z: -1.55, x: s * 0.3, y: 0.12, w: 0.1, h: 0.12 },
        { z: -1.0, x: s * 0.46, y: 0.12, w: 0.17, h: 0.22 },
        { z: -0.35, x: s * 0.6, y: 0.13, w: 0.22, h: 0.33 },
        { z: 0.3, x: s * 0.64, y: 0.16, w: 0.21, h: 0.38 },
        { z: 0.55, x: s * 0.63, y: 0.2, w: 0.19, h: 0.34, p: 4 },
      ]));
      B.dark.push(boxAt(0.3, 0.26, 0.02, s * 0.63, 0.37, 0.565));
      // Mirrors on stalks
      B.body.push(boxAt(0.15, 0.06, 0.05, s * 0.55, 0.7, 0.42));
      B.carbon.push(strut([s * 0.36, 0.6, 0.4], [s * 0.5, 0.69, 0.42], 0.012));
      B.visor.push(boxAt(0.13, 0.045, 0.01, s * 0.55, 0.7, 0.394));
    }

    // --- Cockpit, driver, steering wheel ---
    const opening = new THREE.CylinderGeometry(1, 1, 0.02, 24); opening.scale(0.25, 1, 0.42); opening.translate(0, 0.705, 0.28);
    B.dark.push(opening);
    const helmet = new THREE.SphereGeometry(0.135, 20, 14); helmet.translate(0, 0.79, 0.14);
    B.helmet.push(helmet);
    const visor = new THREE.SphereGeometry(0.137, 20, 6, -0.9, 1.8, 1.25, 0.35); visor.translate(0, 0.79, 0.14);
    B.visor.push(visor);
    B.dark.push(boxAt(0.26, 0.1, 0.04, 0, 0.66, 0.45));

    // --- Halo ---
    B.carbon.push(tube([[-0.34, 0.7, -0.12], [-0.32, 0.88, 0.05], [-0.22, 0.96, 0.32], [0, 0.98, 0.44],
      [0.22, 0.96, 0.32], [0.32, 0.88, 0.05], [0.34, 0.7, -0.12]], 0.032));
    B.carbon.push(tube([[0, 0.98, 0.44], [0, 0.88, 0.58], [0, 0.71, 0.7]], 0.03, 12));

    // --- Front wing: mainplane + three flaps curving up to the endplates ---
    for (const s of [-1, 1]) {
      B.carbon.push(wing(0.92, 0.3, 0.025, s * 0.53, 0.1, 2.72, 0.05, s * 0.04));
      B.body.push(wing(0.86, 0.16, 0.02, s * 0.56, 0.15, 2.56, 0.28, s * 0.07));
      B.carbon.push(wing(0.78, 0.13, 0.02, s * 0.6, 0.2, 2.45, 0.48, s * 0.1));
      B.accent.push(wing(0.66, 0.11, 0.02, s * 0.66, 0.25, 2.36, 0.62, s * 0.14));
      B.carbon.push(sidePlate([[2.9, 0.06], [2.3, 0.06], [2.25, 0.3], [2.5, 0.37], [2.85, 0.2]], 0.02, s * 0.99));
    }
    B.carbon.push(wing(0.24, 0.3, 0.025, 0, 0.1, 2.72, 0.05)); // neutral centre section

    // --- Rear wing: endplates, mainplane, DRS flap, beam wing, pylon ---
    for (const s of [-1, 1]) {
      // Endplate: narrow at the bottom, sweeping back to the wing tips
      B.carbon.push(sidePlate([[-2.3, 0.5], [-2.46, 0.5], [-2.74, 0.96], [-2.72, 1.04], [-2.36, 1.05], [-2.28, 0.97]], 0.018, s * 0.52));
      B.body.push(sidePlate([[-2.36, 1.05], [-2.72, 1.04], [-2.73, 1.09], [-2.37, 1.1]], 0.02, s * 0.52));
    }
    B.carbon.push(wing(1.02, 0.3, 0.025, 0, 0.87, -2.46, 0.22));
    B.accent.push(wing(1.02, 0.2, 0.02, 0, 0.99, -2.63, 0.6));
    B.carbon.push(wing(0.8, 0.14, 0.02, 0, 0.4, -2.5, 0.3));
    B.carbon.push(wing(0.8, 0.12, 0.02, 0, 0.47, -2.62, 0.5));
    B.carbon.push(boxAt(0.03, 0.42, 0.14, 0, 0.66, -2.42));  // swan-neck pylon
    B.carbon.push(boxAt(0.04, 0.06, 0.12, 0, 1.04, -2.56));  // DRS actuator
    B.carbon.push(loft([{ z: -2.72, y: 0.27, w: 0.07, h: 0.14 }, { z: -2.2, y: 0.22, w: 0.12, h: 0.24 }], 12)); // crash structure
    B.light.push(boxAt(0.1, 0.05, 0.03, 0, 0.34, -2.73));    // rain light
    const diffuser = new THREE.BoxGeometry(1.1, 0.02, 0.55); diffuser.rotateX(-0.32); diffuser.translate(0, 0.16, -2.25);
    B.carbon.push(diffuser);
    for (const x of [-0.5, -0.2, 0.2, 0.5]) B.carbon.push(boxAt(0.01, 0.14, 0.45, x, 0.17, -2.25));

    // --- Suspension (carbon wishbones and pushrods) ---
    const r = 0.016;
    for (const s of [-1, 1]) {
      // front
      B.carbon.push(strut([s * 0.22, 0.5, 1.98], [s * 0.66, 0.48, 1.8], r), strut([s * 0.22, 0.5, 1.55], [s * 0.66, 0.48, 1.8], r));
      B.carbon.push(strut([s * 0.2, 0.2, 2.02], [s * 0.66, 0.22, 1.8], r), strut([s * 0.2, 0.2, 1.45], [s * 0.66, 0.22, 1.8], r));
      B.carbon.push(strut([s * 0.64, 0.24, 1.78], [s * 0.24, 0.55, 1.62], r), strut([s * 0.22, 0.32, 1.96], [s * 0.66, 0.32, 1.96], r * 0.8));
      // rear
      B.carbon.push(strut([s * 0.22, 0.48, -1.5], [s * 0.64, 0.5, -1.8], r), strut([s * 0.22, 0.48, -2.05], [s * 0.64, 0.5, -1.8], r));
      B.carbon.push(strut([s * 0.25, 0.2, -1.4], [s * 0.64, 0.22, -1.8], r), strut([s * 0.25, 0.2, -2.05], [s * 0.64, 0.22, -1.8], r));
    }
    return { wheels: [[-0.8, 1.8, 0.3, true], [0.8, 1.8, 0.3, true], [-0.78, -1.8, 0.4, false], [0.78, -1.8, 0.4, false]],
      tyre: { R: 0.36, rim: 0.232, stripe: true }, cams: BUILTIN_CAMS };
  },
};

// kind: the body shape (BODIES above); cams: onboard cameras to use instead of the body's own
function createBuiltinCar(team = {}, kind = 'f1', cams = null) {
  if (NEW_BODIES.includes(kind)) return createBodyCar(team, kind, cams);
  const { color = 0xe10600, accent = 0xffffff, number = 1 } = team;
  const car = new THREE.Group();
  car.rotation.order = 'YXZ'; // yaw first, then pitch in the car's own frame

  const M = {
    paint: new THREE.MeshPhysicalMaterial({ map: liveryTexture(color, accent), metalness: 0.35, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 }),
    body: new THREE.MeshPhysicalMaterial({ color, metalness: 0.35, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 }),
    accent: new THREE.MeshPhysicalMaterial({ color: accent, metalness: 0.3, roughness: 0.35, clearcoat: 0.8 }),
    carbon: new THREE.MeshStandardMaterial({ map: carbonTexture(), metalness: 0.4, roughness: 0.45 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.7 }),
    helmet: new THREE.MeshPhysicalMaterial({ color: accent === 0xffffff ? 0xffd400 : accent, roughness: 0.25, clearcoat: 1 }),
    visor: new THREE.MeshStandardMaterial({ color: 0x0a0a0a, metalness: 0.9, roughness: 0.1 }),
    light: new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1a1a, emissiveIntensity: 0.6 }),
    head: new THREE.MeshStandardMaterial({ color: 0xdfe6f2, emissive: 0xf4f7ff, emissiveIntensity: 0.35, roughness: 0.2 }), // headlights
    tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92, side: THREE.DoubleSide }),
    cover: new THREE.MeshStandardMaterial({ color: 0x202226, metalness: 0.8, roughness: 0.3 }),
    number: new THREE.MeshStandardMaterial({ map: numberTexture(number, color), roughness: 0.4 }),
  };
  // paint = lofted bodywork with the livery wrap; body = flat painted parts in the base colour
  const B = { paint: [], body: [], accent: [], carbon: [], dark: [], helmet: [], visor: [], light: [], head: [] };
  const shape = (BODIES[kind] ?? BODIES.f1)(B, car, M);

  // Merge each material bucket into one mesh
  for (const [key, list] of Object.entries(B)) {
    if (!list.length) continue;
    const geo = mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      return g;
    }));
    const mesh = new THREE.Mesh(geo, M[key]);
    mesh.name = 'builtin_' + key; // (builtin_head: the headlights, headlights.js)
    mesh.castShadow = true; mesh.receiveShadow = true;
    car.add(mesh);
  }

  // --- Wheels: low-profile tyres on rims with covers (F1: the compound stripe on the sidewall) ---
  const compound = new THREE.MeshBasicMaterial({ color: COMPOUNDS[number % 3] });
  const marks = shape.tyre.stripe ? compound : new THREE.MeshBasicMaterial({ color: 0x9aa0a8 });
  const wheels = [], steerPivots = [];
  const makeWheel = (x, z, width, front) => {
    const { R, rim } = shape.tyre, w2 = width / 2, k = R / 0.36; // (the profile is drawn for a 0.36 m tyre)
    const pivot = new THREE.Group(); pivot.position.set(x, R, z); car.add(pivot);
    const wheel = new THREE.Group(); pivot.add(wheel);
    const prof = [[rim, -w2], [0.3 * k, -w2], [0.343 * k, -w2 + 0.015], [R, -w2 + 0.06], [R, w2 - 0.06], [0.343 * k, w2 - 0.015], [0.3 * k, w2], [rim, w2]]
      .map(([rr, y]) => new THREE.Vector2(rr, y));
    const tyre = new THREE.Mesh(new THREE.LatheGeometry(prof, 36), M.tyre);
    tyre.rotation.z = Math.PI / 2; tyre.castShadow = true; wheel.add(tyre);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rim, rim, width - 0.01, 32), M.cover);
    barrel.rotation.z = Math.PI / 2; wheel.add(barrel);
    // the compound stripes on both sidewalls and the marks on the cover (so you can see it spin): one mesh, one draw
    const decor = new THREE.Mesh(wheelDecor(Math.sign(x), w2, !!shape.tyre.stripe), marks);
    decor.userData.detail = true; wheel.add(decor);
    wheels.push(wheel); if (front) steerPivots.push(pivot);
  };
  for (const [x, z, width, front] of shape.wheels) makeWheel(x, z, width, front);

  // details: small parts not drawn on a car far from the camera (carLod.js, GRAPHICS.detailDistance)
  const details = [];
  car.traverse((o) => { if (o.userData.detail || o.name === 'builtin_helmet' || o.name === 'builtin_visor') details.push(o); });
  car.userData = { wheels, steerPivots, cams: cams ?? shape.cams, compoundMat: shape.tyre.stripe ? compound : null, details };
  return car;
}

// A wheel's stripes and spin marks, merged (shared by every car: the same for each side and tyre width)
const decors = new Map();
function wheelDecor(side, w2, stripe) {
  const key = `${side}|${w2}|${stripe}`;
  if (decors.has(key)) return decors.get(key);
  const parts = [];
  if (stripe) for (const face of [-1, 1]) parts.push(new THREE.RingGeometry(0.29, 0.305, 40).rotateY(face * Math.PI / 2).translate(face * (w2 + 0.001), 0, 0));
  for (let j = 0; j < 3; j++) {
    const a = (j * 2 * Math.PI) / 3;
    parts.push(new THREE.BoxGeometry(0.004, 0.09, 0.03).rotateX(a).translate(side * (w2 - 0.002), Math.cos(a) * 0.15, Math.sin(a) * 0.15));
  }
  const g = mergeGeometries(parts.map((q) => q.toNonIndexed()));
  decors.set(key, g);
  return g;
}

// ---------- the built-in Hypercar and GT3 (carBodies.js) ----------
// The shapes are shared by every car of a kind; each car gets its own paint (team colour and accent), number
// plates, and a motion-blur disc on each wheel (the spokes would strobe at speed).
const SHARED = {};
const shared = () => SHARED.carbon ? SHARED : Object.assign(SHARED, {
  carbon: new THREE.MeshStandardMaterial({ map: carbonTexture(), metalness: 0.4, roughness: 0.45 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.75 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0b0e14, metalness: 0.2, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03 }),
  tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92, side: THREE.DoubleSide }),
  disc: new THREE.MeshStandardMaterial({ color: 0x3a3c40, metalness: 0.7, roughness: 0.5 }),
});
function plateTexture(num) { // race number: black on a white plate
  return canvasTex(128, 96, (x) => {
    x.fillStyle = '#f4f4f2'; x.beginPath(); x.roundRect(2, 2, 124, 92, 14); x.fill();
    x.fillStyle = '#0b0b0d'; x.font = 'bold 72px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(num), 64, 52);
  });
}
const rimMats = new Map();
function createBodyCar({ color = 0xe10600, accent = 0xffffff, number = 1 } = {}, kind, cams) {
  const b = bodyFor(kind), S = shared(), car = new THREE.Group();
  car.rotation.order = 'YXZ'; // yaw first, then pitch in the car's own frame
  const M = {
    body: new THREE.MeshPhysicalMaterial({ color, metalness: 0.3, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
    accent: new THREE.MeshPhysicalMaterial({ color: accent, metalness: 0.3, roughness: 0.35, clearcoat: 0.8 }),
    carbon: S.carbon, dark: S.dark, glass: S.glass,
    light: new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1a1a, emissiveIntensity: 0.6 }),     // tail lights
    head: new THREE.MeshStandardMaterial({ color: 0xdfe6f2, emissive: 0xf4f7ff, emissiveIntensity: 0.35, roughness: 0.2 }), // headlights
  };
  for (const [key, geo] of Object.entries(b.merged)) {
    const mesh = new THREE.Mesh(geo, M[key] ?? M.body);
    mesh.name = 'builtin_' + key; // (builtin_head: the headlights, headlights.js)
    mesh.castShadow = true; mesh.receiveShadow = true;
    car.add(mesh);
  }
  const plate = new THREE.MeshStandardMaterial({ map: plateTexture(number), roughness: 0.45, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const n of b.numbers) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(n.w, n.h), plate);
    m.position.set(...n.pos); if (n.rotX) m.rotation.x = n.rotX; if (n.rotY) m.rotation.y = n.rotY;
    car.add(m);
  }
  // wheels: tyre, spoked rim, brake disc (all spin), caliper (steers, doesn't spin), blur disc (fades in with speed)
  const t = b.tyre, key = kind + t.rimColour;
  if (!rimMats.has(key)) rimMats.set(key, {
    rim: new THREE.MeshStandardMaterial({ color: t.rimColour, metalness: 0.65, roughness: 0.32 }),
    caliper: new THREE.MeshStandardMaterial({ color: t.caliper, metalness: 0.3, roughness: 0.4 }),
  });
  const RM = rimMats.get(key), rimRGB = [16, 8, 0].map((sh) => +Math.min(1, (((t.rimColour >> sh) & 255) / 255) * 1.5).toFixed(2));
  const blurMat = new THREE.MeshStandardMaterial({ map: blurTexture(rimRGB), roughness: 0.6, metalness: 0.2, transparent: true, opacity: 0, depthWrite: false });
  blurMat.visible = false;
  const wheels = [], steerPivots = [];
  for (const [x, z, width, front] of b.wheels) {
    const { R, rim } = t, w2 = width / 2, k = R / 0.36, side = Math.sign(x);
    const pivot = new THREE.Group(); pivot.position.set(x, R, z); car.add(pivot);
    const wheel = new THREE.Group(); pivot.add(wheel);
    const prof = [[rim, -w2], [0.3 * k, -w2], [0.343 * k, -w2 + 0.015], [R, -w2 + 0.06], [R, w2 - 0.06], [0.343 * k, w2 - 0.015], [0.3 * k, w2], [rim, w2]]
      .map(([rr, y]) => new THREE.Vector2(rr, y));
    const tyre = new THREE.Mesh(tyreLathe(prof), S.tyre);
    tyre.rotation.z = Math.PI / 2; tyre.castShadow = true; wheel.add(tyre);
    const rg = rimGeometry(R, rim, t.spokes, width);
    const face = new THREE.Group(); face.rotation.y = side > 0 ? 0 : Math.PI; wheel.add(face); // spokes on the outside
    const spokes = new THREE.Mesh(rg.face, RM.rim); spokes.position.x = rg.faceX; face.add(spokes);
    face.add(new THREE.Mesh(rg.barrel, RM.rim), new THREE.Mesh(rg.backing, S.dark));
    const disc = new THREE.Mesh(discGeometry(rim), S.disc); disc.position.x = rg.faceX - 0.07; face.add(disc);
    const caliper = new THREE.Mesh(caliperGeometry(rim), RM.caliper);
    caliper.position.set(side * (rg.faceX - 0.065), rim * 0.55, -rim * 0.45); pivot.add(caliper);
    const blur = new THREE.Mesh(blurDisc(rim), blurMat);
    blur.rotation.y = side * Math.PI / 2; blur.position.x = side * (w2 - 0.004); blur.name = 'blur'; pivot.add(blur);
    wheels.push(wheel); if (front) steerPivots.push(pivot);
  }
  car.userData = { wheels, steerPivots, cams: cams ?? b.cams, blurMats: [blurMat], spinVis: 0, lastSpin: null };
  return car;
}
const lathes = new Map(), discs = new Map(), calipers = new Map(), blurDiscs = new Map();
const once = (map, key, make) => (map.has(key) ? map.get(key) : map.set(key, make()).get(key));
const tyreLathe = (prof) => once(lathes, prof.map((p) => p.x.toFixed(3) + ',' + p.y.toFixed(3)).join(), () => new THREE.LatheGeometry(prof, 36));
const discGeometry = (rim) => once(discs, rim, () => new THREE.CylinderGeometry(rim * 0.8, rim * 0.8, 0.03, 24).rotateZ(Math.PI / 2));
const caliperGeometry = (rim) => once(calipers, rim, () => new THREE.BoxGeometry(0.05, rim * 0.5, rim * 0.32).rotateX(0.7));
const blurDisc = (rim) => once(blurDiscs, rim, () => new THREE.CircleGeometry(rim * 1.02, 40));

// Called every frame with the physics state.
// ---------- the car models (.glb) ----------
const templates = new Map(); // a car's model settings → the loaded model, ready to copy for each car
const loading = new Map();   // … and the load in progress

// Motion blur for the wheels: a smeared cover on each face and a smooth tread band that fade in with
// speed. Above ~40 km/h they hide the real wheel, which keeps turning underneath (capped, so it never
// strobes backwards) — the same trick racing games use.
const BLUR_TEX = new Map();
// colour: the rim's own colour ([r, g, b] 0–1, measured by prepare-car.mjs); none = the RB19's wheel covers
function blurTexture(colour = null) {
  const key = colour ? colour.join() : 'rb19';
  if (BLUR_TEX.has(key)) return BLUR_TEX.get(key);
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'), m = 128;
  const ring = (r0, r1, style) => { x.beginPath(); x.arc(m, m, r1, 0, Math.PI * 2); x.arc(m, m, r0, 0, Math.PI * 2, true); x.fillStyle = style; x.fill(); };
  if (!colour) {
    ring(0, 116, '#1b2030');                       // wheel cover, logos smeared into rings
    for (let r = 10; r < 112; r += 13) ring(r, r + 3, 'rgba(90,100,130,0.35)');
    ring(34, 42, 'rgba(200,40,50,0.45)');          // red of the logo turned into a ring
  } else {                                         // spokes spinning: the rim's colour smeared over the dark inside
    const rgb = (k, a = 1) => `rgba(${colour.map((v) => Math.round(Math.min(255, v * 255 * k))).join(',')},${a})`;
    ring(0, 116, rgb(0.55));
    for (let r = 8; r < 112; r += 11) ring(r, r + 4, rgb(1.25, 0.35));
    ring(0, 22, rgb(0.8));                         // the hub and wheel nut
  }
  ring(116, 128, '#0e0f12');                       // rim edge
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  BLUR_TEX.set(key, tex);
  return tex;
}
const TYRES = { F: { R: 0.2505, W: 0.284 }, R: { R: 0.2545, W: 0.303 } }; // the RB19's radius and width (model units)
const RIM = 0.64; // rim radius as a fraction of the tyre radius (18" rim)

// Tyre-shaped shell (rounded shoulders, like a real low-profile tyre), axle along X. rimFrac: rim radius ÷ R
function tyreShellGeometry(R, W, rimFrac = RIM) {
  const rim = R * rimFrac, rc = (R + rim) / 2, hr = (R - rim) / 2, w2 = W / 2, n = 3.2; // n: higher = squarer shoulders
  const pts = [new THREE.Vector2(rim, -w2 * 0.96)];
  for (let k = 0; k <= 40; k++) {                // outer half of the tyre's cross-section (a rounded rectangle)
    const a = -Math.PI / 2 + (k / 40) * Math.PI, c = Math.cos(a), s = Math.sin(a);
    pts.push(new THREE.Vector2(rc + hr * Math.abs(c) ** (2 / n), w2 * Math.sign(s) * Math.abs(s) ** (2 / n)));
  }
  pts.push(new THREE.Vector2(rim, w2 * 0.96));
  const g = new THREE.LatheGeometry(pts, 56);
  g.rotateZ(Math.PI / 2);
  return g;
}

// Live display on the steering wheel (or the dash): shift lights, gear, speed, throttle and brake.
// aspect: the screen's width ÷ height (the picture is drawn 256 × 108 and centred on a taller screen)
function makeDisplay(aspect = 256 / 108) {
  const c = document.createElement('canvas'); c.width = 256; c.height = Math.max(108, Math.round(256 / aspect));
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return { c, ctx: c.getContext('2d'), tex, last: '' };
}
function drawDisplay(d, state) {
  const speed = Math.round(Math.abs(state.vf ?? 0) * 3.6);
  const box = state.spec?.gearbox ?? F1.gearbox, [r0, r1] = box.rpm;   // this car's gearbox (src/cars/)
  const gb = gearbox(Math.abs(state.vf ?? 0), box);
  const rev = Math.min(1, Math.max(0, (gb.rpm - r0) / (r1 - r0)));
  const key = `${speed}|${gb.gear}|${Math.round(rev * 15)}|${Math.round((state.throttle ?? 0) * 10)}|${Math.round((state.brake ?? 0) * 10)}`;
  if (key === d.last) return; d.last = key;
  const x = d.ctx, W = d.c.width, H = d.c.height;
  x.fillStyle = '#05070a'; x.fillRect(0, 0, W, H);
  x.save(); x.translate(0, (H - 108) / 2); // a taller screen: the picture in the middle
  const lit = Math.round(rev * 15), flash = rev > 0.97 && (Date.now() >> 6) % 2;
  for (let k = 0; k < 15; k++) { // shift lights: green, red, blue
    x.fillStyle = k < lit && !flash ? (k < 5 ? '#19e04a' : k < 10 ? '#ff2a2a' : '#3b6bff') : '#1a1d24';
    x.beginPath(); x.arc(16 + k * 16, 11, 5.5, 0, Math.PI * 2); x.fill();
  }
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = '#ffffff'; x.font = 'bold 64px system-ui, sans-serif'; x.fillText(gb.gear, W / 2, 64);
  x.font = 'bold 26px system-ui, sans-serif'; x.fillText(String(speed), 42, 58);
  x.font = '12px system-ui, sans-serif'; x.fillStyle = '#9aa3b2'; x.fillText('KM/H', 42, 80); x.fillText('GEAR', W / 2, 100);
  x.fillStyle = '#1a1d24'; x.fillRect(196, 36, 18, 58); x.fillRect(222, 36, 18, 58);             // throttle / brake bars
  const t = state.throttle ?? 0, b = state.brake ?? 0;
  x.fillStyle = '#19e04a'; x.fillRect(196, 94 - 58 * t, 18, 58 * t);
  x.fillStyle = '#ff2a2a'; x.fillRect(222, 94 - 58 * b, 18, 58 * b);
  x.restore();
  d.tex.needsUpdate = true;
}

// Wheels, front-wheel steering and steering wheel: each part turns around its own pivot
// (stored in the model file as node extras: `pivot` on the RB19's, `pivotPoint` on a part with children, because
// three.js's loader reads `pivot` there as its own thing). cfg: the car's model settings.
// Models made with tools/prepare-car.mjs also have, in their extras: each tyre's size and rim colour (for the
// motion blur), the brake calipers (hub_FL / hub_FR: steer, don't spin) and where the live screen goes
// (display_anchor). The RB19 has none of those: its tyre sizes are TYRES and its screen is cfg.display.
function rigModel(root, cfg) {
  const byName = (n) => root.getObjectByName(n);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.85, transparent: true, opacity: 0, depthWrite: false });
  const faceMats = new Map(); // one smeared-rim material per rim colour
  const faceMat = (colour) => {
    const key = colour ? colour.join() : '';
    if (!faceMats.has(key)) faceMats.set(key, new THREE.MeshStandardMaterial({ map: blurTexture(colour), roughness: 0.6, metalness: 0.2, transparent: true, opacity: 0, depthWrite: false }));
    return faceMats.get(key);
  };
  for (const id of ['FL', 'FR', 'RL', 'RR']) {
    const node = byName('wheel_' + id); if (!node) continue;
    const p = new THREE.Vector3().fromArray(node.userData.pivotPoint ?? node.userData.pivot ?? node.position.toArray());
    const steer = new THREE.Group(); steer.name = 'steer_' + id; steer.position.copy(p);
    const spin = new THREE.Group(); spin.name = 'spin_' + id;
    node.parent.add(steer); steer.add(spin); spin.add(node);
    node.position.sub(p);
    const hub = byName('hub_' + id); // brake caliper and duct: turn with the wheel, don't spin
    if (hub) { steer.add(hub); hub.position.sub(p); }
    // blur: tread band + a disc on each face (they don't need to spin, they're round)
    const t = node.userData.tyre ?? TYRES[id[0]], rim = t.rim ?? RIM;
    const tread = new THREE.Mesh(tyreShellGeometry(t.R * 1.004, t.W * 0.96, rim), shellMat);
    tread.name = 'blur';
    steer.add(tread);
    if (cfg.tyreStripes) { // the compound's colour band on the outside sidewall (each car colours its own: createModelCar)
      const side = Math.sign(p.x) || 1, band = new THREE.Mesh(new THREE.RingGeometry(t.R * 0.8, t.R * 0.86, 48), COMPOUND_MAT);
      band.rotation.y = side * Math.PI / 2; band.position.x = side * (t.W * 0.5 + 0.003); band.name = 'compound'; spin.add(band);
    }
    for (const face of [-1, 1]) { // smeared wheel cover inside the rim
      const disc = new THREE.Mesh(new THREE.CircleGeometry(t.R * rim * 1.02, 48), faceMat(t.colour));
      disc.rotation.y = face * Math.PI / 2; disc.position.x = face * (t.W * 0.48 + 0.002); disc.name = 'blur';
      steer.add(disc);
    }
  }
  const sw = byName('steering_wheel');
  let screenParent = null, D = null;
  if (sw) {
    const p = new THREE.Vector3().fromArray(sw.userData.pivotPoint ?? sw.userData.pivot ?? sw.position.toArray());
    const pivot = new THREE.Group(); pivot.name = 'steering_pivot'; pivot.position.copy(p);
    pivot.userData.axis = sw.userData.spinAxis ?? [0, 0, -1]; // steering column direction, pointing at the driver
    sw.parent.add(pivot); pivot.add(sw); sw.position.sub(p);
    if (cfg.display) { screenParent = pivot; D = cfg.display; }
  }
  const anchor = byName('display_anchor'); // (on the steering wheel or the dash; it faces the driver along +Z)
  if (anchor) { screenParent = anchor; D = { x: 0, y: 0, z: 0, w: anchor.userData.w, h: anchor.userData.h, front: true }; }
  if (screenParent) { // the live screen (placeholder texture until the car is created)
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(D.w, D.h), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    screen.name = 'display'; screen.position.set(D.x, D.y, D.z); if (!D.front) screen.rotation.y = Math.PI;
    screen.userData.aspect = D.w / D.h;
    screenParent.add(screen);
  }
}

// Load a car's model (once; asking again gives the same load). cfg: the `model` part of a car's file
// (src/cars/). Resolves true when the model is ready, false if it couldn't be loaded.
export function loadCarModel(cfg = CAR_MODEL) {
  if (!cfg?.url) return Promise.resolve(false);
  if (!loading.has(cfg)) loading.set(cfg, loadModel(cfg));
  return loading.get(cfg);
}
function loadModel(cfg) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader.loadAsync(cfg.url).then((gltf) => {
    const model = gltf.scene;
    const f = cfg.finish;
    model.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      o.castShadow = !m.transparent; o.receiveShadow = true; // glass throws no shadow (or the cockpit would be dark)
      if (f && m.isMeshStandardMaterial && !m.userData.finished) {
        m.userData.finished = true;
        if (m.isMeshPhysicalMaterial) { m.clearcoat = f.clearcoat; m.clearcoatRoughness = f.clearcoatRoughness; }
        // cap the shine from the model's metal/roughness texture
        const patch = (sh) => {
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n  roughnessFactor = max(roughnessFactor, ${f.minRoughness.toFixed(3)});`)
            .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n  metalnessFactor = min(metalnessFactor, ${f.maxMetalness.toFixed(3)});`);
        };
        m.onBeforeCompile = patch;
        m.customProgramCacheKey = () => `car-finish-${f.minRoughness}-${f.maxMetalness}`;
      }
    });
    rigModel(model, cfg);
    if (cfg.length) {
      // Scale to the right length, centre it, wheels on the road (y = 0), nose towards +Z
      model.updateMatrixWorld(true);
      let box = new THREE.Box3().setFromObject(model);
      model.scale.setScalar(cfg.length / (box.max.z - box.min.z || 1));
      model.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(model);
      const c = box.getCenter(new THREE.Vector3());
      model.position.set(-c.x, -box.min.y, -c.z + (cfg.offsetZ ?? 0));
    } // (no length: made with tools/prepare-car.mjs, so already in metres, the axles' middle at 0 and the tyres on y = 0)
    const template = new THREE.Group(); template.add(model);
    templates.set(cfg, template);
    return true;
  }).catch((err) => {
    console.warn(`Car model ${cfg.url} couldn't be loaded, using the built-in car.`, err);
    return false;
  });
}

// lite: someone else's car (a friend's, online), seen from outside: no live screen, and the parts in cfg.lite left
// out (cockpit details nobody sees from outside)
function createModelCar(cfg, { lite = false } = {}) {
  const car = new THREE.Group();
  car.rotation.order = 'YXZ'; // yaw first, then pitch in the car's own frame
  car.add(templates.get(cfg).clone());  // geometry and textures are shared between cars
  if (lite) for (const name of cfg.lite ?? []) { const o = car.getObjectByName(name); if (o) o.visible = false; }
  const wheels = [], steerPivots = [], blurMats = new Set();
  let display = null;
  car.traverse((o) => {
    if (o.name.startsWith('spin_')) wheels.push(o);
    if (o.name === 'steer_FL' || o.name === 'steer_FR') steerPivots.push(o);
    if (o.name === 'blur') blurMats.add(o.material);
    if (o.name === 'display') {
      if (lite) { o.visible = false; return; }
      display = makeDisplay(o.userData.aspect); o.material = new THREE.MeshBasicMaterial({ map: display.tex, toneMapped: false });
    }
  });
  const band = new THREE.MeshBasicMaterial({ color: 0xffd12a }); // its own tyre compound colour (syncCarModel)
  car.traverse((o) => { if (o.name === 'compound') o.material = band; });
  // each car fades its own wheel blur
  const own = new Map([...blurMats].map((m) => [m, m.clone()]));
  car.traverse((o) => { if (o.name === 'blur') o.material = own.get(o.material); });
  const steeringWheel = car.getObjectByName('steering_pivot');
  const swAxis = new THREE.Vector3().fromArray(steeringWheel?.userData.axis ?? [0, 0, -1]).normalize();
  car.userData = { model: true, cfg, wheels, steerPivots, blurMats: [...own.values()], steeringWheel, swAxis, display, compoundMat: cfg.tyreStripes ? band : null,
    cams: cfg.cams, spinVis: 0, lastSpin: null, frame: 0 };
  return car;
}

// A car for a team. car: which car (its file in src/cars/; race.carDef).
//   player: your car (or a friend's online): the model in its own livery
//   lite:   seen only from outside (see createModelCar)
// The model is used once it has loaded (loadCarModel); until then, and for AI cars, the built-in car in the
// team's colours (never a copy of your car).
export function createCarModel(team = {}, { player = false, car = F1, lite = false } = {}) {
  const cfg = car.model;
  if (templates.has(cfg) && (player || cfg.forAI)) return createModelCar(cfg, { lite });
  // the car's body shape (BODIES), with its own cameras, unless the car only has the built-in body
  return createBuiltinCar(team, cfg.builtin ?? 'f1', cfg.builtin && !cfg.url ? cfg.cams : null);
}
// Has this car's model loaded?
export const modelReady = (car) => templates.has(car.model);

// Onboard camera positions for this car (a car that swaps detail, carLod.js: the one showing)
export const carCams = (car) => {
  const lod = car?.userData.lod;
  if (lod) return carCams(lod.near ? lod.hi : lod.lo);
  return car?.userData.cams ?? BUILTIN_CAMS;
};

const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const tmpQ = new THREE.Quaternion();

export function syncCarModel(model, state) {
  model.position.set(state.x, state.y ?? 0, state.z);
  model.rotation.y = state.h;
  const u = model.userData, cfg = u.cfg ?? CAR_MODEL; // the model's settings (the built-in car uses the F1 car's)
  if (u.model) {
    // Wheels: follow the real rotation, but never more than maxSpinPerFrame per frame (no backwards strobing),
    // with a motion-blur disc fading in as the speed rises.
    const spin = state.wheelSpin ?? 0;
    const d = u.lastSpin == null ? 0 : spin - u.lastSpin; u.lastSpin = spin;
    u.spinVis += THREE.MathUtils.clamp(d, -cfg.maxSpinPerFrame, cfg.maxSpinPerFrame);
    for (const w of u.wheels) w.rotation.x = u.spinVis;
    const blur = smooth01(cfg.blurSpeed[0], cfg.blurSpeed[1], Math.abs(state.vf ?? state.speed ?? 0));
    for (const m of u.blurMats) { m.opacity = blur; m.visible = blur > 0.01; }
    if (u.display && u.frame++ % 2 === 0) drawDisplay(u.display, state); // steering-wheel screen, 30 times a second
    // Steering wheel: turns with your steering input (full lock = the model's steeringLock)
    if (u.steeringWheel) {
      const k = THREE.MathUtils.clamp((state.steer ?? 0) / Math.max(steerLimit(Math.abs(state.vf ?? 0), state.spec?.physics), 1e-3), -1, 1);
      u.steeringWheel.quaternion.copy(tmpQ.setFromAxisAngle(u.swAxis, k * cfg.steeringLock));
    }
  } else if (u.blurMats) { // the built-in Hypercar and GT3: spoked rims, so like the models: capped spin, blur at speed
    const spin = state.wheelSpin ?? 0, d = u.lastSpin == null ? 0 : spin - u.lastSpin; u.lastSpin = spin;
    u.spinVis += THREE.MathUtils.clamp(d, -cfg.maxSpinPerFrame, cfg.maxSpinPerFrame);
    for (const w of u.wheels) w.rotation.x = u.spinVis;
    const blur = smooth01(cfg.blurSpeed[0], cfg.blurSpeed[1], Math.abs(state.vf ?? state.speed ?? 0));
    for (const m of u.blurMats) { m.opacity = blur; m.visible = blur > 0.01; }
  } else {
    for (const w of u.wheels) w.rotation.x = state.wheelSpin;
  }
  for (const p of u.steerPivots) p.rotation.y = (state.steer ?? 0) * cfg.frontWheelSteer;
  const cmp = state.tyres?.compound; // the tyres it's on (tyres.js): the sidewall band's colour
  if (u.compoundMat && cmp && u.compoundShown !== cmp) { u.compoundShown = cmp; u.compoundMat.color.setHex(COMPOUND_SETS.compounds[cmp].colour); }
  // Follow the slope of the hill, plus a little pitch for weight transfer
  model.rotation.x = -(state.pitch ?? 0) + state.brake * 0.012 - state.throttle * 0.006;
  model.rotation.z = state.roll ?? 0; // lean with banked corners
}