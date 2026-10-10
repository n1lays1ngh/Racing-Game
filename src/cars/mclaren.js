// Mid-engined GT3 (McLaren 720S GT3-like): a carbon tub with a twin-turbo V8 behind the driver. Settings as in
// gt3.js and f1.js; only what differs is described here.
//
// Real figures it's tuned to (public, approximate): 4.0-litre twin-turbo V8 at ~380 kW (≈520 hp, what the Balance of
// Performance allows), ~1,300 kg + driver ≈ 1,380 kg; 6-speed sequential; ABS and traction control; ~1.6 g in slow
// corners, ~2.3 g in fast ones, ~2 g on the brakes, ~280 km/h flat out. A GT3 lap is ~25–30% slower than an F1 car's.
export default {
  id: 'mclaren',
  name: 'MC-GT',
  short: 'MC',
  car: 'Apex MC-GT (mid-engined)',
  specs: ['4.0 twin-turbo V8', '1,300 kg', 'ABS · traction control'],

  darkNights: ['lemans', 'nurburgring'],
  trackLimits: { strikes: 5 },
  pitStop: { time: 8 },
  damage: { strength: 1.8, frontAero: 0.2 },
  tyreLife: 1.5,

  physics: {
    // --- engine & brakes ---
    accel: 10,            // m/s²: first-gear push (traction limits it first)
    power: 248,           // W/kg: 380 kW ÷ 1,380 kg, less drivetrain losses (turbo torque: strong from low revs)
    accelFade: 0.55,
    traction: 0.6,        // mid-engined: plenty of weight on the rear tyres
    spinRotation: 0.6,
    tc: 0.7,
    combined: true,
    drag: 0.00052,        // ½ × 1.2 × drag area 1.2 m² ÷ 1,380 kg → ~281 km/h flat out
    roll: 0.45,
    liftOff: 2.5,         // turbo V8: little engine braking
    brake: 16,            // ~2 g with ABS, from any speed
    // --- grip: GT3 slicks on a heavy car, modest downforce ---
    mu: 1.45,             // ~1.6 g in slow corners
    g: 9.81,
    downforce: 0.00122,   // ½ × 1.2 × lift area 2.8 m² ÷ 1,380 kg: ~2.0 g at 200 km/h, ~2.3 g at 250
    // --- steering & handling feel ---
    wheelbase: 2.67,      // the real one
    steerBase: 3.6,       // steering as tuned for the GT3s (see gt3.js)
    trackWidth: 1.69,
    maxSteer: 0.4,
    steerFade: 26,
    steerRate: 2.0,
    yawResponse: 6.8,     // mid-engined: a little sharper than the front-engined GT3
    slideAllowance: 1.15,
    trailBrake: 0.22,
    powerRotation: 0.24,
    stability: 1.9,
    // --- driver aids ---
    abs: true,
    lockThreshold: 1.25,
    lockSteer: 0.30,
    lockBrake: 0.8,
    reverseMax: 12,
    // --- size (4.7 m long, 2.1 m wide) ---
    radius: 1.2,
    contactOffset: 1.25,
  },

  // 6-speed sequential; the turbo V8 pulls from ~5,200 to ~7,800 rpm
  gearbox: {
    top: [0, 28, 39, 50, 61, 71, 80],
    neutral: 1500,
    rpm: [5200, 7800],
    flash: 7600,
  },

  headlights: { at: [0.72, 0.57, 2.05], colour: 0xf4f6ff, intensity: 1, lamps: ['lights_emissive', 'lights_emissive_0', 'endu_lights_emissive'] },
  sound: 'mclaren',       // (audio.js ENGINES.mclaren: twin-turbo V8, whistle and wastegate)
  ers: null,

  // "mclaren_720s_gt3_2" by MattDoesBlender on Sketchfab, CC-BY-NC-SA-4.0: non-commercial (credit in the README). Prepared for the game (wheels and steering
  // wheel split, damage glass and blurred-rim copies removed, scaled to the 2.67 m wheelbase; 473k → 206k triangles).
  model: {
    url: '/models/mclaren_720s_gt3.glb',
    length: null,
    builtin: 'gt',
    farLivery: { color: 0xf2f2f2, accent: 0xff7a00 },
    lite: [],
    steeringLock: 2.6, frontWheelSteer: 1.4, maxSpinPerFrame: 0.5, blurSpeed: [4, 11],
    cams: { tcam: { name: 'Roof cam', x: 0, z: 0.1, y: 1.3, tilt: -1.5 }, cockpit: { x: 0.28, z: 0.02, y: 1.02, tilt: -2 } },
  },

  cameras: {
    chase: { pos: [0, 3.2, -8.8], look: [0, 1.1, 6] },
    far: { pos: [0, 5.3, -14], look: [0, 0.8, 8] },
    back: { pos: [0, 2.9, 7.6], look: [0, 1.1, -8] },
  },
};