// 911 GT3 R: the Porsche 911 GT3 R (992), a rear-engined 4.2 flat-six GT3 racer, in the pink "Roxy" livery.
// Every setting is explained in f1.js.
//
// The same class as the GT3 (the AMG), and like real GT3 cars under the Balance of Performance the two lap within a
// few tenths of each other, but they get there differently. The engine hangs out behind the rear axle, so the
// 911 puts its power down earlier out of slow corners, brakes a little later (the weight on the rear tyres helps)
// and turns in sharply, and the rear steps out on the power if you're greedy. The AMG's big front-engined V8 is a
// touch quicker down the straights. Lighter (1,250 kg), and the flat-six revs past 9,000. ABS and traction control,
// no hybrid.   npm run sim -- 1 hard lemans porsche
export default {
  id: 'porsche',
  name: '911 GT3 R',
  short: '911',
  car: 'Porsche 911 GT3 R (992)',
  specs: ['4.2 flat-six', '1,250 kg', 'ABS · traction control'],

  // ---- When it races, and track limits (see hypercar.js) ----
  darkNights: ['lemans', 'nurburgring'],
  trackLimits: { strikes: 5 },
  // ---- Pit stops (pitstop.js): seconds stationary in the box (tyres and fuel, game length) ----
  pitStop: { time: 8 },
  damage: { strength: 1.8, frontAero: 0.2 },  // (damage.js) a road car underneath: the toughest
  tyreLife: 1.5,          // endurance tyres: they last 1.5× as long as the F1 car's (tyres.js)

  // ---- How it drives ----
  physics: {
    // --- engine & brakes ---
    accel: 9.95,          // the rear-engine weight on the driven wheels: more drive out of slow corners
    accelFade: 0.575,
    drag: 0.000705,       // → about 287 km/h flat out
    roll: 0.45,
    liftOff: 6.0,
    brake: 26.5,
    // --- grip ---
    mu: 1.6,
    g: 9.81,
    downforce: 0.00064,
    // --- steering & handling feel ---
    wheelbase: 2.507,      // the real one (where the wheels are: tyre marks, the model)
    steerBase: 3.6,       // … but the steering works like the F1 car's 3.6 m (as in gt3.js)
    trackWidth: 1.67,     // between the left and right wheels (tyre marks; the model's)
    maxSteer: 0.4,
    steerFade: 26,
    steerRate: 2.1,
    yawResponse: 7.0,     // lighter at the front than the AMG: quicker to turn in
    slideAllowance: 1.16,
    trailBrake: 0.24,     // a light nose: it rotates on the brakes
    powerRotation: 0.3,   // … and the tail steps out on the power (traction control tames it)
    stability: 1.7,
    // --- driver aids ---
    abs: true,            // can't lock the wheels
    tc: 0.7,
    // --- lock-ups (ABS stops them) ---
    lockThreshold: 1.25,
    lockSteer: 0.30,
    lockBrake: 0.8,
    reverseMax: 12,
    // --- size (4.62 m long, 2.05 m wide) ---
    radius: 1.17,
    contactOffset: 1.14,
  },

  // ---- Gearbox: 6-speed sequential, a flat-six that revs to about 9,400 ----
  gearbox: {
    top: [0, 24, 34, 45, 56, 68, 80],
    neutral: 2500,
    rpm: [4400, 9400],
    flash: 9100,
  },

  // ---- Headlights (headlights.js; every setting is explained in hypercar.js) ----
  headlights: { at: [0.62, 0.62, 2.36], colour: 0xf4f6ff, intensity: 1, lamps: ['Glass', 'Glass_opaque'] },

  // ---- Engine sound (audio.js): it uses the GT3's engine sound ----
  sound: 'gt3',

  ers: null,              // no hybrid

  // ---- How it looks (carModel.js; every setting is explained in gt3.js) ----
  // "Porsche 992 GT3 R "Roxy"" by VTX on Sketchfab, CC-BY-NC-SA-4.0 (credit in the README), made for the game with
  // tools/prepare-car.mjs: rigged (wheels, calipers, steering wheel and its buttons, dash screen), 470k → 152k triangles.
  model: {
    url: '/models/porsche_911_gt3r.glb',
    length: null,
    builtin: 'gt',            // the AI cars: the built-in GT3 (carBodies.js), in their team's colours
    farLivery: { color: 0xe23585, accent: 0x18d848 }, // friends' cars further away (online): Roxy pink and green
    lite: [],
    steeringLock: 2.6, frontWheelSteer: 1.4, maxSpinPerFrame: 0.5, blurSpeed: [4, 11],
    // the roof camera, and the driver's eyes in the left-hand seat: below the roll cage and the sun strip, looking
    // out through the clear part of the windscreen
    cams: { tcam: { name: 'Roof cam', x: 0, z: -0.3, y: 1.35, tilt: -1.5 }, cockpit: { x: 0.30, z: -0.34, y: 0.95, tilt: -2 } },
  },

  // ---- Chase cameras: as the GT3's ----
  cameras: {
    chase: { pos: [0, 3.2, -8.8], look: [0, 1.1, 6] },
    far: { pos: [0, 5.3, -14], look: [0, 0.8, 8] },
    back: { pos: [0, 2.9, 7.6], look: [0, 1.1, -8] },
  },
};