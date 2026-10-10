// Cinematic replay: a lap or a whole race filmed like a broadcast, to watch or to save as videos.
//   • Your best lap at a circuit in a car (the ghost lap, ghost.js): main menu → Cinematic replay. The whole lap or one
//     sector (the HUD's thirds of the lap).
//   • A career race (replay.js keeps the last few): the results screen (Watch replay) or the career screen. The whole
//     race or one lap of it; the camera on a car you pick (you, to start with) or a TV director that follows the closest
//     battles.
//
// Cameras (ANGLES): the Director cuts between all of them every few seconds; or pick angles, and each angle is its own
// video of the clip (Helicopter only, Overhead drone only…). Parts: the clip is cut into as many equal parts as you
// ask for, each its own video, and you can record only some of them: long videos never have to be in one file.
//
// Saving: where the browser can (Chrome, Edge) you pick a folder once and each video is written straight into it
// while it records, so it doesn't sit in memory. Otherwise each part is held in memory only until it's downloaded.
// Recording renders frame by frame with the top graphics preset at the size you pick: it doesn't have to keep up with
// real time (a slow computer just takes longer), and the video still plays smoothly at CINEMA.fps (WebCodecs, via
// Mediabunny: H.264 .mp4, or VP9 .webm where H.264 can't be encoded; with no WebCodecs at all it records live, .webm).
// Take: the same take always gives the same edit; another take, another edit. Sound: the engine of the car on camera.
import * as THREE from 'three';
import { createCarModel, loadCarModel, syncCarModel, carCams } from './carModel.js';
import { createRaceModel, syncModels } from './carLod.js';
import { loadGhost } from './ghost.js';
import { projectOnTrack, pointAt, sampleAt } from './track.js';
import { formatTime } from './race.js';
import { buildSpeedProfile } from './ai.js';
import { buildRacingLine, disposeRacingLine } from './racingLine.js';
import { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, StreamTarget, CanvasSource, AudioBufferSource, canEncodeVideo, canEncodeAudio, QUALITY_HIGH } from 'mediabunny';
import { EngineAudio } from './audio.js';
import { gearbox } from './physics.js';
import { RF, COMPOUNDS } from './replay.js';

export const CINEMA = {
  fps: 60, shot: [3.5, 6], bitrate: 0.16, // bitrate: bits per pixel per frame
  maxParts: 20,
  follow: [5, 9],      // seconds: with the TV director on a single angle, how often it looks for another battle
  editStep: 0.1,       // seconds: how finely the edit is planned
};
// Every camera. kind: 'air' (from above), 'side' (standing by the track), 'follow' (moving with the car), 'car' (on it)
export const ANGLES = [
  { id: 'heli', name: 'Helicopter', kind: 'air' }, { id: 'overhead', name: 'Overhead drone', kind: 'air' }, { id: 'blimp', name: 'Blimp', kind: 'air' },
  { id: 'trackside', name: 'Telephoto', kind: 'side' }, { id: 'kerb', name: 'Kerb cam', kind: 'side' }, { id: 'pan', name: 'Trackside pan', kind: 'side' },
  { id: 'chase', name: 'Chase', kind: 'follow' }, { id: 'low', name: 'Low chase', kind: 'follow' }, { id: 'side', name: 'Side tracking', kind: 'follow' },
  { id: 'front', name: 'Front-on', kind: 'follow' }, { id: 'orbit', name: 'Orbit', kind: 'follow' },
  { id: 'hud', name: 'Gameplay + HUD', kind: 'follow' }, // the chase camera with the race HUD drawn on (drawHud)
  { id: 'tcam', name: 'T-cam', kind: 'car' }, { id: 'driver', name: "Driver's eye", kind: 'car' }, { id: 'wing', name: 'Front wing', kind: 'car' },
  { id: 'rear', name: 'Rear-facing', kind: 'car' }, { id: 'wheel', name: 'Wheel cam', kind: 'car' },
];
const DIRECTOR = { id: 'director', name: 'Director (mixed)' };
// the director's running order (take 1; other takes shuffle it)
const SHOTS = ['trackside', 'low', 'side', 'trackside', 'heli', 'front', 'tcam', 'trackside', 'chase', 'overhead', 'kerb', 'orbit',
  'pan', 'wing', 'trackside', 'blimp', 'driver', 'chase', 'wheel', 'pan'];
const PLACED = new Set(['trackside', 'kerb', 'pan']); // standing by the track: moved on once the car has gone by
const SIZES = { 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };
const F = 9; // ghost samples: t, x, y, z, heading, pitch, roll, speed, steer
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const nameOf = (id) => (id === 'director' ? 'director' : id);
const lapClock = (s) => (s == null || !Number.isFinite(s) ? '-:--.---' : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`);
const hex = (c) => `#${((c ?? 0xffffff) >>> 0).toString(16).padStart(6, '0')}`;
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let x = s; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
const hash = (str) => { let h = 2166136261; for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
// the sample at or before time t in a table of `n` samples, `stride` numbers each, the time first
function sampleIndex(S, n, stride, t) {
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid * stride] <= t) lo = mid; else hi = mid; }
  return lo;
}
const newState = () => ({ x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0, vf: 0, speed: 0, steer: 0, wheelSpin: 0, throttle: 0, brake: 0,
  tyres: { compound: 'medium' }, progress: 0, flags: 0 });

// ---------- what's being filmed ----------
// A source has: cars [{ team, isPlayer }], states (one per car, filled by fill(t)), duration, clips [{ id, name, a, b }],
// speedOf(car, t), and for a race, progress and flags for the TV director
class LapSource {
  constructor(ghost, track, team) {
    this.kind = 'lap'; this.S = ghost.samples; this.n = this.S.length / F; this.duration = ghost.time; this.track = track;
    this.cars = [{ team, isPlayer: true }]; this.states = [newState()]; this.player = 0;
    // the sectors: where the lap passes a third and two thirds of the way round
    const L = track.length, S = this.S, cross = [null, null]; let hint = -1;
    for (let k = 0; k < this.n; k++) {
      const p = projectOnTrack(track, S[k * F + 1], S[k * F + 3], hint); hint = p.i;
      if (cross[0] == null && p.s >= L / 3 && p.s < L * 0.9) cross[0] = S[k * F];
      if (cross[1] == null && p.s >= (2 * L) / 3 && p.s < L * 0.97) cross[1] = S[k * F];
    }
    const T = this.duration, t1 = cross[0] ?? T / 3, t2 = cross[1] ?? (2 * T) / 3;
    this.clips = [{ id: 'lap', name: 'Full lap', a: 0, b: T }, { id: 'S1', name: 'Sector 1', a: 0, b: t1 },
      { id: 'S2', name: 'Sector 2', a: t1, b: t2 }, { id: 'S3', name: 'Sector 3', a: t2, b: T }];
  }
  fill(t) {
    const S = this.S, st = this.states[0], lo = sampleIndex(S, this.n, F, t), hi = Math.min(lo + 1, this.n - 1), a = lo * F, b = hi * F;
    const f = clamp((t - S[a]) / Math.max(S[b] - S[a], 1e-6), 0, 1), mix = (k) => S[a + k] + (S[b + k] - S[a + k]) * f;
    st.x = mix(1); st.y = mix(2); st.z = mix(3); st.h = S[a + 4] + angDiff(S[a + 4], S[b + 4]) * f;
    st.pitch = mix(5); st.roll = mix(6); st.vf = st.speed = mix(7); st.steer = mix(8);
    const acc = (S[b + 7] - S[a + 7]) / Math.max(S[b] - S[a], 1e-3);
    st.throttle = acc > 0.4 ? 1 : 0.2; st.brake = acc < -6 ? 1 : 0;
  }
  speedOf(car, t) {
    const S = this.S, lo = sampleIndex(S, this.n, F, t), hi = Math.min(lo + 1, this.n - 1);
    const f = clamp((t - S[lo * F]) / Math.max(S[hi * F] - S[lo * F], 1e-6), 0, 1);
    return S[lo * F + 7] + (S[hi * F + 7] - S[lo * F + 7]) * f;
  }
}

class RaceSource {
  constructor(replay, track) {
    this.kind = 'race'; this.meta = replay.meta; this.track = track;
    this.S = replay.samples; this.N = this.meta.cars.length; this.stride = 1 + this.N * RF;
    this.n = Math.floor(this.S.length / this.stride);
    this.duration = this.n ? this.S[(this.n - 1) * this.stride] : 0;
    this.cars = this.meta.cars.map((c) => ({ team: { name: c.name, color: c.color, accent: c.accent, number: c.number }, isPlayer: c.isPlayer }));
    this.states = this.cars.map(newState);
    this.player = Math.max(0, this.cars.findIndex((c) => c.isPlayer));
    this.starts = []; // per car: the race time each of its laps began (lapStarts, for the HUD)
    // clips: the whole race, then each lap as the leader drove it
    const L = this.meta.length, S = this.S;
    this.clips = [{ id: 'race', name: 'Whole race', a: 0, b: this.duration }];
    let lap = 1, start = 0;
    for (let k = 0; k < this.n && lap <= this.meta.laps; k++) {
      const o = k * this.stride; let lead = -Infinity;
      for (let c = 0; c < this.N; c++) lead = Math.max(lead, S[o + 1 + c * RF + 8]);
      if (lead >= lap * L) { this.clips.push({ id: `L${lap}`, name: `Lap ${lap}`, a: start, b: S[o] }); start = S[o]; lap++; }
    }
  }
  fill(t) {
    const S = this.S, R = this.stride, lo = sampleIndex(S, this.n, R, t), hi = Math.min(lo + 1, this.n - 1), A = lo * R, B = hi * R;
    const f = clamp((t - S[A]) / Math.max(S[B] - S[A], 1e-6), 0, 1), dt = Math.max(S[B] - S[A], 1e-3);
    for (let c = 0; c < this.N; c++) {
      const a = A + 1 + c * RF, b = B + 1 + c * RF, st = this.states[c], mix = (k) => S[a + k] + (S[b + k] - S[a + k]) * f;
      st.x = mix(0); st.y = mix(1); st.z = mix(2); st.h = S[a + 3] + angDiff(S[a + 3], S[b + 3]) * f;
      st.pitch = mix(4); st.roll = mix(5); st.vf = st.speed = mix(6); st.steer = mix(7); st.progress = mix(8);
      st.flags = S[a + 9];
      const comp = (st.flags >> 3) - 1; if (comp >= 0) st.tyres.compound = COMPOUNDS[comp];
      const acc = (S[b + 6] - S[a + 6]) / dt; st.throttle = acc > 0.4 ? 1 : 0.2; st.brake = acc < -6 ? 1 : 0;
    }
  }
  lapStarts(c) {
    if (!this.starts[c]) {
      const S = this.S, R = this.stride, L = this.meta.length, out = [0]; let lap = 1;
      for (let k = 0; k < this.n; k++) { const p = S[k * R + 1 + c * RF + 8]; while (p >= lap * L) { out.push(S[k * R]); lap++; } }
      this.starts[c] = out;
    }
    return this.starts[c];
  }
  speedOf(car, t) {
    const S = this.S, R = this.stride, lo = sampleIndex(S, this.n, R, t), hi = Math.min(lo + 1, this.n - 1);
    const f = clamp((t - S[lo * R]) / Math.max(S[hi * R] - S[lo * R], 1e-6), 0, 1), k = 1 + car * RF + 6;
    return S[lo * R + k] + (S[hi * R + k] - S[lo * R + k]) * f;
  }
}

export class Cinema {
  // hooks: { renderer, scene, camera, highGraphics() → restore(), onFrame(dt, state, model), onExit(), live: { start, update, stop } }
  constructor(hooks) {
    Object.assign(this, hooks);
    this.active = false; this.mode = null; this.res = '1080'; this.take = 1; this.line = false; this.sound = true;
    this.cams = new Set(['director']); this.parts = 1; this.partSel = new Set([0]); this.clipId = null; this.focusPick = 'you';
    this.cc = null; this.comp = null; this.overlay = null; this.edits = new Map(); // one edit (which shot when) per angle for the whole clip: watching and every part agree
    this.v = { p: new THREE.Vector3(), q: new THREE.Vector3(), l: new THREE.Vector3(), fwd: new THREE.Vector3(), left: new THREE.Vector3() };
    $('cin-watch').addEventListener('click', () => this.run(false));
    $('cin-rec').addEventListener('click', () => this.run(true));
    $('cin-back').addEventListener('click', () => this.close());
    const take = (d) => { this.take = Math.max(1, this.take + d); $('cin-take').textContent = this.take; };
    $('cin-take-prev').addEventListener('click', () => take(-1));
    $('cin-take-next').addEventListener('click', () => take(1));
    $('cin-line').addEventListener('click', () => { this.line = !this.line; $('cin-line').setAttribute('aria-checked', String(this.line)); });
    $('cin-sound').addEventListener('click', () => { this.sound = !this.sound; $('cin-sound').setAttribute('aria-checked', String(this.sound)); });
    $('cin-res').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { this.res = b.dataset.v; this.drawRes(); } });
    $('cin-clip').addEventListener('change', (e) => { this.clipId = e.target.value; this.drawParts(); });
    $('cin-follow').addEventListener('change', (e) => { this.focusPick = e.target.value; });
    $('cin-cams').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const id = b.dataset.cam;
      if (this.cams.has(id)) { if (this.cams.size > 1) this.cams.delete(id); } else this.cams.add(id);
      this.drawCams();
    });
    const setParts = (n) => {
      n = clamp(Math.round(n) || 1, 1, CINEMA.maxParts);
      if (n === this.parts) { $('cin-parts').value = n; return; } // (the box losing focus says "changed" too: keep the parts picked)
      this.parts = n; this.partSel = new Set([...Array(n).keys()]); this.drawParts();
    };
    $('cin-parts').addEventListener('change', (e) => setParts(Number(e.target.value)));
    $('cin-parts-dn').addEventListener('click', () => setParts(this.parts - 1));
    $('cin-parts-up').addEventListener('click', () => setParts(this.parts + 1));
    $('cin-partsel').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const k = Number(b.dataset.part);
      if (this.partSel.has(k)) { if (this.partSel.size > 1) this.partSel.delete(k); } else this.partSel.add(k);
      this.drawParts();
    });
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.code !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.mode) this.stop = true; else this.close();
    }, true);
    this.drawRes(); this.drawCams();
  }

  // ---------- opening ----------
  // Your best lap. car: its file (src/cars/); track: the circuit on screen; team: your colours
  async open(car, track, team, onExit = null) {
    this.begin(car, track, onExit);
    $('cin-kicker').textContent = 'Cinematic replay';
    $('cin-title').textContent = track.name;
    $('cin-status').textContent = 'Loading your best lap…';
    const [g] = await Promise.all([loadGhost(car.id, track.id), loadCarModel(car.model)]);
    if (!this.active) return;
    this.src = g ? new LapSource(g, track, team) : null;
    $('cin-sub').textContent = `${car.name}${g ? `  ·  best lap ${formatTime(g.time)}` : ''}`;
    this.ready(g ? null : `No best lap here in the ${car.name} yet: drive a clean lap (any offline race or practice) and it's kept for this.`);
  }
  // A career race (replay.js): { meta, samples }; the circuit is on screen already (main.js)
  async openRace(replay, car, track, onExit = null) {
    this.begin(car, track, onExit);
    const m = replay.meta, me = m.results?.find((r) => r.isPlayer);
    $('cin-kicker').textContent = m.series ? `${m.series} · race replay` : 'Race replay';
    $('cin-title').textContent = track.name;
    $('cin-sub').textContent = `${car.name}  ·  ${m.laps} laps  ·  ${clock(m.duration ?? 0)}${me ? `  ·  you ${me.dnf ? 'DNF' : `P${me.pos}`}` : ''}`;
    await loadCarModel(car.model);
    if (!this.active) return;
    this.src = new RaceSource(replay, track);
    this.ready(this.src.duration > 1 ? null : 'This replay is empty.');
  }
  begin(car, track, onExit) {
    this.active = true; this.car = car; this.track = track; this.exitTo = onExit; this.src = null; this.clipId = null;
    $('cinema').classList.remove('hidden', 'playing');
    $('cin-watch').disabled = $('cin-rec').disabled = true;
  }
  ready(problem) {
    const ok = !problem && !!this.src;
    $('cin-status').textContent = problem ?? (window.showDirectoryPicker
      ? 'Record asks for a folder once: each video is written straight into it.' : 'Each video downloads when it\'s done (Esc stops).');
    $('cin-watch').disabled = $('cin-rec').disabled = !ok;
    const race = this.src?.kind === 'race';
    $('cin-follow-row').classList.toggle('hidden', !race);
    if (ok) {
      $('cin-clip').innerHTML = this.src.clips.map((c) => `<option value="${c.id}">${esc(c.name)}  (${clock(c.b - c.a)})</option>`).join('');
      this.clipId = this.src.clips[0].id;
      if (race) {
        $('cin-follow').innerHTML = `<option value="tv">TV director: the closest battles</option>` +
          this.src.cars.map((c, k) => `<option value="${k}">${c.isPlayer ? 'You' : esc(c.team.name)}</option>`).join('');
        this.focusPick = String(this.src.player); $('cin-follow').value = this.focusPick;
      }
    }
    this.drawParts();
    (ok ? $('cin-watch') : $('cin-back')).focus({ preventScroll: true });
  }
  close() {
    if (this.mode) { this.stop = true; return; }
    this.active = false;
    $('cinema').classList.add('hidden');
    (this.exitTo ?? this.onExit)?.();
  }

  // ---------- the panel ----------
  drawRes() { for (const b of $('cin-res').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === this.res); }
  drawCams() {
    const chip = (a) => `<button type="button" data-cam="${a.id}" class="${this.cams.has(a.id) ? 'on' : ''}">${esc(a.name)}</button>`;
    $('cin-cams').innerHTML = chip(DIRECTOR) + ANGLES.map(chip).join('');
    const n = this.cams.size;
    $('cin-cam-note').textContent = n > 1 ? `${n} angles: ${n} videos of each part` : '';
  }
  clip() { return this.src?.clips.find((c) => c.id === this.clipId) ?? this.src?.clips[0]; }
  partRanges() {
    const c = this.clip(); if (!c) return [];
    const len = (c.b - c.a) / this.parts;
    return [...Array(this.parts).keys()].map((k) => ({ k, a: c.a + k * len, b: k === this.parts - 1 ? c.b : c.a + (k + 1) * len }));
  }
  drawParts() {
    $('cin-parts').value = this.parts;
    const c = this.clip();
    $('cin-part-len').textContent = c ? `${clock((c.b - c.a) / this.parts)} each` : '';
    $('cin-partsel-row').classList.toggle('hidden', this.parts < 2);
    $('cin-partsel').innerHTML = [...Array(this.parts).keys()].map((k) =>
      `<button type="button" data-part="${k}" class="${this.partSel.has(k) ? 'on' : ''}">${k + 1}</button>`).join('');
  }

  // ---------- the edit: which camera, on which car, from when to when ----------
  // Planned before a part is filmed (and the sound is made from it): a list of cuts { t, shot, focus, until, spot… }
  buildEdit(a, b, cam, seed) {
    const src = this.src, rand = seeded(seed), cuts = [], race = src.kind === 'race';
    let order = [cam];
    if (cam === 'director') {
      order = SHOTS.slice();
      if (this.take > 1) for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    }
    const tv = race && this.focusPick === 'tv', fixed = tv ? null : race ? Number(this.focusPick) : 0;
    let cur = null, index = Math.floor(rand() * order.length) * (this.take > 1 ? 1 : 0) - 1, last = null;
    for (let t = a; t < b; t += CINEMA.editStep) {
      src.fill(t);
      if (cur && t < cur.until && !(PLACED.has(cur.shot) && this.passed(cur, t))) continue;
      const focus = tv ? this.pickFocus(rand, last) : fixed;
      index = (index + 1) % order.length;
      let shot = order[index];
      const len = cam === 'director' ? CINEMA.shot[0] + rand() * (CINEMA.shot[1] - CINEMA.shot[0])
        : tv ? CINEMA.follow[0] + rand() * (CINEMA.follow[1] - CINEMA.follow[0]) : PLACED.has(shot) ? 12 : Infinity;
      cur = { t, shot, focus, until: t + len, orbit: rand() * Math.PI * 2, side: rand() < 0.5 ? -1 : 1, r: rand() };
      if (PLACED.has(shot)) cur.spot = this.spotFor(shot, src.states[focus], cur);
      cuts.push(cur); last = focus;
    }
    return cuts;
  }
  // the car on camera has gone past a camera standing by the track (or is too far from it): time to move it on
  passed(cut, t) {
    const st = this.src.states[cut.focus], dx = st.x - cut.spot.x, dz = st.z - cut.spot.z, d = Math.hypot(dx, dz);
    const away = (dx * Math.sin(st.h) + dz * Math.cos(st.h)) > 0; // heading away from it
    return (away && d > (cut.shot === 'kerb' ? 18 : 30)) || d > 260 || t - cut.t > 14;
  }
  // where a camera beside the track stands: ahead of the car, on the outside of the bend
  spotFor(shot, st, cut) {
    const t = this.track, p = projectOnTrack(t, st.x, st.z, -1), v = Math.abs(st.vf);
    const ahead = shot === 'trackside' ? clamp(v * 2.4, 60, 180) : shot === 'kerb' ? clamp(v * 1.1, 25, 80) : clamp(v * 1.6, 35, 110);
    const s = p.s + ahead, i = sampleAt(t, s), side = Math.sign(t.curv[i]) ? -Math.sign(t.curv[i]) : cut.side;
    const wall = side > 0 ? t.wallL[i] : t.wallR[i], hw = t.hw ? t.hw[i] : 6;
    const lat = shot === 'kerb' ? hw + (t.kerb ?? 1) + 1.2 : wall + (shot === 'pan' ? 1.5 : 2.5);
    const at = pointAt(t, s, side * lat), ground = t.h ? t.h[i] : 0;
    const up = shot === 'kerb' ? 0.35 : shot === 'pan' ? 1.6 + cut.r * 1.6 : 1.5 + cut.r * 3.5;
    return new THREE.Vector3(at.x, ground + up, at.z);
  }
  // TV director: the closest fight on the road (nearer the front counts for more, yours a little more again)
  pickFocus(rand, last) {
    const S = this.src.states, run = S.map((s, i) => ({ i, p: s.progress, f: s.flags })).filter((x) => !(x.f & 1)).sort((a, b) => b.p - a.p);
    if (run.length < 2) return run[0]?.i ?? 0;
    if (rand() < 0.15) return run[0].i; // now and then, the leader
    let best = null, score = Infinity;
    for (let k = 0; k + 1 < run.length; k++) {
      const A = run[k], B = run[k + 1];
      let sc = (A.p - B.p) * (1 + k * 0.06);
      if (this.src.cars[A.i].isPlayer || this.src.cars[B.i].isPlayer) sc *= 0.7;
      if ((A.f | B.f) & 4) sc *= 3;                 // in the pits: not much of a fight
      if (B.i === last || A.i === last) sc *= 1.3;  // something else for a change
      if (sc < score) { score = sc; best = B.i; }    // the car behind, attacking
    }
    return best ?? run[0].i;
  }
  cutAt(edit, t, from = 0) { let k = from; while (k + 1 < edit.length && edit[k + 1].t <= t) k++; return k; }

  // ---------- watch or record ----------
  async run(record) {
    if (this.mode || !this.src) return;
    const parts = this.partRanges().filter((p) => this.partSel.has(p.k));
    const cams = [...this.cams];
    let dir = null;
    if (record && window.showDirectoryPicker && window.VideoEncoder) {
      try { dir = await window.showDirectoryPicker({ id: 'apex-cinema', mode: 'readwrite' }); }
      catch (err) { if (err?.name === 'AbortError') return; dir = null; } // (picked nothing: don't record; not allowed: download instead)
    }
    this.mode = record ? 'record' : 'watch'; this.stop = false; this.edits.clear();
    $('cinema').classList.add('playing');
    const { renderer, camera, scene } = this, fov = camera.fov, size = renderer.getSize(new THREE.Vector2()), ratio = renderer.getPixelRatio();
    let restore = null, saved = 0;
    this.setupModels();
    const line = this.line ? buildRacingLine(this.track, buildSpeedProfile(this.track, 1, 0.97, 0.9, this.car.physics), this.car.physics) : null;
    if (line) scene.add(line);
    try {
      if (record) {
        restore = this.highGraphics?.();
        const [W, H] = SIZES[this.res];
        renderer.setPixelRatio(1); renderer.setSize(W, H, false);
        camera.aspect = W / H; camera.updateProjectionMatrix();
        const clip = this.clip(), total = cams.length * parts.length; let done = 0;
        for (const cam of cams) for (const part of parts) {
          if (this.stop) break;
          const label = `${ANGLES.find((x) => x.id === cam)?.name ?? 'Director'}${this.parts > 1 ? `, part ${part.k + 1} of ${this.parts}` : ''}`;
          const name = this.fileName(clip, cam, part);
          const out = await this.film(part, cam, { record: true, dir, name, label, n: ++done, total });
          if (out && !this.stop) { if (out.blob) this.download(out); saved++; }
        }
      } else {
        // watch: the parts picked, back to back, with the first angle picked, framed as the video will be (black bars)
        const a = parts[0].a, b = parts[parts.length - 1].b, [W, H] = SIZES[this.res], A = W / H;
        const w = Math.min(size.x, size.y * A), h = w / A;
        camera.aspect = A; camera.updateProjectionMatrix();
        await this.film({ k: 0, a, b }, cams[0], { record: false, box: [(size.x - w) / 2, (size.y - h) / 2, w, h] });
      }
    } catch (err) {
      console.warn('Cinematic replay:', err);
      $('cin-status').textContent = `Couldn't record: ${err.message ?? err}`;
    } finally {
      this.removeModels();
      if (line) { scene.remove(line); disposeRacingLine(line); }
      if (record) { renderer.setPixelRatio(ratio); renderer.setSize(size.x, size.y, false); restore?.(); }
      renderer.setScissorTest(false); renderer.setViewport(0, 0, size.x, size.y);
      camera.aspect = size.x / size.y;
      camera.fov = fov; camera.up.set(0, 1, 0); camera.updateProjectionMatrix();
      $('cin-progress').textContent = '';
      if (this.overlay) this.overlay.style.display = 'none';
      $('cinema').classList.remove('playing');
      this.mode = null;
      if (record && saved) $('cin-status').textContent = `Saved ${saved} ${saved === 1 ? 'video' : 'videos'}${dir ? ` in “${dir.name}”` : ''}.`;
      else if (record && this.stop) $('cin-status').textContent = 'Stopped.';
    }
  }
  fileName(clip, cam, part) {
    const who = this.src.kind === 'race' ? (this.focusPick === 'tv' ? 'tv' : this.src.cars[Number(this.focusPick)]?.isPlayer ? 'you'
      : (this.src.cars[Number(this.focusPick)]?.team.name ?? '').toLowerCase()) : this.car.id;
    const parts = this.parts > 1 ? `_part${part.k + 1}of${this.parts}` : '';
    return `apex_${this.track.id}_${clip.id}_${nameOf(cam)}_${who}${this.take > 1 ? `_take${this.take}` : ''}${parts}`.replace(/[^a-z0-9_.-]+/gi, '-');
  }

  // One part, with one angle (or the director): watched live, or rendered frame by frame into a video
  async film(part, cam, opts) {
    const { renderer, camera, scene } = this, fps = CINEMA.fps, src = this.src;
    // the edit for the whole clip (not just this part), so a part shows the same shots as watching it does
    if (!this.edits.has(cam)) {
      const c = this.clip();
      // (seeded only by what's filmed: the same take of the same clip, angle and car is always the same edit)
      this.edits.set(cam, this.buildEdit(c.a, c.b, cam, hash(`${this.take}|${cam}|${this.focusPick}|${c.id}`)));
    }
    const edit = this.edits.get(cam);
    let enc = null, rec = null, out = null;
    if (opts.record) {
      $('cin-progress').textContent = `Preparing ${opts.label}…`;
      if (cam === 'hud') { // the HUD is drawn over each frame on a canvas of its own, and that's what gets recorded
        this.comp ??= document.createElement('canvas');
        this.comp.width = renderer.domElement.width; this.comp.height = renderer.domElement.height;
      }
      const canvas = cam === 'hud' ? this.comp : renderer.domElement;
      if (window.VideoEncoder) enc = await this.encoder(canvas.width, canvas.height, fps, part, edit, opts, canvas);
      else rec = this.recorder(canvas);
    }
    if (!opts.record && this.sound) this.live?.start(this.car);
    const frames = Math.max(1, Math.round((part.b - part.a) * fps));
    let t = part.a, last = performance.now(), k = 0, current = -1;
    try {
      for (let i = 0; !this.stop && t <= part.b; i++) {
        await new Promise((go) => requestAnimationFrame(go));
        const now = performance.now(), live = !enc;
        const dt = live ? Math.min((now - last) / 1000, 0.1) : 1 / fps; last = now;
        t = live ? t + dt : part.a + i / fps;
        if (enc && i >= frames) break;
        const tt = Math.min(t, part.b);
        src.fill(tt);
        k = this.cutAt(edit, tt, Math.max(0, k));
        const cut = edit[k], snap = k !== current; current = k;
        this.frame(tt, dt, cut, snap);
        if (!opts.record && this.sound) this.live?.update(this.noise(tt, edit));
        if (opts.box) { // watching: black bars round the video's frame
          renderer.setScissorTest(false); renderer.setViewport(0, 0, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
          const cc = renderer.getClearColor(this.cc ??= new THREE.Color()), ca = renderer.getClearAlpha();
          renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.setClearColor(cc, ca);
          renderer.setViewport(...opts.box); renderer.setScissor(...opts.box); renderer.setScissorTest(true);
        }
        renderer.render(scene, camera);
        if (cam === 'hud') {
          if (opts.record) { const g = this.comp.getContext('2d'); g.drawImage(renderer.domElement, 0, 0); this.drawHud(g, 0, 0, this.comp.width, this.comp.height, tt, cut); }
          else this.overlayHud(opts.box, tt, cut);
        }
        if (enc) {
          await enc.add(i);
          $('cin-progress').textContent = `Recording ${opts.label}  ·  ${opts.n} of ${opts.total}  ·  ${Math.round((i / frames) * 100)}%  ·  Esc stops`;
        } else $('cin-progress').textContent = rec ? `Recording ${opts.label} live  ·  Esc stops` : `${clock(tt - part.a)} / ${clock(part.b - part.a)}  ·  Esc stops`;
      }
      if (enc) out = this.stop ? (await enc.cancel(), null) : await enc.finish();
      if (rec) out = await rec.finish(opts.name);
    } catch (err) { if (enc) await enc.cancel().catch(() => {}); throw err; }
    finally { if (!opts.record) this.live?.stop(); }
    return out;
  }

  // ---------- the cars ----------
  setupModels() {
    const src = this.src, scene = this.scene;
    this.models = src.cars.map((c) => {
      const m = src.kind === 'race' ? createRaceModel({ isPlayer: c.isPlayer, isHuman: false, team: c.team }, this.car)
        : createCarModel(c.team, { player: true, car: this.car });
      scene.add(m); return m;
    });
    this.syncCars = src.states.map((state, k) => ({ state, dnf: false, parked: false, retired: false, isPlayer: src.cars[k].isPlayer }));
  }
  removeModels() { for (const m of this.models ?? []) this.scene.remove(m); this.models = null; }
  frame(t, dt, cut, snap) {
    const src = this.src;
    for (const st of src.states) st.wheelSpin += (st.vf * dt) / 0.36;
    if (src.kind === 'race') {
      this.syncCars.forEach((c) => { const f = c.state.flags; c.dnf = !!(f & 1); c.parked = !!(f & 2); c.retired = c.dnf; });
      syncModels(this.models, this.syncCars, this.camera);
    } else syncCarModel(this.models[0], src.states[0]);
    const st = src.states[cut.focus], model = this.models[cut.focus];
    this.onFrame?.(dt, st, this.models[src.player]); // (sun and shadows follow the car on camera; headlights on yours)
    this.aim(dt, cut, st, model, snap);
  }

  // ---------- the camera ----------
  aim(dt, cut, st, model, snap) {
    const { camera } = this, V = this.v, k = snap ? 1 : 1 - Math.exp(-dt * 6);
    V.fwd.set(Math.sin(st.h), 0, Math.cos(st.h)); V.left.set(Math.cos(st.h), 0, -Math.sin(st.h));
    const car = V.q.set(st.x, st.y + 0.6, st.z);
    const at = (back, up, side) => V.p.set(st.x, st.y + up, st.z).addScaledVector(V.fwd, -back).addScaledVector(V.left, side);
    const look = V.l.copy(car);
    let fov = 50, pos = null, shot = cut.shot;
    const cams = carCams(model);
    if ((shot === 'tcam' && !cams?.tcam) || (shot === 'driver' && !cams?.cockpit)) shot = 'chase';
    camera.up.set(0, 1, 0);
    switch (shot) {
      case 'trackside': pos = cut.spot; fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(3.4 / Math.max(cut.spot.distanceTo(car), 1))), 7, 45); break;
      case 'kerb': pos = cut.spot; fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(5 / Math.max(cut.spot.distanceTo(car), 1))), 14, 62); break;
      case 'pan': pos = cut.spot; fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(6.5 / Math.max(cut.spot.distanceTo(car), 1))), 16, 50); break;
      case 'chase': pos = at(7.5, 1.7, 0); look.addScaledVector(V.fwd, 10); fov = 55; break;
      case 'low': pos = at(4.6, 0.42, 1.3); look.addScaledVector(V.fwd, 25); fov = 58; break;
      case 'side': pos = at(-1.5, 1.0, 7 * Math.sign(Math.cos(cut.orbit))); fov = 38; break;
      case 'front': pos = at(-11, 0.75, 0.8); fov = 34; break;
      case 'hud': pos = at(6.4, 1.85, 0); look.addScaledVector(V.fwd, 12); fov = 60; break; // as you drive it
      case 'orbit': cut.orbit += dt * 0.35; pos = at(Math.cos(cut.orbit) * 8, 2.2, Math.sin(cut.orbit) * 8); fov = 48; break;
      case 'heli': cut.orbit += dt * 0.12; pos = at(Math.cos(cut.orbit) * 30, 17, Math.sin(cut.orbit) * 30); fov = 38; break;
      case 'overhead': // straight down from a drone, the car pointing up the picture
        pos = V.p.set(st.x, st.y + 38, st.z).addScaledVector(V.fwd, 3); camera.up.copy(V.fwd); fov = 42; break;
      case 'blimp': // very high and far off, a long lens: the car small in the circuit
        cut.orbit += dt * 0.02; pos = V.p.set(st.x + Math.cos(cut.orbit) * 150, st.y + 105, st.z + Math.sin(cut.orbit) * 150); fov = 17; break;
      default: { this.mounted(shot, cut, model, cams); return; } // on the car
    }
    if (PLACED.has(shot) || snap) camera.position.copy(pos); else camera.position.lerp(pos, k);
    camera.fov = fov; camera.updateProjectionMatrix();
    camera.lookAt(look);
  }
  // cameras fixed to the car: they move with it exactly (no smoothing)
  mounted(shot, cut, model, cams) {
    const camera = this.camera, b = localBox(model), V = this.v;
    let p, l, fov = 68;
    if (shot === 'tcam') { const c = cams.tcam; p = [c.x ?? 0, c.y, c.z]; l = [c.x ?? 0, c.y - 0.6, c.z + 20]; }
    else if (shot === 'driver') { const c = cams.cockpit, drop = Math.tan(((c.tilt ?? -3) * Math.PI) / 180) * 20; p = [c.x ?? 0, c.y, c.z]; l = [c.x ?? 0, c.y + drop, c.z + 20]; fov = 72; }
    else if (shot === 'wing') { p = [0, 0.3, b.max.z - 0.15]; l = [0, 0.25, b.max.z + 30]; fov = 70; }
    else if (shot === 'rear') { const y = Math.max(0.6, b.max.y * 0.7); p = [0, y, b.min.z + 0.2]; l = [0, y - 0.4, b.min.z - 30]; fov = 66; }
    else { const s = cut.side, x = b.max.x * 0.95 + 0.08; p = [s * x, 0.55, b.max.z * 0.05]; l = [s * x * 0.8, 0.3, b.max.z * 0.7 + 8]; fov = 64; } // wheel cam
    camera.position.copy(model.localToWorld(V.p.set(p[0], p[1], p[2])));
    camera.fov = fov; camera.updateProjectionMatrix();
    camera.lookAt(model.localToWorld(V.l.set(l[0], l[1], l[2])));
  }

  // ---------- the HUD angle: the race as you'd see it driving, drawn onto the picture ----------
  // watching: on a canvas over the view (box: where the picture is, in CSS pixels)
  overlayHud(box, t, cut) {
    if (!this.overlay) {
      this.overlay = document.createElement('canvas');
      this.overlay.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:0';
      $('cinema').prepend(this.overlay);
    }
    const o = this.overlay, d = window.devicePixelRatio || 1, W = Math.round(innerWidth * d), H = Math.round(innerHeight * d);
    if (o.width !== W || o.height !== H) { o.width = W; o.height = H; }
    o.style.display = 'block';
    const g = o.getContext('2d'); g.clearRect(0, 0, W, H);
    const [bx, by, bw, bh] = box ?? [0, 0, innerWidth, innerHeight];
    this.drawHud(g, bx * d, by * d, bw * d, bh * d, t, cut);
  }
  // the HUD in a w × h picture at x, y (laid out for 1080 pixels high, scaled): timing tower (races), lap timing, dash
  drawHud(g, x, y, w, h, t, cut) {
    const s = h / 1080, W = w / s, src = this.src, race = src.kind === 'race', st = src.states[cut.focus];
    const box = (px, py, pw, ph, fill = 'rgba(14,16,22,0.84)') => { g.fillStyle = fill; g.beginPath(); g.roundRect(x + px * s, y + py * s, pw * s, ph * s, 7 * s); g.fill(); };
    const text = (str, px, py, size, color = '#fff', align = 'left', weight = 700) => {
      g.font = `${weight} ${Math.round(size * s)}px 'Titillium Web', system-ui, sans-serif`;
      g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(str, x + px * s, y + py * s);
    };
    const dim = 'rgba(255,255,255,0.6)';
    g.save();
    // ---- lap timing, top right ----
    let lap = 1, lapT = t, other = null, otherLabel = 'BEST';
    if (race) {
      const starts = src.lapStarts(cut.focus); let k = 0; while (k + 1 < starts.length && starts[k + 1] <= t) k++;
      lap = Math.min(k + 1, src.meta.laps); lapT = t - starts[k]; other = k > 0 ? starts[k] - starts[k - 1] : null; otherLabel = 'LAST';
    } else other = src.duration;
    const tx = W - 32 - 330;
    box(tx, 32, 330, 128);
    text(race ? `LAP ${lap}/${src.meta.laps}` : 'LAP', tx + 20, 58, 20, dim, 'left', 600);
    text(lapClock(lapT), tx + 20, 98, 46);
    text(`${otherLabel}  ${lapClock(other)}`, tx + 20, 138, 19, dim, 'left', 600);
    // ---- timing tower, top left (races) ----
    if (race) {
      const order = src.states.map((q, i) => i).sort((a, b) => ((src.states[a].flags & 1) - (src.states[b].flags & 1)) || src.states[b].progress - src.states[a].progress);
      const max = 10, at = order.indexOf(cut.focus), rows = order.slice(0, max);
      if (at >= max) rows[max - 1] = cut.focus;
      const RH = 34, top = 32;
      box(32, top, 290, 44 + rows.length * RH);
      text(`LAP ${Math.min(Math.floor(Math.max(src.states[order[0]].progress, 0) / src.meta.length) + 1, src.meta.laps)}/${src.meta.laps}`, 50, top + 24, 18, dim, 'left', 600);
      rows.forEach((c, r) => {
        const q = src.states[c], pos = order.indexOf(c), yy = top + 44 + r * RH + RH / 2, me = c === cut.focus;
        if (me) box(36, yy - RH / 2 + 2, 282, RH - 4, 'rgba(255,255,255,0.92)');
        const ink = me ? '#11131a' : '#fff';
        text(String(pos + 1), 62, yy, 19, ink, 'center');
        g.fillStyle = hex(src.cars[c].team.color); g.fillRect(x + 82 * s, y + (yy - 10) * s, 4 * s, 20 * s);
        text(String(src.cars[c].team.name ?? '').slice(0, 3).toUpperCase(), 96, yy, 19, ink);
        let gap = '';
        if (q.flags & 1) gap = 'OUT';
        else if (q.flags & 4) gap = 'PIT';
        else if (pos === 0) gap = 'LEADER';
        else { const A = src.states[order[pos - 1]]; gap = `+${((A.progress - q.progress) / Math.max(q.vf, 10)).toFixed(3)}`; }
        text(gap, 304, yy, 17, me ? '#11131a' : dim, 'right', 600);
      });
    }
    // ---- dash, bottom right: shift lights, rev bar, gear, speed ----
    const v = Math.abs(st.vf), gb = gearbox(v, this.car.gearbox), [r0, r1] = this.car.gearbox?.rpm ?? [4000, 12000];
    const f = clamp((gb.rpm - r0) / Math.max(r1 - r0, 1), 0, 1), dx = W - 32 - 330, dy = 1080 - 32 - 186;
    box(dx, dy, 330, 186);
    const lit = Math.round(clamp((f - 0.5) / 0.46, 0, 1) * 15);
    for (let k = 0; k < 15; k++) {
      g.fillStyle = k >= lit ? 'rgba(255,255,255,0.13)' : k < 5 ? '#22d36b' : k < 10 ? '#ff3b3b' : '#3b8bff';
      g.beginPath(); g.arc(x + (dx + 25 + k * 20) * s, y + (dy + 24) * s, 6.5 * s, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.13)'; g.fillRect(x + (dx + 20) * s, y + (dy + 44) * s, 290 * s, 5 * s);
    g.fillStyle = f > 0.92 ? '#ff3b3b' : '#fff'; g.fillRect(x + (dx + 20) * s, y + (dy + 44) * s, 290 * f * s, 5 * s);
    text(gb.gear, dx + 90, dy + 118, 108, '#fff', 'center', 800);
    text(String(Math.round(v * 3.6)), dx + 245, dy + 104, 58, '#fff', 'center', 800);
    text('km/h', dx + 245, dy + 146, 20, dim, 'center', 600);
    g.restore();
  }

  // ---------- sound: the engine of the car on camera ----------
  noise(t, edit) {
    const k = this.cutAt(edit, t), car = edit[k]?.focus ?? 0, v = this.src.speedOf(car, t), a = (this.src.speedOf(car, t + 0.15) - v) / 0.15;
    const gb = gearbox(v, this.car.gearbox);
    return { rpm: gb.rpm, gear: gb.gear, throttle: a > 0.4 ? 1 : a > -3 ? 0.2 : 0, brake: a < -6 ? 1 : 0, speed: v, slip: 0, surface: 'road', hit: 0, ers: '' };
  }
  // the part's engine sound, made faster than real time (the game's engine, played into an OfflineAudioContext)
  async offlineSound(part, edit) {
    const rate = 48000, time = Math.max(0.1, part.b - part.a), ctx = new OfflineAudioContext(2, Math.ceil(time * rate), rate), eng = new EngineAudio(), step = 1 / 60;
    eng.setCar(this.car); eng.start(ctx); await eng.loaded;
    eng.update(this.noise(part.a, edit));
    for (let t = step; t < time; t += step) ctx.suspend(t).then(() => { eng.update(this.noise(part.a + t, edit)); ctx.resume(); });
    return ctx.startRendering();
  }

  // ---------- saving ----------
  // WebCodecs → .mp4 (H.264) or .webm (VP9), frame-exact whatever speed it renders at; written into the folder you
  // picked as it goes, or kept in memory until it's downloaded
  async encoder(W, H, fps, part, edit, opts, canvas = this.renderer.domElement) {
    const bitrate = Math.round(W * H * fps * CINEMA.bitrate);
    let codec = 'avc', mp4 = true;
    if (!(await canEncodeVideo('avc', { width: W, height: H, bitrate }))) {
      if (await canEncodeVideo('vp9', { width: W, height: H, bitrate })) { codec = 'vp9'; mp4 = false; }
      else throw new Error(`this browser can't encode ${H}p video, try a smaller size`);
    }
    const file = `${opts.name}.${mp4 ? 'mp4' : 'webm'}`;
    let target, handle = null;
    if (opts.dir) {
      handle = await opts.dir.getFileHandle(file, { create: true });
      target = new StreamTarget(await handle.createWritable(), { chunked: true, chunkSize: 8 * 2 ** 20 });
    } else target = new BufferTarget();
    const output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: opts.dir ? false : 'in-memory' }) : new WebMOutputFormat(), target });
    const source = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: fps });
    const acodec = !this.sound ? null : mp4 && (await canEncodeAudio('aac')) ? 'aac' : (await canEncodeAudio('opus')) ? 'opus' : null;
    const audio = acodec ? new AudioBufferSource({ codec: acodec, bitrate: QUALITY_HIGH }) : null;
    if (audio) output.addAudioTrack(audio);
    await output.start();
    if (audio) { $('cin-progress').textContent = `Making the engine sound for ${opts.label}…`; await audio.add(await this.offlineSound(part, edit)); }
    return {
      add: (i) => source.add(i / fps, 1 / fps),
      finish: async () => {
        await output.finalize();
        return opts.dir ? { file } : { blob: new Blob([target.buffer], { type: mp4 ? 'video/mp4' : 'video/webm' }), file };
      },
      cancel: async () => { await output.cancel(); if (handle) await opts.dir.removeEntry(file).catch(() => {}); },
    };
  }
  // no WebCodecs: record the canvas live (.webm), one part at a time
  recorder(canvas = this.renderer.domElement) {
    const type = ['video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const r = new MediaRecorder(canvas.captureStream(CINEMA.fps), { mimeType: type, videoBitsPerSecond: 25e6 });
    const parts = []; r.ondataavailable = (e) => parts.push(e.data); r.start(1000);
    return { finish: (name) => new Promise((done) => { r.onstop = () => done({ blob: new Blob(parts, { type: 'video/webm' }), file: `${name}.webm` }); r.stop(); }) };
  }
  download({ blob, file }) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
}

// A car's size in its own frame (for the cameras fixed to it), measured once
function localBox(model) {
  if (model.userData.cinBox) return model.userData.cinBox;
  const p = model.position.clone(), r = model.rotation.clone();
  model.position.set(0, 0, 0); model.rotation.set(0, 0, 0); model.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(model);
  model.position.copy(p); model.rotation.copy(r); model.updateMatrixWorld(true);
  if (b.isEmpty()) b.set(new THREE.Vector3(-1, 0, -2.5), new THREE.Vector3(1, 1, 2.5));
  return (model.userData.cinBox = b);
}