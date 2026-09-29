// Name tags over your friends' cars in an online race: their colour, name and race position.
// Plain HTML placed over the 3D view, so the text stays sharp.
import * as THREE from 'three';

export const TAGS = {
  height: 1.6,      // metres above the car
  maxDistance: 400, // hide further away than this
  fadeFrom: 250,    // start fading out here
};

const v = new THREE.Vector3();
const hex = (c) => '#' + c.toString(16).padStart(6, '0');

export class NameTags {
  constructor(parent = document.getElementById('hud')) {
    this.root = document.createElement('div');
    this.root.id = 'nametags';
    parent.prepend(this.root); // under the HUD panels
    this.tags = [];
  }

  setup(race) {
    this.clear();
    for (const car of race.cars) {
      if (!car.isHuman || car.isPlayer) continue;
      const el = document.createElement('div');
      el.className = 'ntag';
      el.innerHTML = `<i style="background:${hex(car.team.color)}"></i><span></span><b></b>`;
      el.querySelector('span').textContent = car.team.name;
      this.root.appendChild(el);
      this.tags.push({ car, el, pos: el.querySelector('b'), shown: false, p: 0 });
    }
  }

  update(camera) {
    if (!this.tags.length) return;
    camera.updateMatrixWorld(); // this frame's camera, not last frame's (else the tags wobble)
    const w = window.innerWidth, h = window.innerHeight;
    for (const t of this.tags) {
      const s = t.car.state;
      v.set(s.x, (s.y ?? 0) + TAGS.height, s.z);
      const d = camera.position.distanceTo(v);
      v.project(camera);
      const show = !t.car.dnf && d < TAGS.maxDistance && v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      if (!show) { if (t.shown) { t.el.style.opacity = '0'; t.shown = false; } continue; }
      const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
      const scale = Math.min(1, Math.max(0.6, 1.15 - d / 260));
      t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
      t.el.style.opacity = d > TAGS.fadeFrom ? ((TAGS.maxDistance - d) / (TAGS.maxDistance - TAGS.fadeFrom)).toFixed(2) : '1';
      if (t.p !== t.car.position) { t.p = t.car.position; t.pos.textContent = 'P' + t.p; }
      t.shown = true;
    }
  }

  clear() { this.root.innerHTML = ''; this.tags = []; }
}