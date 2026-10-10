// 2006 V8 open-wheeler (Renault R26-like): the last of the screaming V8s' first year, on grooved tyres.
// Every setting is explained in f1.js; only what differs is described here.
//
// Real figures it's tuned to (public, approximate): 2.4-litre V8, ~560 kW (750 hp) at 19,000 rpm, no hybrid;
// 605 kg with the driver (+ a light fuel load in the refuelling era: ~640 kg); 7-speed seamless gearbox; grooved
// Michelin tyres (four grooves: less grip at low speed than slicks); traction control was legal; no ABS.
// Against the 2023 car (f1.js): ~160 kg lighter, about the same power-to-weight (with no battery to deploy), less
// grip in slow corners, as much in fast ones; it brakes later and turns in sharper. A 2006 lap is ~1–2% slower.
export default {
  id: 'r26',
  name: 'Open-Wheel 2006',
  short: 'OW06',
  car: 'Apex V8-06',
  specs: ['2.4 V8 · 19,000 rpm', '605 kg', '7 gears'],

  darkNights: [],
  trackLimits: { strikes: 3 },
  pitStop: { time: 7.5 },          // refuelling era: tyres and fuel
  damage: { strength: 1, frontAero: 0.45 },

  physics: {
    // --- engine & brakes ---
    accel: 22,            // m/s²: the most the engine can push in the low gears (traction limits it first)
    power: 805,           // W/kg: 560 kW ÷ 640 kg, less drivetrain losses (push = power ÷ speed)
    accelFade: 0.6,
    traction: 0.6,        // narrower grooved rears than today's slicks
    spinRotation: 0.8,
    tc: 0.7,              // traction control (legal in 2006)
    combined: true,       // braking / driving and turning share the tyres
    drag: 0.00108,        // ½ × 1.2 × drag area 1.15 m² ÷ 640 kg → ~326 km/h flat out
    roll: 0.4,
    liftOff: 4.5,         // a high-revving V8's engine braking (no hybrid harvesting)
    brake: 46,            // ~6 g from 300 km/h, ~5 g from 200 (light car, carbon brakes)
    // --- grip ---
    mu: 1.55,             // grooved tyres: ~2.0 g in slow corners (2023 slicks: ~2.2 g)
    g: 9.81,
    downforce: 0.00403,   // ½ × 1.2 × lift area 4.3 m² ÷ 640 kg: ~3.5 g at 200 km/h, ~6 g at 300
    // --- steering & handling feel: lighter and shorter than the 2023 car, so sharper ---
    wheelbase: 3.1,       // the real one (the model, tyre marks)
    steerBase: 3.4,       // steering geometry: a bit sharper than the 2023 car's 3.6 m
    trackWidth: 1.44,
    maxSteer: 0.36,
    steerFade: 32,
    steerRate: 2.5,
    yawResponse: 9.8,
    slideAllowance: 1.08,
    trailBrake: 0.15,
    powerRotation: 0.2,
    stability: 2.1,
    // --- lock-ups (no ABS) ---
    lockThreshold: 1.2,
    lockSteer: 0.30,
    lockBrake: 0.8,
    reverseMax: 12,
    // --- size (4.6 m long, 1.8 m wide) ---
    radius: 1.2,
    contactOffset: 1.25,
  },

  // 7 gears, close ratios: the V8 lives between 16,000 and 19,000 rpm
  gearbox: {
    top: [0, 31, 41, 50, 59, 69, 80, 92],
    neutral: 4500,
    rpm: [16000, 19000],
    flash: 18700,
  },

  headlights: null,
  sound: 'f1_loud',       // (audio.js ENGINES.f1_loud: the RB19's engine sound, a bit louder)
  ers: null,              // no hybrid

  // "2006 Renault" (CIM): the file carries no author or licence: find them and credit them in the README. Prepared for the game (wheels, calipers
  // split; scaled to the 3.1 m wheelbase; 174k → 95k triangles). The file came without its livery (the skin textures
  // were missing), so it's painted in the team's 2006 blue and yellow.
  model: {
    url: '/models/renault_r26.glb',
    length: null,
    builtin: 'f1',
    farLivery: { color: 0x2f86e8, accent: 0xf2c200 },
    lite: [],
    steeringLock: 1.75, frontWheelSteer: 1.4, maxSpinPerFrame: 0.5, blurSpeed: [4, 11],
    finish: { maxMetalness: 0.25, minRoughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.2 },
    tyreStripes: false,   // (no compound stripes in 2006)
    cams: { tcam: { z: -0.25, y: 1.2, tilt: -5 }, cockpit: { z: 0.12, y: 0.8, tilt: -4 } },
  },

  cameras: {
    chase: { pos: [0, 2.8, -8.2], look: [0, 0.9, 6] },
    far: { pos: [0, 4.9, -13.5], look: [0, 0.6, 8] },
    back: { pos: [0, 2.5, 7.2], look: [0, 0.9, -8] },
  },
};