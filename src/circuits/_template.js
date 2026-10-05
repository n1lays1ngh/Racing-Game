// TEMPLATE — copy this file to make a new circuit, then add it to index.js.
//
// Every distance below (startAt, from/to, at) is in metres along the lap,
// measured from points[0] in driving direction. Negative numbers count back
// from the end of the lap (e.g. -200 = 200 m before points[0]).
// Only `id`, `name`, `type` and `points` are required; everything else has a
// sensible default for the circuit type (see CIRCUIT_DEFAULTS in track.js).
//
// Tip: run `npm run sim -- 3 hard <id>` after editing. If "off-track samples" is well
// above 0, a corner is too tight for the AI or the barriers are too close.
export default {
  id: 'my-circuit',          // unique, used in code and the sim command
  name: 'My Circuit',        // shown in the menu
  country: 'Somewhere',
  round: 25,                 // optional: calendar round, shown in the menu
  type: 'permanent',         // 'permanent' (open run-off) or 'street' (walls close to the track)
  time: 'day',               // 'day', 'dusk' (sunset, floodlights on) or 'night' (floodlit race)

  // ---- Layout ----
  startAt: 0,                // where the start/finish line is (grid lines up behind it)
  width: 14,                 // tarmac width. Defaults: permanent 14, street 11
  widths: [                  // optional sections with a different width
    // { from: 2530, to: 2720, width: 7.6, name: 'castle section' },
  ],

  // ---- Edges ----
  kerbWidth: 1.5,            // kerb strip outside the white line. Defaults: permanent 1.5, street 1.0
  runoff: 15.5,              // metres between kerb and barrier. Defaults: permanent 15.5, street 1.5
  runoffSections: [          // escape roads or tighter bits. side: 'L' | 'R' | 'both' (driver's left/right)
    // { from: 380, to: 470, side: 'R', runoff: 10, name: 'Turn 1 escape road' },
  ],
  surface: 'grass',          // run-off surface: 'grass' (slow), 'tarmac' (grippy), 'gravel' (very slow)
  gravel: 'auto',            // 'auto' = gravel traps on the outside of corners, 'none',
                             // or a list: [{ from: 500, to: 620, side: 'L' }]
  barrier: 'ads',            // barrier look: 'ads' (advertising boards) or 'concrete' (street walls)
                             // Barriers automatically move closer where two parts of the track run side by side.

  // ---- Buildings ----
  pits: [{ from: -400, to: -20 }],   // pit building on the infield side
  stands: [                  // grandstands. side: 'L' | 'R' | 'out' (outside of the corner at that point)
    // { at: -180, len: 200, side: 'L', name: 'Main Grandstand' },
    // { at: 560, len: 90, side: 'out', name: 'Turn 1' },
  ],

  // ---- Shape ----
  banking: [                 // banked corners, tilted toward the inside. at → at + len fully banked;
                             // ramp: metres it takes to build up / die away (default 45; ~150 for an oval's 31°)
    // { at: 854, len: 134, deg: 19, name: 'Hugenholtzbocht' },
  ],
  elevation: [],             // road heights (m), evenly spaced round the lap from points[0]. [] = flat.
                             // Only the shape matters (the game uses heights relative to the average).

  terrain: null,             // optional: the real ground around the circuit, in the same heights as `elevation`:
                             // { x0, z0, step, cols, rows, heights: [...] } (rows northwards from z0, each row
                             // westwards from x0, `step` metres apart). null = made-up hills (see nurburgring.js).

  // ---- Surroundings ----
  scenery: { ground: 'grass', trees: 350, buildings: 0 }, // ground: 'grass' | 'sand' | 'city'
  forest: [                  // stretches through the woods: only trees there, right behind a steel guardrail
                             // (no gravel, grandstands, sponsor walls or braking boards; forest.js)
    // { from: 4330, to: 24480, name: 'Nordschleife' },
  ],
  meadows: [                 // open fields along a forest stretch: the trees start further back.
                             // woods: 0 = open fields … 1 = forest; side: 'L' | 'R' | 'both'
    // { from: 21880, to: 23420, side: 'both', woods: 0.1, name: 'Döttinger Höhe' },
  ],

  // ---- Centreline ----
  // [x, z] in metres, in driving order: x = west, z = north (so the minimap shows north up).
  // From GPS: x = -(lon - lon0) * 111195 * cos(lat0), z = (lat - lat0) * 111195 (lon0/lat0 = the circuit's centre).
  // Layouts for most F1 circuits: https://github.com/bacinger/f1-circuits (MIT)
  points: [
    // [0, 0], [0, 500], ...
  ],
};