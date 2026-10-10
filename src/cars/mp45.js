// 1989 V10 open-wheeler (McLaren MP4/5-like): no wings to speak of by today's standards, a big naturally
// aspirated V10, a manual gearbox and no driver aids at all. Every setting is explained in f1.js.
//
// Real figures it's tuned to (public, approximate): 3.5-litre Honda V10, ~510 kW (685 hp) at 13,000 rpm; 500 kg dry,
// ~650 kg on average with the driver and fuel (no refuelling: the tank was full at the start); 6-speed manual; wide Goodyear
// slicks; flat floor (no ground effect) and simple wings: about half today's downforce; carbon brakes; no traction
// control, no ABS, no power steering. A 1989 lap is ~10–15% slower than a 2023 one.
export default {
  id: 'mp45',
  name: 'Open-Wheel 1989',
  short: 'OW89',
  car: 'Apex V10-89',
  specs: ['3.5 V10 · 13,000 rpm', '500 kg', '6-speed manual'],

  darkNights: [],
  trackLimits: { strikes: 3 },
  pitStop: { time: 8.5 },          // tyres only, by hand
  damage: { strength: 1.1, frontAero: 0.3 },

  physics: {
    // --- engine & brakes ---
    accel: 20,
    power: 660,           // W/kg: ~485 kW in race trim ÷ 650 kg, less drivetrain losses
    accelFade: 0.6,
    traction: 0.6,
    spinRotation: 0.9,    // the rear steps out easily on the power …
    tc: 0,                // … and there's no traction control to catch it (raise it to make the car friendlier)
    combined: true,
    drag: 0.00097,        // ½ × 1.2 × drag area 1.05 m² ÷ 650 kg → ~317 km/h flat out
    roll: 0.45,
    liftOff: 4,
    brake: 28,            // early carbon brakes and far less downforce: ~3.8 g from 300 km/h, ~2.7 g from 100
    // --- grip: wide slicks, little downforce ---
    mu: 1.6,              // 1989 compounds: ~1.8 g in slow corners
    g: 9.81,
    downforce: 0.00166,   // ½ × 1.2 × lift area 1.8 m² ÷ 650 kg: ~2.4 g at 200 km/h, ~3.5 g at 300
    // --- steering & handling feel: short, light, no power steering ---
    wheelbase: 2.896,
    steerBase: 3.3,
    trackWidth: 1.72,
    maxSteer: 0.38,
    steerFade: 30,
    steerRate: 1.8,       // heavy unassisted steering: slower hands
    yawResponse: 7.5,
    slideAllowance: 1.14, // slides more before it lets go
    trailBrake: 0.18,
    powerRotation: 0.24,
    stability: 1.7,
    // --- lock-ups (no ABS): the fronts lock more easily ---
    lockThreshold: 1.15,
    lockSteer: 0.30,
    lockBrake: 0.78,
    reverseMax: 10,
    // --- size (4.4 m long, 2.15 m wide) ---
    radius: 1.2,
    contactOffset: 1.1,
  },

  // 6-speed manual; the V10 between 10,000 and 13,500 rpm
  gearbox: {
    top: [0, 33, 45, 56, 67, 78, 92],
    neutral: 4000,
    rpm: [10000, 13500],
    flash: 13200,
  },

  headlights: null,
  sound: 'f1_loud',       // (audio.js ENGINES.f1_loud: the RB19's engine sound, a bit louder)
  ers: null,

  // "McLaren MP4/5 || Formula 1" by dark_igorek on Sketchfab, CC-BY-4.0 (credit in the README). Prepared for the game (wheels split,
  // scaled to the 2.896 m wheelbase; 329k → 137k triangles).
  model: {
    url: '/models/mclaren_mp45.glb',
    length: null,
    builtin: 'f1',
    farLivery: { color: 0xf2f2f2, accent: 0xd40000 },
    lite: [],
    steeringLock: 2.4, frontWheelSteer: 1.4, maxSpinPerFrame: 0.5, blurSpeed: [4, 11],
    finish: { maxMetalness: 0.2, minRoughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2 },
    tyreStripes: false,
    cams: { tcam: { z: 0.0, y: 1.06, tilt: -5 }, cockpit: { z: 0.28, y: 0.8, tilt: -4 } },
  },

  cameras: {
    chase: { pos: [0, 2.7, -8.0], look: [0, 0.9, 6] },
    far: { pos: [0, 4.8, -13.2], look: [0, 0.6, 8] },
    back: { pos: [0, 2.4, 7.0], look: [0, 0.9, -8] },
  },
};