// Time of day. Each circuit file can set  time: 'day' | 'dusk' | 'night'  (default 'day').
//   applyTimeOfDay() – sky, sun/floodlight, fog, exposure and reflections (called when a circuit loads)
//   buildFloodlights() – light towers along the track for dusk and night races
//   darkenAwayFromTrack() – at night, ground, trees and buildings fade to dark away from the lit track
// To tweak the look, change the numbers in TIMES.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { GRAPHICS } from './settings.js';

export const TIMES = {
  //        sun angle (from overhead, compass), light colour and strength, sky/ground fill light, fog, exposure, reflections
  day:   { phi: 58, theta: 210, sun: 0xfff2de, sunI: 2.6, hemiSky: 0xcfe6ff, hemiGround: 0x4a5a30, hemiI: 1.1,
           fog: 0xbfd4e6, fogNear: 300, fogFar: 3200, exposure: 0.9, env: 0.4, windows: 0 },
  dusk:  { phi: 87.5, theta: 250, sun: 0xffa45c, sunI: 1.6, hemiSky: 0x8f9fd0, hemiGround: 0x3a3226, hemiI: 0.7,
           fog: 0xcf9e86, fogNear: 250, fogFar: 2800, exposure: 1.0, env: 0.5, windows: 0.7, turbidity: 8, rayleigh: 2.6 },
  // At night the "sun" is the floodlighting: bright, white and from high above.
  night: { phi: 20, theta: 200, sun: 0xf4f6ff, sunI: 2.2, hemiSky: 0x6a7ab0, hemiGround: 0x1c1d22, hemiI: 0.55,
           fog: 0x060a14, fogNear: 220, fogFar: 2400, exposure: 1.1, env: 1.0, windows: 1.3 },
};

// ---------- sky ----------
function nightSkyTexture(city) {
  const w = 2048, h = 1024, c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#01020a'); g.addColorStop(0.35, '#060b1f');
  g.addColorStop(0.49, city ? '#2a2233' : '#101a36');  // city glow on the horizon
  g.addColorStop(0.52, '#07090f'); g.addColorStop(1, '#030407');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) {                        // stars
    const sy = Math.random() ** 1.6 * h * 0.47, b = Math.random();
    x.fillStyle = `rgba(255,255,255,${0.25 + b * 0.75})`;
    x.fillRect(Math.random() * w, sy, b > 0.93 ? 2 : 1, b > 0.93 ? 2 : 1);
  }
  const mx = w * 0.62, my = h * 0.2;                        // moon
  const mg = x.createRadialGradient(mx, my, 0, mx, my, 60);
  mg.addColorStop(0, 'rgba(255,250,235,1)'); mg.addColorStop(0.18, 'rgba(255,250,235,1)');
  mg.addColorStop(0.22, 'rgba(200,210,255,0.25)'); mg.addColorStop(1, 'rgba(200,210,255,0)');
  x.fillStyle = mg; x.fillRect(mx - 60, my - 60, 120, 120);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

// What shiny surfaces (the cars) reflect at night: the night sky plus banks of floodlights all round.
function floodlitEnv(skyTex) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide })));
  const ground = new THREE.Mesh(new THREE.CircleGeometry(100, 32), new THREE.MeshBasicMaterial({ color: 0x2a2c31 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -2; s.add(ground);
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.8, 5.4) }); // brighter than white: HDR
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2, bank = new THREE.Mesh(new THREE.PlaneGeometry(14, 5), lamp);
    bank.position.set(Math.cos(a) * 70, 30 + (k % 3) * 8, Math.sin(a) * 70); bank.lookAt(0, 0, 0); s.add(bank);
  }
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.5, 0.55) }));
  glow.position.y = 60; glow.rotation.x = Math.PI / 2; s.add(glow); // soft light from above
  return s;
}

const envCache = new Map();
function envFor(world, time, city) {
  const key = time + (city ? '-city' : '');
  if (envCache.has(key)) return envCache.get(key);
  const pmrem = new THREE.PMREMGenerator(world.renderer);
  let tex;
  if (time === 'night') tex = pmrem.fromScene(floodlitEnv(world.nightSky[city ? 1 : 0]), 0.02).texture;
  else {
    const envScene = new THREE.Scene(), s = new Sky(); s.scale.setScalar(1000);
    s.material.uniforms.sunPosition.value.copy(world.sunDir);
    s.material.uniforms.showSunDisc.value = 0;
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG'])
      s.material.uniforms[k].value = world.sky.material.uniforms[k].value;
    envScene.add(s); tex = pmrem.fromScene(envScene).texture;
  }
  pmrem.dispose();
  envCache.set(key, tex);
  return tex;
}

// world = what buildWorld() returned. track = the built track (for its time and type).
export function applyTimeOfDay(world, track) {
  const time = TIMES[track.time] ? track.time : 'day', T = TIMES[time];
  const city = track.type === 'street';
  world.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(T.phi), THREE.MathUtils.degToRad(T.theta));
  world.sun.color.setHex(T.sun); world.sun.intensity = T.sunI;
  world.hemi.color.setHex(T.hemiSky); world.hemi.groundColor.setHex(T.hemiGround); world.hemi.intensity = T.hemiI;
  world.scene.fog.color.setHex(T.fog); world.scene.fog.near = T.fogNear; world.scene.fog.far = T.fogFar;
  world.renderer.toneMappingExposure = T.exposure;

  const u = world.sky.material.uniforms;
  u.turbidity.value = T.turbidity ?? 3; u.rayleigh.value = T.rayleigh ?? 1.2;
  u.sunPosition.value.copy(world.sunDir);
  if (time === 'night') {
    world.nightSky ??= [nightSkyTexture(false), nightSkyTexture(true)];
    world.sky.visible = false;
    world.scene.background = world.nightSky[city ? 1 : 0];
  } else {
    world.sky.visible = true;
    world.scene.background = null;
  }
  world.scene.environment = envFor(world, time, city);
  world.scene.environmentIntensity = T.env;
  return T;
}

// ---------- floodlights ----------
let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.15, 'rgba(255,248,230,0.8)');
  g.addColorStop(0.45, 'rgba(255,240,210,0.18)'); g.addColorStop(1, 'rgba(255,240,210,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c); glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3e45, metalness: 0.6, roughness: 0.5 });
const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff6e8, emissiveIntensity: 3 });

// Spatial hash so we can ask "how far is the nearest bit of track?" quickly.
function trackIndex(track) {
  const CELL = 50, grid = new Map(), key = (a, b) => a * 100003 + b;
  for (let i = 0; i < track.n; i += 2) {
    const k = key(Math.floor(track.cx[i] / CELL), Math.floor(track.cz[i] / CELL));
    if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
  }
  return (x, z, R = 4) => { // → { d, i } nearest sample within R cells (d = Infinity if none)
    let best = Infinity, bi = -1;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
      const list = grid.get(key(cx + a, cz + b)); if (!list) continue;
      for (const i of list) { const d = (x - track.cx[i]) ** 2 + (z - track.cz[i]) ** 2; if (d < best) { best = d; bi = i; } }
    }
    return { d: Math.sqrt(best), i: bi };
  };
}

// Light towers every `spacing` metres, alternating sides, just behind the barriers.
export function buildFloodlights(track, groundHeight, spacing = GRAPHICS.floodlightSpacing) {
  const nearest = trackIndex(track);
  const tall = track.type === 'street' ? 14 : 22;
  const spots = [];
  let side = 1;
  for (let s = 0; s < track.length; s += spacing, side = -side) {
    const i = Math.floor(s / track.ds) % track.n;
    const wall = side > 0 ? track.wallL[i] : track.wallR[i];
    const off = wall + 3;
    const x = track.cx[i] + track.nx[i] * side * off, z = track.cz[i] + track.nz[i] * side * off;
    const near = nearest(x, z);                       // not in the middle of another part of the circuit
    if (near.i >= 0 && near.d < Math.max(track.wallL[near.i], track.wallR[near.i]) + 2) continue;
    const base = groundHeight(x, z), top = (track.h ? track.h[i] : 0) + tall;
    spots.push({ x, z, base, top: Math.max(top, base + 8), yaw: Math.atan2(-track.nx[i] * side, -track.nz[i] * side) });
  }
  const group = new THREE.Group();
  const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.32, 1, 6), poleMat, spots.length);
  const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(3.2, 1.3, 0.5), lampMat, spots.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  const glowPos = [];
  spots.forEach((p, k) => {
    const h = p.top - p.base;
    m.compose(v.set(p.x, p.base + h / 2, p.z), q.identity(), sc.set(1, h, 1)); poles.setMatrixAt(k, m);
    q.setFromEuler(e.set(0.45, p.yaw, 0, 'YXZ'));    // tilted down towards the track
    m.compose(v.set(p.x, p.top, p.z), q, sc.set(1, 1, 1)); lamps.setMatrixAt(k, m);
    glowPos.push(p.x + Math.sin(p.yaw) * 0.4, p.top, p.z + Math.cos(p.yaw) * 0.4);
  });
  poles.castShadow = false;
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
  const glows = new THREE.Points(glowGeo, new THREE.PointsMaterial({
    map: glowTexture(), size: 14, sizeAttenuation: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xfff1d6, fog: true,
  }));
  group.add(poles, lamps, glows);
  group.userData.ownMaterials = [glows.material];
  return group;
}

// ---------- night: fade the surroundings to dark away from the lit track ----------
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function darkenAwayFromTrack(track, objects, lit = 35, dark = 200, floor = 0.12) {
  const nearest = trackIndex(track);
  const bright = (x, z) => {
    const near = nearest(x, z, 5);
    const d = near.i < 0 ? Infinity : near.d - Math.max(track.wallL[near.i], track.wallR[near.i]);
    return 1 - (1 - floor) * smooth(lit, dark, d);
  };
  const c = new THREE.Color(), m = new THREE.Matrix4(), p = new THREE.Vector3();
  for (const o of objects) {
    if (!o) continue;
    if (o.isInstancedMesh) {
      for (let k = 0; k < o.count; k++) {
        o.getMatrixAt(k, m); p.setFromMatrixPosition(m);
        if (o.instanceColor) o.getColorAt(k, c); else c.setRGB(1, 1, 1);
        o.setColorAt(k, c.multiplyScalar(bright(p.x, p.z)));
      }
      if (o.instanceColor) o.instanceColor.needsUpdate = true;
    } else if (o.isMesh) {
      const pos = o.geometry.attributes.position, col = new Float32Array(pos.count * 3);
      for (let k = 0; k < pos.count; k++) { const b = bright(pos.getX(k), pos.getZ(k)); col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = b; }
      o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
      o.material = o.material.clone(); o.material.vertexColors = true;
      (o.userData.ownMaterials ??= []).push(o.material);
    }
  }
}