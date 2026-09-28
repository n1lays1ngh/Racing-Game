# Apex Circuit

An open-wheel racing game that runs in the browser, built with **Three.js** and **Vite**.
It has a 4.1 km procedural circuit, 5 AI rivals, start lights, lap timing, live standings, a minimap,
four camera views, synthesised engine sound and gamepad support.

## Requirements

- **Node.js 20.19+ or 22.12+** (check with `node -v`; Vite 8 needs this)
- A modern desktop browser (Chrome, Edge, Firefox or Safari)

## Run it

```bash
cd apex-circuit
npm install
npm run dev
```

Vite opens http://localhost:5173 for you. Saved edits hot-reload in the browser.

| Command           | What it does                                          |
|-------------------|-------------------------------------------------------|
| `npm run dev`     | Dev server with hot reload                            |
| `npm run build`   | Production build into `dist/` (static files you can host anywhere) |
| `npm run preview` | Serve the production build locally                    |
| `npm run sim`     | Headless race sim in Node (`npm run sim -- 3 hard`) for testing physics and AI |

## Scaffolding from scratch

If you'd rather build the project yourself than use this folder:

```bash
npm create vite@latest apex-circuit -- --template vanilla
cd apex-circuit
npm install three
# delete the template's counter.js, javascript.svg and style.css,
# then copy in index.html, vite.config.js, src/ and tools/ from this project
npm run dev
```

## Controls

| Key                  | Action                         |
|----------------------|--------------------------------|
| W / ↑                | Throttle                       |
| S / ↓ / Space        | Brake (hold when stopped to reverse) |
| A D / ← →            | Steer                          |
| C                    | Cycle camera: chase, far chase, T-cam, cockpit |
| R                    | Reset onto the track           |
| M                    | Mute                           |
| Esc / P              | Pause                          |
| Gamepad              | Left stick steers, RT throttle, LT brake |

## Project layout

```
index.html          HUD, menus and overlays (plain HTML)
vite.config.js
src/
  main.js           Renderer, game loop, cameras, menus
  track.js          Circuit spline → samples, racing line, track projection
  physics.js        Arcade car physics (grip, downforce, slip, walls), gearbox
  ai.js             Speed profile + pure-pursuit AI drivers
  race.js           Grid, start lights, laps, timing, positions, collisions
  carModel.js       Procedural open-wheel car mesh
  scenery.js        Sky, sun and shadows, road, kerbs, barriers, gantry, stands, trees
  hud.js            Speedo, timing, standings, minimap
  input.js          Keyboard and gamepad
  audio.js          Web Audio engine, tyre and wind sound
  style.css
tools/simulate.mjs  Runs a whole race headless
```

`physics.js`, `track.js`, `ai.js` and `race.js` don't import any rendering code,
which is why the whole race can run in Node.

## Ways to customise it

- **New circuit:** edit `TRACK_POINTS` in `src/track.js`. These are (x, z) points in metres, in driving order.
  Keep corner radii above about 30 m and keep separate sections more than 45 m apart,
  otherwise the barriers overlap. Then run `npm run sim` to check the AI still gets round cleanly.
- **Car handling:** change the numbers in `CAR` in `src/physics.js`: `mu` (grip), `downforce`, `accel`, `brake`, `maxSteer`.
- **AI pace:** change `DIFFICULTY` in `src/race.js`.
- **Teams and liveries:** edit `TEAMS` in `src/race.js`.
- **Real 3D car model:** export a `.glb` from Blender, load it with `GLTFLoader`
  (`three/examples/jsm/loaders/GLTFLoader.js`) in `carModel.js`, and keep the same `syncCarModel` interface.

## Ideas for what to build next

- Ghost car of your best lap (record `x, z, h` every frame and replay it)
- Tyre wear and pit stops
- A track editor that lets you drag the spline points
- Rain with lower grip, spray particles and a wet sky
- Online multiplayer with WebSockets (Colyseus or Socket.IO) that syncs car states at about 20 Hz
- Touch controls for mobile
- Post-processing with `EffectComposer`: bloom and motion blur

## Performance tips

If frame rate is low, reduce `shadow.mapSize` in `scenery.js` (2048 → 1024), lower `TREES`,
or cap the pixel ratio at 1 in `main.js`.

## A note on naming

All teams, liveries and branding here are made up. "Formula 1", "F1", and real team names, logos and drivers
are trademarks, so keep the game generic if you publish it.
