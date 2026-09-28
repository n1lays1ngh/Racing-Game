// Looking behind you:
//   • a rear-view mirror strip at the top of the screen (V toggles it)
//   • hold Q to swing the main camera round and look back over the car
// Self-contained: main.js calls render() after drawing each frame and asks
// lookBackTarget() for the camera while Q is held.
import * as THREE from 'three';

export class RearView {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;   // mirror strip on/off (V)
    this.lookBack = false; // Q held
    this.visible = false;

    this.cam = new THREE.PerspectiveCamera(55, 4, 0.3, 4000);
    this.target = new THREE.WebGLRenderTarget(4, 1, { samples: 4 });
    // The mirror image is drawn as a flipped quad over the top of the screen.
    this.hudScene = new THREE.Scene();
    this.hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({
      map: this.target.texture, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    }));
    quad.scale.x = -1; // mirrors swap left and right
    this.hudScene.add(quad);

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
    const dpr = this.renderer.getPixelRatio();
    this.target.setSize(Math.round(w * dpr), Math.round(h * dpr));
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    this.css.textContent = `body.mirror-on .timing { top: ${h + 26}px; } body.mirror-on #lights { top: ${h + 130}px; }`;
  }

  setVisible(v) {
    this.visible = v;
    this.frame.style.display = v ? 'block' : 'none';
    document.body.classList.toggle('mirror-on', v);
  }

  hide() { this.setVisible(false); }

  // Draw the mirror for this car (call after the main render each frame).
  render(scene, state) {
    const show = this.enabled && !this.lookBack;
    if (show !== this.visible) this.setVisible(show);
    if (!show) return;
    this.layout();

    // Camera just behind the rear wing, looking back down the track
    const fx = Math.sin(state.h), fz = Math.cos(state.h), y = state.y ?? 0, sp = Math.sin(state.pitch ?? 0);
    this.cam.position.set(state.x - fx * 3.1, y + 1.05 - sp * 3.1, state.z - fz * 3.1);
    this.cam.lookAt(state.x - fx * 40, y + 0.5 - sp * 40, state.z - fz * 40);

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

  // Camera while Q is held: in front of the car, looking back over it.
  lookBackTarget(state, out, look) {
    const fx = Math.sin(state.h), fz = Math.cos(state.h), y = state.y ?? 0, sp = Math.sin(state.pitch ?? 0);
    out.set(state.x + fx * 7.5, y + 2.6 + sp * 7.5, state.z + fz * 7.5);
    look.set(state.x - fx * 8, y + 0.9 - sp * 8, state.z - fz * 8);
  }
}
