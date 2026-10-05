// GT3: the Mercedes-AMG GT3, a front-engined 6.2 V8 GT racer, in Red Bull colours. Every setting is explained in f1.js.
//
// The heaviest (1,285 kg), least powerful car, with a fraction of the F1 car's downforce: it brakes far
// earlier, slides more and leans on mechanical grip. Like a real GT3 it has ABS and traction control,
// so it can't lock its wheels, and no hybrid boost.
// Tuned with the sim against the real thing: LMGT3 pole at Le Mans 2026 was 3:52.4; at the Nürburgring 24 Hours
// (2024) pole was 8:10.992.   npm run sim -- 1 hard lemans gt3
export default {
  id: 'gt3',
  name: 'GT3',
  short: 'GT3',
  car: 'Mercedes-AMG GT3',
  specs: ['6.2 V8', '1,285 kg', 'ABS · traction control'],

  // ---- When it races (see hypercar.js) ----
  times: { '*': ['day'], lemans: ['day', 'night'], nurburgring: ['day', 'night'] },
  night: 'pits',

  // ---- How it drives ----
  physics: {
    // --- engine & brakes ---
    accel: 9.7,
    accelFade: 0.55,
    drag: 0.00069,        // → about 290 km/h flat out
    roll: 0.45,
    liftOff: 6.5,
    brake: 25.5,
    // --- grip ---
    mu: 1.6,
    g: 9.81,
    downforce: 0.00066,
    // --- steering & handling feel ---
    wheelbase: 2.63,       // the real one (where the wheels are: tyre marks, the model)
    steerBase: 3.6,       // … but the steering works like the F1 car's 3.6 m: the handling and the AI are tuned for
                          // that, and a short one makes the steering twitchy (the AI weaves and runs wide)
    trackWidth: 1.65,     // between the left and right wheels (tyre marks; the model's)
    maxSteer: 0.4,
    steerFade: 26,
    steerRate: 2.0,
    yawResponse: 6.5,     // heavier
    slideAllowance: 1.18, // slides more before it lets go
    trailBrake: 0.2,
    powerRotation: 0.26,
    stability: 1.8,
    // --- driver aids ---
    abs: true,            // can't lock the wheels
    tc: 0.7,
    // --- lock-ups (ABS stops them) ---
    lockThreshold: 1.25,
    lockSteer: 0.30,
    lockBrake: 0.8,
    reverseMax: 12,
    // --- size (4.75 m long, 2.05 m wide) ---
    radius: 1.17,
    contactOffset: 1.2,
  },

  // ---- Gearbox: 6 gears, a big V8 that revs to about 7,500 ----
  gearbox: {
    top: [0, 23, 33, 43, 54, 66, 81],
    neutral: 2200,
    rpm: [3800, 7600],
    flash: 7300,
  },

  // ---- Headlights (headlights.js; every setting is explained in hypercar.js) ----
  headlights: { at: [0.70, 0.53, 2.36], colour: 0xf4f6ff, intensity: 1, lamps: ['Glass', 'Glass_opaque'] },

  // ---- Engine sound (audio.js: ENGINES.gt3): the big V8's burble ----
  sound: 'gt3',

  ers: null,              // no hybrid

  // ---- How it looks (carModel.js) ----
  // "Mercedes Benz AMG GT3 Red Bull" by toddeppe on Sketchfab, CC-BY-4.0 (credit in the README), made for the game
  // with tools/prepare-car.mjs: rigged (wheels, calipers, steering wheel, dash screen), 420k → 160k triangles.
  model: {
    url: '/models/amg_gt3.glb',
    length: null,             // null = the file is already to scale, in metres, centred on the axles (prepare-car.mjs)
    builtin: 'gt',            // the light built-in car: AI cars further away (and your car if the model can't load)
    // AI cars close up are this model repainted: the livery's navy blue becomes the team's colour (stickers stay)
    paint: { material: 'Body', colour: '#081848' },
    farLivery: { color: 0x081848, accent: 0xd81838 }, // friends' cars further away (online): the light car in these colours
    lite: [],                 // parts left out of other people's cars (none: its steering wheel is one light part)
    steeringLock: 2.6, frontWheelSteer: 1.4, maxSpinPerFrame: 0.5, blurSpeed: [4, 11],
    // Onboard cameras (x = metres to the left of the middle, name = what the HUD calls it, the rest as in f1.js):
    // the roof camera, and the driver's eyes in the left-hand seat behind the wheel (prepare-car.mjs prints where)
    cams: { tcam: { name: 'Roof cam', x: 0, z: -0.35, y: 1.36, tilt: -1.5 }, cockpit: { x: 0.40, z: -0.765, y: 0.915, tilt: -2 } },
  },

  // ---- Chase cameras: a taller car than the F1 car ----
  cameras: {
    chase: { pos: [0, 3.2, -8.8], look: [0, 1.1, 6] },
    far: { pos: [0, 5.3, -14], look: [0, 0.8, 8] },
    back: { pos: [0, 2.9, 7.6], look: [0, 1.1, -8] },
  },
};