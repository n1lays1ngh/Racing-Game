// Looking behind you:
//   • a rear-view mirror strip at the top of the screen (V toggles it)
//   • hold Q to swing the main camera round and look back over the car
// Self-contained: main.js calls render() after drawing each frame and asks
// lookBackTarget() for the camera while Q is held.
import * as THREE from 'three';
import { GRAPHICS } from './settings.js';

// The mirror's image. three.js draws into an ordinary render target in different colours from the screen (no tone
// mapping, linear colour), and switches every object's shader to match, then back for the screen: twice a frame for
// everything in the mirror, which costs time every frame. Marked like a VR headset's target, three.js draws into it
// exactly as it draws the screen (tone mapped, sRGB), so the same shaders serve both. The pixels are stored as they
// are (RGBA8), and copied to the screen as they are.
function mirrorTarget(samples) {
  const t = new THREE.WebGLRenderTarget(4, 1, { samples });
  t.isXRRenderTarget = true;
  t.texture.colorSpace = THREE.SRGBColorSpace; t.texture.internalFormat = 'RGBA8';
  return t;
}

const ME = new THREE.Euler(0, 0, 0, 'YXZ'), MQ = new THREE.Quaternion(), MB = new THREE.Vector3(), ML = new THREE.Vector3();

export class RearView {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = GRAPHICS.mirror ?? true; // mirror strip on/off (V); the graphics preset sets it at the start
    this.lookBack = false; // Q held
    this.visible = false;

    this.cam = new THREE.PerspectiveCamera(55, 4, 0.3, 4000);
    this.target = mirrorTarget(GRAPHICS.mirrorSamples ?? 4);
    // The mirror image is copied, flipped left to right (mirrors swap left and right), over the top of the screen, as it
    // is: it's already in the screen's colours
    this.hudScene = new THREE.Scene();
    this.hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { map: { value: this.target.texture } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = vec2(1.0 - uv.x, uv.y); gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }',
      depthTest: false, depthWrite: false,
    }));
    quad.frustumCulled = false;
    this.hudScene.add(quad);
    this.quad = quad;

    // Frame drawn around the mirror, and a rule that moves the lap timer below it.
    this.frame = document.createElement('div');
    Object.assign(this.frame.style, {
      position: 'fixed', display: 'none', pointerEvents: 'none', zIndex: 5, boxSizing: 'border-box',
      border: '4px solid #15171c', borderRadius: '12px', boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
    });
    document.body.appendChild(this.frame);
    this.css = document.createElement('style');
    document.head.appendChild(this.css);
    this.size = '';

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyV' && !e.repeat) this.enabled = !this.enabled;
      if (e.code === 'KeyQ') this.lookBack = true;
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'KeyQ') this.lookBack = false; });
    window.addEventListener('blur', () => { this.lookBack = false; });
  }

  layout() {
    const W = window.innerWidth, H = window.innerHeight;
    if (this.size === `${W}x${H}`) return;
    this.size = `${W}x${H}`;
    const w = Math.round(Math.min(520, W * 0.36)), h = Math.round(w / 4);
    this.rect = { x: Math.round((W - w) / 2), y: 12, w, h };
    Object.assign(this.frame.style, { left: `${this.rect.x - 4}px`, top: `${this.rect.y - 4}px`, width: `${w + 8}px`, height: `${h + 8}px` });
    const dpr = this.renderer.getPixelRatio() * (GRAPHICS.mirrorScale ?? 1); // lower = cheaper mirror
    this.target.setSize(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)));
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    this.css.textContent = `body.mirror-on .timing { top: ${h + 26}px; } body.mirror-on #lights { top: ${h + 130}px; }`;
  }

  setVisible(v) {
    this.visible = v;
    this.frame.style.display = v ? 'block' : 'none';
    document.body.classList.toggle('mirror-on', v);
  }

  hide() { this.setVisible(false); }

  // A graphics preset was picked (settings.js): mirror on/off, its resolution and edge smoothing.
  applyGraphics() {
    this.enabled = GRAPHICS.mirror ?? true;
    const samples = GRAPHICS.mirrorSamples ?? 4;
    if (this.target.samples !== samples) { // edge smoothing is part of the render target: make a new one
      this.target.dispose();
      this.target = mirrorTarget(samples);
      this.quad.material.uniforms.map.value = this.target.texture;
    }
    this.cam.far = Math.min(4000, GRAPHICS.viewDistance ?? 4000); this.cam.updateProjectionMatrix();
    this.size = ''; // size it again on the next frame (resolution may have changed)
  }

  // Draw the mirror for this car (call after the main render each frame).
  render(scene, state) {
    const show = this.enabled && !this.lookBack;
    if (show !== this.visible) this.setVisible(show);
    if (!show) return;
    this.layout();

    // Camera just behind the rear wing, looking back down the track; it turns, pitches and leans with the car
    MQ.setFromEuler(ME.set(-(state.pitch ?? 0), state.h, state.roll ?? 0));
    MB.set(state.x, state.y ?? 0, state.z);
    this.cam.position.set(0, 1.05, -3.1).applyQuaternion(MQ).add(MB);
    this.cam.up.set(0, 1, 0).applyQuaternion(MQ);
    this.cam.lookAt(ML.set(0, 0.5, -40).applyQuaternion(MQ).add(MB));

    const r = this.renderer;
    const shadows = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false; // reuse this frame's shadows
    r.setRenderTarget(this.target);
    r.render(scene, this.cam);
    r.setRenderTarget(null);
    r.shadowMap.autoUpdate = shadows;

    const { x, y: top, w, h } = this.rect, H = window.innerHeight;
    r.autoClear = false;
    r.setViewport(x, H - top - h, w, h); r.setScissor(x, H - top - h, w, h); r.setScissorTest(true);
    r.clearDepth();
    r.render(this.hudScene, this.hudCam);
    r.setScissorTest(false); r.setViewport(0, 0, window.innerWidth, window.innerHeight);
    r.autoClear = true;
  }

  // (Not used any more: main.js places the look-back camera with the others, so it leans with the car too.)
  lookBackTarget(state, out, look) {
    const fx = Math.sin(state.h), fz = Math.cos(state.h), y = state.y ?? 0, sp = Math.sin(state.pitch ?? 0);
    out.set(state.x + fx * 7.5, y + 2.6 + sp * 7.5, state.z + fz * 7.5);
    look.set(state.x - fx * 8, y + 0.9 - sp * 8, state.z - fz * 8);
  }
}