// Your friends' cars in an online race: everyone drives the same car, in its own livery. A car model is
// ~170–240k triangles, so ten of them at once would slow the game down: the nearest few are the full model, the
// rest swap to the light built-in car in the car's colours (`farLivery` in its model settings; at that distance
// you can't tell). AI cars are always the built-in car, in their team's colours.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCarModel, syncCarModel } from './carModel.js';
import { GRAPHICS } from './settings.js';

export const LOD = {
  maxDetailed: 3, // at most this many friends' cars in full detail at once (the graphics preset's detailedCars wins)
  near: 50,       // metres: closer than this can switch to full detail…
  far: 60,        // …and further than this switches back (the gap stops flickering)
  farLivery: { color: 0x1b2448, accent: 0xd8141d }, // the RB19's colours (a car's own farLivery wins)
};

// A friend's car. car: the car everyone's racing (its file in src/cars/; race.carDef)
export function createRemoteModel(team, car) {
  const group = new THREE.Group();
  const hi = createCarModel(team, { player: true, car, lite: true });
  hi.userData.display = null; // no live steering-wheel screen on other people's cars (saves work every frame)
  const lo = createCarModel({ ...team, ...(car.model.farLivery ?? LOD.farLivery) }, { player: false, car });
  lo.visible = false;
  group.add(hi, lo);
  group.userData = { lod: { hi, lo, near: false, d: 0 } };
  return group;
}

// The model for each car in a race (race.cars[i]): yours, a friend's (online) or an AI car's (the built-in car, which
// also gets a far model: see farModel)
export function createRaceModel(c, car) {
  if (c.isPlayer) return createCarModel(c.team, { player: true, car });
  if (c.isHuman) return createRemoteModel(c.team, car);
  const m = createCarModel(c.team, { car });
  const near = [...m.children], far = farModel(m);
  if (far) { m.add(far); m.userData.lodFar = { near, far, on: false }; }
  return m;
}

// A car seen from far away (further than GRAPHICS.detailDistance): the whole car as ONE mesh, each part in its own
// colour, with one material shared by every car. The full car is 15–40 meshes, each drawn on its own (and again for the
// shadows and the mirror); far away you can't see the difference, and the graphics card draws it in one go. The wheels
// don't turn on it: at that distance they're a blur anyway.
const FAR_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.3 });
const texColour = new WeakMap();
function averageColour(tex) { // a textured part (carbon weave, number plates): its texture's average colour
  if (texColour.has(tex)) return texColour.get(tex);
  let c = null; const img = tex.image;
  try {
    if (img && (img.width ?? 0) > 0) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 1;
      const x = cv.getContext('2d'); x.drawImage(img, 0, 0, 1, 1);
      const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
      c = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    }
  } catch { /* not a picture we can read */ }
  texColour.set(tex, c);
  return c;
}
function farModel(model) {
  model.updateMatrixWorld(true);
  const inv = model.matrixWorld.clone().invert(), parts = [], c = new THREE.Color(), rel = new THREE.Matrix4();
  model.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    for (let p = o; p && p !== model; p = p.parent) if (!p.visible) return;   // (hidden: the motion-blur discs at rest)
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.transparent || m.visible === false) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(rel.multiplyMatrices(inv, o.matrixWorld));
    c.copy(m.color ?? c.set(0xffffff));
    if (m.map) { const t = averageColour(m.map); if (t) c.multiply(t); }
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  });
  if (!parts.length) return null;
  const mesh = new THREE.Mesh(mergeGeometries(parts), FAR_MAT);
  parts.forEach((g) => g.dispose());
  mesh.name = 'far'; mesh.castShadow = true; mesh.receiveShadow = true; mesh.visible = false;
  return mesh;
}

// Place every car model for this frame (race.cars[i] ↔ models[i]); picks the detail for friends' cars.
export function syncModels(models, cars, camera) {
  const swapping = [];
  models.forEach((m, i) => {
    const c = cars[i];
    m.visible = !c.dnf || !!c.parked || (c.isPlayer && !!c.retired); // (a car out with damage stays where it parked: race.js retire)
    const lod = m.userData.lod;
    if (!lod) {
      syncCarModel(m, c.state);
      const F = m.userData.lodFar; // far away: the one-mesh car (farModel; GRAPHICS.detailDistance, settings.js)
      if (F) {
        const d2 = (c.state.x - camera.position.x) ** 2 + (c.state.z - camera.position.z) ** 2, D = GRAPHICS.detailDistance ?? 80;
        const far = d2 > (F.on ? D * 0.9 : D) ** 2; // (a little closer to swap back: no flicker at the edge)
        if (far !== F.on) { F.on = far; for (const o of F.near) o.visible = !far; F.far.visible = far; }
      }
      return;
    }
    lod.d = Math.hypot(c.state.x - camera.position.x, c.state.z - camera.position.z);
    swapping.push([m, c]);
  });
  // nearest first; cars already in full detail get a head start so two close cars don't keep swapping
  const key = (lod) => lod.d - (lod.near ? 8 : 0);
  swapping.sort((a, b) => key(a[0].userData.lod) - key(b[0].userData.lod));
  swapping.forEach(([m, c], rank) => {
    const lod = m.userData.lod;
    lod.near = rank < (GRAPHICS.detailedCars ?? LOD.maxDetailed) && lod.d < (lod.near ? LOD.far : LOD.near);
    lod.hi.visible = lod.near; lod.lo.visible = !lod.near;
    syncCarModel(lod.near ? lod.hi : lod.lo, c.state);
  });
}