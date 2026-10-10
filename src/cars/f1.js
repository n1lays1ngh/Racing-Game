// Formula 1: the RB19, the car the game has always had.
//
// Every car in the game is one file in this folder, like the circuits in src/circuits/: how it drives
// (physics), its gearbox, its hybrid boost, how it looks (model) and where the cameras sit. The game reads
// everything about a car from here, so these numbers are the ones to change to tune it. To add a car, copy
// this file, change what's different, and add it to the list in index.js.
//
// The numbers here are exactly what the game used before cars had their own files (physics.js CAR,
// ers.js ERS, carModel.js CAR_MODEL and the chase cameras in main.js), so the F1 car drives as it always has.
export default {
  id: 'f1',                  // unique, used in code, saved stats and the sim command
  name: 'RB-19',        // shown in the menu
  short: 'RB19',
  car: 'F1 RB-19',         // the car you drive in this class
  specs: ['1.6 V6 turbo hybrid', '798 kg', '8 gears'],  // shown in the menu

  // ---- When it races: the menu's Day / Night choice ----
  // Every car can race every circuit by day or by night under its floodlights (and at twilight where that's the
  // circuit's own time). darkNights: a list of circuit ids where it can also race a night without floodlights
  // (see hypercar.js); none for the F1 car.
  darkNights: [],

  // ---- Track limits (race.js): how many times you can go off in a lap before it's invalidated ----
  trackLimits: { strikes: 3 },
  // ---- Pit stops (pitstop.js): seconds stationary in the box (four tyres) ----
  pitStop: { time: 2.4 },
  damage: { strength: 1, frontAero: 0.45 }, // (damage.js) the most fragile: open wheels, a big front wing that carries a lot of the downforce

  // ---- How it drives (physics.js; the AI plans its corner speeds and braking from the same numbers) ----
  physics: {
    // Tuned to a 2023 car (RB19-like), from public figures: 798 kg, ~630 kW engine (+120 kW hybrid, the ERS below),
    // ~2.2 g in slow corners, ~3.6 g at 200 km/h, ~5.9 g at 300, braking ~5–6 g from top speed, ~330 km/h (~350 with ERS).
    // --- engine & brakes ---
    accel: 20,            // m/s²: the most the engine can push in the low gears (the tyres usually limit it first: traction)
    power: 720,           // W/kg: engine power ÷ mass (630 kW ÷ 798 kg, less drivetrain losses); push = power ÷ speed
    accelFade: 0.6,       // (only used by a car without power: its push fades in a straight line toward top speed)
    traction: 0.62,       // the rear tyres put down at most this share of the grip (~1.1 g off the line); the rest spins them
    spinRotation: 0.8,    // how much wheelspin swings the rear round in a corner (before traction control)
    tc: 0.6,              // traction control: catches this share of the wheelspin (F1 22's medium; a real F1 car has 0)
    combined: true,       // braking / accelerating and turning share the tyres' grip (a friction circle): trail-brake gently
    drag: 0.00095,        // aero drag (× v²): ½ × air density × drag area 1.26 m² ÷ 798 kg
    roll: 0.4,            // rolling resistance, m/s²
    liftOff: 4,           // m/s² extra slowing off the throttle (engine braking and the hybrid harvesting; the air does the rest)
    brake: 50,            // m/s² max braking (still limited by grip): with the drag, ~6 g from 300 km/h, ~3 g from 100
    // --- grip ---
    mu: 1.7,              // tyre grip (mechanical: what's left at low speed)
    g: 9.81,
    downforce: 0.0035,    // extra grip per v²: downforce ≈ 1.6 × the car's weight at 240 km/h (lift area ~4.7 m²)
    // --- steering & handling feel ---
    wheelbase: 3.6,       // metres between the axles; the steering works from this (or steerBase, if a car has one)
    maxSteer: 0.36,       // steering lock at low speed
    steerFade: 32,        // lock reduces with speed (higher = more lock at speed)
    steerRate: 2.3,       // how fast the front wheels turn
    yawResponse: 9,       // how quickly the car rotates (lower = heavier, higher = sharper)
    slideAllowance: 1.10, // how far the car can rotate past grip → small controllable slide
    trailBrake: 0.15,     // extra rotation while braking into a corner
    powerRotation: 0.20,  // extra rotation on throttle in slow corners
    stability: 2,         // how strongly slides straighten out (higher = safer, lower = driftier)
    // --- lock-ups ---
    lockThreshold: 1.25,  // brake + cornering needed to lock the fronts (higher = harder to lock)
    lockSteer: 0.30,      // steering left while locked (lock-up understeer)
    lockBrake: 0.8,       // braking left while locked
    reverseMax: 12,
    // --- size, for car-to-car contact (race.js): two circles, one front and one rear ---
    radius: 1.25,         // radius of each circle (m)
    contactOffset: 1.4,   // metres from the car's centre to each circle
    // Optional (see hypercar.js and gt3.js): steerBase (the steering works from this instead of the wheelbase),
    // trackWidth (between the left and right wheels, for the tyre marks), abs: true (can't lock the wheels),
    // tc: 0–1 (traction control: trims the power when the rear steps out).
  },

  // ---- Gearbox: the gear and engine revs shown on the HUD and the steering wheel, and heard (audio.js) ----
  gearbox: {
    top: [0, 24, 36, 47, 57, 66, 75, 84, 97], // m/s at the top of each gear (8 gears)
    neutral: 4000,        // revs when stopped
    rpm: [6000, 13000],   // revs at the bottom and top of each gear
    flash: 12600,         // the shift lights flash above this
  },

  // ---- Headlights (headlights.js): none on an F1 car (see hypercar.js) ----
  headlights: null,

  // ---- Engine sound (audio.js): one of its ENGINES. null = the engine set there in SOUND.engineType ----
  sound: null,

  // ---- ERS: the hybrid battery boost you deploy (ers.js). null = this car has none; auto: true = it deploys by
  // itself between minSpeed and maxSpeed (the Hypercar's front motor, see hypercar.js) ----
  ers: {
    capacity: 9,          // seconds of deployment in a full battery
    power: 150,           // how strong: extra push = power ÷ speed (m/s²): the 120 kW MGU-K ÷ 798 kg …
    maxPush: 3.5,         // … capped at this at low speed. ~+20 km/h top speed (≈ 330 → 350 km/h)
    minThrottle: 0.2,     // only deploys while you're on the throttle
    harvest: 0.055,       // charge gained per second of full braking at speed (0.055 = 5.5% a second)
    harvestSpeed: 30,     // m/s (108 km/h) from which braking charges at the full rate; slower = less
  },

  // ---- How it looks (carModel.js) ----
  // "Oracle Red Bull F1 Car RB19 2023" by Redgrund on Sketchfab, CC-BY-4.0 (credit in the README).
  model: {
    url: '/models/rb19.glb',  // null = use the built-in car (builtin: its shape, 'f1' | 'proto' | 'gt', carModel.js)
    length: 5.6,              // nose to rear wing in metres (the model is scaled to this)
    offsetZ: 0.29,            // slides the model so its wheels sit on the physics wheelbase (±1.8 m)
    forAI: false,             // true = every car on the grid is an RB19
    steeringLock: 1.75,       // steering wheel rotation at full lock (radians, 1.75 ≈ 100°)
    frontWheelSteer: 1.4,     // how far the front wheels turn compared with the physics steer angle
    maxSpinPerFrame: 0.5,     // cap on wheel rotation per frame, so fast wheels don't strobe backwards
    blurSpeed: [4, 11],       // m/s where the motion blur on the wheels starts / is complete
    // Paint finish: the RB19 is matte. Lower maxMetalness / raise minRoughness for less shine.
    finish: { maxMetalness: 0.2, minRoughness: 0.5, clearcoat: 0.06, clearcoatRoughness: 0.3 },
    tyreStripes: true,        // the compound's colour band on the tyres' sidewalls (tyres.js)
    // Onboard cameras for this model: z = metres forward (+) / back (−) from the car's centre,
    // y = metres above the road, tilt = degrees up (+) / down (−).
    cams: { tcam: { z: -0.40, y: 1.50, tilt: -5 }, cockpit: { z: 0.25, y: 0.80, tilt: -4 } },
    // Steering-wheel display, in model units from the steering wheel's centre (x right, y up, z forward)
    display: { x: 0, y: 0.006, z: -0.0088, w: 0.064, h: 0.027 },
    // Optional (see gt3.js and hypercar.js, whose models were made with tools/prepare-car.mjs): length: null (the file
    // is already to scale), builtin (the AI cars' body: 'proto' or 'gt', carBodies.js), farLivery (friends' cars
    // further away), lite (parts left out of friends' cars), x in the onboard cameras (seat to one side). Those
    // models carry their own screen position, tyre sizes and brake calipers.
  },

  // ---- Chase cameras (main.js): [x (left), y (up), z (forward)] in metres from the car's centre on the road ----
  cameras: {
    chase: { pos: [0, 2.9, -8.5], look: [0, 0.9, 6] },   // Chase
    far: { pos: [0, 5, -14], look: [0, 0.6, 8] },        // Far chase
    back: { pos: [0, 2.6, 7.5], look: [0, 0.9, -8] },    // Q held: in front of the car, looking back over it
  },
};