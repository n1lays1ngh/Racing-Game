// Your car's headlights: the Hypercar and the GT3 have them (`headlights` in their file in src/cars/), the F1
// car doesn't. They come on by themselves at night and H (D-pad ← on a controller) switches them on or off.
//
//  • Two real spotlights, one at each lamp, aimed just below level. A "cookie" (a little picture the light
//    shines through, like a slide in a projector) shapes them like a race car's main beams: a bright, wide
//    band reaching far down the track, a soft top edge a few degrees above level, and less light on the road
//    right in front of the car (which is close, so it would glare). They light everything: the cars ahead,
//    barriers, boards, trees and the road.
//  • Light that grazes the road at a low angle hardly lights it (that's real: in your beams the car ahead and
//    the walls look far brighter than the road), so the ground also gets a pool of light worked out in its
//    own shader (HEADLIGHT in lighting.js), set here every frame.
//  • The lamps on the model glow while they're on.
// The lights stay in the scene the whole race (switching them off only turns them down): adding or removing a
// light makes every material rebuild its shader, which would stutter.
import * as THREE from 'three';
import { HEADLIGHT } from './lighting.js';

export const HEADLIGHTS = {
  intensity: 450,          // each lamp; the light on what it hits falls with the square of the distance, so a car
                           // 30 m ahead gets 2 × 450 / 30² = 1 (about as bright as under the floodlights on a lit night)
  reach: 260,              // metres: no light beyond this
  angle: 0.62,             // radians: half the width of the cone the cookie is drawn in (±35°)
  aim: -1.0,               // degrees: the brightest part of the beam, below level
  spread: [12, 30],        // degrees: half-width of the bright middle and of the wide edge of the beam
  top: [1, 6],             // degrees above level where the beam starts to fade and where it's gone
  road: 2.4,               // the pool of light on the ground: brightness …
  roadReach: 38,           // … and the distance (m) at which it's half that
  roadSpread: [0.22, 0.6], // radians: its narrow bright middle and wide edge
  glow: 5,                 // how bright the lamps on the car look while on
  fade: 0.12,              // seconds to come on / go off
  auto: ['dusk', 'night', 'dark'], // times of day (lighting.js) they're on by themselves at the start
};

const deg = Math.PI / 180;
let COOKIE = null;
function cookie() {
  if (COOKIE) return COOKIE;
  const H = HEADLIGHTS, N = 128, T = Math.tan(H.angle), data = new Uint8Array(N * N * 4);
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const tx = ((i + 0.5) / N * 2 - 1) * T, ty = ((j + 0.5) / N * 2 - 1) * T; // row 0 is the bottom
    const a = Math.atan(tx) / deg, e = Math.atan(ty / Math.sqrt(1 + tx * tx)) / deg + H.aim; // across, and above level
    const vert = e > H.top[0] ? 1 - smooth(H.top[0], H.top[1], e) : e > -2 ? 1 : Math.max(Math.exp((e + 2) / 4), 0.04);
    const across = 0.72 * Math.exp(-((a / H.spread[0]) ** 2)) + 0.28 * Math.exp(-((a / H.spread[1]) ** 2));
    const v = Math.round(255 * Math.min(1, vert * across)), k = (j * N + i) * 4;
    data[k] = data[k + 1] = data[k + 2] = v; data[k + 3] = 255;
  }
  COOKIE = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  COOKIE.colorSpace = THREE.NoColorSpace; COOKIE.magFilter = COOKIE.minFilter = THREE.LinearFilter;
  COOKIE.generateMipmaps = false; COOKIE.needsUpdate = true;
  return COOKIE;
}

const tmpV = new THREE.Vector3(), tmpF = new THREE.Vector3();

export class Headlights {
  constructor() {
    const H = HEADLIGHTS;
    this.lamps = [-1, 1].map(() => {
      const light = new THREE.SpotLight(0xffffff, 0, H.reach, H.angle, 0.3, 2);
      light.map = cookie(); light.castShadow = false;
      light.target = new THREE.Object3D();
      return light;
    });
    this.model = null; this.cfg = null; this.on = false; this.level = 0; this.glowing = [];
  }

  // Put the lights on a car (your car's model; car: its file in src/cars/). A car without headlights: none.
  // on: whether they start on (usually: is it night? see autoOn)
  attach(model, car, on = false) {
    this.detach();
    const cfg = car?.headlights;
    if (!model || !cfg) return;
    this.model = model; this.cfg = cfg; this.on = on; this.level = on ? 1 : 0;
    const [x, y, z] = cfg.at, drop = Math.tan(HEADLIGHTS.aim * deg) * 20;
    this.lamps.forEach((light, k) => {
      const side = k ? -1 : 1;                        // left lamp (+x), right lamp
      light.color.setHex(cfg.colour ?? 0xf2f5ff);
      light.position.set(side * x, y, z);
      light.target.position.set(side * x, y + drop, z + 20);
      model.add(light, light.target);
    });
    HEADLIGHT.color.value.setHex(cfg.colour ?? 0xf2f5ff);
    // the lamps on the model (lights_front parts, or the built-in car's headlights), with their own materials
    const lamps = [];
    model.getObjectByName('lights_front')?.traverse((o) => { if (o.isMesh && (!cfg.lamps || cfg.lamps.includes(o.material.name))) lamps.push(o); });
    model.traverse((o) => { if (o.isMesh && o.name === 'builtin_head') lamps.push(o); });
    this.glowing = lamps.map((o) => {
      const m = o.material.clone(); o.material = m;
      return { m, emissive: m.emissive.clone(), intensity: m.emissiveIntensity };
    });
    this.apply();
  }
  detach() {
    for (const light of this.lamps) { light.parent?.remove(light); light.target.parent?.remove(light.target); }
    this.model = null; this.cfg = null; this.glowing = []; this.level = 0;
    HEADLIGHT.on.value = 0;
  }
  get has() { return !!this.cfg; }
  set(on) { if (this.cfg) this.on = on; }
  toggle() { this.set(!this.on); return this.on; }

  // Every frame, after the car models have moved: fade, and the pool of light on the ground
  update(dt, state) {
    if (!this.cfg) return;
    const target = this.on ? 1 : 0;
    if (this.level !== target) this.level = target > this.level ? Math.min(1, this.level + dt / HEADLIGHTS.fade) : Math.max(0, this.level - dt / HEADLIGHTS.fade);
    if (state) state.lightsOn = this.on;
    this.apply();
  }
  apply() {
    const H = HEADLIGHTS, k = this.level * (this.cfg?.intensity ?? 1);
    for (const light of this.lamps) light.intensity = H.intensity * k;
    for (const g of this.glowing) {
      if (this.level > 0) { g.m.emissive.setHex(this.cfg.colour ?? 0xf2f5ff); g.m.emissiveIntensity = Math.max(g.intensity, H.glow * this.level); }
      else { g.m.emissive.copy(g.emissive); g.m.emissiveIntensity = g.intensity; }
    }
    HEADLIGHT.on.value = H.road * k;
    if (k > 0 && this.model) { // where the lamps are and which way the car points, in the world
      const m = this.model; m.updateWorldMatrix(true, false);
      tmpV.set(0, this.cfg.at[1], this.cfg.at[2]).applyMatrix4(m.matrixWorld);
      tmpF.set(0, 0, 1).transformDirection(m.matrixWorld);
      HEADLIGHT.pos.value.copy(tmpV);
      HEADLIGHT.dir.value.set(tmpF.x, tmpF.z).normalize();
      HEADLIGHT.shape.value.set(H.roadReach, H.roadSpread[0], H.roadSpread[1], Math.tan(H.top[1] * deg));
    }
  }
}

// Should the lights be on at the start? time: the time of day the circuit is lit for (timeOf in lighting.js)
export const autoOn = (time) => HEADLIGHTS.auto.includes(time);