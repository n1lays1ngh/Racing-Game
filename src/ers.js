// ERS: the hybrid battery boost.
//   Hold Shift (keyboard) or R1 / RB (controller) to deploy: an electric motor adds its power on top of the
//   engine for as long as the battery has charge. Every race starts with a full battery, and braking charges
//   it again (harder braking at higher speed charges faster, like a real MGU-K). Where and when you use it is
//   up to you; the HUD shows the charge and reminds you when the battery is full (hud.js).
//
//   ersStep(car, controls, vf, dt) → extra acceleration (m/s²) this step; physics.js calls it for every car,
//                                    but only the player's input has `boost`, so the AI never deploys.
// State on the car: car.ers (0–1, starts full) and car.ersMode ('deploy' | 'harvest' | '').

export const ERS = {
  capacity: 9,        // seconds of deployment in a full battery
  power: 85,          // how strong: extra push = power ÷ speed (m/s²), like a motor of fixed power …
  maxPush: 3.2,       // … capped at this at low speed. 85 / 3.2 ≈ +14% acceleration and ~20 km/h more top speed
  minThrottle: 0.2,   // only deploys while you're on the throttle
  harvest: 0.055,     // charge gained per second of full braking at speed (0.055 = 5.5% a second)
  harvestSpeed: 30,   // m/s (108 km/h) from which braking charges at the full rate; slower = less
};

export function ersStep(car, { boost = false, throttle = 0, brake = 0 }, vf, dt) {
  car.ers ??= 1;                                   // a new car (every race start): full battery
  car.ersMode = '';
  // Deploy: button held, on the throttle, moving forwards, charge left (not in the pit lane, where the
  // speed limiter holds the car anyway)
  if (boost && throttle >= ERS.minThrottle && vf > 2 && car.ers > 0 && !car.pitLimiter) {
    car.ers = Math.max(0, car.ers - dt / ERS.capacity);
    car.ersMode = 'deploy';
    return Math.min(ERS.maxPush, ERS.power / vf) * Math.min(1, throttle / 0.6);
  }
  // Harvest: braking charges the battery
  if (brake > 0.05 && vf > 3 && car.ers < 1) {
    car.ers = Math.min(1, car.ers + ERS.harvest * brake * Math.min(1, vf / ERS.harvestSpeed) * dt);
    car.ersMode = 'harvest';
  }
  return 0;
}