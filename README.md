# Apex Circuit

An open-wheel racing game that runs in the browser, built with **Three.js** and **Vite**.
24 real Grand Prix layouts built from GPS data, with real elevation from the official F1 timing data (Eau Rouge, Turn 1 at COTA),
banked corners (Zandvoort, Jeddah), grandstands, pit buildings and gravel traps. Street circuits
(Monaco, Singapore, Baku, Las Vegas…) have concrete walls close to the track and a city around them.
Night races (Bahrain, Jeddah, Singapore, Las Vegas, Qatar) run under floodlights, and Abu Dhabi starts at sunset.
Le Mans and Daytona race through the night, and the Nürburgring 24h runs the Grand Prix circuit plus the whole
Nordschleife: 25 km through the Eifel woods on the real ground, only trees behind a steel guardrail.
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
| C                    | Cycle camera: chase, far chase, T-cam (a roof cam on the Hypercar and GT3), cockpit |
| Q (hold)             | Look behind                    |
| V                    | Rear-view mirror on / off      |
| H                    | Headlights on / off (Hypercar and GT3; on by themselves at night) |
| R                    | Reset onto the track           |
| M                    | Mute                           |
| Esc / P              | Pause                          |
| Menu: ↑ ↓ / ← → / N  | Car / circuit / day or night (where the car can race both) |
| Controller           | Left stick steer · RT throttle · LT brake · Y camera · B (hold) look back · LB mirror · RB tower gaps · D-pad ← headlights · View reset · Menu pause. In menus: D-pad ↑ ↓ car, D-pad ← → / LB / RB circuit, B day or night, A start, Y multiplayer; in the lobby the host's Menu button starts the race. Mapping and rumble settings in `src/input.js` |

## Multiplayer

Menu → **Multiplayer**. One person creates a room and gets a 4-letter code (or an invite link);
everyone else types the code. The host picks the circuit, laps, how many AI cars (none by default),
AI skill and whether cars collide, then starts. Up to 10 people; everyone drives the car the host picks (in
its own livery) and gets their own colour for the tower, the map and the name tag over their car. People start at the back
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
`SMOOTH` in `src/net/remote.js`; when friends' cars switch to the light model is `LOD` in `src/carLod.js` (within what distance; how many at once is
`detailedCars` in the graphics presets, `src/settings.js`);
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
  cars/             One file per car (physics, gearbox, hybrid boost, 3D model, cameras)
    index.js        The list of cars — add or remove cars here
    f1.js           The F1 car (RB19); every setting is explained in it
  track.js          Circuit file → samples, walls, surfaces, racing line; CIRCUIT_DEFAULTS
  elevation.js      Hills and crests from a circuit's elevation list
  banking.js        Banked corners
  terrain.js        Ground that follows the track's height (or a circuit's real ground)
  forest.js         Woods right behind the guardrail along forest stretches (the Nordschleife)
  rearview.js       Mirror and look-behind camera
  headlights.js     Your car's headlights (Hypercar, GT3)
  lighting.js       Day / dusk / night: sky, floodlights, fog, lit windows
  settings.js       Graphics settings (resolution, shadows, how many trees and buildings)
  physics.js        Arcade car physics (grip, downforce, slip, walls), gearbox; each car's numbers are in cars/
  ai.js             Speed profile + pure-pursuit AI drivers
  race.js           Grid, start lights, laps, timing, positions, collisions
  carModel.js       The car models (rigged .glb: spinning wheels, steering, live screen) and the built-in cars
  carBodies.js      The built-in Hypercar and GT3 (the AI cars in those classes), made in code
  scenery.js        Sky, sun and shadows, road, kerbs, run-off, barriers, stands, trees, city buildings
  hud.js            Speedo, timing, standings, minimap
  input.js          Keyboard and gamepad
  audio.js          Web Audio engine, tyre and wind sound
  lobby.js          Multiplayer lobby screen: create / join a room, drivers, race settings
  nametags.js       Names over friends' cars
  carLod.js         Friends' cars swap to the light built-in car further away
  net/
    peer.js         Browser-to-browser connections (WebRTC) and the room server calls
    session.js      Online room: lobby, start, keeping everyone's race in step
    remote.js       Drawing other people's cars smoothly between updates
    protocol.js     The binary car-position packets
    background.js   Keeps an online race running in a background tab
  style.css
tools/simulate.mjs  Runs a whole race headless
tools/prepare-car.mjs  Turns a downloaded car .glb into a game model (see Using your own car model)
```

`physics.js`, `track.js`, `ai.js` and `race.js` don't import any rendering code,
which is why the whole race can run in Node.

## Ways to customise it

- **Circuits:** see *Adding or changing a circuit* below.
- **Car handling:** change the numbers in `physics` in the car's file (`src/cars/f1.js` for the F1 car): `mu` (grip),
  `downforce`, `accel`, `brake`, `maxSteer`. The AI plans its corner speeds from the same numbers. See *Cars* below.
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

## Cars

Each car is one file in `src/cars/`, listed in `src/cars/index.js`, the same way circuits work. A car's file
has everything about it: `physics` (how it drives; the AI uses the same numbers), `gearbox` (gears and revs
for the HUD and engine sound), `sound` (which engine it sounds like), `ers` (the hybrid boost, or `null` for none), `model` (its `.glb` and how it's
rigged), `cameras` (where the chase cameras sit) and `times` (when it races: see below). One kind of car races
at a time: you pick it in the menu (the host picks it online). To add a car, copy `f1.js`, change what's
different, and add it to the list. `npm run sim -- 3 hard monza <car id>` races it headless.

The cars are the F1 car (Red Bull RB19), the Hypercar (Ferrari 499P) and the GT3 (Mercedes-AMG GT3 in Red Bull
colours). Each drives like itself, tuned with the sim against real lap times: the Hypercar does a flying lap of
Le Mans in about 3:26 (the 499P qualified in 3:25.1 in 2026), the GT3 about 3:55 there (LMGT3 pole: 3:52.4) and
8:12 round the Nürburgring 24h lap (pole: 8:11.0). The Hypercar has less power and downforce than the F1 car,
traction control, no ABS, and a hybrid front axle that deploys by itself above 190 km/h (the HUD says HYBRID).
The GT3 is heavier, has far less downforce, and has ABS and traction control (the ABS and TC lights show when
they're working) but no hybrid. Each has its own engine sound (`sound` in its file; the engines are `ENGINES` in
`src/audio.js`): the Hypercar a twin-turbo V6 that revs to 8,800, deeper than the F1 car's, with a louder turbo and
the front motor's whine when it deploys; the GT3 a 6.2 V8 with the burble of its cross-plane crank.

Your car is the real model in its own livery (the 499P in Ferrari red, the AMG in Max Verstappen's Red Bull
colours), with a live screen on the 499P's steering wheel and on the AMG's dash. The T-cam is a roof camera on
these two, and the cockpit camera sits at the driver's eyes in the left-hand seat. The AI cars never drive your
car: they're a generic Le Mans Hypercar and a generic GT3 made in code (`src/carBodies.js`), in their team's
colours, with spoked rims, brake calipers and their own lights. (AI F1 cars are the built-in F1 car.)

**When a car races** (`times` in its file): the F1 car races every circuit at that circuit's own time of day
(the `time` in the circuit file, so Bahrain or Singapore are night races under floodlights). The Hypercar and
GT3 race every circuit by day, and Le Mans and the Nürburgring by day or by night (the Day / Night buttons under
the circuit, or N). Their night is a real endurance night (`night: 'pits'`): floodlights only along the pit
straight and paddock, the rest of the lap lit by the moon (`TIMES.dark` in `src/lighting.js`) and your headlights.
They come on by themselves at night (H switches them; the green LIGHTS light under the speed shows they're on):
two real spotlights shaped like a race car's main beams, plus a pool of light on the road ahead
(`HEADLIGHTS` in `src/headlights.js`; each car's lamp positions and colour are `headlights` in its file).

Your stats keep separate records for each car: a lap in one car never competes with a lap in another.

The original model files are in `assets-src/cars/` (not served to the browser: they're too big; the game uses
the rigged, compressed copies in `public/models/` that `tools/prepare-car.mjs` made from them).

## Using your own car model (.glb)

Each car's model is set in `model` in its file: the RB19 is `public/models/rb19.glb` (`src/cars/f1.js`), the
499P `ferrari_499p.glb` (`hypercar.js`) and the AMG `amg_gt3.glb` (`gt3.js`).
The wheels spin (with a motion-blur disc at speed), the front wheels steer and the steering wheel turns
with your input. That works because the model file has the wheels and steering wheel as separate parts
named `wheel_FL`, `wheel_FR`, `wheel_RL`, `wheel_RR` and `steering_wheel`, each with its pivot point
stored in the node's `extras` (`pivot`; `pivotPoint` on a node with children, since three.js's loader reads
`pivot` there as something else). The 499P and AMG also have `hub_FL` / `hub_FR`, the brake calipers that steer
but don't spin, and `display_anchor`, where the live screen goes. Set `forAI: true` to give every car on the
grid the full model in its own livery, or `url: null` to go back to the built-in car.

To turn a downloaded model (Sketchfab and the like) into one: `tools/prepare-car.mjs` (instructions at its top)
puts it to scale in the game's frame (wheelbase = the physics wheelbase), sorts its parts into those groups by
their names (a few lines per car in the script), fixes see-through materials, simplifies it to about 40% of
its triangles and compresses it (meshopt, WebP textures: ~430k triangles and 35–40 MB → 170k and 5 MB). It prints
where the driver's eyes and the roof are, for the onboard cameras in the car's file.

## Credits

- Car model: "Oracle Red Bull F1 Car RB19 2023" by Redgrund on Sketchfab
  (https://sketchfab.com/3d-models/oracle-red-bull-f1-car-rb19-2023-e4afe46f3aab4b23a418da06fc163821),
  licensed CC-BY-4.0. If you share the game, keep this credit visible.
- Car model: "Ferrari 499p | www.vecarz.com" by vecarz on Sketchfab
  (https://sketchfab.com/3d-models/ferrari-499p-wwwvecarzcom-f87c672819f34a759ee171733284c53c), licensed CC-BY-4.0.
- Car model: "Mercedes Benz AMG GT3 Red Bull" by toddeppe on Sketchfab
  (https://sketchfab.com/3d-models/mercedes-benz-amg-gt3-red-bull-83c34fe5c0d64d838bc3c5e0f2d7f56a), licensed CC-BY-4.0.
- Circuit layouts: bacinger/f1-circuits (MIT). Elevation: F1 timing data via TracingInsights.
- Le Mans and Daytona: centrelines from tobi/track-atlas (https://github.com/tobi/track-atlas, MIT), built from
  OpenStreetMap data (© OpenStreetMap contributors, ODbL) and, for Daytona, 2021 aerial survey data (Florida DEP).
  Le Mans elevation: Mapzen Terrain Tiles (USGS, NOAA, Copernicus EU-DEM) via markthebault/open-racetrack-db.
- Nürburgring 24h: centreline, start/finish, pit lane and section names from OpenStreetMap (© OpenStreetMap
  contributors, ODbL) via markthebault/open-racetrack-db (https://github.com/markthebault/open-racetrack-db);
  road heights and the ground around the circuit from Mapzen Terrain Tiles (Copernicus EU-DEM, SRTM) via the same.

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