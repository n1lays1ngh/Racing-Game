// The cars in the game, in menu order. One file per car in this folder (see f1.js for every setting).
// To add a car: copy f1.js to a new file, change what's different, import it here and add it to the list.
// One kind of car races at a time (race.js).
//
//   getCar(id)                → the car with that id (the default car if there's none)
//   selectedCar()             → the id of the car you last picked (kept in this browser), or the default
//   setSelectedCar(id)        → remember your pick
//   timesFor(car, circuit)    → the times of day this car can race at this circuit (the menu's Time buttons):
//                               'day' and 'night' (under the circuit's floodlights) everywhere, 'dusk' where that's
//                               the circuit's own time (Abu Dhabi), and 'dark' (a night without floodlights round
//                               the lap, only the pit straight lit) where the car has it (darkNights in its file)
//   raceSetup(car, circuit, choice) → { choice, time, lighting }: how the circuit is set up for that choice
//                               (time: 'day' | 'dusk' | 'night'; lighting: 'circuit' = floodlights all round,
//                               'pits' = only the pit straight). No choice yet (null): the circuit's own time.
//   TIME_LABELS               → what the buttons say
import f1 from './f1.js';
import hypercar from './hypercar.js';
import gt3 from './gt3.js';
import porsche from './porsche.js';

export const CARS = [
  f1,
  hypercar,
  gt3,
  porsche,
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

export const TIME_LABELS = { day: 'Day', dusk: 'Twilight', night: 'Night', dark: 'Night · no floodlights' };

// circuit: a circuit file (src/circuits/)
export function timesFor(car, circuit) {
  const list = ['day'];
  if (circuit.time === 'dusk') list.push('dusk');
  list.push('night');
  if (car.darkNights?.includes(circuit.id)) list.push('dark');
  return list;
}

// choice: the one you'd like ('day' | 'dusk' | 'night' | 'dark', or null for the circuit's own). Where it isn't on
// offer: a night without floodlights becomes a floodlit one, twilight becomes night, else the circuit's own time.
export function raceSetup(car, circuit, choice) {
  const options = timesFor(car, circuit), own = circuit.time ?? 'day';
  const c = options.includes(choice) ? choice : choice === 'dark' || choice === 'dusk' ? 'night' : options.includes(own) ? own : options[0];
  return { choice: c, time: c === 'dark' ? 'night' : c, lighting: c === 'dark' ? 'pits' : 'circuit' };
}