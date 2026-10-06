import * as THREE from 'three';
import './style.css';
import { buildTrack, getTrackDef, TRACKS } from './track.js';
import { buildWorld, buildCircuit, disposeCircuit } from './scenery.js';
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

// ---------- renderer / scene / camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: GRAPHICS.antialias, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, GRAPHICS.pixelRatio)); // lower in settings.js if it lags
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = GRAPHICS.shadows;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
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

// Build (or switch to) a circuit for a car and time of day: physics data, scenery and minimap.
// The circuit is only built again when it or its time of day changes; another car only needs new
// scenery (the braking boards). preview: restart the live race behind the menu with that car.
function loadTrack(id, car = myCar, time = myTime, preview = true) {
  const def = getTrackDef(id), setup = raceSetup(car, def, time), key = `${def.id}|${setup.time}|${setup.lighting}`;
  const newTrack = !track || key !== trackKey, newCar = car !== sceneCar;
  sceneCar = car;
  if (newTrack) {
    if (circuit) disposeCircuit(circuit);
    track = buildTrack({ ...def, time: setup.time, lighting: setup.lighting }); trackKey = key;
    showCircuit();
    if (hud) hud.setupMinimap(track); else hud = new HUD(track);
    menuUI?.setTrackInfo(track);
  } else if (newCar) { disposeCircuit(circuit); showCircuit(); }
  if (preview && !race && (newTrack || showcase.car !== car)) showcase.start(track, car); // the live race, on this circuit with this car
}

// The scenery for the current circuit (built again when a graphics preset changes how many trees
// or buildings there are).
function showCircuit() {
  circuit = buildCircuit(track, { car: sceneCar }); // (the braking boards depend on the car)
  scene.add(circuit.group);
  applyTimeOfDay(world, track); // day, dusk or night (the circuit file's, or the one picked for the car)
  circuitBuiltWith = sceneryKey();
  applyViewDistance();
  applyShadowCasters();
}

// ---------- graphics presets: Low / Medium / High (settings.js) ----------
const startedWithAA = GRAPHICS.antialias; // edge smoothing is fixed when the page loads
let circuitBuiltWith = null;              // the tree / building counts the current circuit was built with
const sceneryKey = () => [GRAPHICS.trees, GRAPHICS.forest, GRAPHICS.buildings, GRAPHICS.floodlightSpacing, sceneCar.id].join('|');

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
  const mode = GRAPHICS.shadowCasters;
  circuit.group.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.castShadow0 ??= o.castShadow; // as the circuit built it
    const tree = !!o.parent?.userData.trees;  // the trees group (scenery.js)
    o.castShadow = o.userData.castShadow0 && (mode === 'all' || (mode === 'noTrees' && !tree));
  });
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
function countFrame(now) { // once per frame actually drawn
  if (!fpsOn) return;
  fpsFrom ??= now; fpsFrames++;
  const span = now - fpsFrom;
  if (span < 500) return;
  fpsEl.textContent = `${Math.round((fpsFrames * 1000) / span)} fps · ${(span / fpsFrames).toFixed(1)} ms · ${PRESET_NAMES[GRAPHICS.preset]}`;
  fpsFrames = 0; fpsFrom = now;
}
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
  previewTimer = setTimeout(() => { if (!race) loadTrack(trackSelect.value); }, 220);
}
trackSelect.addEventListener('change', previewSoon);

// ---------- game state ----------
let race = null;
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
  lobby.session?.attach(race, cfg); // online: other people's cars are driven from the network
  statsRun = new StatsRun(race, { online: !!lobby.session }); // your stats: time, laps, sectors, result
  models = race.cars.map((c) => { // yours, friends' and (Hypercar, GT3) AI cars: the full model close up (carLod.js)
    const m = createRaceModel(c, race.carDef);
    scene.add(m);
    return m;
  });
  syncModels(models, race.cars, camera);
  headlights.attach(models[race.cars.indexOf(race.player)], race.carDef, autoOn(timeOf(track))); // on at night
  cams = carCams(models[race.cars.indexOf(race.player)]);
  hud.setCamera(camLabel(camMode));
  nameTags.setup(race);
  snapCamera();
  clearPressed();
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
    carModelReady.then((ok) => { if (ok && !race && showcase.car === myCar) showcase.start(track, myCar); }); // its model is in
    labelTracks();
    previewSoon();
  },
  onTime: (time) => { myTime = time; previewSoon(); },
});
const nameTags = new NameTags(); // names over friends' cars online

// Multiplayer lobby (lobby.js) and the online race (net/session.js)
const lobby = new Lobby({
  tracks: TRACKS,
  // the host's circuit, car and time of day, behind the lobby
  previewTrack: (st) => {
    if (trackSelect.value !== st.track) { trackSelect.value = st.track; menuUI.refresh(); }
    loadTrack(st.track, getCar(st.car), st.time);
  },
  menuChoice: () => ({ car: myCar.id, time: myTime }), // what a new room starts with
  onStart: (cfg) => startGame(cfg),
  onEnd: () => { if (race) { exitRace(); lobby.show(); } },  // the host ended the race
  onClosed: () => { exitRace(); menu.classList.add('hidden'); }, // the room is gone: the lobby says why
  onDnf: (car) => hud.toast(`${car.team.name} is out`, 2.5),
  onSession: (on) => { // keep racing in a background tab; out of the room, your own car and time again
    if (on) keepTicking(tick); else { stopTicking(); if (!race) loadTrack(trackSelect.value); }
  },
});
window.addEventListener('pagehide', () => lobby.session?.leave());
window.addEventListener('pagehide', () => statsRun?.end());                                 // closing the tab mid-race
document.addEventListener('visibilitychange', () => { if (document.hidden) statsRun?.flush(); }); // save what's driven so far

// Your stats (main menu → Your stats; statsScreen.js)
const statsScreen = new StatsScreen({ tracks: TRACKS, onClose: () => menu.classList.remove('hidden') });
document.getElementById('btn-stats').addEventListener('click', () => { menu.classList.add('hidden'); statsScreen.open(myCar.id); });

loadTrack(trackSelect.value);                               // first circuit + live race behind the menu
carModelReady.then((ok) => { if (ok && !race && showcase.car === myCar) showcase.start(track, myCar); }); // swap in your car's model once it has loaded

// cfg: race settings (solo: from the menu; online: from the host)
async function startGame(cfg = soloConfig()) {
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
document.getElementById('btn-again').addEventListener('click', () => (online() ? toLobby() : startGame()));
document.getElementById('btn-menu').addEventListener('click', toMenu);
document.getElementById('btn-resume').addEventListener('click', () => setPaused(false));
document.getElementById('btn-quit').addEventListener('click', toMenu);
document.getElementById('btn-restart').addEventListener('click', () => { setPaused(false); online() ? toLobby() : startGame(); });

// Clear the race away; the live race plays behind the menus again
function exitRace() {
  statsRun?.end(); statsRun = null;
  results.classList.add('hidden'); pauseEl.classList.add('hidden');
  hud.show(false); nameTags.clear();
  paused = false; audio.suspend(); rearView.hide();
  for (const m of models) scene.remove(m);
  models = [];
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
  set('#btn-again', 'Back to lobby', 'Race again');
  set('#btn-menu', 'Leave room', 'Main menu');
  set('#btn-restart span', s?.isHost ? 'End race · back to lobby' : 'Retire · back to lobby', 'Restart race');
  set('#btn-quit span', 'Leave room', 'Quit to menu');
}
function setPaused(v) {
  paused = v; pauseEl.classList.toggle('hidden', !v);
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
  if (results.classList.contains('hidden')) { results.classList.remove('hidden'); $('btn-again').focus({ preventScroll: true }); }
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
let lastTime = null;
let shadowSweep = 0;
function frame(timestamp) {
  requestAnimationFrame(frame);
  tick(timestamp);
}
// One step of the game. Normally once per animation frame; online it also runs from a background
// timer while the tab is hidden (see net/background.js), just without drawing anything.
function tick(timestamp) {
  const dt = lastTime == null ? 0 : Math.min(Math.max((timestamp - lastTime) / 1000, 0), 0.1);
  lastTime = timestamp;
  const drawing = !document.hidden;
  pollPad(); // controller buttons → the same shortcuts as the keyboard
  world.sky.material.uniforms.time.value += dt;
  if (wasPressed('KeyF') && !typing()) toggleFps();
  shadowSweep += dt;
  if (shadowSweep > 1) { shadowSweep = 0; applyShadowCasters(); } // scenery that loaded since (see applyShadowCasters)

  if (!race) { // menu: live AI race filmed like TV
    camera.up.set(0, 1, 0); // (the race camera leans with the car; the TV cameras don't)
    showcase.update(dt);
    headlights.update(dt);
    const t = showcase.target?.state;
    if (t) { // keep the sharp shadows around the car on screen
      world.sun.position.set(t.x + world.sunDir.x * 150, (t.y ?? 0) + world.sunDir.y * 150, t.z + world.sunDir.z * 150);
      world.sun.target.position.set(t.x, t.y ?? 0, t.z);
    }
    if (drawing) { renderer.render(scene, camera); countFrame(timestamp); }
    return;
  }

  if (wasPressed('Escape') || wasPressed('KeyP')) setPaused(!paused);
  if (wasPressed('KeyG')) cyclePreset(); // graphics: Low → Medium → High
  if (wasPressed('KeyC')) { camMode = (camMode + 1) % CAMERAS.length; hud.setCamera(camLabel(camMode)); snapCamera(); }
  if (wasPressed('KeyM')) audio.setMuted(!audio.muted);
  if (wasPressed('KeyH') && headlights.has) hud.toast(headlights.toggle() ? 'Headlights on' : 'Headlights off', 1.2);
  if (wasPressed('KeyR') && race.state === 'racing' && race.player.finishTime == null) race.resetPlayer(); // (invalidates the lap: race.js)

  const input = readInput(dt);
  const session = lobby.session;
  if (!paused || session) { // online the race doesn't stop for the pause menu: your car coasts
    // Variable number of fixed-ish substeps keeps physics stable at any FPS.
    const steps = Math.ceil(dt / (1 / 120));
    for (let i = 0; i < steps; i++) race.step(dt / steps, paused ? IDLE : input);
    // Messages for this frame, put together so a circuit record isn't hidden by "Final lap" in the same moment
    let msg = null, secs = 2.2;
    for (const e of race.takeEvents()) {
      if (e.type === 'go') { msg = 'GO! GO! GO!'; secs = 1.2; }
      if (e.type === 'bestLap') msg = `Personal best  ${formatTime(e.time)}`;
      if (e.type === 'invalid') hud.invalidated(e); // track limits: "Lap invalidated" banner (race.js, hud.js)
      if (e.type === 'warning') hud.limitsWarning(e); // … or a warning, in the cars allowed a few
      if (e.type === 'lap') { // every lap you complete → your stats; beat your best ever here → say so
        const r = statsRun?.lap(e);
        if (r?.best && r.prevBest != null) { msg = `Circuit record  ${formatTime(r.lap.t)}  −${(r.prevBest - r.lap.t).toFixed(3)}`; secs = 3; }
        else if (e.valid === false) msg ??= `Lap deleted  ${formatTime(e.time)}`; // invalidated: doesn't count
      }
      if (e.type === 'finalLap') msg = msg ? `${msg}  ·  Final lap` : 'Final lap';
      if (e.type === 'finish') {
        msg = msg ? `Chequered flag!  ·  ${msg}` : 'Chequered flag!'; secs = Math.max(secs, 2.5);
        statsRun?.finish();
        const finished = race;
        setTimeout(() => { if (race === finished) showResults(); }, 2500);
      }
    }
    if (msg) hud.toast(msg, secs);
    statsRun?.update(dt, true); // time on track, distance, top speed, sectors, track limits
  }

  session?.tick(dt, timestamp); // online: swap car positions with the others
  syncModels(models, race.cars, camera); // other cars: the full model only for the nearest few (carLod.js)
  headlights.update(dt, race.player.state); // (after your car has moved: the light on the road follows it)

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
  if (shake > 0) camera.position.add(new THREE.Vector3((Math.random() - 0.5) * shake * 0.25, (Math.random() - 0.5) * shake * 0.25, 0));
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
  audio.updateTraffic(race.cars.filter((c) => !c.dnf), race.player, camera); // engines around you, with Doppler
  if (!paused) padFeedback({ hit: ps.hitWall, surface: ps.surface, speed: ps.speed, slip: ps.slip, // controller rumble
    throttle: ps.throttle, brake: ps.brake, lock: ps.lockF, rpm: gb.rpm, gear: gb.gear });
  if (!paused) circuit.marks?.update(ps); // your tyres leave rubber on the track (tyreMarks.js)

  hud.update(race, dt);
  // Keep the results table live while the rest of the field crosses the line.
  resultsTimer -= dt;
  if (!results.classList.contains('hidden') && resultsTimer <= 0) { showResults(); resultsTimer = 0.5; }
  if (!drawing) return;
  renderer.render(scene, camera);
  rearView.render(scene, ps); // mirror strip at the top of the screen
  countFrame(timestamp);
}
hud.show(false);
hud.setCamera(camLabel(camMode));
requestAnimationFrame(frame);

// Handy for debugging in the browser console: window.game.race
window.game = { get race() { return race; }, get track() { return track; }, scene, camera, loadTrack };