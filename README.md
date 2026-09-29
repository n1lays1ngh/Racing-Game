# Apex Circuit

An open-wheel racing game that runs in the browser, built with **Three.js** and **Vite**.
24 real Grand Prix layouts built from GPS data, with real elevation from the official F1 timing data (Eau Rouge, Turn 1 at COTA),
banked corners (Zandvoort, Jeddah), grandstands, pit buildings and gravel traps. Street circuits
(Monaco, Singapore, Baku, Las Vegas…) have concrete walls close to the track and a city around them.
Night races (Bahrain, Jeddah, Singapore, Las Vegas, Qatar) run under floodlights, and Abu Dhabi starts at sunset.
Every circuit is one file in `src/circuits/`, so you can add, remove or fine-tune tracks yourself.
Up to 19 AI rivals, online multiplayer for up to 10 friends, start lights, lap timing, live standings,
a minimap, four camera views, a rear-view mirror, synthesised engine sound and gamepad support.

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
| `npm run sim`     | Headless race sim in Node: `npm run sim -- 3 hard monza` (laps, difficulty, circuit id or `all`) |

`npm run dev` also serves the multiplayer room server, and prints a **Network** address (like
`http://192.168.1.20:5173`) that friends on the same Wi-Fi can open to join your rooms.

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
| Q (hold)             | Look behind                    |
| V                    | Rear-view mirror on / off      |
| R                    | Reset onto the track           |
| M                    | Mute                           |
| Esc / P              | Pause                          |
| Controller           | Left stick steer · RT throttle · LT brake · Y camera · B (hold) look back · LB mirror · RB tower gaps · View reset · Menu pause. In menus: D-pad/LB/RB circuit, A start, Y multiplayer; in the lobby the host's Menu button starts the race. Mapping and rumble settings in `src/input.js` |

## Multiplayer

Menu → **Multiplayer**. One person creates a room and gets a 4-letter code (or an invite link);
everyone else types the code. The host picks the circuit, laps, how many AI cars (none by default),
AI skill and whether cars collide, then starts. Up to 10 people; everyone drives the RB19 and gets
their own colour for the tower, the map and the name tag over their car. People start at the back
of the grid in random order, behind any AI. Anyone who drops out mid-race gets a DNF.

**How it works.** The host's browser is the referee: it runs the AI and sends every car's position
to everyone 20 times a second. Each player drives their own car on their own computer (no input lag)
and sends it to the host 30 times a second; other cars are drawn where they are *now*, predicted
from their last speed and turn. Lap times are measured by whoever drives the car, on a clock shared
with the host, so everyone sees the same order and times. The browsers connect directly to each
other (WebRTC); the small room server (`api/room.js`) only swaps the connection details when
someone joins. No game data goes through it.

Keep the host's tab open until the race ends: if the host leaves, the room closes. Tabs in the
background keep racing (just without drawing).

**Running it**

- `npm run dev` or `npm run preview`: rooms work straight away (kept in memory by the dev server).
  Friends on your Wi-Fi open the Network address it prints.
- **Vercel:** rooms are kept in Upstash Redis (free tier is plenty). In the Vercel dashboard open
  your project → **Storage** → **Create / Connect** → **Upstash for Redis** (free plan) → connect it
  to the project, then **redeploy**. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which is
  all `api/room.js` needs. Without it, *Create a room* says multiplayer isn't set up.
- **Relay server (recommended).** Home and phone connections usually connect directly, but office,
  college and some mobile networks block that (also two laptops on the same office/college Wi-Fi).
  A relay (TURN) server passes the race data along instead; the game only uses it when it has to.
  Cloudflare's is free up to 1,000 GB a month (a race uses a few MB):
  1. Cloudflare dashboard → **Realtime** → **TURN Server** → **Create**. Copy the *Turn Token ID* and *API Token*.
  2. For `npm run dev`: make a file called `.env.local` in the project folder (it's in `.gitignore`, so it
     never gets committed) and restart `npm run dev`:
     ```
     TURN_KEY_ID=your-turn-token-id
     TURN_KEY_API_TOKEN=your-api-token
     ```
  3. For Vercel: project → **Settings** → **Environment Variables** → add the same two (Production and
     Preview) → redeploy.

  Any other TURN server works too: set `TURN_URLS` (comma separated), `TURN_USERNAME` and `TURN_CREDENTIAL` instead.
  To check the relay works, open the game with `?relay` at the end of the address (e.g.
  `http://localhost:5173/?relay`) in both windows: everything then goes through the relay.

**Tuning:** update rates are `RATE` in `src/net/session.js`; smoothing of other people's cars is
`SMOOTH` in `src/net/remote.js`; when friends' cars switch to the light model is `LOD` in `src/carLod.js` (how many friends get the full RB19 at once, and within what distance);
name tag size and range are `TAGS` in `src/nametags.js`; max players is `NET.maxPlayers` in `src/net/peer.js`.

## Project layout

```
index.html          HUD, menus and overlays (plain HTML)
vite.config.js      Also runs the room server during npm run dev
api/room.js         Vercel Function: room codes for multiplayer
server/rooms.js     Room code + connection swap logic (used by api/room.js and vite.config.js)
src/
  main.js           Renderer, game loop, cameras, menus
  circuits/         One file per circuit (layout, width, walls, run-off, stands, elevation…)
    index.js        The list shown in the menu — add or remove circuits here
    _template.js    Copy this to make a new circuit; every option is explained in it
  track.js          Circuit file → samples, walls, surfaces, racing line; CIRCUIT_DEFAULTS
  elevation.js      Hills and crests from a circuit's elevation list
  banking.js        Banked corners
  terrain.js        Ground that follows the track's height
  rearview.js       Mirror and look-behind camera
  lighting.js       Day / dusk / night: sky, floodlights, fog, lit windows
  settings.js       Graphics settings (resolution, shadows, how many trees and buildings)
  physics.js        Arcade car physics (grip, downforce, slip, walls), gearbox
  ai.js             Speed profile + pure-pursuit AI drivers
  race.js           Grid, start lights, laps, timing, positions, collisions
  carModel.js       Your car (rigged RB19 .glb: spinning wheels, steering) and the built-in AI car
  scenery.js        Sky, sun and shadows, road, kerbs, run-off, barriers, stands, trees, city buildings
  hud.js            Speedo, timing, standings, minimap
  input.js          Keyboard and gamepad
  audio.js          Web Audio engine, tyre and wind sound
  lobby.js          Multiplayer lobby screen: create / join a room, drivers, race settings
  nametags.js       Names over friends' cars
  carLod.js         Friends' RB19s swap to a light model further away
  net/
    peer.js         Browser-to-browser connections (WebRTC) and the room server calls
    session.js      Online room: lobby, start, keeping everyone's race in step
    remote.js       Drawing other people's cars smoothly between updates
    protocol.js     The binary car-position packets
    background.js   Keeps an online race running in a background tab
  style.css
tools/simulate.mjs  Runs a whole race headless
```

`physics.js`, `track.js`, `ai.js` and `race.js` don't import any rendering code,
which is why the whole race can run in Node.

## Ways to customise it

- **Circuits:** see *Adding or changing a circuit* below.
- **Car handling:** change the numbers in `CAR` in `src/physics.js`: `mu` (grip), `downforce`, `accel`, `brake`, `maxSteer`.
- **AI pace:** change `DIFFICULTY` in `src/race.js` (`pace` = how hard it pushes, `grip` = grip bonus over you).
- **Teams and liveries:** edit `TEAMS` in `src/race.js`.
- **Real 3D car model:** export a `.glb` from Blender, load it with `GLTFLoader`
  (`three/examples/jsm/loaders/GLTFLoader.js`) in `carModel.js`, and keep the same `syncCarModel` interface.

## Adding or changing a circuit

Each circuit lives in its own file in `src/circuits/`. Only `id`, `name`, `type` and `points`
are required; anything you leave out comes from the defaults for that type
(`CIRCUIT_DEFAULTS` in `src/track.js`):

| Setting    | `'permanent'` (open circuit) | `'street'` (walls close by) |
|------------|------------------------------|-----------------------------|
| `width`    | 14 m                         | 11 m                        |
| `kerbWidth`| 1.5 m                        | 1.0 m                       |
| `runoff`   | 15.5 m to the barrier        | 1.5 m to the wall           |
| `surface`  | grass (+ gravel on corner exits) | tarmac                  |
| `barrier`  | advertising boards           | concrete walls              |
| `scenery`  | grass, 350 trees             | city, 400 buildings         |

All positions (`startAt`, `from`/`to`, `at`) are metres along the lap from the first point, in driving
direction. Negative numbers count back from the end of the lap. The options you'll use most:

```js
widths: [{ from: 2530, to: 2720, width: 7.6, name: 'Baku castle' }],   // narrow or wide sections
runoffSections: [{ from: 1150, to: 1240, side: 'R', runoff: 10, name: 'Chicane escape road' }],
gravel: [{ from: 500, to: 620, side: 'L' }],                          // or 'auto' / 'none'
stands: [{ at: 560, len: 90, side: 'out', name: 'Turn 1' }],          // 'L', 'R' or 'out' (outside of the corner)
banking: [{ at: 854, len: 134, deg: 19, name: 'Hugenholtzbocht' }],
elevation: [12, 13.5, 15, ...],                                       // heights (m), evenly spaced round the lap
time: 'night',                                                        // 'day', 'dusk' or 'night'
```

The `elevation` lists come from car positions (which include height) in the official F1 timing data,
via the TracingInsights telemetry archive (https://github.com/TracingInsights), averaged over several
qualifying laps. So hills are where they really are: 102 m of climb at Spa, 63 m at the Red Bull Ring,
42 m at Monaco. Circuits like Albert Park, Jeddah, Mexico City and Qatar really are almost flat (2–5 m).

**To add a circuit:** copy `_template.js` to `src/circuits/<id>.js`, fill it in, then import it in
`src/circuits/index.js` and add it to the `CIRCUITS` list (menu order = list order).
**To remove one:** delete its line from `CIRCUITS` (the file can stay).

Layouts for most F1 circuits are in the f1-circuits dataset (https://github.com/bacinger/f1-circuits,
MIT licence). Convert lon/lat to metres with the formula in `_template.js`. Check the data runs in
driving direction (Singapore's is reversed) and that its first point is where you think it is, then
set `startAt`. Figure-of-eight tracks like Suzuka won't work because the layout crosses itself.

After editing, run `npm run sim -- 3 hard <id>`. "off-track samples" should be 0 or close to it
(a few in lap-1 traffic is normal). If it isn't, a corner is too tight for the AI or a wall is too
close: widen that section or give it more run-off. ("wall hits" also counts car-to-car contact.)

## Using your own car model (.glb)

Your car is the RB19 in `public/models/rb19.glb` (settings in `CAR_MODEL` at the top of `src/carModel.js`).
Its wheels spin (with a motion-blur disc at speed), the front wheels steer and the steering wheel turns
with your input. That works because the model file has the wheels and steering wheel as separate parts
named `wheel_FL`, `wheel_FR`, `wheel_RL`, `wheel_RR` and `steering_wheel`, each with its pivot point
stored in the node's `extras`. Set `forAI: true` to give every car on the grid the RB19,
or `url: null` to go back to the built-in car. A different model needs the same named parts to animate. Big models (hundreds of thousands of triangles)
can be shrunk without visible loss using glTF-Transform:
`npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress false`.

## Credits

- Car model: "Oracle Red Bull F1 Car RB19 2023" by Redgrund on Sketchfab
  (https://sketchfab.com/3d-models/oracle-red-bull-f1-car-rb19-2023-e4afe46f3aab4b23a418da06fc163821),
  licensed CC-BY-4.0. If you share the game, keep this credit visible.
- Circuit layouts: bacinger/f1-circuits (MIT). Elevation: F1 timing data via TracingInsights.

## Ideas for what to build next

- Ghost car of your best lap (record `x, z, h` every frame and replay it)
- Tyre wear and pit stops
- A track editor that lets you drag the spline points
- Rain with lower grip, spray particles and a wet sky
- Spectating: watch friends' onboard cameras after you finish
- Touch controls for mobile
- Post-processing with `EffectComposer`: bloom and motion blur

## Performance tips

All the graphics settings are in `src/settings.js`. If the frame rate is low, lower `pixelRatio`
(biggest win on Retina/4K screens), then `shadowMapSize`, `trees` and `buildings`. Press V in a race
to turn the mirror off. Per circuit, `scenery.trees` / `scenery.buildings` in its file still set the numbers.

## A note on naming

All teams, liveries and branding here are made up. "Formula 1", "F1", and real team names, logos and drivers
are trademarks, so keep the game generic if you publish it.