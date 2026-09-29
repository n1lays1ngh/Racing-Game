import * as THREE from 'three';
import './style.css';
import { buildTrack, getTrackDef, TRACKS } from './track.js';
import { buildWorld, buildCircuit, disposeCircuit } from './scenery.js';
import { createCarModel, loadCarModel, carCams } from './carModel.js';
import { GRAPHICS } from './settings.js';
import { Showcase } from './showcase.js';
import { setupMenu } from './menu.js';
import { Race, formatTime } from './race.js';
import { gearbox } from './physics.js';
import { readInput, wasPressed, clearPressed, pollPad, padFeedback } from './input.js';
import { EngineAudio } from './audio.js';
import { HUD } from './hud.js';
import { RearView } from './rearview.js';
import { applyTimeOfDay } from './lighting.js';
import { Lobby } from './lobby.js';
import { NameTags } from './nametags.js';
import { createRemoteModel, syncModels } from './carLod.js';
import { keepTicking, stopTicking } from './net/background.js';

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

// Race settings from the menu (online races get theirs from the host, see lobby.js)
function soloConfig() {
  const $ = (id) => document.getElementById(id);
  return {
    track: trackSelect.value, laps: Number($('opt-laps').value), difficulty: $('opt-diff').value,
    aiCount: Number($('opt-ai').value), playerName: $('opt-name').value.trim() || 'You', playerColor,
  };
}

function newRace(cfg = soloConfig()) {
  for (const m of models) scene.remove(m);
  if (trackSelect.value !== cfg.track) trackSelect.value = cfg.track;
  loadTrack(cfg.track);
  showcase.stop();
  race = new Race(track, cfg);
  lobby.session?.attach(race, cfg); // online: other people's cars are driven from the network
  models = race.cars.map((c) => {
    const m = c.isHuman && !c.isPlayer ? createRemoteModel(c.team) : createCarModel(c.team, { player: c.isPlayer });
    scene.add(m);
    return m;
  });
  syncModels(models, race.cars, camera);
  cams = carCams(models[race.cars.indexOf(race.player)]);
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

menuUI = setupMenu({ tracks: TRACKS, onStart: () => startGame() });
const nameTags = new NameTags(); // names over friends' cars online

// Multiplayer lobby (lobby.js) and the online race (net/session.js)
const lobby = new Lobby({
  tracks: TRACKS,
  previewTrack: (id) => { if (trackSelect.value !== id) { trackSelect.value = id; trackSelect.dispatchEvent(new Event('change')); } },
  onStart: (cfg) => startGame(cfg),
  onEnd: () => { if (race) { exitRace(); lobby.show(); } },  // the host ended the race
  onClosed: () => { exitRace(); menu.classList.add('hidden'); }, // the room is gone: the lobby says why
  onDnf: (car) => hud.toast(`${car.team.name} is out`, 2.5),
  onSession: (on) => (on ? keepTicking(tick) : stopTicking()), // keep racing in a background tab
});
window.addEventListener('pagehide', () => lobby.session?.leave());
loadTrack(trackSelect.value);                               // first circuit + live race behind the menu
carModelReady.then(() => { if (!race) showcase.start(track); }); // swap in the RB19 once it has loaded

// cfg: race settings (solo: from the menu; online: from the host)
async function startGame(cfg) {
  audio.start();
  await carModelReady; // usually loaded long before you press Start
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
  results.classList.add('hidden'); pauseEl.classList.add('hidden');
  hud.show(false); nameTags.clear();
  paused = false; audio.suspend(); rearView.hide();
  for (const m of models) scene.remove(m);
  models = [];
  if (race) { race = null; showcase.start(track); }
}
function toMenu() {
  lobby.leave(); lobby.hide(); // online: leaving the menu means leaving the room
  exitRace();
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
const IDLE = { throttle: 0, brake: 0, steer: 0 };
let lastTime = null;
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

  if (!race) { // menu: live AI race filmed like TV
    showcase.update(dt);
    const t = showcase.target?.state;
    if (t) { // keep the sharp shadows around the car on screen
      world.sun.position.set(t.x + world.sunDir.x * 150, (t.y ?? 0) + world.sunDir.y * 150, t.z + world.sunDir.z * 150);
      world.sun.target.position.set(t.x, t.y ?? 0, t.z);
    }
    if (drawing) renderer.render(scene, camera);
    return;
  }

  if (wasPressed('Escape') || wasPressed('KeyP')) setPaused(!paused);
  if (wasPressed('KeyC')) { camMode = (camMode + 1) % CAMERAS.length; hud.setCamera(CAMERAS[camMode]); snapCamera(); }
  if (wasPressed('KeyM')) audio.setMuted(!audio.muted);
  if (wasPressed('KeyR') && race.state === 'racing' && race.player.finishTime == null) race.resetPlayer();

  const input = readInput(dt);
  const session = lobby.session;
  if (!paused || session) { // online the race doesn't stop for the pause menu: your car coasts
    // Variable number of fixed-ish substeps keeps physics stable at any FPS.
    const steps = Math.ceil(dt / (1 / 120));
    for (let i = 0; i < steps; i++) race.step(dt / steps, paused ? IDLE : input);
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

  session?.tick(dt, timestamp); // online: swap car positions with the others
  syncModels(models, race.cars, camera); // friends' cars: full RB19 only for the nearest few

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
  nameTags.update(camera);

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
  audio.updateTraffic(race.cars.filter((c) => !c.dnf), race.player, camera); // engines around you, with Doppler
  if (!paused) padFeedback({ hit: ps.hitWall, surface: ps.surface, speed: ps.speed, slip: ps.slip }); // controller rumble

  hud.update(race, dt);
  // Keep the results table live while the rest of the field crosses the line.
  resultsTimer -= dt;
  if (!results.classList.contains('hidden') && resultsTimer <= 0) { showResults(); resultsTimer = 0.5; }
  if (!drawing) return;
  renderer.render(scene, camera);
  rearView.render(scene, ps); // mirror strip at the top of the screen
}
hud.show(false);
hud.setCamera(CAMERAS[camMode]);
requestAnimationFrame(frame);

// Handy for debugging in the browser console: window.game.race
window.game = { get race() { return race; }, get track() { return track; }, scene, camera, loadTrack };