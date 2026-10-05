// Other cars in full detail only when they're close. A car model is ~170–240k triangles, so twenty of them at
// once would slow the game down. The nearest few are the full model; the rest swap to the light built-in car
// (at that distance you can't tell). That's for:
//  • your friends' cars in an online race (everyone drives the same car, in its own livery; further away the
//    light car in the car's colours, `farLivery` in its model settings), and
//  • AI cars, for the cars whose model can be repainted (`paint` in the model settings: the Hypercar and the
//    GT3): the model in the team's colours close up, the light car in the team's colours further away.
//    (F1 AI cars are always the light car.)
import * as THREE from 'three';
import { createCarModel, syncCarModel, modelReady } from './carModel.js';
import { GRAPHICS } from './settings.js';

export const LOD = {
  maxDetailed: 3, // at most this many other cars in full detail at once (the graphics preset's detailedCars wins)
  near: 50,       // metres: closer than this can switch to full detail…
  far: 60,        // …and further than this switches back (the gap stops flickering)
  farLivery: { color: 0x1b2448, accent: 0xd8141d }, // the RB19's colours (a car's own farLivery wins)
};

// One car that swaps detail. car: the car everyone's racing (its file in src/cars/; race.carDef).
// ai: true = an AI car (the model repainted in its team's colours); false = a friend's car (its own livery)
export function createLodModel(team, car, { ai = false } = {}) {
  const group = new THREE.Group();
  const hi = createCarModel(team, ai ? { car, paint: true, lite: true } : { player: true, car, lite: true });
  hi.userData.display = null; // no live steering-wheel screen on other people's cars (saves work every frame)
  const lo = createCarModel(ai ? team : { ...team, ...(car.model.farLivery ?? LOD.farLivery) }, { player: false, car });
  lo.visible = false;
  group.add(hi, lo);
  group.userData = { lod: { hi, lo, near: false, d: 0 } };
  return group;
}
export const createRemoteModel = (team, car) => createLodModel(team, car); // a friend's car (online)

// The model for each car in a race (race.cars[i]): yours, a friend's (online) or an AI car's
export function createRaceModel(c, car) {
  if (c.isPlayer) return createCarModel(c.team, { player: true, car });
  if (c.isHuman) return createLodModel(c.team, car);
  if (car.model.paint && modelReady(car)) return createLodModel(c.team, car, { ai: true });
  return createCarModel(c.team, { car });
}

// Place every car model for this frame (race.cars[i] ↔ models[i]); picks the detail for the cars that swap.
export function syncModels(models, cars, camera) {
  const swapping = [];
  models.forEach((m, i) => {
    const c = cars[i];
    m.visible = !c.dnf;
    const lod = m.userData.lod;
    if (!lod) { syncCarModel(m, c.state); return; }
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