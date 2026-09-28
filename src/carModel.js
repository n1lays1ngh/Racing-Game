// How the cars look.
//
//  • Your car: the 3D model in public/models/rb19.glb (settings in CAR_MODEL below).
//    The model is rigged when it loads: the four wheels spin, the front wheels steer,
//    and the steering wheel in the cockpit turns as you steer.
//  • AI cars (and your car if the .glb can't be loaded): a built-in procedural car,
//    painted in each team's colours (createBuiltinCar further down).
//
// "Oracle Red Bull F1 Car RB19 2023" model by Redgrund
// (https://sketchfab.com/3d-models/oracle-red-bull-f1-car-rb19-2023-e4afe46f3aab4b23a418da06fc163821),
// licensed CC-BY-4.0. Prepared for the game with glTF-Transform: wheels and steering wheel split
// into their own parts around their real pivot points, compressed from 40 MB to 3.3 MB.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { steerLimit, gearbox } from './physics.js';

export const CAR_MODEL = {
  url: '/models/rb19.glb',  // null = use the built-in car
  length: 5.6,              // nose to rear wing in metres (the model is scaled to this)
  offsetZ: 0.29,            // slides the model so its wheels sit on the physics wheelbase (±1.8 m)
  forAI: false,             // true = every car on the grid is an RB19
  steeringLock: 1.75,       // steering wheel rotation at full lock (radians, 1.75 ≈ 100°)
  frontWheelSteer: 1.4,     // how far the front wheels turn compared with the physics steer angle
  maxSpinPerFrame: 0.5,     // cap on wheel rotation per frame, so fast wheels don't strobe backwards
  blurSpeed: [4, 11],       // m/s where the motion blur on the wheels starts / is complete
  // Paint finish: the RB19 is matte. Lower maxMetalness / raise minRoughness for less shine.
  finish: { maxMetalness: 0.2, minRoughness: 0.5, clearcoat: 0.06, clearcoatRoughness: 0.3 },
  // Onboard cameras for this model: z = metres forward (+) / back (−) from the car's centre,
  // y = metres above the road, tilt = degrees up (+) / down (−).
  cams: { tcam: { z: -0.40, y: 1.50, tilt: -5 }, cockpit: { z: 0.25, y: 0.80, tilt: -4 } },
  // Steering-wheel display, in model units from the steering wheel's centre (x right, y up, z forward)
  display: { x: 0, y: 0.006, z: -0.0088, w: 0.064, h: 0.027 },
};
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

function createBuiltinCar({ color = 0xe10600, accent = 0xffffff, number = 1 } = {}) {
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
    tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92, side: THREE.DoubleSide }),
    cover: new THREE.MeshStandardMaterial({ color: 0x202226, metalness: 0.8, roughness: 0.3 }),
    number: new THREE.MeshStandardMaterial({ map: numberTexture(number, color), roughness: 0.4 }),
  };
  // paint = lofted bodywork with the livery wrap; body = flat painted parts in the base colour
  const B = { paint: [], body: [], accent: [], carbon: [], dark: [], helmet: [], visor: [], light: [] };

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
    num.position.set(s * 0.012, 0.8, -0.95); num.rotation.y = s * Math.PI / 2; car.add(num);
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

  // Merge each material bucket into one mesh
  for (const [key, list] of Object.entries(B)) {
    if (!list.length) continue;
    const geo = mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      return g;
    }));
    const mesh = new THREE.Mesh(geo, M[key]);
    mesh.castShadow = true; mesh.receiveShadow = true;
    car.add(mesh);
  }

  // --- Wheels: 18" rims with covers, low-profile tyres, compound stripe ---
  const compound = new THREE.MeshBasicMaterial({ color: COMPOUNDS[number % 3] });
  const wheels = [], steerPivots = [];
  const makeWheel = (x, z, width, front) => {
    const R = 0.36, rim = 0.232, w2 = width / 2;
    const pivot = new THREE.Group(); pivot.position.set(x, R, z); car.add(pivot);
    const wheel = new THREE.Group(); pivot.add(wheel);
    const prof = [[rim, -w2], [0.3, -w2], [0.343, -w2 + 0.015], [R, -w2 + 0.06], [R, w2 - 0.06], [0.343, w2 - 0.015], [0.3, w2], [rim, w2]]
      .map(([rr, y]) => new THREE.Vector2(rr, y));
    const tyre = new THREE.Mesh(new THREE.LatheGeometry(prof, 36), M.tyre);
    tyre.rotation.z = Math.PI / 2; tyre.castShadow = true; wheel.add(tyre);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rim, rim, width - 0.01, 32), M.cover);
    barrel.rotation.z = Math.PI / 2; wheel.add(barrel);
    const side = Math.sign(x);
    for (const face of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.RingGeometry(0.29, 0.305, 40), compound);
      stripe.position.x = face * (w2 + 0.001); stripe.rotation.y = face * Math.PI / 2; wheel.add(stripe);
    }
    for (let k = 0; k < 3; k++) { // marks on the wheel cover so you can see it spin
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.09, 0.03), compound);
      mark.position.set(side * (w2 - 0.002), Math.cos((k * 2 * Math.PI) / 3) * 0.15, Math.sin((k * 2 * Math.PI) / 3) * 0.15);
      mark.rotation.x = (k * 2 * Math.PI) / 3; wheel.add(mark);
    }
    wheels.push(wheel); if (front) steerPivots.push(pivot);
  };
  makeWheel(-0.8, 1.8, 0.3, true);
  makeWheel(0.8, 1.8, 0.3, true);
  makeWheel(-0.78, -1.8, 0.4, false);
  makeWheel(0.78, -1.8, 0.4, false);

  car.userData = { wheels, steerPivots, cams: BUILTIN_CAMS };
  return car;
}

// Called every frame with the physics state.
// ---------- the RB19 (.glb) ----------
let template = null;

// Motion blur for the wheels: a smeared cover on each face and a smooth tread band that fade in with
// speed. Above ~40 km/h they hide the real wheel, which keeps turning underneath (capped, so it never
// strobes backwards) — the same trick racing games use.
let BLUR_TEX = null;
function blurTexture() {
  if (BLUR_TEX) return BLUR_TEX;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'), m = 128;
  const ring = (r0, r1, style) => { x.beginPath(); x.arc(m, m, r1, 0, Math.PI * 2); x.arc(m, m, r0, 0, Math.PI * 2, true); x.fillStyle = style; x.fill(); };
  ring(0, 116, '#1b2030');                       // wheel cover, logos smeared into rings
  for (let r = 10; r < 112; r += 13) ring(r, r + 3, 'rgba(90,100,130,0.35)');
  ring(34, 42, 'rgba(200,40,50,0.45)');          // red of the logo turned into a ring
  ring(116, 128, '#0e0f12');                     // rim edge
  BLUR_TEX = new THREE.CanvasTexture(c); BLUR_TEX.colorSpace = THREE.SRGBColorSpace;
  return BLUR_TEX;
}
const TYRES = { F: { R: 0.2505, W: 0.284 }, R: { R: 0.2545, W: 0.303 } }; // radius and width (model units)
const RIM = 0.64; // rim radius as a fraction of the tyre radius (18" rim)

// Tyre-shaped shell (rounded shoulders, like a real low-profile tyre), axle along X.
function tyreShellGeometry(R, W) {
  const rim = R * RIM, rc = (R + rim) / 2, hr = (R - rim) / 2, w2 = W / 2, n = 3.2; // n: higher = squarer shoulders
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

// Live display on the steering wheel: shift lights, gear, speed, throttle and brake.
function makeDisplay() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 108;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return { c, ctx: c.getContext('2d'), tex, last: '' };
}
function drawDisplay(d, state) {
  const speed = Math.round(Math.abs(state.vf ?? 0) * 3.6);
  const gb = gearbox(Math.abs(state.vf ?? 0));
  const rev = Math.min(1, Math.max(0, (gb.rpm - 6000) / 7000));
  const key = `${speed}|${gb.gear}|${Math.round(rev * 15)}|${Math.round((state.throttle ?? 0) * 10)}|${Math.round((state.brake ?? 0) * 10)}`;
  if (key === d.last) return; d.last = key;
  const x = d.ctx, W = d.c.width, H = d.c.height;
  x.fillStyle = '#05070a'; x.fillRect(0, 0, W, H);
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
  d.tex.needsUpdate = true;
}

// Wheels, front-wheel steering and steering wheel: each part turns around its own pivot
// (stored in the model file as node extras).
function rigModel(root) {
  const byName = (n) => root.getObjectByName(n);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.85, transparent: true, opacity: 0, depthWrite: false });
  const faceMat = new THREE.MeshStandardMaterial({ map: blurTexture(), roughness: 0.6, metalness: 0.2, transparent: true, opacity: 0, depthWrite: false });
  for (const id of ['FL', 'FR', 'RL', 'RR']) {
    const node = byName('wheel_' + id); if (!node) continue;
    const p = new THREE.Vector3().fromArray(node.userData.pivot ?? node.position.toArray());
    const steer = new THREE.Group(); steer.name = 'steer_' + id; steer.position.copy(p);
    const spin = new THREE.Group(); spin.name = 'spin_' + id;
    node.parent.add(steer); steer.add(spin); spin.add(node);
    node.position.sub(p);
    // blur: tread band + a disc on each face (they don't need to spin, they're round)
    const { R, W } = TYRES[id[0]];
    const tread = new THREE.Mesh(tyreShellGeometry(R * 1.004, W * 0.96), shellMat);
    tread.name = 'blur';
    steer.add(tread);
    for (const face of [-1, 1]) { // smeared wheel cover inside the rim
      const disc = new THREE.Mesh(new THREE.CircleGeometry(R * RIM * 1.02, 48), faceMat);
      disc.rotation.y = face * Math.PI / 2; disc.position.x = face * (W * 0.48 + 0.002); disc.name = 'blur';
      steer.add(disc);
    }
  }
  const sw = byName('steering_wheel');
  if (sw) {
    const p = new THREE.Vector3().fromArray(sw.userData.pivot ?? sw.position.toArray());
    const pivot = new THREE.Group(); pivot.name = 'steering_pivot'; pivot.position.copy(p);
    pivot.userData.axis = sw.userData.spinAxis ?? [0, 0, -1]; // steering column direction, pointing at the driver
    sw.parent.add(pivot); pivot.add(sw); sw.position.sub(p);
    const D = CAR_MODEL.display; // screen facing the driver (placeholder texture until the car is created)
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(D.w, D.h), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    screen.name = 'display'; screen.position.set(D.x, D.y, D.z); screen.rotation.y = Math.PI;
    pivot.add(screen);
  }
}

// Load once at startup. Resolves true when the model is ready, false if it couldn't be loaded.
export function loadCarModel(cfg = CAR_MODEL) {
  if (!cfg.url) return Promise.resolve(false);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader.loadAsync(cfg.url).then((gltf) => {
    const model = gltf.scene;
    const f = cfg.finish;
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      const m = o.material;
      if (f && m.isMeshStandardMaterial && !m.userData.finished) {
        m.userData.finished = true;
        if (m.isMeshPhysicalMaterial) { m.clearcoat = f.clearcoat; m.clearcoatRoughness = f.clearcoatRoughness; }
        // cap the shine from the model's metal/roughness texture
        m.onBeforeCompile = (sh) => {
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n  roughnessFactor = max(roughnessFactor, ${f.minRoughness.toFixed(3)});`)
            .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n  metalnessFactor = min(metalnessFactor, ${f.maxMetalness.toFixed(3)});`);
        };
        m.customProgramCacheKey = () => `car-finish-${f.minRoughness}-${f.maxMetalness}`;
      }
    });
    rigModel(model);
    // Scale to the right length, centre it, wheels on the road (y = 0), nose towards +Z
    model.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(model);
    model.scale.setScalar(cfg.length / (box.max.z - box.min.z || 1));
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    model.position.set(-c.x, -box.min.y, -c.z + cfg.offsetZ);
    template = new THREE.Group(); template.add(model);
    return true;
  }).catch((err) => {
    console.warn(`Car model ${cfg.url} couldn't be loaded, using the built-in car.`, err);
    return false;
  });
}

function createModelCar() {
  const car = new THREE.Group();
  car.rotation.order = 'YXZ'; // yaw first, then pitch in the car's own frame
  car.add(template.clone());  // geometry and textures are shared between cars
  const wheels = [], steerPivots = [], blurMats = new Set();
  let display = null;
  car.traverse((o) => {
    if (o.name.startsWith('spin_')) wheels.push(o);
    if (o.name === 'steer_FL' || o.name === 'steer_FR') steerPivots.push(o);
    if (o.name === 'blur') blurMats.add(o.material);
    if (o.name === 'display') { display = makeDisplay(); o.material = new THREE.MeshBasicMaterial({ map: display.tex, toneMapped: false }); }
  });
  // each car fades its own wheel blur
  const own = new Map([...blurMats].map((m) => [m, m.clone()]));
  car.traverse((o) => { if (o.name === 'blur') o.material = own.get(o.material); });
  const steeringWheel = car.getObjectByName('steering_pivot');
  const swAxis = new THREE.Vector3().fromArray(steeringWheel?.userData.axis ?? [0, 0, -1]).normalize();
  car.userData = { model: true, wheels, steerPivots, blurMats: [...own.values()], steeringWheel, swAxis, display,
    cams: CAR_MODEL.cams, spinVis: 0, lastSpin: null, frame: 0 };
  return car;
}

// A car for a team. player = true for your car.
export function createCarModel(team = {}, { player = false } = {}) {
  if (template && (player || CAR_MODEL.forAI)) return createModelCar();
  return createBuiltinCar(team);
}

// Onboard camera positions for this car
export const carCams = (car) => car?.userData.cams ?? BUILTIN_CAMS;

const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const tmpQ = new THREE.Quaternion();

export function syncCarModel(model, state) {
  model.position.set(state.x, state.y ?? 0, state.z);
  model.rotation.y = state.h;
  const u = model.userData;
  if (u.model) {
    // Wheels: follow the real rotation, but never more than maxSpinPerFrame per frame (no backwards strobing),
    // with a motion-blur disc fading in as the speed rises.
    const spin = state.wheelSpin ?? 0;
    const d = u.lastSpin == null ? 0 : spin - u.lastSpin; u.lastSpin = spin;
    u.spinVis += THREE.MathUtils.clamp(d, -CAR_MODEL.maxSpinPerFrame, CAR_MODEL.maxSpinPerFrame);
    for (const w of u.wheels) w.rotation.x = u.spinVis;
    const blur = smooth01(CAR_MODEL.blurSpeed[0], CAR_MODEL.blurSpeed[1], Math.abs(state.vf ?? state.speed ?? 0));
    for (const m of u.blurMats) { m.opacity = blur; m.visible = blur > 0.01; }
    if (u.display && u.frame++ % 2 === 0) drawDisplay(u.display, state); // steering-wheel screen, 30 times a second
    // Steering wheel: turns with your steering input (full lock = CAR_MODEL.steeringLock)
    if (u.steeringWheel) {
      const k = THREE.MathUtils.clamp((state.steer ?? 0) / Math.max(steerLimit(Math.abs(state.vf ?? 0)), 1e-3), -1, 1);
      u.steeringWheel.quaternion.copy(tmpQ.setFromAxisAngle(u.swAxis, k * CAR_MODEL.steeringLock));
    }
  } else {
    for (const w of u.wheels) w.rotation.x = state.wheelSpin;
  }
  for (const p of u.steerPivots) p.rotation.y = (state.steer ?? 0) * CAR_MODEL.frontWheelSteer;
  // Follow the slope of the hill, plus a little pitch for weight transfer
  model.rotation.x = -(state.pitch ?? 0) + state.brake * 0.012 - state.throttle * 0.006;
  model.rotation.z = state.roll ?? 0; // lean with banked corners
}