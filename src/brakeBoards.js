// Braking boards: 300 / 200 / 100 m countdown signs before every big braking zone, like at a real circuit.
// They stand beside the track on the side you'll be driving on (the outside of the corner coming up), turned
// a little towards you so you can read them. "Brake at the 100 board" works the way it does in real racing.
//
// Where they go is worked out from the circuit, so every circuit gets them with nothing to set up:
// an ideal lap (the AI's speed plan, limited by how fast the car can actually accelerate) shows where a
// fast lap brakes hard; the boards count down to the end of that braking zone (about where you turn in).
// That depends on the car you're racing (car: its file in src/cars/; a slower car brakes in fewer places).
//
//   findBrakingZones(track, car)           → [{ i, s, entry, exit, side }]   numbers only, no 3D
//   buildBrakeBoards(track, heightAt, car) → THREE.Group                    scenery.js adds it to the circuit
import * as THREE from 'three';
import { buildSpeedProfile } from './ai.js';
import F1 from './cars/f1.js';

export const BRAKE_BOARDS = {
  enabled: true,
  distances: [300, 200, 100],  // metres before the corner (add 50 for a fourth board)
  minDrop: 70,                 // km/h: only braking zones where a fast lap loses at least this much speed …
  minEntry: 200,               // km/h: … and that it arrives at at least this fast
  size: [1.6, 1.15],           // board width and height (m)
  raise: 1.0,                  // bottom edge of the board above the ground (m); higher in front of a wall
  gap: 2.5,                    // metres beyond the kerb (less if the barrier is closer than that)
  toward: 0.3,                 // radians the board is turned towards the track
  straightOnly: 1 / 160,       // no board where the track curves tighter than this (1 / radius in metres)
};

const mod = (v, m) => ((v % m) + m) % m;

// Speed (m/s) at every sample on an ideal lap: as fast as the corners allow, but no faster than the car accelerates.
function idealSpeeds(track, p) {
  const { n, ds } = track, cap = buildSpeedProfile(track, 1, 0.97, 0.9, p);
  const accel = (u) => p.accel * (1 - p.accelFade * Math.min(Math.max(u, 0) / 90, 1)) - p.drag * u * u - p.roll;
  let i0 = 0;
  for (let i = 1; i < n; i++) if (cap[i] < cap[i0]) i0 = i;      // start from the slowest corner
  const v = new Float32Array(n);
  let u = cap[i0];
  for (let k = 0; k <= 2 * n; k++) {                               // twice round, so the start doesn't matter
    const i = (i0 + k) % n;
    u = Math.min(cap[i], u);
    v[i] = u;
    u = Math.sqrt(u * u + 2 * Math.max(accel(u), 0) * ds);
  }
  return v;
}

// The big braking zones: where an ideal lap slows down a lot from high speed.
export function findBrakingZones(track, car = F1) {
  const { n, ds } = track, B = BRAKE_BOARDS, v = idealSpeeds(track, car.physics);
  // runs of samples where the car is slowing down (a few metres of not slowing don't end a run)
  const slowing = (i) => v[(i + 1) % n] < v[i] - 1e-3;
  let start = 0;
  while (start < n && slowing(start)) start++;                     // begin outside a braking zone
  const zones = [];
  let run = null, calm = 0;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (slowing(i)) { if (!run) run = { a: i }; run.b = (i + 1) % n; calm = 0; }
    else if (run && ++calm > 8) { zones.push(run); run = null; }
  }
  if (run) zones.push(run);
  const out = [];
  for (const z of zones) {
    const entry = v[z.a] * 3.6, exit = v[z.b] * 3.6;
    if (entry < B.minEntry || entry - exit < B.minDrop) continue;
    // which way the corner goes: boards on the outside (left-hander → on the right)
    let k = 0;
    for (let d = -10; d <= 40; d++) k += track.curv[(z.b + d + n) % n];
    out.push({ i: z.b, s: z.b * ds, a: z.a, entry, exit, side: k > 0 ? -1 : 1 });
  }
  return out;
}

// ---------- the 3D boards ----------
let KIT = null; // textures and materials, made once and shared by every circuit
function kit() {
  if (KIT) return KIT;
  const face = (label) => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 184;
    const g = c.getContext('2d');
    g.fillStyle = '#f4f5f2'; g.fillRect(0, 0, 256, 184);
    g.strokeStyle = '#111'; g.lineWidth = 12; g.strokeRect(6, 6, 244, 172);
    g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `900 ${label.length > 2 ? 112 : 128}px "Titillium Web", system-ui, Arial, sans-serif`;
    g.fillText(label, 128, 98);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  };
  const frame = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.4 });
  KIT = { frame, faces: new Map(), face };
  return KIT;
}
function faceMaterial(d) {
  const K = kit();
  if (!K.faces.has(d)) {
    const map = K.face(String(d));
    K.faces.set(d, new THREE.MeshStandardMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.06, roughness: 0.55 }));
  }
  return K.faces.get(d);
}

// heightAt(x, z): the ground's height there (terrain.js); car: the car you're racing (src/cars/)
export function buildBrakeBoards(track, heightAt, car = F1) {
  const group = new THREE.Group();
  group.name = 'brake-boards';
  if (!BRAKE_BOARDS.enabled) return group;
  const B = BRAKE_BOARDS, { n, ds, length } = track, K = kit();
  const lit = track.time === 'night' ? 0.55 : track.time === 'dusk' ? 0.3 : 0.06; // boards glow a little under the floodlights
  for (const d of B.distances) faceMaterial(d).emissiveIntensity = lit;
  const [w, h] = B.size;
  const panel = new THREE.BoxGeometry(w, h, 0.08);
  const zones = findBrakingZones(track, car);
  zones.forEach((z, k) => {
    const prev = zones[(k - 1 + zones.length) % zones.length];
    const room = zones.length > 1 ? mod(z.a - prev.i, n) * ds - 40 : length; // metres of straight since the last big corner
    const braking = mod(z.i - z.a, n) * ds;                                      // length of this braking zone
    for (const d of B.distances) {
      if (d > room + braking) continue;                                          // would stand in the last corner
      const i = Math.floor(mod(z.s - d, length) / ds) % n;
      if (Math.abs(track.curv[i]) > B.straightOnly) continue;                   // not on a bend
      if (track.forest?.[i]) continue;                                          // nor in the woods (only trees there)
      const side = z.side, E = track.hw[i] + track.kerb;
      let wall = side > 0 ? track.wallL[i] : track.wallR[i];
      const pit = track.pitLane;
      if (pit && pit.range[i] && pit.side === side) { if (!pit.wall[i]) continue; wall = Math.min(wall, pit.wall[i]); } // pit lane on that side
      const lateral = Math.max(E + 0.3, Math.min(E + B.gap, wall - 0.7));
      const nearWall = wall - lateral < 1.5;
      const x = track.cx[i] + track.nx[i] * side * lateral, z0 = track.cz[i] + track.nz[i] * side * lateral;
      const y0 = heightAt(x, z0), raise = nearWall ? Math.max(B.raise, 1.4) : B.raise; // in front of a wall: above it
      const board = new THREE.Group();
      board.position.set(x, y0, z0);
      board.rotation.y = Math.atan2(track.tx[i], track.tz[i]) + Math.PI + side * B.toward; // facing the cars coming
      const mats = [K.frame, K.frame, K.frame, K.frame, faceMaterial(d), K.frame];       // +Z face: the number
      const p = new THREE.Mesh(panel, mats); p.position.y = raise + h / 2; p.castShadow = true;
      board.add(p);
      for (const sx of [-0.32, 0.32]) {                                                  // two posts
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, raise + h * 0.6, 0.1), K.frame);
        post.position.set(sx * w, (raise + h * 0.6) / 2, -0.06); post.castShadow = true;
        board.add(post);
      }
      group.add(board);
    }
  });
  return group;
}