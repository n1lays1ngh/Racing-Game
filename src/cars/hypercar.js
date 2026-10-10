// Hypercar: the Ferrari 499P, a Le Mans Hypercar (LMH): a 3.0 V6 twin-turbo driving the rear wheels, plus an
// electric motor on the front axle that the rules only let it use above 190 km/h, all capped at 500 kW.
// Every setting is explained in f1.js.
//
// Against the F1 car it's heavier (1,030 kg), has less power and much less downforce, so it brakes earlier,
// corners slower and tops out lower, but it's a stable, planted car: traction control, no ABS.
// Tuned with the sim against the real thing: the 499P qualified for Le Mans 2026 in 3:25.1 (pole 3:22.6).
//   npm run sim -- 1 hard lemans hypercar
export default {
  id: 'hypercar',
  name: 'Hypercar',
  short: 'HYP',
  car: 'Apex HY-1',
  specs: ['3.0 V6 twin-turbo hybrid', '1,030 kg', 'Hybrid all-wheel drive'],

  // ---- When it races ----
  // Every circuit by day or by night under floodlights (all cars can). darkNights: the circuits where it can also
  // race a real endurance night without floodlights round the lap (only the pit straight and paddock lit), as in
  // their 24-hour races.
  darkNights: ['lemans', 'nurburgring'],

  // ---- Track limits (race.js): how many times you can go off in a lap before it's invalidated (F1: 1) ----
  trackLimits: { strikes: 5 },
  // ---- Pit stops (pitstop.js): seconds stationary in the box (tyres and a splash of fuel, game length) ----
  pitStop: { time: 8 },
  damage: { strength: 1.5, frontAero: 0.3 },  // (damage.js) closed bodywork: takes more than an F1 car
  tyreLife: 1.5,          // endurance tyres: they last 1.5× as long as the F1 car's (tyres.js)

  // ---- How it drives ----
  physics: {
    // --- engine & brakes ---
    accel: 13,          // m/s² engine push at low speed
    accelFade: 0.62,
    drag: 0.000536,        // → about 330 km/h flat out (more in a tow)
    roll: 0.4,
    liftOff: 8,
    brake: 32,
    // --- grip ---
    mu: 1.84,
    g: 9.81,
    downforce: 0.00146,
    // --- steering & handling feel ---
    wheelbase: 3.15,       // the real one (where the wheels are: tyre marks, the model)
    steerBase: 3.6,       // … but the steering works like the F1 car's 3.6 m: the handling and the AI are tuned for
                          // that, and a short one makes the steering twitchy (the AI weaves and runs wide)
    trackWidth: 1.64,     // between the left and right wheels (tyre marks)
    maxSteer: 0.36,
    steerFade: 30,
    steerRate: 2.1,
    yawResponse: 7.5,     // a little heavier to turn in than the F1 car
    slideAllowance: 1.12,
    trailBrake: 0.15,
    powerRotation: 0.18,
    stability: 2,
    // --- driver aids ---
    abs: false,           // no ABS in a Hypercar: lock-ups are possible
    tc: 0.5,              // traction control: how strongly it trims the power when the rear steps out (0–1)
    // --- lock-ups ---
    lockThreshold: 1.3,
    lockSteer: 0.30,
    lockBrake: 0.8,
    reverseMax: 12,
    // --- size (5.0 m long, 2.0 m wide) ---
    radius: 1.15,
    contactOffset: 1.35,
  },

  // ---- Gearbox: 7 gears, a lower-revving engine than the F1 car's ----
  gearbox: {
    top: [0, 25, 36, 47, 58, 69, 80, 95],
    neutral: 2800,
    rpm: [4600, 8800],
    flash: 8500,
  },

  // ---- Headlights (headlights.js): on by themselves at night, H to switch ----
  //   at: where the left lamp's light starts (x left, y up, z forward, metres from the car's centre; the right is its
  //   mirror image): at the lamp's height, just ahead of the nose, so the car doesn't light itself up
  //   colour; intensity (× HEADLIGHTS.intensity); lamps: the model's materials that glow while they're on
  headlights: { at: [0.81, 0.32, 2.62], colour: 0xf2f6ff, intensity: 1, lamps: ['SM_Light_Front_opaque', 'SM_Light_Front_pulse'] },

  // ---- Engine sound (audio.js: ENGINES.hypercar): the twin-turbo V6, deeper than the F1 car's, and the front
  // motor's whine when it deploys ----
  sound: 'hypercar',

  // ---- Hybrid: the front motor deploys by itself above 190 km/h (no button), fading out near top speed ----
  ers: {
    auto: true,
    minSpeed: 52.8,       // m/s (190 km/h)
    maxSpeed: 84,         // m/s: by here the power cap is reached and it gives nothing more
    minThrottle: 0.9,     // flat out
    capacity: 7,          // seconds of full deployment in a full battery
    power: 70,            // extra push = power ÷ speed (m/s²) …
    maxPush: 1.4,         // … at most this
    harvest: 0.07,        // braking charges it (per second of full braking at speed)
    harvestSpeed: 25,
  },

  // ---- How it looks (carModel.js; every setting is explained in gt3.js) ----
  // "Ferrari 499p | www.vecarz.com" by vecarz on Sketchfab, CC-BY-4.0 (credit in the README), made for the game
  // with tools/prepare-car.mjs: rigged (wheels, calipers, steering wheel and its screen), 460k → 175k triangles.
  model: {
    url: '/models/ferrari_499p.glb',
    length: null,
    builtin: 'proto',          // the built-in Hypercar (carBodies.js): the AI cars, in their team's colours
    farLivery: { color: 0xd80808, accent: 0xf8b808 },
    lite: ['steering_pivot'],  // friends' cars: no steering wheel (a dozen small parts nobody sees from outside)
    steeringLock: 1.6, frontWheelSteer: 1.4, maxSpinPerFrame: 0.5, blurSpeed: [4, 11],
    // the T-cam on top of the roof intake; the driver's eyes in the left-hand seat
    cams: { tcam: { name: 'Roof cam', x: 0, z: 0.05, y: 1.24, tilt: -1.4 }, cockpit: { x: 0.145, z: 0.12, y: 0.73, tilt: -2 } },
  },

  // ---- Chase cameras: a longer, wider car than the F1 car ----
  cameras: {
    chase: { pos: [0, 3.1, -9], look: [0, 1.0, 6] },
    far: { pos: [0, 5.2, -14.5], look: [0, 0.7, 8] },
    back: { pos: [0, 2.8, 7.8], look: [0, 1.0, -8] },
  },
};