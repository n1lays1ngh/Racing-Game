// The cars in the game, in menu order. One file per car in this folder (see f1.js for every setting).
// To add a car: copy f1.js to a new file, change what's different, import it here and add it to the list.
//
//   getCar(id)          → the car with that id (the first one if there's none)
//   selectedCar()       → the id of the car you last picked (kept in this browser), or the default
//   setSelectedCar(id)  → remember your pick
import f1 from './f1.js';

export const CARS = [
  f1,
];
export const DEFAULT_CAR = 'f1';

export function getCar(id) {
  return CARS.find((c) => c.id === id) ?? CARS.find((c) => c.id === DEFAULT_CAR) ?? CARS[0];
}

const KEY = 'apex-circuit:car';
export function selectedCar() {
  try {
    const id = localStorage.getItem(KEY);
    if (id && CARS.some((c) => c.id === id)) return id;
  } catch { /* no storage (private window): the default */ }
  return DEFAULT_CAR;
}
export function setSelectedCar(id) {
  try { localStorage.setItem(KEY, id); } catch { /* not kept, that's all */ }
}