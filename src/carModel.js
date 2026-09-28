// Procedural open-wheel car built from primitives (nose faces +Z).
// Swap this for a Blender .glb later with GLTFLoader if you like.
import * as THREE from 'three';

function taperedBox(wBack, hBack, wFront, hFront, length, material) {
  const g = new THREE.BoxGeometry(1, 1, length, 1, 1, 4);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const f = (pos.getZ(i) + length / 2) / length; // 0 at back, 1 at front
    const w = wBack + (wFront - wBack) * f, h = hBack + (hFront - hBack) * f;
    pos.setX(i, pos.getX(i) * w);
    pos.setY(i, (pos.getY(i) + 0.5) * h); // bottom stays flat at y = 0
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  return m;
}

function numberTexture(num, color) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#' + new THREE.Color(color).getHexString(); x.fillRect(0, 0, 128, 128);
  x.fillStyle = '#fff'; x.beginPath(); x.arc(64, 64, 50, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#111'; x.font = 'bold 64px system-ui, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(num), 64, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createCarModel({ color = 0xe10600, accent = 0xffffff, number = 1 } = {}) {
  const car = new THREE.Group();
  car.rotation.order = 'YXZ'; // yaw first, then pitch in the car's own frame
  const body = new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.3 });
  const accentMat = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.4 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.3, roughness: 0.55 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.95 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, metalness: 0.9, roughness: 0.25 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0xffd400, metalness: 0.2, roughness: 0.25 });

  // Floor / plank
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 3.6), carbon);
  floor.position.set(0, 0.1, -0.2); floor.castShadow = true; car.add(floor);

  // Monocoque + nose
  const tub = taperedBox(0.85, 0.62, 0.62, 0.5, 2.6, body); tub.position.set(0, 0.12, 0.1); car.add(tub);
  const nose = taperedBox(0.6, 0.48, 0.18, 0.18, 1.9, body); nose.position.set(0, 0.16, 2.3); car.add(nose);
  const noseTip = taperedBox(0.18, 0.18, 0.12, 0.1, 0.4, accentMat); noseTip.position.set(0, 0.18, 3.4); car.add(noseTip);

  // Sidepods
  for (const s of [-1, 1]) {
    const pod = taperedBox(0.4, 0.45, 0.5, 0.5, 1.8, body);
    pod.position.set(s * 0.62, 0.12, -0.35); car.add(pod);
    const inlet = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.34, 0.05), carbon);
    inlet.position.set(s * 0.62, 0.38, 0.56); car.add(inlet);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 1.2), accentMat);
    stripe.position.set(s * 0.875, 0.42, -0.3); car.add(stripe);
    const num = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34),
      new THREE.MeshStandardMaterial({ map: numberTexture(number, color), roughness: 0.5 }));
    num.position.set(s * 0.88, 0.36, 0.25); num.rotation.y = s * Math.PI / 2; car.add(num);
  }

  // Engine cover / airbox
  const cover = taperedBox(0.3, 0.55, 0.62, 0.95, 2.2, body); cover.position.set(0, 0.12, -1.35); car.add(cover);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.35, 1.2), accentMat);
  fin.position.set(0, 0.9, -1.55); car.add(fin);

  // Cockpit, driver, halo
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.8), new THREE.MeshStandardMaterial({ color: 0x050505 }));
  cockpit.position.set(0, 0.7, 0.35); car.add(cockpit);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 14), helmetMat);
  helmet.position.set(0, 0.8, 0.2); helmet.castShadow = true; car.add(helmet);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.05), new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.8, roughness: 0.1 }));
  visor.position.set(0, 0.83, 0.36); car.add(visor);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 8, 24, Math.PI), carbon);
  halo.rotation.x = -Math.PI / 2; halo.rotation.z = Math.PI; halo.position.set(0, 0.98, 0.3); car.add(halo);
  const haloStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.42, 8), carbon);
  haloStrut.position.set(0, 0.82, 0.68); haloStrut.rotation.x = 0.5; car.add(haloStrut);

  // Front wing
  const fw = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.04, 0.5), accentMat);
  fw.position.set(0, 0.12, 3.35); fw.castShadow = true; car.add(fw);
  const fw2 = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.03, 0.22), body);
  fw2.position.set(0, 0.2, 3.2); fw2.rotation.x = -0.25; car.add(fw2);
  for (const s of [-1, 1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.26, 0.6), carbon);
    ep.position.set(s * 0.98, 0.2, 3.32); car.add(ep);
  }

  // Rear wing
  const rw = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.38), body);
  rw.position.set(0, 0.98, -2.45); rw.rotation.x = 0.15; rw.castShadow = true; car.add(rw);
  const rw2 = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.03, 0.2), accentMat);
  rw2.position.set(0, 1.08, -2.62); rw2.rotation.x = 0.4; car.add(rw2);
  for (const s of [-1, 1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.55, 0.55), carbon);
    ep.position.set(s * 0.52, 0.85, -2.5); ep.castShadow = true; car.add(ep);
  }
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 0.2), carbon);
  pylon.position.set(0, 0.72, -2.45); car.add(pylon);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.18, 0.4), carbon);
  diffuser.position.set(0, 0.2, -2.35); diffuser.rotation.x = -0.3; car.add(diffuser);
  // Rain light
  const rainLight = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.03),
    new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff0000, emissiveIntensity: 0.4 }));
  rainLight.position.set(0, 0.42, -2.58); car.add(rainLight);

  // Wheels: steer pivot (front only) → spinning wheel
  const wheels = [], steerPivots = [];
  const makeWheel = (x, z, r, w, front) => {
    const pivot = new THREE.Group(); pivot.position.set(x, r, z); car.add(pivot);
    const wheel = new THREE.Group(); pivot.add(wheel);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 28), tyre);
    t.rotation.z = Math.PI / 2; t.castShadow = true; wheel.add(t);
    const side = Math.sign(x);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.02, 20), rim);
    disc.rotation.z = Math.PI / 2; disc.position.x = side * (w / 2 + 0.005); wheel.add(disc);
    for (let k = 0; k < 5; k++) { // spokes make the spin visible
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, r * 1.1, 0.05), accentMat);
      spoke.position.x = side * (w / 2 + 0.015); spoke.rotation.x = (k / 5) * Math.PI; wheel.add(spoke);
    }
    const band = new THREE.Mesh(new THREE.TorusGeometry(r * 0.8, 0.012, 6, 32), new THREE.MeshBasicMaterial({ color: 0xffd400 }));
    band.rotation.y = Math.PI / 2; band.position.x = side * (w / 2 + 0.002); wheel.add(band);
    // wishbones
    for (const dy of [-0.08, 0.1]) {
      const len = Math.abs(x) - 0.35;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, len, 6), carbon);
      arm.rotation.z = Math.PI / 2; arm.position.set(x - side * (len / 2 + 0.12), r + dy, z); car.add(arm);
    }
    wheels.push(wheel); if (front) steerPivots.push(pivot);
  };
  makeWheel(-0.85, 2.15, 0.36, 0.38, true);
  makeWheel(0.85, 2.15, 0.36, 0.38, true);
  makeWheel(-0.82, -1.75, 0.37, 0.46, false);
  makeWheel(0.82, -1.75, 0.37, 0.46, false);

  car.userData = { wheels, steerPivots, rainLight };
  return car;
}

// Called every frame with the physics state.
export function syncCarModel(model, state) {
  model.position.set(state.x, 0, state.z);
  model.rotation.y = state.h;
  const { wheels, steerPivots } = model.userData;
  for (const w of wheels) w.rotation.x = state.wheelSpin;
  for (const p of steerPivots) p.rotation.y = state.steer * 1.4;
  // A little body pitch/roll sells the weight transfer
  model.rotation.x = state.brake * 0.012 - state.throttle * 0.006;
}
