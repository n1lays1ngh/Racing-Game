// Ghost laps (pause menu → Settings → Ghost; shown in practice, with no AI cars).
// Every clean flying lap you drive offline is recorded; your fastest ever at each circuit in each car is kept in this
// browser (IndexedDB, so long laps like the Nürburgring fit) and comes back as a see-through car that drives that lap
// alongside you, starting each time you cross the line. The HUD's live delta is then against it (hud.js).
//
//   GhostRecorder  records your laps in a race (record() every frame, lapDone() for each 'lap' event from race.js)
//   loadGhost(car, circuit) / saveGhost(...)  the stored best lap: { car, circuit, time, at, samples, trace }
//   GhostCar       the see-through car: show(ghost), update(race, camera)
import * as THREE from 'three';
import { createCarModel, syncCarModel } from './carModel.js';
import { newTrace, tracePass, GAP_STEP } from './race.js';

export const GHOST = {
  rate: 30,          // samples a second (positions in between are interpolated)
  opacity: 0.38,     // how see-through the ghost is (0–1)
  fadeNear: [3, 14], // metres: it fades out as it gets this close to your car, so it never blocks your view
  colour: 0x9fd6ff, glow: 0x123a5c,
};
const F = 9; // floats per sample: t, x, y, z, heading, pitch, roll, speed, steer

// ---------- storage ----------
let dbp = null;
// The game's database in this browser: 'ghosts' (best laps, here) and 'replays' (career race replays, replay.js)
export function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('apex-circuit', 2);
    r.onupgradeneeded = () => { for (const n of ['ghosts', 'replays']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
const key = (car, circuit) => `${car}|${circuit}`;
async function request(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('ghosts', mode), r = fn(tx.objectStore('ghosts'));
    tx.oncomplete = () => resolve(r?.result); tx.onerror = () => reject(tx.error);
  });
}
// Your best lap here in this car (null if there isn't one, or storage isn't available)
export async function loadGhost(car, circuit) {
  try { return (await request('readonly', (s) => s.get(key(car, circuit)))) ?? null; } catch { return null; }
}
export async function saveGhost(ghost) {
  try { await request('readwrite', (s) => s.put(ghost, key(ghost.car, ghost.circuit))); return true; } catch { return false; }
}

// ---------- recording ----------
export class GhostRecorder {
  // race: the race (race.js); best: the stored ghost's lap time (only faster laps are kept)
  constructor(race, best = null) {
    this.race = race; this.best = best;
    this.lapNo = race.player.lapsDone; this.prev = null;
    this.begin();
  }
  begin() {
    this.buf = []; this.lastT = -Infinity;
    this.trace = newTrace(Math.ceil(this.race.track.length / GAP_STEP) + 8, false); // lap distance → time, for the HUD delta
  }
  // every frame, after the race has moved on
  record() {
    const p = this.race.player, s = p.state;
    if (p.lapsDone !== this.lapNo) { // over the line (either way): the lap that just ended is kept for lapDone()
      this.prev = { lapNo: this.lapNo, buf: this.buf, trace: this.trace };
      this.lapNo = p.lapsDone; this.begin();
    }
    if (p.lapsDone < 1 || p.finishTime != null) return; // lap 1 starts from the grid: not a ghost lap
    const t = this.race.time - p.lapStart;
    tracePass(this.trace, s.s, t);
    if (t - this.lastT < 1 / GHOST.rate - 1e-4) return; // (the margin: a frame that lands on the mark counts)
    this.lastT = t;
    this.buf.push(t, s.x, s.y ?? 0, s.z, s.h, s.pitch ?? 0, s.roll ?? 0, s.vf ?? 0, s.steer ?? 0);
  }
  // a 'lap' event (race.js): a clean flying lap faster than the stored one becomes the ghost. Returns it, or null.
  lapDone(e) {
    const r = this.prev, L = this.race.track.length;
    if (!e.valid || e.lap < 2 || !r || r.lapNo !== e.lap - 1 || r.buf.length < F * 20) return null;
    if (r.buf[0] > 0.3 || r.buf[r.buf.length - F] < e.time - 0.3 || r.trace.k * GAP_STEP < L * 0.95) return null; // not the whole lap
    if (this.best != null && e.time >= this.best) return null;
    this.best = e.time;
    const tr = r.trace;
    return { car: this.race.carDef.id, circuit: this.race.track.id, time: e.time, at: Date.now(),
      samples: new Float32Array(r.buf), trace: { T: Float32Array.from(tr.T), k: tr.k, p: tr.p, t: tr.t } };
  }
}
// The stored lap's distance → time trace, in the form race.js traceTime() reads
export const ghostTrace = (g) => (g ? { T: g.trace.T, ring: false, k: g.trace.k, p: g.trace.p, t: g.trace.t } : null);

// ---------- the ghost car ----------
const lerpAngle = (a, b, f) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * f;

export class GhostCar {
  constructor(scene) { this.scene = scene; this.model = null; this.ghost = null; this.state = null; }

  // ghost: a stored lap (loadGhost / GhostRecorder.lapDone) or null to take it away. car: the race's car (src/cars/)
  show(ghost, car) {
    this.ghost = ghost;
    if (!ghost) { this.hide(); return; }
    if (!this.model || this.car !== car) {
      this.hide(true);
      this.car = car;
      this.model = createCarModel({ color: GHOST.colour, accent: GHOST.colour }, { player: true, car, lite: true });
      const mat = new THREE.MeshStandardMaterial({ color: GHOST.colour, emissive: GHOST.glow, roughness: 0.45, metalness: 0.1,
        transparent: true, opacity: GHOST.opacity, depthWrite: false });
      this.mat = mat;
      this.model.traverse((o) => {
        if (!o.isMesh) return;
        if (o.name === 'blur' || o.name === 'display') { o.visible = false; return; }
        o.material = mat; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 3;
      });
      this.model.userData.display = null;
      this.state = { x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0, vf: 0, speed: 0, steer: 0, wheelSpin: 0, throttle: 0, brake: 0, spec: car };
      this.scene.add(this.model);
    }
    this.model.visible = false;
  }
  hide(dispose = false) {
    if (!this.model) return;
    if (dispose) { this.scene.remove(this.model); this.mat?.dispose(); this.model = null; } else this.model.visible = false;
  }

  // Where the ghost is now: the same time into its lap as you are into yours. Returns the state (or null: not out).
  update(race, dt) {
    const g = this.ghost, m = this.model, p = race.player;
    if (!g || !m) return null;
    const out = race.state === 'racing' && p.lapsDone >= 1 && p.finishTime == null;
    const t = race.time - p.lapStart, S = g.samples, n = S.length / F;
    if (!out || t > g.time) { m.visible = false; return null; } // between laps it waits at the line
    let lo = 0, hi = n - 1; // the samples either side of t
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid * F] <= t) lo = mid; else hi = mid; }
    const a = lo * F, b = hi * F, f = Math.min(1, Math.max(0, (t - S[a]) / Math.max(S[b] - S[a], 1e-6)));
    const st = this.state, mix = (k) => S[a + k] + (S[b + k] - S[a + k]) * f;
    st.x = mix(1); st.y = mix(2); st.z = mix(3); st.h = lerpAngle(S[a + 4], S[b + 4], f);
    st.pitch = mix(5); st.roll = mix(6); st.vf = st.speed = mix(7); st.steer = mix(8);
    st.wheelSpin += (st.vf * dt) / 0.36;
    syncCarModel(m, st);
    // fade out close to your car
    const d = Math.hypot(st.x - p.state.x, st.z - p.state.z), [n0, n1] = GHOST.fadeNear;
    const fade = Math.min(1, Math.max(0, (d - n0) / (n1 - n0)));
    this.mat.opacity = GHOST.opacity * fade;
    m.visible = fade > 0.02;
    return st;
  }
}