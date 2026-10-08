// Cinematic replay: your best lap at a circuit in a car (the ghost lap, ghost.js) filmed like a broadcast, to watch or
// to save as a video. Main menu → Cinematic replay (for the car and circuit picked in the menu).
//
//   Watch         plays it live with the current graphics
//   Record video  renders it frame by frame at the size you pick with the High graphics preset and saves an .mp4.
//                 It doesn't have to keep up with real time: a slow computer just takes longer, and the video still
//                 plays smoothly at CINEMA.fps (WebCodecs, via Mediabunny; where the browser hasn't got it, it records live, .webm)
//
// The director cuts between trackside telephoto shots, low chase, tracking, front-on, helicopter and onboard
// cameras every few seconds (SHOTS below). Take: take 1 is SHOTS in order; every take has its own shot order, cut
// timing and camera spots, and the same take always gives the same edit. Racing line: drawn on the track, or not.
// Sound: the car's engine (audio.js, its own sound settings), from the lap's speed: gear and revs from the car's
// gearbox, throttle and brake from speeding up and slowing down. Live when you watch; in a recording it's made
// offline in step with the frames and saved in the .mp4 (not in the live .webm fallback).
import * as THREE from 'three';
import { createCarModel, loadCarModel, syncCarModel, carCams } from './carModel.js';
import { loadGhost } from './ghost.js';
import { projectOnTrack, pointAt, sampleAt } from './track.js';
import { formatTime } from './race.js';
import { buildSpeedProfile } from './ai.js';
import { buildRacingLine, disposeRacingLine } from './racingLine.js';
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, canEncodeVideo, canEncodeAudio, QUALITY_HIGH } from 'mediabunny';
import { EngineAudio } from './audio.js';
import { gearbox } from './physics.js';

export const CINEMA = { fps: 60, shot: [3.5, 6], bitrate: 0.16 }; // bitrate: bits per pixel per frame
const SHOTS = ['trackside', 'low', 'side', 'trackside', 'heli', 'front', 'tcam', 'trackside', 'chase'];
const SIZES = { 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };
const F = 9; // ghost samples: t, x, y, z, heading, pitch, roll, speed, steer
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Cinema {
  // hooks: { renderer, scene, camera, highGraphics() → restore(), onFrame(dt, state, model), onExit() }
  constructor(hooks) {
    Object.assign(this, hooks);
    this.active = false; this.mode = null; this.res = '1080'; this.take = 1; this.line = false; this.sound = true;
    this.st = { x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0, vf: 0, speed: 0, steer: 0, wheelSpin: 0, throttle: 1, brake: 0, gear: 4, rpm: 0 };
    this.v = { p: new THREE.Vector3(), q: new THREE.Vector3(), fwd: new THREE.Vector3(), left: new THREE.Vector3() };
    $('cin-watch').addEventListener('click', () => this.play(false));
    $('cin-rec').addEventListener('click', () => this.play(true));
    $('cin-back').addEventListener('click', () => this.close());
    const take = (d) => { this.take = Math.max(1, this.take + d); $('cin-take').textContent = this.take; };
    $('cin-take-prev').addEventListener('click', () => take(-1));
    $('cin-take-next').addEventListener('click', () => take(1));
    $('cin-line').addEventListener('click', () => { this.line = !this.line; $('cin-line').setAttribute('aria-checked', String(this.line)); });
    $('cin-sound').addEventListener('click', () => { this.sound = !this.sound; $('cin-sound').setAttribute('aria-checked', String(this.sound)); });
    $('cin-res').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { this.res = b.dataset.v; this.drawRes(); } });
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.code !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.mode) this.stop = true; else this.close();
    }, true);
    this.drawRes();
  }
  drawRes() { for (const b of $('cin-res').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === this.res); }

  // car: its file (src/cars/); track: the circuit on screen; team: your colours
  async open(car, track, team) {
    this.active = true; this.car = car; this.track = track; this.team = team;
    $('cinema').classList.remove('hidden', 'playing');
    $('cin-title').textContent = `${track.name}`;
    $('cin-status').textContent = 'Loading your best lap…';
    $('cin-watch').disabled = $('cin-rec').disabled = true;
    const [g] = await Promise.all([loadGhost(car.id, track.id), loadCarModel(car.model)]);
    if (!this.active) return;
    this.ghost = g;
    $('cin-sub').textContent = `${car.name}${g ? `  ·  best lap ${formatTime(g.time)}` : ''}`;
    $('cin-status').textContent = g ? 'Watch it, or record it as a video (Esc stops).'
      : `No best lap here in the ${car.name} yet: drive a clean lap (any offline race or practice) and it's kept for this.`;
    $('cin-watch').disabled = $('cin-rec').disabled = !g;
    (g ? $('cin-watch') : $('cin-back')).focus({ preventScroll: true });
  }
  close() {
    if (this.mode) { this.stop = true; return; }
    this.active = false;
    $('cinema').classList.add('hidden');
    this.onExit?.();
  }

  async play(record) {
    if (this.mode || !this.ghost) return;
    const { renderer, camera, scene } = this, g = this.ghost, fps = CINEMA.fps;
    this.mode = record ? 'record' : 'watch'; this.stop = false;
    $('cinema').classList.add('playing');
    this.model = createCarModel(this.team, { player: true, car: this.car });
    scene.add(this.model);
    // this take's edit: a random sequence seeded by the take number (take 1: SHOTS in order)
    let seed = this.take * 2654435761 >>> 0;
    this.rand = () => { seed = (seed + 0x6d2b79f5) >>> 0; let x = seed; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    this.order = SHOTS.slice();
    if (this.take > 1) for (let k = this.order.length - 1; k > 0; k--) { const j = Math.floor(this.rand() * (k + 1)); [this.order[k], this.order[j]] = [this.order[j], this.order[k]]; }
    const line = this.line ? buildRacingLine(this.track, buildSpeedProfile(this.track, 1, 0.97, 0.9, this.car.physics), this.car.physics) : null;
    if (line) scene.add(line);
    this.hint = -1; this.shotIndex = -1; this.cut(0);
    const fov = camera.fov, size = renderer.getSize(new THREE.Vector2()), ratio = renderer.getPixelRatio();
    let restore = null, enc = null, rec = null, out = null;
    try {
      if (record) {
        restore = this.highGraphics?.();
        const [W, H] = SIZES[this.res];
        renderer.setPixelRatio(1); renderer.setSize(W, H, false);
        camera.aspect = W / H; camera.updateProjectionMatrix();
        if (window.VideoEncoder) enc = await this.encoder(W, H, fps, this.sound);
        else rec = this.recorder();
      }
      const frames = Math.ceil(g.time * fps);
      let t = 0, last = performance.now();
      if (!record && this.sound) this.live?.start(this.car);
      for (let i = 0; !this.stop && t <= g.time; i++) {
        await new Promise((go) => requestAnimationFrame(go));
        const now = performance.now(), live = !enc; // (encoder: one lap frame per drawn frame, however long it takes)
        const dt = live ? Math.min((now - last) / 1000, 0.1) : 1 / fps; last = now;
        t = live ? t + dt : i / fps;
        this.frame(Math.min(t, g.time), dt);
        if (!record && this.sound) this.live?.update(this.noise(Math.min(t, g.time)));
        renderer.render(scene, camera);
        if (enc) {
          await enc.add(i); // (this frame, straight off the canvas; waits while the encoder catches up)
          $('cin-progress').textContent = `Recording ${Math.round((i / frames) * 100)}%  ·  Esc stops`;
        } else $('cin-progress').textContent = rec ? 'Recording live  ·  Esc stops' : 'Esc stops';
      }
      if (enc) out = await enc.finish();
      if (rec) out = await rec.finish();
      if (out && !this.stop) this.download(out);
    } catch (err) {
      console.warn('Cinematic replay:', err);
      $('cin-status').textContent = `Couldn't record: ${err.message ?? err}`;
    } finally {
      if (!record) this.live?.stop();
      scene.remove(this.model); this.model = null;
      if (line) { scene.remove(line); disposeRacingLine(line); }
      if (record) {
        renderer.setPixelRatio(ratio); renderer.setSize(size.x, size.y, false);
        camera.aspect = size.x / size.y; restore?.();
      }
      camera.fov = fov; camera.updateProjectionMatrix();
      $('cin-progress').textContent = '';
      $('cinema').classList.remove('playing');
      this.mode = null;
      if (out && !this.stop) $('cin-status').textContent = 'Saved. Record again at another size, or watch it.';
    }
  }

  // WebCodecs H.264 → .mp4 (Mediabunny), frame-exact whatever the frame rate it renders at; with the engine sound
  async encoder(W, H, fps, sound) {
    const bitrate = Math.round(W * H * fps * CINEMA.bitrate);
    if (!(await canEncodeVideo('avc', { width: W, height: H, bitrate }))) throw new Error(`this browser can't encode ${H}p video, try a smaller size`);
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const source = new CanvasSource(this.renderer.domElement, { codec: 'avc', bitrate, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: fps });
    const codec = !sound ? null : (await canEncodeAudio('aac')) ? 'aac' : (await canEncodeAudio('opus')) ? 'opus' : null;
    const audio = codec ? new AudioBufferSource({ codec, bitrate: QUALITY_HIGH }) : null;
    if (audio) output.addAudioTrack(audio);
    await output.start();
    if (audio) { $('cin-progress').textContent = 'Making the engine sound…'; await audio.add(await this.offlineSound(this.ghost.time)); }
    return {
      add: (i) => source.add(i / fps, 1 / fps),
      finish: async () => { await output.finalize(); return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), ext: 'mp4' }; },
    };
  }
  // the lap's engine sound, made faster than real time (the game's engine, played into an OfflineAudioContext)
  async offlineSound(time) {
    const rate = 48000, ctx = new OfflineAudioContext(2, Math.ceil(time * rate), rate), eng = new EngineAudio(), step = 1 / 60;
    eng.setCar(this.car); eng.start(ctx); await eng.loaded;
    eng.update(this.noise(0));
    for (let t = step; t < time; t += step) ctx.suspend(t).then(() => { eng.update(this.noise(t)); ctx.resume(); });
    return ctx.startRendering();
  }
  // what the engine is doing at lap time t: revs and gear from the speed, throttle and brake from how it changes
  noise(t) {
    const v = this.speedAt(t), a = (this.speedAt(t + 0.15) - v) / 0.15, gb = gearbox(v, this.car.gearbox);
    return { rpm: gb.rpm, gear: gb.gear, throttle: a > 0.4 ? 1 : a > -3 ? 0.2 : 0, brake: a < -6 ? 1 : 0, speed: v, slip: 0, surface: 'road', hit: 0, ers: '' };
  }
  speedAt(t) {
    const S = this.ghost.samples, n = S.length / F;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid * F] <= t) lo = mid; else hi = mid; }
    const f = clamp((t - S[lo * F]) / Math.max(S[hi * F] - S[lo * F], 1e-6), 0, 1);
    return S[lo * F + 7] + (S[hi * F + 7] - S[lo * F + 7]) * f;
  }
  // no WebCodecs: record the canvas live (.webm)
  recorder() {
    const type = ['video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const r = new MediaRecorder(this.renderer.domElement.captureStream(CINEMA.fps), { mimeType: type, videoBitsPerSecond: 25e6 });
    const parts = []; r.ondataavailable = (e) => parts.push(e.data); r.start(1000);
    return { finish: () => new Promise((done) => { r.onstop = () => done({ blob: new Blob(parts, { type: 'video/webm' }), ext: 'webm' }); r.stop(); }) };
  }
  download({ blob, ext }) {
    const a = document.createElement('a'), name = `${this.track.id}-${this.car.id}-${formatTime(this.ghost.time).replace(/[:.]/g, '-')}`;
    a.href = URL.createObjectURL(blob); a.download = `apex-circuit-${name}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ---- the car at lap time t, and the camera on it ----
  frame(t, dt) {
    const S = this.ghost.samples, n = S.length / F, st = this.st;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid * F] <= t) lo = mid; else hi = mid; }
    const a = lo * F, b = hi * F, f = clamp((t - S[a]) / Math.max(S[b] - S[a], 1e-6), 0, 1), mix = (k) => S[a + k] + (S[b + k] - S[a + k]) * f;
    st.x = mix(1); st.y = mix(2); st.z = mix(3);
    st.h = S[a + 4] + Math.atan2(Math.sin(S[b + 4] - S[a + 4]), Math.cos(S[b + 4] - S[a + 4])) * f;
    st.pitch = mix(5); st.roll = mix(6); st.vf = st.speed = mix(7); st.steer = mix(8);
    st.wheelSpin += (st.vf * dt) / 0.36;
    syncCarModel(this.model, st);
    const p = projectOnTrack(this.track, st.x, st.z, this.hint); this.hint = p.i; this.s = p.s;
    this.onFrame?.(dt, st, this.model);
    if ((this.shotTime += dt) > this.shotLength) this.cut(t);
    this.aim(dt);
  }
  cut() {
    this.shot = this.order[(this.shotIndex = (this.shotIndex + 1) % this.order.length)];
    if (this.shot === 'tcam' && !carCams(this.model)?.tcam) this.shot = 'chase';
    this.shotTime = 0; this.shotLength = CINEMA.shot[0] + this.rand() * (CINEMA.shot[1] - CINEMA.shot[0]);
    this.orbit = this.rand() * Math.PI * 2; this.snap = true;
    if (this.shot === 'trackside') { // a camera beside the track ahead of the car, outside the barrier on the outside of the bend
      const t = this.track, ahead = clamp(Math.abs(this.st.vf) * 2.4, 60, 180), s = (this.s ?? 0) + ahead, i = sampleAt(t, s);
      const side = Math.sign(t.curv[i]) ? -Math.sign(t.curv[i]) : 1;
      const at = pointAt(t, s, side * ((side > 0 ? t.wallL[i] : t.wallR[i]) + 2.5));
      this.fixed = new THREE.Vector3(at.x, (t.h ? t.h[i] : 0) + 1.5 + this.rand() * 3.5, at.z);
    }
  }
  aim(dt) {
    const { camera } = this, st = this.st, V = this.v, k = this.snap ? 1 : 1 - Math.exp(-dt * 6);
    V.fwd.set(Math.sin(st.h), 0, Math.cos(st.h)); V.left.set(Math.cos(st.h), 0, -Math.sin(st.h));
    const car = V.q.set(st.x, st.y + 0.6, st.z), at = (back, up, side) => V.p.set(st.x, st.y + up, st.z).addScaledVector(V.fwd, -back).addScaledVector(V.left, side);
    let fov = 50, pos = null, look = car;
    switch (this.shot) {
      case 'trackside': { pos = this.fixed; fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(3.4 / Math.max(camera.position.distanceTo(car), 1))), 7, 45); break; }
      case 'chase': pos = at(7.5, 1.7, 0); look = car.clone().addScaledVector(V.fwd, 10); fov = 55; break;
      case 'low': pos = at(4.6, 0.42, 1.3); look = car.clone().addScaledVector(V.fwd, 25); fov = 58; break;
      case 'side': pos = at(-1.5, 1.0, 7 * Math.sign(Math.cos(this.orbit))); fov = 38; break;
      case 'front': pos = at(-11, 0.75, 0.8); fov = 34; break;
      case 'heli': { this.orbit += dt * 0.12; pos = at(Math.cos(this.orbit) * 30, 17, Math.sin(this.orbit) * 30); fov = 38; break; }
      case 'tcam': {
        const c = carCams(this.model).tcam;
        pos = this.model.localToWorld(V.p.set(c.x ?? 0, c.y, c.z)); look = this.model.localToWorld(new THREE.Vector3(c.x ?? 0, c.y - 0.6, c.z + 20)); fov = 68;
        camera.position.copy(pos); camera.fov = fov; camera.updateProjectionMatrix(); camera.lookAt(look); this.snap = false; return;
      }
    }
    if (this.shot === 'trackside') camera.position.copy(pos); else camera.position.lerp(pos, this.snap ? 1 : k);
    camera.fov = fov; camera.updateProjectionMatrix();
    camera.lookAt(look);
    this.snap = false;
  }
}