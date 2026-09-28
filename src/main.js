import * as THREE from 'three';
import './style.css';
import { buildTrack, getTrackDef, TRACKS } from './track.js';
import { buildWorld, buildCircuit, disposeCircuit } from './scenery.js';
import { createCarModel, syncCarModel, loadCarModel, carCams } from './carModel.js';
import { GRAPHICS } from './settings.js';
import { Showcase } from './showcase.js';
import { setupMenu } from './menu.js';
import { Race, formatTime } from './race.js';
import { gearbox } from './physics.js';
import { readInput, wasPressed, clearPressed } from './input.js';
import { EngineAudio } from './audio.js';
import { HUD } from './hud.js';
import { RearView } from './rearview.js';
import { applyTimeOfDay } from './lighting.js';

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
const carModelReady = loadCarModel();    // your RB19 (see carModel.js); falls back to the built-in car
const showcase = new Showcase(scene, camera); // live AI race behind the menu
let menuUI = null;
let track = null, circuit = null, hud = null;

// Build (or switch to) a circuit: physics data, scenery and minimap.
function loadTrack(id) {
  if (track && track.id === id) return;
  if (circuit) disposeCircuit(circuit);
  track = buildTrack(getTrackDef(id));
  circuit = buildCircuit(track);
  scene.add(circuit.group);
  applyTimeOfDay(world, track); // day, dusk or night (set in the circuit file)
  if (hud) hud.setupMinimap(track); else hud = new HUD(track);
  menuUI?.setTrackInfo(track);
  if (!race) showcase.start(track); // restart the live race on the new circuit
}

// ---------- menus ----------
const menu = document.getElementById('menu');
const results = document.getElementById('results');
const pauseEl = document.getElementById('pause');
const trackSelect = document.getElementById('opt-track');
const TIME_LABEL = { night: ' · Night', dusk: ' · Twilight' };
trackSelect.innerHTML = TRACKS.map((t) => `<option value="${t.id}">${t.round ? `R${t.round} · ` : ''}${t.name} — ${t.country}${TIME_LABEL[t.time] ?? ''}</option>`).join('');
trackSelect.addEventListener('change', () => loadTrack(trackSelect.value)); // preview behind the menu

// ---------- game state ----------
let race = null;
let models = [];
let paused = false;
let playerColor = 0xe10600;
const CAMERAS = ['Chase', 'Far chase', 'T-cam', 'Cockpit'];
let camMode = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let shake = 0;
let resultsTimer = 0;
let cams = null; // onboard camera positions for the player's car model (from carModel.js)

function newRace() {
  showcase.stop();
  for (const m of models) scene.remove(m);
  loadTrack(trackSelect.value);
  const laps = Number(document.getElementById('opt-laps').value);
  const difficulty = document.getElementById('opt-diff').value;
  race = new Race(track, { laps, difficulty, playerColor });
  models = race.cars.map((c) => {
    const m = createCarModel(c.team, { player: c.isPlayer });
    scene.add(m); syncCarModel(m, c.state);
    return m;
  });
  cams = carCams(models[race.cars.indexOf(race.player)]);
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

menuUI = setupMenu({ tracks: TRACKS, onStart: () => startGame() });
loadTrack(trackSelect.value);                               // first circuit + live race behind the menu
carModelReady.then(() => { if (!race) showcase.start(track); }); // swap in the RB19 once it has loaded

async function startGame() {
  audio.start();
  await carModelReady; // usually loaded long before you press Start
  menu.classList.add('hidden'); results.classList.add('hidden'); pauseEl.classList.add('hidden');
  paused = false;
  newRace();
  hud.show(true);
}
document.getElementById('btn-start').addEventListener('click', startGame);
document.getElementById('btn-again').addEventListener('click', startGame);
document.getElementById('btn-menu').addEventListener('click', toMenu);
document.getElementById('btn-resume').addEventListener('click', () => setPaused(false));
document.getElementById('btn-quit').addEventListener('click', toMenu);

function toMenu() {
  results.classList.add('hidden'); pauseEl.classList.add('hidden');
  menu.classList.remove('hidden'); hud.show(false);
  paused = false; audio.suspend(); rearView.hide();
  for (const m of models) scene.remove(m);
  models = [];
  race = null;
  showcase.start(track);
}
function setPaused(v) {
  paused = v; pauseEl.classList.toggle('hidden', !v);
  v ? audio.suspend() : audio.resume();
}

function showResults() {
  const rows = race.standings.map((c) => {
    const time = c.finishTime != null
      ? (c.position === 1 ? formatTime(c.finishTime) : '+' + (c.finishTime - race.standings[0].finishTime).toFixed(3))
      : 'Running';
    return `<tr class="${c.isPlayer ? 'me' : ''}"><td>${c.position}</td><td>` +
      `<span class="sw" style="background:#${c.team.color.toString(16).padStart(6, '0')}"></span>${c.team.name}</td>` +
      `<td>${time}</td><td>${formatTime(c.bestLap)}</td></tr>`;
  }).join('');
  document.getElementById('results-body').innerHTML = rows;
  const p = race.player.position;
  document.getElementById('results-title').textContent =
    p === 1 ? 'Victory!' : p <= 3 ? `Podium — P${p}` : `Finished P${p}`;
  const fl = race.bestLapOverall;
  document.getElementById('results-fl').textContent =
    `${track.name} · ` + (fl ? `Fastest lap: ${fl.name} ${formatTime(fl.time)}` : '');
  results.classList.remove('hidden');
}

// ---------- camera ----------
// Chase cams trail the car's heading (smoothed) rather than lerping position,
// so the camera never falls behind at 300 km/h.
let camYaw = 0;
// How much each camera tilts with the car on a slope (1 = fully, like a camera bolted to the car).
// Less than 1 keeps the horizon steadier, so you can see hills like Eau Rouge rise up in front of you.
const PITCH_FOLLOW = [0.3, 0.3, 0.65, 0.65];
function cameraTarget(state, out, look) {
  if (rearView.lookBack) return rearView.lookBackTarget(state, out, look);
  const yaw = camMode <= 1 ? camYaw : state.h;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const y = state.y ?? 0, sp = Math.sin(state.pitch ?? 0); // follow the car up and down hills
  const lp = sp * PITCH_FOLLOW[camMode];                    // ...but only partly tilt the view
  switch (camMode) {
    case 0: out.set(state.x - fx * 8.5, y + 2.9 - sp * 8.5, state.z - fz * 8.5); look.set(state.x + fx * 6, y + 0.9 + lp * 6, state.z + fz * 6); break;
    case 1: out.set(state.x - fx * 14, y + 5 - sp * 14, state.z - fz * 14); look.set(state.x + fx * 8, y + 0.6 + lp * 8, state.z + fz * 8); break;
    case 2: case 3: { // T-cam on the airbox / driver's eyes. Positions and tilt are in CAR_MODEL.cams (carModel.js)
      const c = camMode === 2 ? cams.tcam : cams.cockpit, tilt = Math.tan(THREE.MathUtils.degToRad(c.tilt ?? 0)) * 20;
      out.set(state.x + fx * c.z, y + c.y, state.z + fz * c.z);
      look.set(state.x + fx * 20, y + c.y + tilt + lp * 20, state.z + fz * 20); break;
    }
  }
}
function snapCamera() {
  if (!race) return;
  camYaw = race.player.state.h;
  cameraTarget(race.player.state, camPos, camLook);
  camera.position.copy(camPos); camera.lookAt(camLook);
}

// ---------- main loop ----------
const timer = new THREE.Timer();
timer.connect(document); // pauses cleanly when the tab is hidden
function frame(timestamp) {
  requestAnimationFrame(frame);
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1);
  world.sky.material.uniforms.time.value += dt;

  if (!race) { // menu: live AI race filmed like TV
    showcase.update(dt);
    const t = showcase.target?.state;
    if (t) { // keep the sharp shadows around the car on screen
      world.sun.position.set(t.x + world.sunDir.x * 150, (t.y ?? 0) + world.sunDir.y * 150, t.z + world.sunDir.z * 150);
      world.sun.target.position.set(t.x, t.y ?? 0, t.z);
    }
    renderer.render(scene, camera); return;
  }

  if (wasPressed('Escape') || wasPressed('KeyP')) setPaused(!paused);
  if (wasPressed('KeyC')) { camMode = (camMode + 1) % CAMERAS.length; hud.setCamera(CAMERAS[camMode]); snapCamera(); }
  if (wasPressed('KeyM')) audio.setMuted(!audio.muted);
  if (wasPressed('KeyR') && race.state === 'racing' && race.player.finishTime == null) race.resetPlayer();

  const input = readInput(dt);
  if (!paused) {
    // Variable number of fixed-ish substeps keeps physics stable at any FPS.
    const steps = Math.ceil(dt / (1 / 120));
    for (let i = 0; i < steps; i++) race.step(dt / steps, input);
    for (const e of race.takeEvents()) {
      if (e.type === 'go') hud.toast('GO! GO! GO!', 1.2);
      if (e.type === 'bestLap') hud.toast(`Personal best  ${formatTime(e.time)}`);
      if (e.type === 'finalLap') hud.toast('Final lap');
      if (e.type === 'finish') {
        hud.toast('Chequered flag!', 2.5);
        const finished = race;
        setTimeout(() => { if (race === finished) showResults(); }, 2500);
      }
    }
  }

  race.cars.forEach((c, i) => syncCarModel(models[i], c.state));

  // Start lights on the gantry
  for (const l of circuit.lights) l.mat.emissiveIntensity = race.state === 'countdown' && l.index < race.lightsOn ? 4 : 0;

  // Camera follow with speed-based FOV and a bit of shake on impacts / kerbs
  const ps = race.player.state;
  let dYaw = ps.h - camYaw;
  dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
  camYaw += dYaw * (1 - Math.exp(-5 * dt));
  cameraTarget(ps, camPos, camLook);
  camera.position.copy(camPos);
  shake = Math.max(ps.hitWall, ps.surface !== 'road' && ps.speed > 5 ? 0.15 : 0, shake - dt * 3);
  if (shake > 0) camera.position.add(new THREE.Vector3((Math.random() - 0.5) * shake * 0.25, (Math.random() - 0.5) * shake * 0.25, 0));
  camera.lookAt(camLook);
  const fov = 62 + Math.min(ps.speed, 95) * 0.14;
  camera.fov += (fov - camera.fov) * Math.min(1, dt * 4); camera.updateProjectionMatrix();

  // Shadows follow the player so they stay sharp.
  world.sun.position.set(ps.x + world.sunDir.x * 150, ps.y + world.sunDir.y * 150, ps.z + world.sunDir.z * 150);
  world.sun.target.position.set(ps.x, ps.y, ps.z);

  const gb = gearbox(Math.abs(ps.vf));
  audio.update({
    rpm: race.state === 'countdown' ? 6000 + input.throttle * 6000 : gb.rpm,
    throttle: race.state === 'countdown' ? input.throttle : ps.throttle,
    slip: ps.slip, surface: ps.surface, speed: ps.speed, hit: ps.hitWall,
    gear: gb.gear, brake: ps.brake,
  });
  audio.updateTraffic(race.cars, race.player, camera); // AI engines around you, with Doppler

  hud.update(race, dt);
  // Keep the results table live while the rest of the field crosses the line.
  resultsTimer -= dt;
  if (!results.classList.contains('hidden') && resultsTimer <= 0) { showResults(); resultsTimer = 0.5; }
  renderer.render(scene, camera);
  rearView.render(scene, ps); // mirror strip at the top of the screen
}
hud.show(false);
hud.setCamera(CAMERAS[camMode]);
requestAnimationFrame(frame);

// Handy for debugging in the browser console: window.game.race
window.game = { get race() { return race; }, get track() { return track; }, scene, camera, loadTrack };