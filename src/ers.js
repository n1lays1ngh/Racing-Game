// ERS: the hybrid battery boost.
//   Hold Shift (keyboard) or R1 / RB (controller) to deploy: an electric motor adds its power on top of the
//   engine for as long as the battery has charge. Every race starts with a full battery, and braking charges
//   it again (harder braking at higher speed charges faster, like a real MGU-K). Where and when you use it is
//   up to you; the HUD shows the charge and reminds you when the battery is full (hud.js).
//
//   ersStep(car, controls, vf, dt) → extra acceleration (m/s²) this step; physics.js calls it for every car,
//                                    but only the player's input has `boost`, so the AI never deploys.
// A car whose ers has `auto: true` (the Hypercar) needs no button: its hybrid front axle deploys by itself
// on the throttle between minSpeed (190 km/h, as in the Le Mans Hypercar rules) and maxSpeed, where the
// engine and motor together reach the power cap and it fades out (so it doesn't raise the top speed).
// State on the car: car.ers (0–1, starts full) and car.ersMode ('deploy' | 'harvest' | '').
// How big and strong the battery is depends on the car: `ers` in its file in src/cars/.
import F1 from './cars/f1.js';

// The F1 car's ERS (src/cars/f1.js); each car has its own in its file (ers: null = no hybrid boost).
export const ERS = F1.ers;

export function ersStep(car, { boost = false, throttle = 0, brake = 0 }, vf, dt) {
  const E = car.spec ? car.spec.ers : F1.ers;      // this car's battery (null: it has none)
  car.ersMode = '';
  if (!E) { car.ers = 0; return 0; }
  car.ers ??= 1;                                   // a new car (every race start): full battery
  // Deploy: button held, on the throttle, moving forwards, charge left (not in the pit lane, where the
  // speed limiter holds the car anyway)
  if (E.auto) {
    if (throttle >= E.minThrottle && vf > E.minSpeed && car.ers > 0 && !car.pitLimiter) {
      const fade = 1 - Math.min(1, Math.max(0, (vf - E.maxSpeed + 8) / 8)); // nothing left at maxSpeed
      if (fade > 0) {
        car.ers = Math.max(0, car.ers - (dt / E.capacity) * fade);
        car.ersMode = 'deploy';
        return Math.min(E.maxPush, E.power / vf) * fade;
      }
    }
  } else if (boost && throttle >= E.minThrottle && vf > 2 && car.ers > 0 && !car.pitLimiter) {
    car.ers = Math.max(0, car.ers - dt / E.capacity);
    car.ersMode = 'deploy';
    return Math.min(E.maxPush, E.power / vf) * Math.min(1, throttle / 0.6);
  }
  // Harvest: braking charges the battery
  if (brake > 0.05 && vf > 3 && car.ers < 1) {
    car.ers = Math.min(1, car.ers + E.harvest * brake * Math.min(1, vf / E.harvestSpeed) * dt);
    car.ersMode = 'harvest';
  }
  return 0;
}