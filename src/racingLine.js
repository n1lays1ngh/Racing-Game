// The racing line drawn on the track (pause menu → Settings → Racing line): the line the AI drives (track.js: the
// racing line offset `ro`), green where you can be on the throttle and red where you need to brake for the next corner.
// The braking zones come from the same speed plan the AI uses (ai.js buildSpeedProfile), worked out for the car you
// drive with your grip (race.playerProfile), so they move with the car: a GT3 brakes much earlier than an F1 car.
// lineColours() is also what the close-up minimap colours its line with (hud.js).
import * as THREE from 'three';
import { bankLift } from './banking.js';

export const RACING_LINE = {
  width: 0.9,       // metres
  lift: 0.075,      // above the road (the tarmac is at 0.06, skid marks just above it)
  green: [0.12, 0.85, 0.36, 0.55],  // r, g, b, opacity
  red: [1.0, 0.16, 0.12, 0.78],
  brakeAbove: 3.5,  // m/s² of slowing more than lifting off would give = braking (red)
  blend: 3,         // samples (~2 m each) the colours fade over at each end of a braking zone
};

// How hard you're braking at each point of the lap (0 = throttle, 1 = braking), for this car.
// profile: the fastest you can go at each sample (braking-limited, ai.js); the car accelerates out of the corners
// as hard as its engine allows (physics.js: accel fading with speed, minus drag and rolling resistance).
export function brakeZones(track, profile, p) {
  const { n, ds } = track, u = new Float32Array(n);
  u.set(profile);
  for (let loop = 0; loop < 2; loop++) { // accelerate out of each corner (twice round, so the line is joined up)
    for (let k = 1; k <= n; k++) {
      const i = k % n, prev = u[k - 1], grade = track.grade ? track.grade[i] : 0;
      const a = p.accel * (1 - p.accelFade * Math.min(prev / 90, 1)) - p.drag * prev * prev - p.roll - p.g * grade;
      u[i] = Math.min(profile[i], Math.sqrt(Math.max(0, prev * prev + 2 * Math.max(a, 0) * ds)));
    }
  }
  const brake = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = u[i], next = u[(i + 1) % n];
    const decel = (v * v - next * next) / (2 * ds), coast = p.drag * v * v + p.roll + (p.liftOff ?? 0);
    brake[i] = decel > coast + RACING_LINE.brakeAbove ? 1 : 0;
  }
  // soften the ends so the colour fades rather than switches
  const out = new Float32Array(n), B = RACING_LINE.blend;
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let d = -B; d <= B; d++) { const k = B + 1 - Math.abs(d); s += brake[(i + d + n) % n] * k; w += k; }
    out[i] = Math.min(1, (s / w) * 1.6);
  }
  return out;
}

// [r, g, b, a] at each sample
export function lineColours(zones) {
  const { green: G, red: R } = RACING_LINE, c = new Float32Array(zones.length * 4);
  zones.forEach((z, i) => { for (let k = 0; k < 4; k++) c[i * 4 + k] = G[k] + (R[k] - G[k]) * z; });
  return c;
}

// The mesh: a thin ribbon on the racing line, following the hills and the banking. Unlit, so it's as clear at night.
export function buildRacingLine(track, profile, physics) {
  const { n } = track, zones = brakeZones(track, profile, physics), col = lineColours(zones), W = RACING_LINE.width / 2;
  const pos = new Float32Array((n + 1) * 6), colour = new Float32Array((n + 1) * 8), idx = [];
  for (let k = 0; k <= n; k++) {
    const i = k % n, o = track.ro[i];
    for (let e = 0; e < 2; e++) {
      const lat = o + (e ? W : -W), j = k * 2 + e;
      pos.set([track.cx[i] + track.nx[i] * lat, (track.h ? track.h[i] : 0) + bankLift(track, i, lat) + RACING_LINE.lift,
        track.cz[i] + track.nz[i] * lat], j * 3);
      colour.set(col.subarray(i * 4, i * 4 + 4), j * 4);
    }
  }
  for (let k = 0; k < n; k++) { const a = k * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colour, 4));
  g.setIndex(idx);
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'racingLine';
  mesh.renderOrder = 2;          // over the road and the skid marks
  mesh.frustumCulled = false;    // one long strip round the whole circuit
  mesh.userData.zones = zones;
  return mesh;
}

export function disposeRacingLine(mesh) {
  if (!mesh) return;
  mesh.parent?.remove(mesh);
  mesh.geometry.dispose(); mesh.material.dispose();
}