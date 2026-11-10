// MotoGP: a 2026 prototype racing bike (Ducati Desmosedici-style: ~1000 cc V4, ~300 hp, 157 kg + rider).
//
// A bike drives differently from a car (physics.js, the `bike` block): it turns by leaning, so steering asks for a lean
// angle and the bike rolls into it (it takes a moment: flicking from full lean one way to the other is most of a
// second); the turn follows from the lean (a lean of θ corners at g·tan θ). How far it can lean is the tyres' grip.
// The front wheel lifts under hard acceleration and the rear goes light under hard braking, which is what limits a
// bike's acceleration and braking (not the tyres); braking or opening the throttle while leaned over takes grip the
// corner needs. How it looks (lean, wheelies, the rider hanging off) is bikeModel.js.
export default {
  id: 'motogp',
  name: 'GP-26',
  short: 'GP26',
  car: 'Apex GP-26 (MotoGP)',
  specs: ['1000 cc V4', '157 kg', '6 gears'],
  category: 'bike',          // the menu's group (cars/index.js CATEGORIES)
  bike: true,                // two wheels: the bike's model (bikeModel.js), cameras and physics
  dev: false,

  darkNights: [],
  trackLimits: { strikes: 3 },
  pitStop: { time: 6 },      // (a MotoGP rider swaps to his second bike: no tyre stops)
  damage: { strength: 0.8, frontAero: 0.15 },

  physics: {
    // From public figures: ~157 kg bike + ~68 kg rider, ~220 kW, ~350 km/h on the long straights, 0–100 km/h in ~2.6 s
    // (the front wheel limits it), braking ~1.4–1.5 g (the rear lifting limits it), ~60° of lean (~1.6 g in corners).
    // --- engine & brakes ---
    accel: 10.6,          // m/s²: the most it can push (wheelie control holds it at about 1.08 g)
    power: 880,           // W/kg: ~220 kW ÷ 225 kg, less drivetrain losses
    accelFade: 0.6,
    traction: 0.74,       // one driven tyre: it puts down at most this share of the grip (less leaned over: combined)
    spinRotation: 0.25,   // wheelspin leaned over steps the rear out a little …
    tc: 0.7,              // … traction control catches most of it
    combined: true,       // a friction circle: braking or driving leaned over takes grip the corner needs
    combinedMin: 0.3,     // (a bike has almost nothing left at full lean: brake upright, pick it up, then drive)
    drag: 0.00093,        // aero drag (× v²): tops out ~350 km/h
    roll: 0.3,
    liftOff: 2.6,         // engine braking off the throttle
    brake: 14.2,          // m/s² (the stoppie limit: bike.stoppie)
    // --- grip ---
    mu: 1.55,             // tyre grip: ~1.55 g, ~57° of lean
    g: 9.81,
    downforce: 0.00008,   // the winglets: a little more at speed
    // --- steering & handling ---
    wheelbase: 1.46,
    maxSteer: 0.6,        // bars' lock at walking pace
    steerFade: 5,         // a bike turns with its lean at speed: the bars barely move
    steerRate: 3,
    yawResponse: 12,      // (the lean is the slow part: bike.roll)
    slideAllowance: 1.03, // a bike hardly slides: past the grip it runs wide
    trailBrake: 0.04,
    powerRotation: 0,
    stability: 3,
    lockThreshold: 1.15,  // grabbing the front brake leaned over locks the front (understeer, braking lost)
    lockSteer: 0.3,
    lockBrake: 0.75,
    reverseMax: 2,
    // --- how it feels when YOU ride it (the AI keeps the numbers above) ---
    human: {
      // The stick is the lean: half stick = half lean, full stick = as far as the tyres allow, at any speed
      // (physics.js bikeLean). Before, the lightest touch at speed was already full lean.
      leanSteer: true,
      leanCurve: 1.3,       // above 1: the first part of the stick is gentler (small corrections on the straights)
      leanMargin: 0.95,     // full stick stops this share short of the tyres' limit: a little in hand
      steerRate: 6,         // (the lean is the slow part, not your hands)
      combinedMin: 0.55,    // (0.3) braking leaned over still leaves this much grip to turn: you can trail the brake in
      lockThreshold: 1.7,   // (1.15) the front only locks if you grab a lot of brake at a lot of lean
      slideAllowance: 1.08, // (1.03) it slides a touch before it runs wide
      tc: 0.85,             // (0.7) more traction control: full throttle leaned over is held, not punished
    },
    // --- size for contact (race.js): two small circles along the bike ---
    radius: 0.5,
    contactOffset: 0.55,
    trackWidth: 0,        // one track of tyre marks
    // --- the bike (physics.js) ---
    bike: {
      maxLean: 1.08,      // rad (62°): the most it leans, grip allowing
      rollRate: 2.7,      // rad/s: the fastest it changes lean (a full flick left to right takes ~0.8 s)
      rollResponse: 7,    // 1/s: how quickly the lean follows the steering
      lowSpeed: 6,        // m/s: slower than this it steers with the bars (paddock speed), faster with the lean
      wheelie: 10.4,      // m/s²: acceleration at which the front wheel lifts (the wheelie control holds it there)
      stoppie: 14.2,      // m/s²: braking at which the rear lifts
      wheelieMax: 0.16,   // rad: the most the front comes up (shown: bikeModel.js)
    },
  },

  gearbox: {
    top: [0, 30, 45, 58, 70, 82, 98], // m/s at the top of each gear (6 gears)
    neutral: 3800,
    rpm: [10500, 18000],
    flash: 17600,
  },

  headlights: null,
  sound: 'v4',               // audio.js ENGINES
  ers: null,

  // ---- How it looks (bikeModel.js; the model was prepared with tools/prepare-bike.mjs: metres, nose +Z, tyres on
  // y = 0, the axles' middle at z = 0, the wheels split out to spin) ----
  // "Ducati Lenovo Team - MotoGP26" (Sketchfab; check its licence and credit it in the README)
  model: {
    url: '/models/motogp_gp26.glb',
    length: null,             // already to scale
    forAI: true,              // every bike on the grid is this bike, its rider in the team's colours
    maxSpinPerFrame: 0.6,
    blurSpeed: [4, 11],
    finish: { maxMetalness: 0.35, minRoughness: 0.35, clearcoat: 0.3, clearcoatRoughness: 0.25 },
    // onboard cameras: on the tail behind the rider, and the rider's eyes (z forward of the axles' middle, y up, tilt °)
    cams: { tcam: { name: 'Tail cam', z: -0.95, y: 1.2, tilt: -4 }, cockpit: { z: 0.3, y: 1.09, tilt: -3 } },
  },

  // chase cameras: closer and lower than a car's (a bike is small)
  cameras: {
    chase: { pos: [0, 1.9, -5.2], look: [0, 0.9, 5] },
    far: { pos: [0, 3.2, -9], look: [0, 0.7, 7] },
    back: { pos: [0, 1.8, 5], look: [0, 0.9, -6] },
  },
};