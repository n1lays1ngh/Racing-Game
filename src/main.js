import * as THREE from 'three';
import './style.css';
import { buildTrack } from './track.js';
import { buildScenery } from './scenery.js';
import { createCarModel, syncCarModel } from './carModel.js';
import { Race, formatTime } from './race.js';
import { gearbox } from './physics.js';
import { readInput, wasPressed, clearPressed } from './input.js';
import { EngineAudio } from './audio.js';
import { HUD } from './hud.js';

// ---------- renderer / scene / camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.25, 12000);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const track = buildTrack();
const world = buildScenery(scene, renderer, track);
const hud = new HUD(track);
const audio = new EngineAudio();

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

function newRace() {
  for (const m of models) scene.remove(m);
  const laps = Number(document.getElementById('opt-laps').value);
  const difficulty = document.getElementById('opt-diff').value;
  race = new Race(track, { laps, difficulty, playerColor });
  models = race.cars.map((c) => {
    const m = createCarModel(c.team);
    scene.add(m); syncCarModel(m, c.state);
    return m;
  });
  snapCamera();
  clearPressed();
}

// ---------- menus ----------
const menu = document.getElementById('menu');
const results = document.getElementById('results');
const pauseEl = document.getElementById('pause');

document.querySelectorAll('.swatch').forEach((el) => {
  el.style.background = el.dataset.color;
  el.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('sel'));
    el.classList.add('sel');
    playerColor = parseInt(el.dataset.color.slice(1), 16);
  });
});

function startGame() {
  audio.start();
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
  paused = false; audio.suspend();
  race = null;
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
  document.getElementById('results-fl').textContent = fl ? `Fastest lap: ${fl.name} ${formatTime(fl.time)}` : '';
  results.classList.remove('hidden');
}

// ---------- camera ----------
// Chase cams trail the car's heading (smoothed) rather than lerping position,
// so the camera never falls behind at 300 km/h.
let camYaw = 0;
function cameraTarget(state, out, look) {
  const yaw = camMode <= 1 ? camYaw : state.h;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  switch (camMode) {
    case 0: out.set(state.x - fx * 8.5, 2.9, state.z - fz * 8.5); look.set(state.x + fx * 6, 0.9, state.z + fz * 6); break;
    case 1: out.set(state.x - fx * 14, 5, state.z - fz * 14); look.set(state.x + fx * 8, 0.6, state.z + fz * 8); break;
    case 2: out.set(state.x - fx * 0.9, 1.5, state.z - fz * 0.6); look.set(state.x + fx * 20, 0.9, state.z + fz * 20); break;
    case 3: out.set(state.x + fx * 0.3, 1.12, state.z + fz * 0.3); look.set(state.x + fx * 20, 0.6, state.z + fz * 20); break;
  }
}
function snapCamera() {
  if (!race) return;
  camYaw = race.player.state.h;
  cameraTarget(race.player.state, camPos, camLook);
  camera.position.copy(camPos); camera.lookAt(camLook);
}

// Slow orbit around the start line behind the menu.
let menuAngle = 0;
function menuCamera(dt) {
  menuAngle += dt * 0.08;
  const cx = track.cx[40], cz = track.cz[40];
  camera.position.set(cx + Math.cos(menuAngle) * 60, 18, cz + Math.sin(menuAngle) * 60);
  camera.lookAt(cx, 2, cz);
}

// ---------- main loop ----------
const timer = new THREE.Timer();
timer.connect(document); // pauses cleanly when the tab is hidden
function frame(timestamp) {
  requestAnimationFrame(frame);
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1);
  world.sky.material.uniforms.time.value += dt;

  if (!race) { menuCamera(dt); renderer.render(scene, camera); return; }

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
      if (e.type === 'finish') { hud.toast('Chequered flag!', 2.5); setTimeout(() => race && showResults(), 2500); }
    }
  }

  race.cars.forEach((c, i) => syncCarModel(models[i], c.state));

  // Start lights on the gantry
  for (const l of world.lights) l.mat.emissiveIntensity = race.state === 'countdown' && l.index < race.lightsOn ? 4 : 0;

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
  world.sun.position.set(ps.x + world.sunDir.x * 150, world.sunDir.y * 150, ps.z + world.sunDir.z * 150);
  world.sun.target.position.set(ps.x, 0, ps.z);

  const gb = gearbox(Math.abs(ps.vf));
  audio.update({
    rpm: race.state === 'countdown' ? 6000 + input.throttle * 6000 : gb.rpm,
    throttle: race.state === 'countdown' ? input.throttle : ps.throttle,
    slip: ps.slip, surface: ps.surface, speed: ps.speed, hit: ps.hitWall,
  });

  hud.update(race, dt);
  // Keep the results table live while the rest of the field crosses the line.
  resultsTimer -= dt;
  if (!results.classList.contains('hidden') && resultsTimer <= 0) { showResults(); resultsTimer = 0.5; }
  renderer.render(scene, camera);
}
hud.show(false);
hud.setCamera(CAMERAS[camMode]);
requestAnimationFrame(frame);

// Handy for debugging in the browser console: window.game.race
window.game = { get race() { return race; }, scene, camera, track };
