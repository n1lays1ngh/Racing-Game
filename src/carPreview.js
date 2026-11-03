// The turning 3D models on the menu's car cards (menu.js): each card has a <canvas>, and one small renderer of its own
// draws each car in turn and copies the picture onto its card. Only while the car page is showing; leaving it frees
// everything (the renderer, its copy of the models' textures), so the game itself never pays for it.
//
//   const previews = new CarPreviews()
//   previews.show([{ canvas, car, team }, …], pickedId)   the cards on screen now (a category's cars)
//   previews.pick(id)                                     the picked one turns a little faster, and is drawn every frame
//   previews.start() / previews.stop()                    the car page shown / left
//
// A car's model loads the first time its card shows (carModel.js; usually already loaded for the car you drive). Until
// then a car shows the built-in body; a bike shows nothing (the built-in body is a car).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadCarModel, createCarModel, modelReady } from './carModel.js';
import { IS_MOBILE } from './mobile/detect.js';

export const PREVIEW = {
  fps: IS_MOBILE ? 24 : 30, // frames a second for the picked car (the others: every other frame; on a phone, still)
  spin: 0.35,               // rad/s the cards turn …
  pickedSpin: 0.6,          // … and the picked one
  pixelRatio: 1.5,          // the most screen pixels per CSS pixel it draws (sharp enough, not costly)
  tilt: 0.3,                // rad: how far above the car the camera looks down from
  fill: 0.92,               // how much of the card the car fills
};

export class CarPreviews {
  // visible(): is the car page on screen right now (the menu showing, on that page)? While it isn't, nothing's drawn,
  // and after a few seconds the renderer is let go (made again when the page shows)
  constructor(visible = () => true) {
    this.visible = visible; this.away = null;
    this.items = []; this.picked = null; this.running = false; this.raf = 0; this.last = 0; this.frame = 0;
    this.models = new Map(); // car id → { model, center, radius, ready }
    this.renderer = null;
  }

  setup() {
    if (this.renderer) return true;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: true });
    } catch { return false; } // (no WebGL for a second canvas: the cards just have no picture)
    const r = this.renderer;
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
    r.setScissorTest(true);
    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
    this.scene.environment = this.envTex;
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(4, 6, 5); this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x202020, 0.6));
    this.camera = new THREE.PerspectiveCamera(26, 1.6, 0.05, 100);
    this.holder = new THREE.Group(); this.scene.add(this.holder);
    return true;
  }

  // the cards on screen now
  show(items, picked) {
    this.items = items.map((it) => ({ ...it, angle: it.angle ?? Math.random() * Math.PI * 2, drawn: false }));
    this.picked = picked;
    if (this.running) for (const it of this.items) this.entry(it.car);
  }
  pick(id) { this.picked = id; }

  start() {
    if (this.running) return;
    if (!this.setup()) return;
    this.running = true; this.last = 0; this.away = null;
    for (const it of this.items) this.entry(it.car);
    const loop = (t) => { if (!this.running) return; this.raf = requestAnimationFrame(loop); this.tick(t); };
    this.raf = requestAnimationFrame(loop);
  }

  // left the car page: everything let go (the next start makes it again)
  stop() {
    this.running = false; cancelAnimationFrame(this.raf);
    this.release();
  }
  release() {
    if (!this.renderer) return;
    for (const e of this.models.values()) if (e.model) this.holder?.remove(e.model);
    this.models.clear();
    this.envTex?.dispose(); this.envTex = null;
    if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss?.(); this.renderer = null; }
    for (const it of this.items) it.drawn = false;
  }

  // a car's model for the cards (made once while the page shows; its file loaded if it isn't yet)
  entry(car) {
    let e = this.models.get(car.id);
    if (!e) { e = { model: null, center: new THREE.Vector3(), radius: 1, height: 1, ready: false, loading: false }; this.models.set(car.id, e); }
    if (e.ready) return e;
    const make = () => createCarModel(car.preview ?? { color: 0xe10600, accent: 0xffffff }, { player: true, car });
    if (modelReady(car) || !car.model?.url) { this.place(e, make()); e.ready = true; return e; }
    if (!e.model && !car.bike) this.place(e, make()); // (the built-in body meanwhile: a car's, so not for a bike)
    if (!e.loading) {
      e.loading = true;
      loadCarModel(car.model).then(() => { for (const it of this.items) if (it.car === car) it.drawn = false; }); // (swapped in next frame)
    }
    return e;
  }
  place(e, model) {
    if (e.model) this.holder.remove(e.model);
    e.model = model;
    if (!model) return;
    model.visible = false; this.holder.add(model);
    model.rotation.set(0, 0, 0); model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    model.traverse((o) => { // (only what's drawn: the far copies and hidden parts don't count)
      if (!o.isMesh) return;
      for (let p = o; p; p = p.parent) if (!p.visible && p !== model) return;
      box.expandByObject(o);
    });
    if (box.isEmpty()) box.setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(e.center);
    e.radius = Math.hypot(size.x, size.z) / 2 || 1; // (how far it reaches as it turns)
    e.height = size.y || 1;
  }

  tick(t) {
    if (document.hidden || !this.visible()) { // (not on screen: draw nothing, and soon let the renderer go)
      this.last = t;
      if (this.away == null) this.away = t; else if (t - this.away > 4000) this.release();
      return;
    }
    this.away = null;
    if (!this.renderer && !this.setup()) return;
    if (this.last && t - this.last < 1000 / PREVIEW.fps - 2) return;
    const dt = this.last ? Math.min((t - this.last) / 1000, 0.1) : 0;
    this.last = t; this.frame++;
    const r = this.renderer, dpr = Math.min(window.devicePixelRatio || 1, PREVIEW.pixelRatio);
    // the renderer's canvas: as big as the biggest card (each card draws into its corner of it)
    let W = 1, H = 1;
    const live = this.items.filter((it) => it.canvas.isConnected && it.canvas.clientWidth > 0);
    for (const it of live) { W = Math.max(W, Math.round(it.canvas.clientWidth * dpr)); H = Math.max(H, Math.round(it.canvas.clientHeight * dpr)); }
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== W || size.y !== H) { r.setPixelRatio(1); r.setSize(W, H, false); for (const it of live) it.drawn = false; }
    for (const it of live) {
      const picked = it.car.id === this.picked;
      it.angle += dt * (picked ? PREVIEW.pickedSpin : PREVIEW.spin);
      // which cards to draw this frame: the picked one always; the others every other frame (on a phone: once)
      if (!picked && it.drawn && (IS_MOBILE || (this.frame + live.indexOf(it)) % 2)) continue;
      const e = this.entry(it.car);
      const w = Math.round(it.canvas.clientWidth * dpr), h = Math.round(it.canvas.clientHeight * dpr);
      if (it.canvas.width !== w || it.canvas.height !== h) { it.canvas.width = w; it.canvas.height = h; }
      const ctx = it.ctx ??= it.canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      if (!e.model) continue;
      for (const o of this.holder.children) o.visible = o === e.model;
      e.model.rotation.y = it.angle;
      // the camera: far enough back for the car to fill the card at any angle, a little above it
      const cam = this.camera, tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2), aspect = w / h, tanH = tanV * aspect;
      const across = e.radius / tanH, up = (e.height / 2 + e.radius * Math.sin(PREVIEW.tilt) * 0.6) / tanV;
      const d = Math.max(across, up) / PREVIEW.fill + e.radius * 0.35;
      cam.aspect = aspect; cam.updateProjectionMatrix();
      cam.position.set(0, e.center.y + Math.sin(PREVIEW.tilt) * d, Math.cos(PREVIEW.tilt) * d);
      cam.lookAt(0, e.center.y * 0.9, 0);
      r.setViewport(0, 0, w, h); r.setScissor(0, 0, w, h);
      r.clear();
      r.render(this.scene, cam);
      ctx.drawImage(r.domElement, 0, H - h, w, h, 0, 0, w, h); // (the drawing's at the bottom left of the renderer's canvas)
      it.drawn = picked ? false : e.ready;
    }
  }
}