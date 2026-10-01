// City buildings around street circuits.
//   buildCity(track, options) → { group, meshes }  (scenery.js places them)
//   setWindowLights(v)        → how bright the lit windows are (0 in the day; set from TIMES in lighting.js)
//
// The buildings are models from public/models/ (see models.js; credits in README.md):
//   city_buildings.glb – "city at night low poly skyscrapers" by dasy444: nine towers (b0–b8) and six low
//                        blocks (b9–b14), each scaled to fit the plot it's given
//   office_tower.glb   – "Singapore Office Skyscraper" by 99.Miles: a few of these stand out on the skyline
// Their lit windows glow at dusk and at night only. Until the models have loaded (or if they can't be),
// the buildings are drawn in code as described below.
//
// Drawn in code: every building is an instanced box, but its facade is drawn by a shader at real size: 3.2–3.9 m floors,
// window bays fitted to the width of each face. Three kinds of facade: glass curtain-wall towers,
// concrete blocks with punched windows, and bands of ribbon windows. Glass is smooth and reflects the
// sky; walls are matt. Street level is darker, there's a solid parapet at the top, tall towers get a
// narrower upper section, and roofs have plant rooms on them. At night a random mix of offices and
// flats have their lights on, a few whole floors at a time.
import * as THREE from 'three';
import { loadModel, instanceModel, inScene } from './models.js';

const WINDOWS = { value: 0 };
const MODEL_MATS = new Set(); // the models' materials: their lit windows follow setWindowLights too
export function setWindowLights(v) {
  WINDOWS.value = v;
  for (const m of MODEL_MATS) m.emissiveIntensity = m.userData.baseEmissive * v;
}
export const CITY_MODELS = { enabled: true, landmarks: 3 }; // use the models; how many office towers stand out
// Street circuits: most of the buildings stand in a row right behind the barriers, in runs along the track,
// so the track runs between walls of buildings; the rest stand further back as the skyline.
export const FRONTAGE = {
  share: 0.9,      // share of a circuit's buildings in the row by the track (the rest go further back)
  setback: 5,      // metres from the barrier to the building fronts (fence, floodlight poles and a pavement)
  gap: [0.5, 1.5],     // metres between neighbouring buildings
  run: [12, 25],    // buildings in a row before a gap (a side street, a park)
};

const TINTS = [0xd9d4c7, 0xc9ccd1, 0xb9aa92, 0x9ea8b3, 0x8b939c, 0xe8e3d8, 0xa99a86, 0x7f868e, 0xcfc8bb];

let MAT = null;
function facadeMaterial() {
  if (MAT) return MAT;
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWindows = WINDOWS;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
        attribute float aSeed, aBase;
        varying vec3 vFac;    // metres across the face, metres above the street, 1 on the roof
        varying vec2 vSize;   // width of this face, height of the building
        varying float vSeed;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        bool sideX = abs(normal.x) > 0.5;
        vFac = vec3(sideX ? (position.z + 0.5) * sc.z : (position.x + 0.5) * sc.x, aBase + position.y * sc.y, normal.y > 0.5 ? 1.0 : 0.0);
        vSize = vec2(sideX ? sc.z : sc.x, aBase + sc.y); // width of this face, height of its top above the street
        vSeed = aSeed;`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        uniform float uWindows;
        varying vec3 vFac;
        varying vec2 vSize;
        varying float vSeed;
        float gGlass, gFar;
        vec3 gLit;
        float hsh(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        float band(float f, float a, float b, float w) { return smoothstep(a - w, a + w, f) - smoothstep(b - w, b + w, f); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float style = floor(hsh(vec3(vSeed, 1.7, 3.1)) * 3.0);       // 0 glass tower, 1 punched windows, 2 ribbon windows
          float floorH = style < 0.5 ? 3.9 : (style < 1.5 ? 3.2 : 3.6);
          float bayT = style < 0.5 ? 1.5 : (style < 1.5 ? 3.0 : 7.5);
          float bayW = vSize.x / max(1.0, floor(vSize.x / bayT + 0.5));
          vec2 g = vec2(vFac.x / bayW, vFac.y / floorH), cell = floor(g), f = fract(g), fw = fwidth(g);
          vec4 win = style < 0.5 ? vec4(0.05, 0.95, 0.07, 0.96) : (style < 1.5 ? vec4(0.24, 0.76, 0.28, 0.84) : vec4(0.0, 1.0, 0.34, 0.82));
          float glass = band(f.x, win.x, win.y, fw.x) * band(f.y, win.z, win.w, fw.y);
          gFar = smoothstep(0.2, 0.6, max(fw.x, fw.y));               // far away the grid is finer than a pixel
          glass = mix(glass, (win.y - win.x) * (win.w - win.z), gFar);
          float street = 1.0 - step(4.4, vFac.y), parapet = step(vSize.y - 1.1, vFac.y);
          glass *= (1.0 - parapet) * (1.0 - vFac.z);
          if (street > 0.5) glass = style < 1.5 ? 0.85 * band(f.x, 0.04, 0.96, fw.x) : 0.0; // shop fronts
          float h1 = hsh(vec3(cell, vSeed)), h2 = hsh(vec3(cell.yx + 7.0, vSeed)), fl = hsh(vec3(cell.y, vSeed, 5.0));
          // glass: dark, a little blue, some windows with blinds half down
          vec3 glassCol = vec3(0.03, 0.042, 0.055) * (0.7 + 0.6 * h1);
          glassCol = mix(glassCol, vec3(0.32, 0.31, 0.29), step(0.86, h2) * step(0.5, f.y) * (1.0 - gFar));
          vec3 wall = diffuseColor.rgb * (0.94 + 0.12 * hsh(vec3(cell.y, 2.0, vSeed)));  // tinted per building
          wall *= 0.62 + 0.38 * smoothstep(0.0, 9.0, vFac.y);                          // darker at street level
          wall = mix(wall, vec3(0.2, 0.2, 0.21) * (0.85 + 0.3 * h1), vFac.z);          // roofs: dark membrane
          diffuseColor.rgb = mix(wall, glassCol, glass);
          gGlass = glass;
          // lights on at night: offices a whole floor at a time, flats window by window; warm or cool
          float on = max(step(fl, 0.22), step(h1, 0.3));
          if (street > 0.5) on = step(h2, 0.7);
          vec3 lamp = mix(vec3(1.0, 0.72, 0.42), vec3(0.8, 0.9, 1.0), step(0.55, h2)) * (0.5 + h1);
          gLit = lamp * mix(on, 0.33, gFar) * glass;
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.07, gGlass * (1.0 - gFar * 0.5));')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += gLit * uWindows;`);
  };
  m.customProgramCacheKey = () => 'apex-facade';
  MAT = m;
  return m;
}

let ROOFTOP = null;
const rooftopMaterial = () => (ROOFTOP ??= new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.8, metalness: 0.3 }));

// Plots in a row right behind the barriers, both sides, walking round the lap. Each plot's corners must
// be clear of every part of the track (so none sit on a hairpin's inside or over another straight).
// Plot sizes: w across the track (depth), d along it (frontage), like the boxes they become.
function frontagePlots(track, nearest, blocked) {
  const F = FRONTAGE, plots = [];
  const wallAt = (i, x, z) => ((x - track.cx[i]) * track.nx[i] + (z - track.cz[i]) * track.nz[i] > 0 ? track.wallL[i] : track.wallR[i]); // that side's barrier
  for (const side of [1, -1]) {
    const row = [];
    let s = Math.random() * 30;
    while (s < track.length - 12) {
      const d = 16 + Math.random() * 20, w = 16 + Math.random() * 18;
      const i = Math.floor((s + d / 2) / track.ds) % track.n;
      const off = (side > 0 ? track.wallL[i] : track.wallR[i]) + F.setback + w / 2;
      const x = track.cx[i] + track.nx[i] * side * off, z = track.cz[i] + track.nz[i] * side * off;
      let ok = !blocked.some(([bx, bz, r]) => (x - bx) ** 2 + (z - bz) ** 2 < (r + Math.max(w, d) * 0.5) ** 2);
      for (const [a, b] of [[-0.5, -0.5], [-0.5, 0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0], [0, 0]]) { // corners, front middle, centre
        if (!ok) break;
        const px = x + track.nx[i] * a * w + track.tx[i] * b * d, pz = z + track.nz[i] * a * w + track.tz[i] * b * d;
        const near = nearest(px, pz);
        ok = near.d > wallAt(near.i, px, pz) + F.setback - 1.5;
      }
      if (ok) { row.push({ x, z, w, d, yaw: Math.atan2(track.tx[i], track.tz[i]) }); s += d + F.gap[0] + Math.random() * (F.gap[1] - F.gap[0]); }
      else { row.push(null); s += 8; }                                     // no room here: a break in the row
    }
    plots.push(row);
  }
  return plots;
}

// options: count, heightAt(x,z), nearest(x,z) → { d, i }, clear(x,z,extra) (away from the track),
// blocked: [[x, z, r]] to avoid (and added to), tall: height range of the tallest buildings,
// frontage: street circuit (most buildings in a row right behind the barriers).
export function buildCity(track, { count, heightAt, nearest, clear, blocked, tall = 70, frontage = false }) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.cx[i]); maxX = Math.max(maxX, track.cx[i]);
    minZ = Math.min(minZ, track.cz[i]); maxZ = Math.max(maxZ, track.cz[i]);
  }
  const blocks = [], tiers = [], roofs = [];
  const addBuilding = (x, z, w, d, yaw, hgt) => {
    const y = heightAt(x, z) - 1, seed = Math.random() * 1000;
    const tint = TINTS[(Math.random() * TINTS.length) | 0];
    blocks.push({ x, y, z, w, d, h: hgt, yaw, seed, tint });
    if (hgt > 32 && Math.random() < 0.65) { // a narrower upper section on tall towers
      const k = 0.6 + Math.random() * 0.2, th = hgt * (0.2 + Math.random() * 0.35);
      tiers.push({ x, y: y + hgt, z, w: w * k, d: d * k, h: th, yaw, seed, tint, base: hgt });
    }
    for (let r = 0, nr = Math.floor(Math.random() * 3); r < nr; r++) { // plant rooms and tanks on the roof
      const rw = 2 + Math.random() * 5, rd = 2 + Math.random() * 4, rh = 1.5 + Math.random() * 2;
      const ox = (Math.random() - 0.5) * (w - rw - 2), oz = (Math.random() - 0.5) * (d - rd - 2);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      roofs.push({ x: x + ox * c + oz * s, y: y + hgt, z: z - ox * s + oz * c, w: rw, d: rd, h: rh, yaw });
    }
    blocked.push([x, z, Math.max(w, d) * 0.6]);
  };
  // the row by the track: runs of plots with gaps between them, until its share of the buildings is used
  if (frontage) {
    const target = Math.round(count * FRONTAGE.share), rows = frontagePlots(track, nearest, blocked);
    const available = rows.flat().filter(Boolean).length, keep = Math.min(1, target / Math.max(1, available));
    let placed = 0;
    for (const row of rows) {
      for (let k = 0; k < row.length && placed < target;) {
        const len = FRONTAGE.run[0] + Math.floor(Math.random() * (FRONTAGE.run[1] - FRONTAGE.run[0]));
        const on = Math.random() < keep;
        for (const p of row.slice(k, k + len)) {
          if (!p || !on || placed >= target) continue;
          // where two parts of the track run close together, their rows could meet: skip plots on top of another
          if (blocks.some((b) => (p.x - b.x) ** 2 + (p.z - b.z) ** 2 < (Math.min(p.w, p.d, b.w, b.d) * 0.5 + 4) ** 2)) continue;
          addBuilding(p.x, p.z, p.w, p.d, p.yaw, 12 + Math.random() ** 1.7 * tall * 0.75); placed++;
        }
        k += len;
      }
    }
  }
  // the rest anywhere around the circuit (further back: the skyline)
  let tries = 0;
  while (blocks.length < count && tries++ < count * 40) {
    const x = minX - 400 + Math.random() * (maxX - minX + 800), z = minZ - 400 + Math.random() * (maxZ - minZ + 800);
    const w = 16 + Math.random() * 26, d = 14 + Math.random() * 24;
    if (!clear(x, z, 6 + Math.max(w, d) * 0.6)) continue;
    if (blocked.some(([bx, bz, r]) => (x - bx) ** 2 + (z - bz) ** 2 < (r + w) * (r + w))) continue;
    const i = nearest(x, z).i;                                             // lined up with the nearest street
    addBuilding(x, z, w, d, Math.atan2(track.tx[i], track.tz[i]), (frontage ? 20 : 12) + Math.random() ** 2.2 * tall);
  }
  const group = new THREE.Group(), meshes = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const instanced = (list, material, seeds) => {
    if (!list.length) return;
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    if (seeds) {
      geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(list.map((b) => b.seed)), 1));
      geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(new Float32Array(list.map((b) => b.base ?? 0)), 1));
    }
    const mesh = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((b, k) => {
      mesh.setMatrixAt(k, m4.compose(p.set(b.x, b.y, b.z), q.setFromAxisAngle(up, b.yaw), sc.set(b.w, b.h, b.d)));
      mesh.setColorAt(k, col.setHex(b.tint ?? 0xffffff));
    });
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere();
    group.add(mesh); meshes.push(mesh);
  };
  instanced(blocks, facadeMaterial(), true);
  instanced(tiers, facadeMaterial(), true);
  instanced(roofs, rooftopMaterial(), false);
  if (CITY_MODELS.enabled) useModels(track, blocks, group, meshes);
  return { group, meshes };
}

// Once the models have loaded, every plot gets one instead of its box: the office tower on a few big
// plots near the track, a tower from the pack on the tall plots, a low block on the rest.
function useModels(track, blocks, group, boxes) {
  const names = Array.from({ length: 15 }, (_, k) => `b${k}`);
  Promise.all([...names.map((n) => loadModel('city_buildings.glb', n)), loadModel('office_tower.glb')]).then((models) => {
    const office = models.pop(), towers = models.slice(0, 9).filter(Boolean), low = models.slice(9).filter(Boolean);
    if (!inScene(group) || !towers.length || !low.length) return; // circuit changed, or no models: keep the boxes
    for (const model of [...towers, ...low, office].filter(Boolean)) for (const { material: m } of model.parts) {
      if (MODEL_MATS.has(m)) continue;
      m.userData.baseEmissive = m.emissiveIntensity; MODEL_MATS.add(m);
      m.emissiveIntensity = m.userData.baseEmissive * WINDOWS.value;
    }
    const near = (b) => { let d = Infinity; for (let i = 0; i < track.n; i += 5) d = Math.min(d, (b.x - track.cx[i]) ** 2 + (b.z - track.cz[i]) ** 2); return d; };
    const picks = new Map(); // model → list of placements
    const place = (model, b, sy, sxz) => { if (!picks.has(model)) picks.set(model, []); picks.get(model).push({ x: b.x, y: b.y, z: b.z, yaw: b.yaw, sx: sxz, sy, sz: sxz }); };
    const landmarks = office ? blocks.filter((b) => b.h > 40 && Math.min(b.w, b.d) > 24).sort((a, b) => near(a) - near(b)).slice(0, CITY_MODELS.landmarks) : [];
    for (const b of blocks) {
      if (landmarks.includes(b)) { const s = Math.min(b.w, b.d) / Math.max(office.size.x, office.size.z); place(office, b, s, s); continue; }
      const list = b.h >= 22 ? towers : low, model = list[Math.floor((b.seed * 7.31) % list.length)];
      const sy = b.h / model.size.y;
      const fit = Math.min(b.w / model.size.x, b.d / model.size.z) * 0.95;     // fill the plot...
      const sxz = Math.min(Math.max(fit, sy * 0.5), sy * (b.h >= 22 ? 1.6 : 2.2), fit / 0.95); // ...without stretching it out of shape, or past the plot
      place(model, b, sy, sxz);
    }
    for (const o of boxes.splice(0)) { group.remove(o); o.geometry.dispose(); o.dispose(); }
    for (const [model, list] of picks) for (const mesh of instanceModel(model, list)) { group.add(mesh); boxes.push(mesh); }
  });
}