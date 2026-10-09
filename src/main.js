import * as THREE from 'three';
import './style.css';
import { getTrackDef, TRACKS } from './track.js';
import { buildWorld, buildCircuit, circuitSteps, swapBrakeBoards, disposeCircuit } from './scenery.js';
import { CircuitBuilder } from './circuitBuilder.js';
import { loadCarModel, carCams } from './carModel.js';
import { GRAPHICS, PRESET_ORDER, PRESET_NAMES, setGraphicsPreset } from './settings.js';
import { Showcase } from './showcase.js';
import { Headlights, autoOn } from './headlights.js';
import { setupMenu, savedTime } from './menu.js';
import { Race, formatTime } from './race.js';
import { gearbox } from './physics.js';
import { readInput, wasPressed, clearPressed, pollPad, padFeedback } from './input.js';
import { EngineAudio } from './audio.js';
import { HUD } from './hud.js';
import { RearView } from './rearview.js';
import { applyTimeOfDay, TIMES, timeOf } from './lighting.js';
import { Lobby } from './lobby.js';
import { NameTags } from './nametags.js';
import { createRaceModel, syncModels } from './carLod.js';
import { keepTicking, stopTicking } from './net/background.js';
import { StatsRun } from './stats.js';
import { StatsScreen } from './statsScreen.js';
import { CARS, getCar, selectedCar, setSelectedCar, timesFor, raceSetup } from './cars/index.js';
import { OPTIONS, setOption, onOption } from './options.js';
import { buildRacingLine, disposeRacingLine } from './racingLine.js';
import { pitRoute } from './pitlane.js';
import { PitCrews } from './pitcrew.js';
import { TYRES, fitTyres } from './tyres.js';
import { DAMAGE } from './damage.js';
import { installShadowLayer, addShadowChunks } from './shadowChunks.js';
import { Career, CAREER } from './career.js';
import { ReplayRecorder, saveReplay, loadReplay } from './replay.js';
import { GhostRecorder, GhostCar, loadGhost, saveGhost, ghostTrace } from './ghost.js';
import { setupSupport, raceFinished, askOnResults } from './support.js';
import { Cinema } from './cinema.js';

// ---------- renderer / scene / camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: GRAPHICS.antialias, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, GRAPHICS.pixelRatio)); // lower in settings.js if it lags
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = GRAPHICS.shadows;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.info.autoReset = false; // reset once a frame (tick), so F shows the whole frame's draws
renderer.toneMappingExposure = 0.9;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
installShadowLayer(scene); // shadow-only copies of long scenery, drawn only near you (shadowChunks.js)
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.25, GRAPHICS.viewDistance);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const world = buildWorld(scene, renderer);
const audio = new EngineAudio();
const rearView = new RearView(renderer); // mirror (V) and look back (Q)
// What you've picked in the menu (menu.js): the car you race (one of src/cars/; one kind of car per race) and
// the time of day, where the car can race a circuit by day or by night. Your car's 3D model loads in the
// background (carModel.js); until then, or if it can't be loaded, you get the built-in car.
let myCar = getCar(selectedCar());
let myTime = savedTime();
let carModelReady = loadCarModel(myCar.model);
const showcase = new Showcase(scene, camera); // live AI race behind the menu
// Your car's headlights (Hypercar, GT3): on by themselves at night, H switches them (headlights.js).
// Behind the menu they're on your car in the live race too.
const headlights = new Headlights();
showcase.onStart = (sc) => headlights.attach(sc.models[sc.race.cars.indexOf(sc.race.player)], sc.car, autoOn(timeOf(sc.track)));
let menuUI = null;
let track = null, circuit = null, hud = null;
let trackKey = '';      // the circuit as built: its id, time of day and night lighting
let sceneCar = myCar;   // the car the scenery was built for (its braking boards)
// The circuits' data and ground are worked out in a worker and the last few are kept (circuitBuilder.js)
const builder = new CircuitBuilder();
let previewJob = 0;     // the latest circuit asked for behind the menu (an older one still being built gives up)

// Build (or switch to) a circuit for a car and time of day: physics data, scenery and minimap, all at once (a race
// is starting, or the page has just loaded; the menu uses previewTrack below, which doesn't freeze it).
// The circuit is only built again when it or its time of day changes; another car only needs new braking boards.
// preview: restart the live race behind the menu with that car.
function loadTrack(id, car = myCar, time = myTime, preview = true) {
  previewJob++; // (anything being built behind the menu is no longer wanted)
  const def = getTrackDef(id), setup = raceSetup(car, def, time), key = builder.key(def, setup);
  if (!track || key !== trackKey) {
    const { track: t, ground } = builder.now(def, setup); // (kept from the menu, usually: then it's instant)
    showTrack(t, key, car, buildCircuit(t, { car, ground }));
  } else if (car !== sceneCar) newBoards(car);
  if (preview && !race && showcase.car !== car) showcase.start(track, car); // the live race, on this circuit with this car
}

// The circuit behind the menu: the number crunching in the worker, then the scenery a piece a frame, while the menu
// and the live race carry on; then it swaps in. Picking another one meanwhile drops this one.
async function previewTrack(id, car = myCar, time = myTime) {
  const job = ++previewJob, stale = () => job !== previewJob || !!race;
  const def = getTrackDef(id), setup = raceSetup(car, def, time), key = builder.key(def, setup);
  if (track && key === trackKey) { // the same circuit: just the car (its braking boards and the live race)
    if (car !== sceneCar) newBoards(car);
    if (!race && showcase.car !== car) showcase.start(track, car);
    return;
  }
  const data = await builder.get(def, setup);
  if (!data || stale()) return;
  menuUI?.setTrackInfo(data.track); // (its exact length and climb, while the scenery is being built)
  const steps = circuitSteps(data.track, { car, ground: data.ground });
  let r;
  while (!(r = steps.next()).done) {
    await afterFrame();
    if (stale()) { steps.return(); return; } // (frees what it had built)
  }
  const next = r.value;
  try { await renderer.compileAsync(next.group, camera, scene); } catch { /* compiled when it's first drawn instead */ }
  if (stale()) { disposeCircuit(next); return; }
  next.show();
  showTrack(data.track, key, car, next);
  showcase.start(track, car);
}
const afterFrame = () => new Promise((go) => requestAnimationFrame(() => setTimeout(go, 0))); // once the next frame is drawn

// Make a circuit the one on screen: its scenery (built), minimap and menu details
function showTrack(t, key, car, built) {
  if (circuit) disposeCircuit(circuit);
  track = t; trackKey = key; sceneCar = car;
  showCircuit(built);
  if (hud) hud.setupMinimap(track); else { hud = new HUD(track); hud.setMapMode(OPTIONS.mapZoom); }
  menuUI?.setTrackInfo(track);
}
// Another car on the same circuit: new braking boards (where a car brakes depends on the car), nothing else
function newBoards(car) {
  sceneCar = car;
  swapBrakeBoards(circuit, track, car);
  circuitBuiltWith = sceneryKey();
}

// The scenery for the current circuit (built again when a graphics preset changes how many trees
// or buildings there are). built: already built (and shown) by the caller
function showCircuit(built = null) {
  circuit = built ?? buildCircuit(track, { car: sceneCar, ground: builder.kept.get(trackKey)?.ground }); // (the braking boards depend on the car)
  scene.add(circuit.group);
  applyTimeOfDay(world, track); // day, dusk or night (the circuit file's, or the one picked for the car)
  circuitBuiltWith = sceneryKey();
  applyViewDistance();
  applyShadowCasters();
}

// ---------- graphics presets: Low / Medium / High (settings.js) ----------
const startedWithAA = GRAPHICS.antialias; // edge smoothing is fixed when the page loads
let circuitBuiltWith = null;              // the tree / building counts the current circuit was built with
const sceneryKey = () => [GRAPHICS.trees, GRAPHICS.forest, GRAPHICS.buildings, GRAPHICS.floodlightSpacing, GRAPHICS.towerModel, sceneCar.id].join('|');

// How far the camera sees. The haze is pulled in to end before that, so nothing pops in or out.
function applyViewDistance() {
  camera.far = GRAPHICS.viewDistance; camera.updateProjectionMatrix();
  const T = TIMES[timeOf(track)];
  scene.fog.far = Math.min(T.fogFar, GRAPHICS.viewDistance * 0.9);
  scene.fog.near = Math.min(T.fogNear, scene.fog.far * 0.5);
}

// Which scenery casts shadows (the cars always do): 'all', 'noTrees' or 'cars'. Shadows are drawn
// every frame, and trees and buildings are instanced over the whole circuit, so they cost a lot.
// tick() runs this again every second, because city buildings are swapped in once their models load.
function applyShadowCasters() {
  if (!circuit) return;
  if (GRAPHICS.shadowCasters !== 'cars') addShadowChunks(circuit.group); // long scenery casts through square-by-square copies: only those near you are drawn (Low: scenery casts none)
  const mode = GRAPHICS.shadowCasters;
  circuit.group.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.castShadow0 ??= o.castShadow; // as the circuit built it
    const tree = !!o.parent?.userData.trees;  // the trees group (scenery.js)
    o.castShadow = o.userData.castShadow0 && (mode === 'all' || (mode === 'noTrees' && !tree));
  });
}
// Low ('cars'): your car's wheels (the detailed models' wheels are tens of thousands of triangles each) cast no
// shadow of their own; the body's shadow covers them. (tick() runs this every second, with applyShadowCasters)
function applyCarShadows() {
  const mode = GRAPHICS.shadowCasters, mine = race ? models[race.cars.indexOf(race.player)] : null;
  mine?.traverse((o) => {
    if (!o.isMesh || !/^(wheel|tyre|tire|rim)/i.test(o.name)) return;
    o.userData.castShadow0 ??= o.castShadow;
    o.castShadow = o.userData.castShadow0 && mode !== 'cars';
  });
}

// Everything the race will draw, made ready while the start lights run: three.js otherwise builds a shader the first
// time a material is drawn and uploads a texture the first time it's used, which is a hitch when it happens mid-lap
// (a new building, a board, a car's far model). compileAsync builds them in the background where the browser can.
function prewarm() {
  const seen = new Set();
  scene.traverse((o) => {
    for (const m of [o.material].flat()) {
      if (!m || seen.has(m)) continue; seen.add(m);
      for (const v of Object.values(m)) if (v?.isTexture && !v.isRenderTargetTexture && !seen.has(v)) { seen.add(v); try { renderer.initTexture(v); } catch { /* not ready yet */ } }
    }
  });
  renderer.compileAsync(scene, camera).catch(() => {});
}

// Apply GRAPHICS to everything that's already built.
function applyGraphics() {
  const G = GRAPHICS, sun = world.sun;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, G.pixelRatio));
  if (renderer.shadowMap.enabled !== G.shadows) { // shaders have to be rebuilt for this one
    renderer.shadowMap.enabled = G.shadows;
    scene.traverse((o) => { for (const m of [].concat(o.material ?? [])) m.needsUpdate = true; });
  }
  sun.castShadow = G.shadows;
  if (sun.shadow.mapSize.x !== G.shadowMapSize) {
    sun.shadow.mapSize.set(G.shadowMapSize, G.shadowMapSize);
    sun.shadow.map?.dispose(); sun.shadow.map = null; // made again at the new size
  }
  applyViewDistance();
  applyShadowCasters();
  rearView.applyGraphics();
  document.body.classList.toggle('gfx-noblur', !G.blur);
  if (circuit && circuitBuiltWith !== sceneryKey()) { disposeCircuit(circuit); showCircuit(); } // trees, buildings
  drawGraphicsButtons();
}

// Switch preset. Returns true if part of it (edge smoothing) only changes once the page reloads.
function choosePreset(name) {
  if (name === GRAPHICS.preset || !setGraphicsPreset(name)) return false;
  applyGraphics();
  const needsReload = GRAPHICS.antialias !== startedWithAA;
  if (needsReload && !race && !menu.classList.contains('hidden')) { // on the main menu: reload now
    setGraphicsNote('Reloading to change edge smoothing…');
    setTimeout(() => location.reload(), 250);
    return false;
  }
  setGraphicsNote(needsReload ? 'Edge smoothing changes the next time the page loads.' : '');
  return needsReload;
}

// The Low / Medium / High buttons (main menu and pause menu, see index.html)
function drawGraphicsButtons() {
  for (const box of document.querySelectorAll('[data-gfx]')) {
    box.innerHTML = PRESET_ORDER.map((k) =>
      `<button type="button" class="${k === GRAPHICS.preset ? 'on' : ''}" data-v="${k}">${PRESET_NAMES[k]}</button>`).join('');
  }
}
function setGraphicsNote(text) { for (const el of document.querySelectorAll('[data-gfx-note]')) el.textContent = text; }
document.querySelectorAll('[data-gfx]').forEach((box) => box.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur(); // so Enter / Space don't press it again
  choosePreset(b.dataset.v);
}));
function cyclePreset() { // G during a race
  const next = PRESET_ORDER[(PRESET_ORDER.indexOf(GRAPHICS.preset) + 1) % PRESET_ORDER.length];
  const later = choosePreset(next);
  hud.toast(`Graphics: ${PRESET_NAMES[next]}${later ? ' · edge smoothing after a reload' : ''}`, 2);
}

// Frame rate counter (F): frames per second, milliseconds per frame and the preset. Remembered.
const fpsEl = document.createElement('div');
fpsEl.id = 'fps';
document.body.appendChild(fpsEl);
let fpsOn = false, fpsFrames = 0, fpsFrom = null;
try { fpsOn = localStorage.getItem('apex-circuit:fps') === '1'; } catch { /* private mode */ }
fpsEl.classList.toggle('hidden', !fpsOn);
function toggleFps() {
  fpsOn = !fpsOn; fpsFrames = 0; fpsFrom = null;
  fpsEl.textContent = '… fps';
  fpsEl.classList.toggle('hidden', !fpsOn);
  try { localStorage.setItem('apex-circuit:fps', fpsOn ? '1' : '0'); } catch { /* private mode */ }
}
// F: the frame rate, the slowest frame (a spike) and where the time went on the processor: sim (physics, AI, pit stops),
// hud, draw (handing the frame to the graphics card), every half second. PERF also keeps the last 600 frames
// (window.game.perf) for measuring.
const PERF = { last: null, worst: 0, sim: 0, hud: 0, draw: 0, n: 0, spikes: 0, log: [], t0: 0 };
function countFrame(now) { // once per frame actually drawn
  const P = PERF, gap = P.last == null ? 0 : now - P.last; P.last = now;
  if (gap > 0 && gap < 1000) {
    P.log.push([gap, P.cur.sim, P.cur.hud, P.cur.draw]); if (P.log.length > 600) P.log.shift();
    P.worst = Math.max(P.worst, gap); if (gap > 25) P.spikes++;
  }
  P.sim += P.cur.sim; P.hud += P.cur.hud; P.draw += P.cur.draw; P.n++;
  if (!fpsOn) return;
  fpsFrom ??= now; fpsFrames++;
  const span = now - fpsFrom;
  if (span < 500) return;
  const ms = (v) => (v / P.n).toFixed(1), info = renderer.info.render;
  fpsEl.innerHTML = `${Math.round((fpsFrames * 1000) / span)} fps · ${(span / fpsFrames).toFixed(1)} ms · worst ${P.worst.toFixed(1)} ms · ${PRESET_NAMES[GRAPHICS.preset]}` +
    `<br>sim ${ms(P.sim)} · hud ${ms(P.hud)} · draw ${ms(P.draw)} ms · ${info.calls} draws · ${Math.round(info.triangles / 1000)}k tris${P.spikes ? ` · ${P.spikes} spikes` : ''}`;
  fpsFrames = 0; fpsFrom = now; P.worst = 0; P.sim = P.hud = P.draw = 0; P.n = 0; P.spikes = 0;
}
PERF.cur = { sim: 0, hud: 0, draw: 0 };
const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

applyGraphics(); // the saved preset (or the default) for this page

// ---------- menus ----------
const menu = document.getElementById('menu');
const results = document.getElementById('results');
const pauseEl = document.getElementById('pause');
const trackSelect = document.getElementById('opt-track');
const TIME_LABEL = { night: ' · Night', dusk: ' · Twilight' };
// The circuit list, labelled with when your car races there
function labelTracks() {
  const was = trackSelect.value;
  trackSelect.innerHTML = TRACKS.map((t) => {
    const times = timesFor(myCar, t), when = times.length > 1 ? ' · Day or night' : TIME_LABEL[times[0]] ?? '';
    return `<option value="${t.id}">${t.round ? `R${t.round} · ` : ''}${t.name} — ${t.country}${when}</option>`;
  }).join('');
  if (was) trackSelect.value = was;
}
labelTracks();
// The circuit, car or time of day changed in the menu: rebuild the live race behind it, once you've stopped
// clicking through them (building a circuit takes a moment)
let previewTimer = 0;
function previewSoon() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { if (!race) previewTrack(trackSelect.value); }, 220);
}
trackSelect.addEventListener('change', previewSoon);

// ---------- game state ----------
let race = null;
let replayRec = null, lastReplay = null; // career: the race replay being recorded, and the last one saved (replay.js)
let pitCrews = null; // the pit crews of the race you're in (pitcrew.js)
let statsRun = null; // records your stats for the race you're in (stats.js)
let models = [];
let paused = false;
let playerColor = 0xe10600;
const CAMERAS = ['Chase', 'Far chase', 'T-cam', 'Cockpit'];
let camMode = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let shake = 0;
let resultsTimer = 0;
let cams = null; // onboard camera positions for the player's car model (from carModel.js)
const camLabel = (i) => (i === 2 && cams?.tcam?.name) || CAMERAS[i]; // (the GT3 and Hypercar's T-cam is a roof camera)

// Race settings from the menu (online races get theirs from the host, see lobby.js)
function soloConfig() {
  const $ = (id) => document.getElementById(id);
  return {
    track: trackSelect.value, laps: Number($('opt-laps').value), difficulty: $('opt-diff').value,
    aiCount: Number($('opt-ai').value), playerName: $('opt-name').value.trim() || 'You', playerColor,
    car: myCar.id, time: myTime,
  };
}

// cfg.car / cfg.time: which car everyone races and when (online: the host's pick)
function newRace(cfg = soloConfig()) {
  statsRun?.end(); // restarting: what you drove in the last one still counts (stats.js)
  for (const m of models) scene.remove(m);
  if (trackSelect.value !== cfg.track) trackSelect.value = cfg.track;
  loadTrack(cfg.track, getCar(cfg.car), cfg.time, false);
  showcase.stop();
  race = new Race(track, cfg);
  // career: every car's position through the race, for the race replay (replay.js; the cinematic replay films it)
  replayRec = race.career ? new ReplayRecorder(race, { track: track.id, trackName: track.name, car: race.carDef.id, time: cfg.time ?? null,
    round: cfg.round ?? null, series: career.state ? CAREER.series[career.state.series]?.short ?? '' : '' }) : null;
  lobby.session?.attach(race, cfg); // online: other people's cars are driven from the network
  statsRun = new StatsRun(race, { online: !!lobby.session }); // your stats: time, laps, sectors, result
  models = race.cars.map((c) => { // yours, friends' and (Hypercar, GT3) AI cars: the full model close up (carLod.js)
    const m = createRaceModel(c, race.carDef);
    scene.add(m);
    return m;
  });
  syncModels(models, race.cars, camera);
  prewarm(); // shaders and textures ready before the lights go out (no hitch the first time something comes into view)
  pitCrews?.dispose(); pitCrews = race.pits ? new PitCrews(scene, race) : null; // career: the crews in front of the garages (pitcrew.js)
  hud.setMode(race.career); // career: the pit and tyre pages
  headlights.attach(models[race.cars.indexOf(race.player)], race.carDef, autoOn(timeOf(track))); // on at night
  cams = carCams(models[race.cars.indexOf(race.player)]);
  hud.setCamera(camLabel(camMode));
  nameTags.setup(race);
  boxCall = boxInLane = false; hud.setBox(false); hud.onBox = () => setBox(!boxCall); hud.onTyres = pickTyres;
  showRacingLine();
  startGhost();
  snapCamera();
  clearPressed();
}

// ---------- racing line and ghost (pause → Settings; options.js) ----------
// The racing line: green where you can be on the throttle, red where you brake, worked out for the car you drive
let racingLine = null;
function showRacingLine() {
  disposeRacingLine(racingLine); racingLine = null;
  const route = race && boxCall ? pitRoute(track) : null; // asked to box: the line goes into the pits (shown even with the line off)
  if (race && (OPTIONS.racingLine || route)) {
    racingLine = buildRacingLine(track, race.playerProfile, race.carDef.physics, route && { ...route, only: !OPTIONS.racingLine });
    scene.add(racingLine);
  }
  hud.setRacingLine(OPTIONS.racingLine ? racingLine?.userData.zones ?? null : null); // (and on the minimap)
  hud.setPitRoute(route);
}

// ---------- tyres (tyres.js): 1 / 2 / 3, the pit page's buttons, or ← → while the team drives you down the pit lane ----------
// On the grid it changes the set you start on; racing, the set you'll get at your next stop.
let steerWas = 0;
function pickTyres(c) {
  const p = race?.player;
  if (!p || !TYRES.compounds[c] || p.finishTime != null) return;
  if (race.state === 'countdown') { fitTyres(p.state, c, race); hud.toast(`Starting on ${TYRES.compounds[c].name.toLowerCase()}s`, 1.4); return; }
  p.nextTyres = c; hud.toast(`Next tyres: ${TYRES.compounds[c].name}`, 1.4);
}
function tyreKeys(input) {
  ['Digit1', 'Digit2', 'Digit3'].forEach((k, n) => { if (wasPressed(k)) pickTyres(TYRES.order[n]); });
  const p = race.player, inLane = p.pitAI && p.pit?.state === 'in';
  const dir = (wasPressed('ArrowRight') || wasPressed('KeyD') ? 1 : 0) - (wasPressed('ArrowLeft') || wasPressed('KeyA') ? 1 : 0)
    || (Math.abs(input.steer) > 0.6 && Math.abs(steerWas) <= 0.6 ? -Math.sign(input.steer) : 0); // (the stick: left = softer)
  steerWas = input.steer;
  if (inLane && dir) {
    const cur = p.nextTyres ?? TYRES.order[1], k = Math.min(2, Math.max(0, TYRES.order.indexOf(cur) + dir));
    pickTyres(TYRES.order[k]);
  }
}

// ---------- box, box: asking to pit (B / D-pad right) ----------
// The line (on the track and the map) takes you into the pit lane, like a team calling you in. It stays until you've
// driven through the pits, or you call it off.
let boxCall = false, boxInLane = false;
function setBox(on, say = true) {
  if (on && (!race?.pits || !track.pitLane || !race || race.player.finishTime != null)) return;
  boxCall = on; boxInLane = false; hud.setBox(on); race.player.boxCall = on; // (the display's pit page, and a BOX tag on every page: hud.js)
  if (say) hud.toast(on ? 'Box, box: pit this lap' : 'Pit call cancelled', 1.6);
  if (race) showRacingLine();
}
function boxCheck(st) { // every frame: through the pits (out of the lane, past its middle) ends the call
  if (!boxCall) return;
  if (st.inPitLane) { boxInLane = true; return; }
  const p = track.pitLane, k = (st.trackIndex - p.i0 + track.n) % track.n;
  if (boxInLane && k > p.steps / 2) setBox(false, false);
}
// The ghost: your best lap ever at this circuit in this car (ghost.js), raced in practice. Laps are recorded in every
// race you drive offline; a faster clean flying lap becomes the new ghost.
const ghostCar = new GhostCar(scene);
let ghostRec = null, ghostLap = null, ghostAsk = 0;
const practice = () => !!race && race.cars.length === 1 && !lobby.session;
function startGhost() {
  ghostLap = null;
  ghostRec = lobby.session ? null : new GhostRecorder(race);
  showGhost();
  const ask = ++ghostAsk, r = race;
  loadGhost(race.carDef.id, track.id).then((g) => {
    if (ask !== ghostAsk || race !== r) return; // a newer race asked since
    ghostLap = g; if (ghostRec) ghostRec.best = g?.time ?? null;
    showGhost();
  });
}
function showGhost() {
  const on = practice() && OPTIONS.ghost;
  ghostCar.show(on ? ghostLap : null, race?.carDef);
  hud.setGhost(ghostLap ? { time: ghostLap.time, trace: ghostTrace(ghostLap) } : null, on);
  if (!on) hud.ghostAt = null;
  drawSettings();
}
// A lap just ended ('lap' event, race.js): the new ghost if it was your fastest clean flying lap
function ghostLapDone(e) {
  const g = ghostRec?.lapDone(e);
  if (!g) return;
  ghostLap = g; saveGhost(g);
  showGhost();
}

document.querySelectorAll('.swatch').forEach((el) => {
  el.style.background = el.dataset.color;
  el.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('sel'));
    el.classList.add('sel');
    playerColor = parseInt(el.dataset.color.slice(1), 16);
  });
});

menuUI = setupMenu({
  tracks: TRACKS, cars: CARS, carId: myCar.id, onStart: () => startGame(),
  onCar: (id) => { // another car: its model, the circuit list's times, and the circuit and live race for it
    myCar = getCar(id); setSelectedCar(id);
    carModelReady = loadCarModel(myCar.model);
    carModelReady.then((ok) => { if (ok && !race && showcase.car === myCar) showcase.refreshPlayer(); }); // its model is in
    labelTracks();
    previewSoon();
  },
  onTime: (time) => { myTime = time; previewSoon(); },
});
const nameTags = new NameTags(); // names over friends' cars online
setupSupport(); // "Support me" on every menu (support.js)

// Cinematic replay of your best lap (cinema.js): from the start screen, for the car and circuit picked in the menu
let cinemaModel = null;
const cinema = new Cinema({
  renderer, scene, camera,
  highGraphics: () => { // recording: the High preset, then back to yours
    const was = GRAPHICS.preset;
    if (setGraphicsPreset(PRESET_ORDER.at(-1))) applyGraphics();
    return () => { if (setGraphicsPreset(was)) applyGraphics(); };
  },
  onFrame: (dt, st, model) => {
    if (model !== cinemaModel) { cinemaModel = model; headlights.attach(model, cinema.car ?? myCar, autoOn(timeOf(track))); }
    headlights.update(dt);
    world.sun.position.set(st.x + world.sunDir.x * 150, st.y + world.sunDir.y * 150, st.z + world.sunDir.z * 150);
    world.sun.target.position.set(st.x, st.y, st.z);
  },
  live: { // Watch with sound: your car's engine, live (audio.js)
    start: (car) => { audio.start(); audio.setCar(car); audio.resume(); },
    update: (p) => audio.update(p),
    stop: () => audio.suspend(),
  },
  onExit: () => { cinemaModel = null; menu.classList.remove('hidden'); if (!race) showcase.start(track, myCar); },
});
document.getElementById('btn-cinema').addEventListener('click', () => {
  clearTimeout(previewTimer);
  loadTrack(trackSelect.value, myCar, myTime, false); // (the circuit picked in the menu, built now if it isn't on screen yet)
  showcase.stop(); menu.classList.add('hidden');
  cinema.open(myCar, track, { color: playerColor, accent: 0xffffff });
});

// Multiplayer lobby (lobby.js) and the online race (net/session.js)
const lobby = new Lobby({
  tracks: TRACKS,
  // the host's circuit, car and time of day, behind the lobby
  previewTrack: (st) => {
    if (trackSelect.value !== st.track) { trackSelect.value = st.track; menuUI.refresh(); }
    previewTrack(st.track, getCar(st.car), st.time);
  },
  menuChoice: () => ({ car: myCar.id, time: myTime }), // what a new room starts with
  onStart: (cfg) => startGame(cfg),
  onEnd: () => { if (race) { exitRace(); lobby.show(); } },  // the host ended the race
  onClosed: () => { exitRace(); menu.classList.add('hidden'); }, // the room is gone: the lobby says why
  onDnf: (car) => hud.toast(`${car.team.name} is out`, 2.5),
  onSession: (on) => { // keep racing in a background tab; out of the room, your own car and time again
    if (on) keepTicking(tick); else { stopTicking(); if (!race) previewTrack(trackSelect.value); }
  },
});
window.addEventListener('pagehide', () => lobby.session?.leave());
window.addEventListener('pagehide', () => statsRun?.end());                                 // closing the tab mid-race
document.addEventListener('visibilitychange', () => { if (document.hidden) statsRun?.flush(); }); // save what's driven so far

// Your stats (main menu → Your stats; statsScreen.js)
// Career (career.js): a championship, round by round; pit stops and tyres are only in career races
let lastCfg = null; // the race you're in, to restart it
const career = new Career({ tracks: TRACKS, onRace: (cfg) => startGame(cfg), onClose: () => menu.classList.remove('hidden') });
career.color = () => playerColor;
document.getElementById('btn-career').addEventListener('click', () => { menu.classList.add('hidden'); career.open(); });
// Race replays (replay.js) in the cinematic replay (cinema.js): back to the career screen afterwards
function watchReplay(replay) {
  if (!replay) return;
  const car = getCar(replay.meta.car);
  clearTimeout(previewTimer);
  loadTrack(replay.meta.track, car, replay.meta.time, false); // (the circuit it was raced on, built now if it isn't on screen)
  showcase.stop(); menu.classList.add('hidden'); career.el.classList.add('hidden');
  cinema.openRace(replay, car, track, () => { cinemaModel = null; showcase.start(track, myCar); career.open(); });
}
document.getElementById('btn-replay').addEventListener('click', () => { if (!race?.career) return; exitRace(); watchReplay(lastReplay); });
career.onReplay = async (id) => watchReplay(lastReplay?.id === id ? lastReplay : await loadReplay(id));
function toCareer() { exitRace(); career.open(); }
const statsScreen = new StatsScreen({ tracks: TRACKS, onClose: () => menu.classList.remove('hidden') });
document.getElementById('btn-stats').addEventListener('click', () => { menu.classList.add('hidden'); statsScreen.open(myCar.id); });

loadTrack(trackSelect.value);                               // first circuit + live race behind the menu
carModelReady.then((ok) => { if (ok && !race && showcase.car === myCar) showcase.refreshPlayer(); }); // swap in your car's model once it has loaded

// cfg: race settings (solo: from the menu; online: from the host)
async function startGame(cfg = soloConfig()) {
  lastCfg = cfg;
  clearTimeout(previewTimer); // (the race builds its circuit itself)
  audio.start();
  audio.setCar(getCar(cfg.car)); // its engine sound (audio.js)
  await loadCarModel(getCar(cfg.car).model); // the race car's model: usually loaded long before you press Start
  menu.classList.add('hidden'); lobby.hide(); results.classList.add('hidden'); pauseEl.classList.add('hidden');
  paused = false; document.activeElement?.blur();
  newRace(cfg);
  onlineLabels();
  hud.show(true);
}
const online = () => !!lobby.session;
document.getElementById('btn-start').addEventListener('click', () => startGame());
document.getElementById('btn-again').addEventListener('click', () => (online() ? toLobby() : race?.career ? toCareer() : startGame()));
document.getElementById('btn-menu').addEventListener('click', toMenu);
document.getElementById('btn-resume').addEventListener('click', () => setPaused(false));
document.getElementById('btn-quit').addEventListener('click', toMenu);
document.getElementById('btn-restart').addEventListener('click', () => { setPaused(false); online() ? toLobby() : startGame(race?.career ? lastCfg : undefined); });

// Clear the race away; the live race plays behind the menus again
function exitRace() {
  statsRun?.end(); statsRun = null;
  results.classList.add('hidden'); pauseEl.classList.add('hidden');
  hud.show(false); nameTags.clear();
  paused = false; audio.suspend(); rearView.hide();
  for (const m of models) scene.remove(m);
  models = [];
  pitCrews?.dispose(); pitCrews = null;
  disposeRacingLine(racingLine); racingLine = null; hud.setRacingLine(null); hud.setPitRoute(null);
  boxCall = boxInLane = false; hud.setBox(false);
  ghostRec = null; ghostLap = null; ghostAsk++; ghostCar.hide(true); hud.setGhost(null, false); hud.ghostAt = null;
  // career: the replay, saved once more with everything up to now (only for a race you finished or retired from)
  if (replayRec && race?.state === 'finished') { lastReplay = replayRec.snapshot(); saveReplay(lastReplay); }
  replayRec = null;
  if (race) { race = null; showcase.start(track, sceneCar); }
}
function toMenu() {
  lobby.leave(); lobby.hide(); // online: leaving the menu means leaving the room
  exitRace();
  statsScreen.refreshButton();
  menuUI.go('home', { focus: false }); // the start screen
  menu.classList.remove('hidden');
}
// Online: the host ends the race for everyone; anyone else just leaves it (and retires if still going)
function toLobby() {
  lobby.session?.endRace();
  exitRace();
  lobby.show();
}
// Buttons on the pause and results screens say what they do online
function onlineLabels() {
  const s = lobby.session, set = (sel, on, off) => { document.querySelector(sel).textContent = s ? on : off; };
  set('#btn-again', 'Back to lobby', race?.career ? 'Back to career' : 'Race again');
  set('#btn-menu', 'Leave room', 'Main menu');
  set('#btn-restart span', s?.isHost ? 'End race · back to lobby' : 'Retire · back to lobby', 'Restart race');
  set('#btn-quit span', 'Leave room', 'Quit to menu');
}
function setPaused(v) {
  paused = v; pauseEl.classList.toggle('hidden', !v);
  pauseEl.dataset.view = 'main'; drawSettings();
  if (!online()) v ? audio.suspend() : audio.resume(); // online the race carries on behind the menu
  if (!v) document.activeElement?.blur(); // so Space (brake) can't press a hidden button
  if (v && race) { // where you are, shown under PAUSED
    const p = race.player, lap = Math.min(Math.max(p.lapsDone + 1, 1), race.laps);
    const bits = [track.name, `Lap ${lap}/${race.laps}`];
    if (race.cars.length > 1) bits.push(`P${p.position} of ${race.cars.length}`);
    if (p.bestLap) bits.push(`Best ${formatTime(p.bestLap)}`);
    document.getElementById('pause-info').textContent = bits.join('  ·  ');
    document.getElementById('btn-resume').focus({ preventScroll: true });
  }
}

// ---------- pause → Settings (racing line, ghost, map, graphics) ----------
function pauseView(view) {
  pauseEl.dataset.view = view;
  drawSettings();
  document.getElementById(view === 'settings' ? 'set-line' : 'btn-settings').focus({ preventScroll: true });
}
function drawSettings() {
  const $ = (id) => document.getElementById(id);
  $('set-line').setAttribute('aria-checked', String(OPTIONS.racingLine));
  $('set-ghost').setAttribute('aria-checked', String(OPTIONS.ghost));
  for (const b of $('set-map').querySelectorAll('button')) b.classList.toggle('on', (b.dataset.v === 'zoom') === OPTIONS.mapZoom);
  const carName = race?.carDef.name ?? myCar.name;
  $('set-ghost-sub').textContent = !practice()
    ? 'In practice (no AI cars): race your best lap ever at this circuit'
    : ghostLap ? `Your best lap ever here in the ${carName}: ${formatTime(ghostLap.time)}`
      : `No ghost here in the ${carName} yet: drive a clean flying lap and it becomes one`;
}
document.getElementById('btn-settings').addEventListener('click', () => pauseView('settings'));
document.getElementById('set-back').addEventListener('click', () => pauseView('main'));
document.getElementById('set-line').addEventListener('click', () => setOption('racingLine', !OPTIONS.racingLine));
document.getElementById('set-ghost').addEventListener('click', () => setOption('ghost', !OPTIONS.ghost));
document.getElementById('set-map').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]'); if (b) setOption('mapZoom', b.dataset.v === 'zoom');
});
onOption((key, value) => {
  if (key === 'racingLine' && race) showRacingLine();
  if (key === 'ghost' && race) showGhost();
  if (key === 'mapZoom') hud.setMapMode(value);
  drawSettings();
});

// ---------- Controls (the start screen's Controls button and the pause menu's) ----------
const controlsEl = document.getElementById('controls');
let controlsFrom = null;
function openControls(from) {
  controlsFrom = from;
  if (from === 'menu') menu.classList.add('hidden');
  controlsEl.classList.remove('hidden'); controlsEl.scrollTop = 0;
  document.getElementById('ctl-back').focus({ preventScroll: true });
}
function closeControls() {
  if (controlsEl.classList.contains('hidden')) return;
  controlsEl.classList.add('hidden');
  if (controlsFrom === 'menu') { menu.classList.remove('hidden'); document.getElementById('btn-controls').focus({ preventScroll: true }); }
  else document.getElementById('btn-pause-controls').focus({ preventScroll: true });
}
document.getElementById('btn-controls').addEventListener('click', () => openControls('menu'));
document.getElementById('btn-pause-controls').addEventListener('click', () => openControls('pause'));
document.getElementById('ctl-back').addEventListener('click', closeControls);
// Esc on the Controls screen from the start screen (in a race the main loop does it, with the pause menu's Esc)
window.addEventListener('keydown', (e) => { if (!race && e.code === 'Escape' && !controlsEl.classList.contains('hidden')) closeControls(); });

// Results: your result on the left, the full classification on the right (updates as cars finish).
function showResults() {
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`); // names typed by people
  const hex = (c) => '#' + c.toString(16).padStart(6, '0');
  const st = race.standings, leader = st[0], p = race.player, fl = race.bestLapOverall;
  const practice = race.cars.length === 1;
  $('results-body').innerHTML = st.map((c) => {
    const time = c.dnf ? '<td class="r running">DNF</td>'
      : c.finishTime == null ? '<td class="r running">Running</td>'
      : c === leader ? `<td class="r">${formatTime(c.finishTime)}</td>`
      : `<td class="r">+${(c.finishTime - leader.finishTime).toFixed(3)}</td>`;
    const moved = c.grid - c.position;
    const gain = moved > 0 ? `<span class="gain up">▲${moved}</span>` : moved < 0 ? `<span class="gain down">▼${-moved}</span>` : '';
    const fastest = fl && c.bestLap === fl.time;
    return `<tr class="${c.isPlayer ? 'me' : ''}"><td class="p">${c.position}</td>` +
      `<td><span class="sw" style="background:${hex(c.team.color)}"></span>${esc(c.team.name)}${c.isHuman ? '' : '<span class="ai">AI</span>'}</td>` +
      `<td class="c">${c.grid}${gain}</td><td class="r${fastest ? ' purple' : ''}">${formatTime(c.bestLap)}</td>${time}</tr>`;
  }).join('');
  const running = st.filter((c) => c.finishTime == null && !c.dnf).length;
  $('res-live').textContent = running ? `${running} still on track` : '';

  const diff = $('opt-diff'), diffKey = race.difficulty ?? diff.value;
  const diffName = [...diff.options].find((o) => o.value === diffKey)?.textContent ?? '';
  $('res-session').textContent = practice ? 'Practice' : online() ? 'Online race result' : 'Race result';
  if (online()) { // the host may still be waiting for friends out on track
    const out = st.filter((c) => c.isHuman && !c.isPlayer && c.finishTime == null && !c.dnf).length;
    $('btn-again').textContent = !lobby.session.isHost ? 'Back to lobby' : out ? `End race (${out} still racing)` : 'Back to lobby';
  }
  $('res-circuit').textContent = track.name;
  const people = st.filter((c) => c.isHuman).length, ai = st.length - people;
  $('res-sub').textContent = [getTrackDef(track.id).country, `${race.laps} lap${race.laps > 1 ? 's' : ''}`,
    people > 1 ? `${people} drivers online` : null, practice ? 'No AI' : ai ? `${ai} AI · ${diffName}` : null].filter(Boolean).join('  ·  ');
  $('res-pos').textContent = practice ? '★' : `P${p.position}`;
  $('results-title').textContent = practice ? 'Practice complete'
    : p.position === 1 ? 'Victory!' : p.position <= 3 ? 'Podium' : `Finished P${p.position}`;
  const moved = p.grid - p.position;
  $('res-gained').innerHTML = practice ? '' : moved > 0 ? `<span class="up">▲ ${moved} places</span> from P${p.grid}`
    : moved < 0 ? `<span class="down">▼ ${-moved} places</span> from P${p.grid}` : `Started P${p.grid}`;
  $('res-best').textContent = formatTime(p.bestLap);
  $('results-fl').textContent = fl ? `${fl.name} ${formatTime(fl.time)}` : '--';
  $('results-fl').classList.toggle('purple', !!fl);
  if (results.classList.contains('hidden')) { // just opened
    if (race.career && !race.recorded) { // career: points and the next round, and the replay so far (saved again when you leave)
      race.recorded = true; career.record(race);
      if (replayRec) saveReplay(replayRec.snapshot());
    }
    document.getElementById('btn-replay').classList.toggle('hidden', !(race.career && replayRec));
    askOnResults(); // now and then, a card asking for support (support.js)
    results.classList.remove('hidden'); $('btn-again').focus({ preventScroll: true });
  }
}

// ---------- camera ----------
// Every camera rides with your car: it turns, pitches over crests and leans on banking exactly as the car does,
// so your car stays put on screen and the world moves round it, like a real onboard camera.
//   pitch / roll: 1 = exactly with the car, 0 = stays level with the world (0.3 was the old horizon-steady chase cam)
//   lag: seconds the chase cameras take to swing round behind the car in a corner (0 = locked behind it; 0.2 = the old feel)
const CAMERA = {
  chase:   { lag: 0, pitch: 1, roll: 1 },   // Chase and Far chase
  onboard: { pitch: 1, roll: 1 },           // T-cam and Cockpit
  shake: { impacts: true, kerbs: false },   // shake when you hit something / over kerbs and grass
  speedFov: true,                           // the view widens a little with speed
};
// Where the chase cameras sit (Chase, Far chase, and Q held: looking back) comes from the car's file in src/cars/
// (`cameras`), the onboard cameras from its model (`model.cams`), since a bigger car needs them further out.
let camYaw = 0;
const camQ = new THREE.Quaternion(), camE = new THREE.Euler(0, 0, 0, 'YXZ'), camBase = new THREE.Vector3();
// Where the camera goes for this car state: camPos, camLook and camera.up
function cameraTarget(state) {
  const onboard = camMode >= 2 && !rearView.lookBack, C = onboard ? CAMERA.onboard : CAMERA.chase;
  const yaw = !onboard && C.lag > 0 ? camYaw : state.h;
  camE.set(-(state.pitch ?? 0) * C.pitch, yaw, (state.roll ?? 0) * C.roll); // the same rotation as the car model (carModel.js)
  camQ.setFromEuler(camE);
  let pos, look;
  const rig = (race?.carDef ?? myCar).cameras;
  if (rearView.lookBack) ({ pos, look } = rig.back);
  else if (onboard) { // T-cam on the airbox or roof / driver's eyes (x: the seat, if it isn't in the middle)
    const c = camMode === 2 ? cams.tcam : cams.cockpit, tilt = Math.tan(THREE.MathUtils.degToRad(c.tilt ?? 0)) * 20;
    pos = [c.x ?? 0, c.y, c.z]; look = [c.x ?? 0, c.y + tilt, 20];
  } else ({ pos, look } = camMode === 0 ? rig.chase : rig.far);
  camBase.set(state.x, state.y ?? 0, state.z);
  camPos.set(...pos).applyQuaternion(camQ).add(camBase);
  camLook.set(...look).applyQuaternion(camQ).add(camBase);
  camera.up.set(0, 1, 0).applyQuaternion(camQ); // leans with the car on banking
}
function snapCamera() {
  if (!race) return;
  camYaw = race.player.state.h;
  cameraTarget(race.player.state);
  camera.position.copy(camPos); camera.lookAt(camLook);
}

// ---------- main loop ----------
const IDLE = { throttle: 0, brake: 0, steer: 0 };
const SHAKE = new THREE.Vector3(), LIVE = []; // (reused every frame: no garbage)
let lastTime = null;
let shadowSweep = 0;
function frame(timestamp) {
  requestAnimationFrame(frame);
  tick(timestamp);
}
// One step of the game. Normally once per animation frame; online it also runs from a background
// timer while the tab is hidden (see net/background.js), just without drawing anything.
function tick(timestamp) {
  if (cinema.active) { lastTime = timestamp; return; } // (the cinematic replay draws itself: cinema.js)
  const dt = lastTime == null ? 0 : Math.min(Math.max((timestamp - lastTime) / 1000, 0), 0.1);
  lastTime = timestamp;
  const drawing = !document.hidden;
  pollPad(dt); // controller: in a race its buttons press the keyboard's shortcuts; in the menus it moves round the buttons
  world.sky.material.uniforms.time.value += dt;
  if (wasPressed('KeyF') && !typing()) toggleFps();
  shadowSweep += dt;
  if (shadowSweep > 1) { shadowSweep = 0; applyShadowCasters(); applyCarShadows(); } // scenery that loaded since (see applyShadowCasters)

  if (!race) { // menu: live AI race filmed like TV
    camera.up.set(0, 1, 0); // (the race camera leans with the car; the TV cameras don't)
    showcase.update(dt);
    headlights.update(dt);
    const t = showcase.target?.state;
    if (t) { // keep the sharp shadows around the car on screen
      world.sun.position.set(t.x + world.sunDir.x * 150, (t.y ?? 0) + world.sunDir.y * 150, t.z + world.sunDir.z * 150);
      world.sun.target.position.set(t.x, t.y ?? 0, t.z);
    }
    if (drawing) { renderer.info.reset(); renderer.render(scene, camera); countFrame(timestamp); }
    return;
  }

  if (wasPressed('Escape') || wasPressed('KeyP')) { // (Esc: back out of Controls and Settings first)
    if (!controlsEl.classList.contains('hidden')) closeControls();
    else if (paused && pauseEl.dataset.view === 'settings') pauseView('main');
    else setPaused(!paused);
  }
  if (wasPressed('KeyZ')) setOption('mapZoom', !OPTIONS.mapZoom); // the minimap: whole circuit / road ahead
  if (wasPressed('KeyG')) cyclePreset(); // graphics: Low → Medium → High
  if (wasPressed('KeyC')) { camMode = (camMode + 1) % CAMERAS.length; hud.setCamera(camLabel(camMode)); snapCamera(); }
  if (wasPressed('KeyM')) audio.setMuted(!audio.muted);
  if (wasPressed('KeyH') && headlights.has) hud.toast(headlights.toggle() ? 'Headlights on' : 'Headlights off', 1.2);
  if (wasPressed('KeyR') && race.state === 'racing' && race.player.finishTime == null) race.resetPlayer(); // (invalidates the lap: race.js)
  if (wasPressed('KeyB')) setBox(!boxCall); // box, box: the line into the pits

  const input = readInput(dt);
  if (race.career) tyreKeys(input); // career: your tyres: start set, next set, the choice in the pit lane
  const session = lobby.session;
  if (!paused || session) { // online the race doesn't stop for the pause menu: your car coasts
    // Variable number of fixed-ish substeps keeps physics stable at any FPS.
    // After a slow frame the physics catches up, but offline never more than 50 ms of it in one frame: making up a
    // long hitch all at once would make the next frame slow too (online the race has to keep real time)
    const simDt = session ? dt : Math.min(dt, 0.05);
    const steps = Math.ceil(simDt / (1 / 120)), t0 = performance.now();
    for (let i = 0; i < steps; i++) race.step(simDt / steps, paused ? IDLE : input);
    PERF.cur.sim = performance.now() - t0;
    ghostRec?.record(); // your lap, for the ghost (ghost.js)
    replayRec?.record(); // career: the race replay (replay.js)
    boxCheck(race.player.state); // asked to box: done once you're through the pits
    // Messages for this frame, put together so a circuit record isn't hidden by "Final lap" in the same moment
    let msg = null, secs = 2.2;
    for (const e of race.takeEvents()) {
      if (e.type === 'go') { msg = 'GO! GO! GO!'; secs = 1.2; }
      if (e.type === 'bestLap') msg = `Personal best  ${formatTime(e.time)}`;
      if (e.type === 'invalid') hud.invalidated(e); // track limits: "Lap invalidated" banner (race.js, hud.js)
      if (e.type === 'warning') hud.limitsWarning(e); // … or a warning, in the cars allowed a few
      if (e.type === 'lap') { // every lap you complete → your stats; beat your best ever here → say so
        ghostLapDone(e);
        const r = statsRun?.lap(e);
        if (r?.best && r.prevBest != null) { msg = `Circuit record  ${formatTime(r.lap.t)}  −${(r.prevBest - r.lap.t).toFixed(3)}`; secs = 3; }
        else if (e.valid === false) msg ??= `Lap deleted  ${formatTime(e.time)}`; // invalidated: doesn't count
      }
      if (e.type === 'pitIn') { msg = 'Pit lane: choose your tyres  ← →'; hud.mfdShow('pit'); }
      if (e.type === 'pitStop' && e.car.isPlayer) { msg = `Pit stop  ${e.time.toFixed(2)} s`; secs = 2.6; }
      // damage (career: damage.js): a part getting bad, someone out, or you
      if (e.type === 'damage') { msg = `${DAMAGE.names[e.part]} ${e.level > 1 ? 'badly damaged: box for repairs' : 'damage'}`; secs = 2.6; hud.mfdShow('damage'); }
      if (e.type === 'out') msg ??= `${e.car.team.name} retires: ${DAMAGE.names[e.part].toLowerCase()}`;
      if (e.type === 'retired') {
        msg = `Retired: ${DAMAGE.names[e.part].toLowerCase()} damage`; secs = 3; hud.mfdShow('damage');
        const out = race;
        setTimeout(() => { if (race === out) showResults(); }, 3000);
      }
      if (e.type === 'finalLap') msg = msg ? `${msg}  ·  Final lap` : 'Final lap';
      if (e.type === 'finish') {
        msg = msg ? `Chequered flag!  ·  ${msg}` : 'Chequered flag!'; secs = Math.max(secs, 2.5);
        statsRun?.finish();
        raceFinished(); // (support.js: after a few, the results screen asks for support now and then)
        const finished = race;
        setTimeout(() => { if (race === finished) showResults(); }, 2500);
      }
    }
    if (msg) hud.toast(msg, secs);
    statsRun?.update(dt, true); // time on track, distance, top speed, sectors, track limits
  }

  session?.tick(dt, timestamp); // online: swap car positions with the others
  syncModels(models, race.cars, camera); // other cars: the full model only for the nearest few (carLod.js)
  pitCrews?.update(paused && !session ? 0 : dt, models); // crews out to the cars that are stopping, wheels off and on
  headlights.update(dt, race.player.state); // (after your car has moved: the light on the road follows it)
  hud.ghostAt = ghostCar.update(race, paused && !session ? 0 : dt); // the ghost car, and where it is for the minimap

  // Start lights on the gantry
  for (const l of circuit.lights) l.mat.emissiveIntensity = race.state === 'countdown' && l.index < race.lightsOn ? 4 : 0;

  // Camera: rides with the car (CAMERA above), a little wider at speed, a shake when you hit something
  const ps = race.player.state, lag = CAMERA.chase.lag;
  if (lag > 0) { const dYaw = Math.atan2(Math.sin(ps.h - camYaw), Math.cos(ps.h - camYaw)); camYaw += dYaw * (1 - Math.exp(-dt / lag)); }
  else camYaw = ps.h;
  cameraTarget(ps);
  camera.position.copy(camPos);
  const SH = CAMERA.shake;
  shake = Math.max(SH.impacts ? ps.hitWall : 0, SH.kerbs && ps.surface !== 'road' && ps.speed > 5 ? 0.15 : 0, shake - dt * 3);
  if (shake > 0) camera.position.add(SHAKE.set((Math.random() - 0.5) * shake * 0.25, (Math.random() - 0.5) * shake * 0.25, 0));
  camera.lookAt(camLook);
  const fov = CAMERA.speedFov ? 62 + Math.min(ps.speed, 95) * 0.14 : 62;
  camera.fov += (fov - camera.fov) * Math.min(1, dt * 4); camera.updateProjectionMatrix();
  nameTags.update(camera);

  // Shadows follow the player so they stay sharp.
  world.sun.position.set(ps.x + world.sunDir.x * 150, ps.y + world.sunDir.y * 150, ps.z + world.sunDir.z * 150);
  world.sun.target.position.set(ps.x, ps.y, ps.z);

  const box = ps.spec.gearbox, gb = gearbox(Math.abs(ps.vf), box); // your car's gearbox (src/cars/)
  audio.update({
    rpm: race.state === 'countdown' ? box.rpm[0] + input.throttle * ((box.rpm[1] - box.rpm[0]) * 6 / 7) : gb.rpm,
    throttle: race.state === 'countdown' ? input.throttle : ps.throttle,
    slip: ps.slip, surface: ps.surface, speed: ps.speed, hit: ps.hitWall,
    gear: gb.gear, brake: ps.brake, ers: ps.ersMode,
  });
  LIVE.length = 0; for (const c of race.cars) if (!c.dnf) LIVE.push(c);
  audio.updateTraffic(LIVE, race.player, camera); // engines around you, with Doppler
  if (!paused) padFeedback({ hit: ps.hitWall, surface: ps.surface, speed: ps.speed, slip: ps.slip, // controller rumble
    throttle: ps.throttle, brake: ps.brake, lock: ps.lockF, rpm: gb.rpm, gear: gb.gear });
  if (!paused) circuit.marks?.update(ps); // your tyres leave rubber on the track (tyreMarks.js)

  const tH = performance.now();
  hud.update(race, dt);
  PERF.cur.hud = performance.now() - tH;
  // Keep the results table live while the rest of the field crosses the line.
  resultsTimer -= dt;
  if (!results.classList.contains('hidden') && resultsTimer <= 0) { showResults(); resultsTimer = 0.5; }
  if (!drawing) return;
  const tR = performance.now();
  renderer.info.reset(); // (counted over the whole frame: the view, its shadows and the mirror)
  renderer.render(scene, camera);
  rearView.render(scene, ps); // mirror strip at the top of the screen
  PERF.cur.draw = performance.now() - tR;
  countFrame(timestamp);
}
hud.show(false);
hud.setCamera(camLabel(camMode));
requestAnimationFrame(frame);

// Handy for debugging in the browser console: window.game.race
window.game = { get race() { return race; }, get track() { return track; }, scene, camera, loadTrack, renderer, perf: PERF };