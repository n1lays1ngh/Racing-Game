// The pit crews (what you see of a pit stop; the stop itself is pitstop.js). Every car's crew waits in front of its
// garage in the team's colours, by two stacks of tyres and the box painted on the pit lane. When their car comes in
// they go out to it: a wheel gun and a tyre man at each wheel, the front and rear jacks, the lollipop. The car goes up
// on the jacks, each wheel comes off and a fresh one goes on, the car drops and goes, and the crew walks back in.
//
//   const crews = new PitCrews(scene, race)   when a race starts (main.js, showcase.js)
//   crews.update(dt, models)                  every frame, after the car models are placed (models[i] ↔ race.cars[i])
//   crews.dispose()
import * as THREE from 'three';

export const CREW = {
  walk: 1.6,       // seconds the crew takes to go out to the car (and back)
  comeOut: 70,     // metres: they go out when their car is this close to its box
  wheelOut: 0.6,   // metres a wheel comes off the car
  lift: 0.06,      // metres the jacks lift the car
};

const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
// a wheel during the stop (f: 0 → 1 through it): off, held, the new one on
const wheelOff = (f) => smooth((f - 0.12) / 0.13) * (1 - smooth((f - 0.5) / 0.15));
const lifted = (f) => smooth(f / 0.08) * (1 - smooth((f - 0.88) / 0.08));

let KIT = null;
function kit() {
  if (KIT) return KIT;
  const body = new THREE.CapsuleGeometry(0.21, 0.85, 4, 10).translate(0, 0.635, 0);
  const head = new THREE.SphereGeometry(0.16, 14, 10).translate(0, 1.43, 0);
  const tyre = new THREE.CylinderGeometry(0.33, 0.33, 0.3, 18).translate(0, 0.15, 0);
  const mark = new THREE.PlaneGeometry(3.4, 6.2).rotateX(-Math.PI / 2);
  KIT = {
    body, head, tyre, mark,
    suit: new THREE.MeshStandardMaterial({ roughness: 0.7 }),
    helmet: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.35, metalness: 0.1 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }),
    paint: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  return KIT;
}

export class PitCrews {
  constructor(scene, race) {
    this.scene = scene; this.race = race; this.group = new THREE.Group();
    const t = race.track, lane = t.pitLane, cars = race.cars.filter((c) => c.box);
    this.crews = [];
    if (!lane || !cars.length) return;
    const K = kit(), p = race.carDef.physics, hb = (p.wheelbase ?? 3.6) / 2, tw = (p.trackWidth ?? 1.6) / 2, side = lane.side;
    // where each of the 11 stands at the car (x: metres to the car's left, z: forward), and waiting by the garage
    const service = [];
    for (const sx of [1, -1]) for (const sz of [1, -1]) service.push([sx * (tw + 0.55), sz * hb], [sx * (tw + 1.2), sz * (hb + 0.5)]);
    service.push([0, hb + 1.9], [0, -hb - 1.7], [-side * (tw + 1.6), hb + 1.1]);
    const n = cars.length * service.length;
    this.bodies = new THREE.InstancedMesh(K.body, K.suit, n);
    this.heads = new THREE.InstancedMesh(K.head, K.helmet, n);
    const tyres = new THREE.InstancedMesh(K.tyre, K.rubber, cars.length * 8);
    const marks = new THREE.InstancedMesh(K.mark, K.paint, cars.length);
    for (const m of [this.bodies, this.heads, tyres]) { m.castShadow = true; m.receiveShadow = true; }
    const M = new THREE.Matrix4(), colour = new THREE.Color();
    cars.forEach((c, ci) => {
      const b = c.box, i = b.i, y = t.h ? t.h[i] : 0;
      const o = { x: t.cx[i] + t.nx[i] * b.lat, z: t.cz[i] + t.nz[i] * b.lat, fx: t.tx[i], fz: t.tz[i], lx: t.nx[i], lz: t.nz[i], y };
      const at = (x, z) => [o.x + o.lx * x + o.fx * z, o.z + o.lz * x + o.fz * z];
      const front = lane.out[i] - Math.abs(b.lat) - 1.1; // the garage front, from the box (metres towards the garage)
      const wait = service.map((_, k) => at(side * front, -5 + (10 * k) / (service.length - 1)));
      const work = service.map(([x, z]) => at(x, z));
      colour.setHex(c.team.color);
      service.forEach((_, k) => { this.bodies.setColorAt(ci * service.length + k, colour); });
      this.crews.push({ car: c, wait, work, y, q: 0, shown: -1, base: ci * service.length, idx: race.cars.indexOf(c) });
      for (let k = 0; k < 8; k++) { // two stacks of four by the garage
        const [x, z] = at(side * (front + 0.4), k < 4 ? -6.2 : 6.2);
        tyres.setMatrixAt(ci * 8 + k, M.makeTranslation(x, y + (k % 4) * 0.3, z));
      }
      const [mx, mz] = at(0, 0);
      M.makeRotationY(Math.atan2(o.fx, o.fz)).setPosition(mx, y + 0.07, mz);
      marks.setMatrixAt(ci, M); marks.setColorAt(ci, colour);
    });
    this.group.add(this.bodies, this.heads, tyres, marks);
    this.placeAll();
    scene.add(this.group);
  }

  placeAll() { for (const c of this.crews) { c.shown = -1; this.place(c); } this.flush(); }
  place(cw) {
    const M = this.M ??= new THREE.Matrix4(), f = smooth(cw.q);
    if (Math.abs(f - cw.shown) < 1e-3) return false;
    cw.shown = f;
    cw.wait.forEach(([wx, wz], k) => {
      const [sx, sz] = cw.work[k], x = wx + (sx - wx) * f, z = wz + (sz - wz) * f;
      M.makeTranslation(x, cw.y, z);
      this.bodies.setMatrixAt(cw.base + k, M); this.heads.setMatrixAt(cw.base + k, M);
    });
    return true;
  }
  flush() {
    this.bodies.instanceMatrix.needsUpdate = true; this.heads.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    this.bodies.computeBoundingSphere(); this.heads.computeBoundingSphere();
  }

  update(dt, models = []) {
    if (!this.crews.length) return;
    const t = this.race.track, L = t.length;
    let moved = false;
    for (const cw of this.crews) {
      const c = cw.car, st = c.state, p = c.pit, d = ((c.box.s - st.s + L * 1.5) % L) - L / 2;
      const atBox = Math.abs(d) < 3 && st.speed < 0.5 && Math.abs(Math.abs(st.lateral) - Math.abs(c.box.lat)) < 3;
      const want = c.remote ? (Math.abs(d) < 30 && st.speed < 25 && Math.abs(st.lateral) > t.hw[st.trackIndex] + 2 ? 1 : 0) // (someone else's car online)
        : (p.state === 'in' && d < CREW.comeOut) || p.state === 'stop' || (p.state === 'out' && d > -6) ? 1 : 0;
      cw.q = Math.min(1, Math.max(0, cw.q + (want ? 1 : -1) * (dt / CREW.walk)));
      moved = this.place(cw) || moved;
      // the car itself: up on the jacks, the wheels off and on
      const m = models[cw.idx], u = m?.userData;
      if (!u?.wheels) continue;
      const f = !c.remote && p.state === 'stop' && p.total > 0 ? 1 - p.timer / p.total : atBox && c.remote ? 0.3 : -1;
      const off = f >= 0 ? wheelOff(f) * CREW.wheelOut : 0;
      for (const w of u.wheels) w.position.x = off ? (Math.sign(w.parent?.position.x) || (/L$/.test(w.name) ? 1 : -1)) * off : 0;
      if (f >= 0) m.position.y += lifted(f) * CREW.lift;
    }
    if (moved) this.flush();
  }

  dispose() {
    this.group.removeFromParent();
    for (const o of this.group.children) o.dispose?.(); // (the geometries and materials are shared: kit())
    this.crews = [];
  }
}