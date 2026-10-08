// Your friends' cars in an online race: everyone drives the same car, in its own livery. A car model is
// ~170–240k triangles, so ten of them at once would slow the game down: the nearest few are the full model, the
// rest swap to the light built-in car in the car's colours (`farLivery` in its model settings; at that distance
// you can't tell). AI cars are always the built-in car, in their team's colours.
import * as THREE from 'three';
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

// The model for each car in a race (race.cars[i]): yours, a friend's (online) or an AI car's (the built-in car)
export function createRaceModel(c, car) {
  if (c.isPlayer) return createCarModel(c.team, { player: true, car });
  if (c.isHuman) return createRemoteModel(c.team, car);
  return createCarModel(c.team, { car });
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
      const det = m.userData.details; // far away: the small parts aren't drawn (GRAPHICS.detailDistance, settings.js)
      if (det?.length && !c.isPlayer) {
        const far = (c.state.x - camera.position.x) ** 2 + (c.state.z - camera.position.z) ** 2 > (GRAPHICS.detailDistance ?? 80) ** 2;
        if (m.userData.far !== far) { m.userData.far = far; for (const o of det) o.visible = !far; }
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