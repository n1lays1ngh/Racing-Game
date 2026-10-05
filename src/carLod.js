// Your friends' cars in an online race. Everyone drives the RB19, but that model is ~240k triangles,
// so ten of them at once would slow the game down. The nearest few are the full RB19; the rest swap
// to the light built-in car in the same dark-blue colours (at that distance you can't tell).
import * as THREE from 'three';
import { createCarModel, syncCarModel } from './carModel.js';
import { GRAPHICS } from './settings.js';

export const LOD = {
  maxDetailed: 3, // at most this many friends' cars in full detail at once (the graphics preset's detailedCars wins)
  near: 50,       // metres: closer than this can switch to full detail…
  far: 60,        // …and further than this switches back (the gap stops flickering)
  farLivery: { color: 0x1b2448, accent: 0xd8141d },
};

export function createRemoteModel(team) {
  const group = new THREE.Group();
  const hi = createCarModel(team, { player: true });
  hi.userData.display = null; // no live steering-wheel screen on other people's cars (saves work every frame)
  const lo = createCarModel({ ...team, ...LOD.farLivery }, { player: false });
  lo.visible = false;
  group.add(hi, lo);
  group.userData = { lod: { hi, lo, near: false, d: 0 } };
  return group;
}

// Place every car model for this frame (race.cars[i] ↔ models[i]); picks the detail for friends' cars.
export function syncModels(models, cars, camera) {
  const friends = [];
  models.forEach((m, i) => {
    const c = cars[i];
    m.visible = !c.dnf;
    const lod = m.userData.lod;
    if (!lod) { syncCarModel(m, c.state); return; }
    lod.d = Math.hypot(c.state.x - camera.position.x, c.state.z - camera.position.z);
    friends.push([m, c]);
  });
  // nearest first; cars already in full detail get a head start so two close cars don't keep swapping
  const key = (lod) => lod.d - (lod.near ? 8 : 0);
  friends.sort((a, b) => key(a[0].userData.lod) - key(b[0].userData.lod));
  friends.forEach(([m, c], rank) => {
    const lod = m.userData.lod;
    lod.near = rank < (GRAPHICS.detailedCars ?? LOD.maxDetailed) && lod.d < (lod.near ? LOD.far : LOD.near);
    lod.hi.visible = lod.near; lod.lo.visible = !lod.near;
    syncCarModel(lod.near ? lod.hi : lod.lo, c.state);
  });
}