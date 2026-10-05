// The cars in the game, in menu order. One file per car in this folder (see f1.js for every setting).
// To add a car: copy f1.js to a new file, change what's different, import it here and add it to the list.
// One kind of car races at a time (race.js).
//
//   getCar(id)                → the car with that id (the default car if there's none)
//   selectedCar()             → the id of the car you last picked (kept in this browser), or the default
//   setSelectedCar(id)        → remember your pick
//   timesFor(car, circuit)    → the times of day this car can race at this circuit (the first is its default)
//   raceSetup(car, circuit, time) → { time, lighting }: how the circuit is set up for that car and time
//                                   (lighting: 'circuit' = its own floodlights at night, 'pits' = only the pit straight)
import f1 from './f1.js';
import hypercar from './hypercar.js';
import gt3 from './gt3.js';

export const CARS = [
  f1,
  hypercar,
  gt3,
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

// circuit: a circuit file (src/circuits/)
export function timesFor(car, circuit) {
  if (!car.times || car.times === 'circuit') return [circuit.time ?? 'day'];
  return car.times[circuit.id] ?? car.times['*'] ?? ['day'];
}

// time: the one you'd like ('day' | 'dusk' | 'night'); if this car can't race then here, its first time instead
export function raceSetup(car, circuit, time) {
  const options = timesFor(car, circuit), t = options.includes(time) ? time : options[0];
  const own = !car.times || car.times === 'circuit';
  return { time: t, lighting: !own && t !== 'day' ? car.night ?? 'circuit' : 'circuit' };
}