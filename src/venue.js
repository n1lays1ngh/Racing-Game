// Grandstands and the pit building, built in code at real size (no model files).
//   buildGrandstands(track, kit) → THREE.Group   (positions and lengths come from the circuit file)
//   buildPits(track, kit)        → THREE.Group
//   buildPitLane(track, kit)     → THREE.Group: the pit lane's tarmac and white lines (its layout: pitlane.js)
//   setVenueLights(v)            → lights under the grandstand roofs, in the garages and on the glass floors
//                                  (scenery.js passes TIMES[time].windows: 0 by day, about 1 at night)
// kit, from scenery.js: sideFrame(track, i, side, offset) → Matrix4 (local X along the track, Z away from
// it, Y up), footprintClear(...), heightAt(x, z), blocked (list that keeps trees and city buildings away),
// ribbon(...) and pitLane (material) for the pit-lane tarmac.
//
// Grandstands, modelled on the big permanent ones (Silverstone, Bahrain, Abu Dhabi):
//   short stands  – one steep tier on a concrete podium, open to the sky (like the temporary corner stands)
//   medium stands – one tall tier under a cantilever roof
//   long stands   – two tiers: the upper tier reaches out over the back rows of the lower one, a sponsor
//                   band along the balcony front, a concourse underneath, a cantilever roof over it all
// Every row is a real step (46 cm high, 86 cm deep) with a seated crowd, aisles every 12 m, clad back walls,
// steel columns and roof trusses. The whole stand is one solid section (extruded), so it casts proper shadows.
//
// Pit building, modelled on Bahrain / Abu Dhabi: garages open to the pit lane (lit inside, team colours),
// then three glass floors stepping back with balconies (offices, hospitality, media), a roof canopy that
// reaches out over the pit lane with sponsors along its edge, and race control on top in the middle.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sampleAt } from './track.js';
import { PITLANE } from './pitlane.js';
import { withLightPools } from './lighting.js';
import { bankLift } from './banking.js';

export const VENUE = {
  stand: {
    front: 4.5,            // metres from the barrier to the front of a grandstand (the fence and light towers are in between)
    podium: 3.6,           // height of the concrete front wall below the first row
    rise: 0.46, tread: 0.86,            // each row: step height and depth (metres)
    upperRise: 0.55, upperTread: 0.8,   // upper tiers are steeper
    rows: { small: 16, medium: 28, lower: 22, upper: 24, compact: 8 }, // rows in each kind of stand (long: lower + upper tier;
                           // compact: where nothing bigger fits)
    overhang: 9,           // how far the upper tier reaches out over the lower one (metres)
    medium: 70, long: 140, // stand length (m, from the circuit file) from which it is medium / long
    scale: 1,              // multiplies all the row counts: 1.3 = even bigger grandstands
    aisle: 1.2,            // width of the aisle every 12 m
    roofHeight: 5,         // roof height above the top row at the back (metres)
  },
  pits: {
    front: 12,             // barrier to garage fronts for a pit building with no pit lane in front (the pit lane's
                           // own width is in pitlane.js)
    depth: 26,             // depth of the building
    garage: 6, garageDepth: 13,
    floors: [              // the floors above the garages: height, and how far each steps back (balconies)
      { h: 4.2, back: 0 },
      { h: 4.2, back: 3 },
      { h: 4.2, back: 6 },
    ],
    canopy: 5,             // how far the roof reaches out over the pit lane
    raceControl: true,     // two more glass floors on top in the middle of the building
  },
};

// ---------- textures, drawn once ----------
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const canvas = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c; };
const texture = (c) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
};
const pick = (list) => list[(rand() * list.length) | 0];

// One row of seated spectators along 12 m (the row is 0.9 m tall): seat backs, people in team colours,
// caps and hair, the odd flag, a few empty seats.
function crowdTexture() {
  seed = 11;
  const shirts = ['#d71920', '#d71920', '#ff8000', '#1e41ff', '#0a2a66', '#ffffff', '#f2f2f2', '#111111', '#ffd400', '#00a19b', '#e10600', '#6b2fb3', '#1b5e20', '#9aa3ad', '#2d6db5', '#ff4fa3', '#1c1c1c', '#7a1f2b'];
  const skin = ['#f1c9a5', '#e8b98f', '#d9a27a', '#c68e62', '#a8714a', '#8d5a3b', '#5a3a26'];
  const hair = ['#2a1a10', '#4a3020', '#111111', '#8a6a40', '#c9b28a', '#6b6b6b'];
  return texture(canvas(1024, 128, (x, w, h) => {
    x.fillStyle = '#2a3038'; x.fillRect(0, 0, w, h);                       // shade between the rows
    x.fillStyle = '#34507e'; x.fillRect(0, 76, w, 52);                      // seat backs
    for (let k = 0; k < 22; k++) {
      const cx = (k + 0.5) * (w / 22) + (rand() - 0.5) * 8;
      x.fillStyle = 'rgba(0,0,0,0.28)'; x.fillRect(cx - 19, 78, 38, 50);     // seat outline
      if (rand() < 0.1) continue;                                           // empty seat
      const up = rand() < 0.12 ? -16 : 0, sw = 29 + rand() * 9;             // a few standing up
      x.fillStyle = pick(shirts); x.beginPath(); x.roundRect(cx - sw / 2, 52 + up, sw, 76, 9); x.fill();
      const s = pick(skin); x.fillStyle = s;
      if (rand() < 0.15) { x.fillRect(cx - sw / 2 - 3, 18 + up, 6, 40); x.fillRect(cx + sw / 2 - 3, 18 + up, 6, 40); } // arms up
      else { x.fillRect(cx - sw / 2 - 2, 72 + up, 6, 26); x.fillRect(cx + sw / 2 - 4, 72 + up, 6, 26); }
      x.beginPath(); x.arc(cx, 38 + up, 12, 0, Math.PI * 2); x.fill();     // head
      const top = rand();
      if (top < 0.3) { x.fillStyle = pick(shirts); x.fillRect(cx - 13, 24 + up, 26, 9); x.fillRect(cx - 2, 29 + up, 17, 4); } // cap
      else if (top < 0.8) { x.fillStyle = pick(hair); x.beginPath(); x.arc(cx, 35 + up, 12.5, Math.PI, 0); x.fill(); }
      if (rand() < 0.04) { x.fillStyle = '#777'; x.fillRect(cx + 14, 0, 2, 52); x.fillStyle = pick(shirts); x.fillRect(cx + 16, 0, 28, 18); } // flag
    }
  }));
}

// Sponsor bands, 24 m long (made-up sponsors): one dark with white/coloured names, one white with coloured names.
const SPONSORS = ['APEX CIRCUIT', 'CORSA TYRES', 'ORION ENERGY', 'MERIDIAN', 'HALCYON AIR', 'NORDA BANK', 'AXIS TELECOM', 'VELOCITÀ'];
function signTexture(dark) {
  return texture(canvas(2048, 128, (x, w, h) => {
    if (dark) { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#182540'); g.addColorStop(1, '#0c1526'); x.fillStyle = g; }
    else x.fillStyle = '#f2f3f4';
    x.fillRect(0, 0, w, h);
    x.textBaseline = 'middle'; x.textAlign = 'center';
    for (let k = 0; k < 4; k++) {
      x.fillStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'; x.fillRect(k * 512, 0, 3, h);
      x.font = `${k % 2 ? 'italic 900' : '800'} 74px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
      x.fillStyle = dark ? ['#ffffff', '#f5cf0f', '#ffffff', '#9fe0d3'][k] : ['#c8102e', '#0c2344', '#111111', '#006b5e'][k];
      x.fillText(SPONSORS[(k * 2 + (dark ? 0 : 1)) % SPONSORS.length], k * 512 + 256, h / 2 + 4, 460);
    }
  }));
}
function claddingTexture() { // ribbed metal cladding, 4 m square
  return texture(canvas(256, 256, (x, w, h) => {
    x.fillStyle = '#b4bbc3'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < w; i += 8) { x.fillStyle = 'rgba(255,255,255,0.18)'; x.fillRect(i, 0, 2, h); x.fillStyle = 'rgba(0,0,0,0.13)'; x.fillRect(i + 5, 0, 2, h); }
    x.fillStyle = 'rgba(0,0,0,0.2)'; x.fillRect(0, 0, w, 3); x.fillRect(0, 0, 3, h);   // panel joints
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(60,50,40,0.16)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  }));
}
// Glazing, 12 m wide × one storey: tinted glass and mullions by day; by night the lit version shows the
// rooms behind (most lit, some dark).
function glazingTextures() {
  seed = 23;
  const lit = Array.from({ length: 8 }, () => (rand() < 0.78 ? pick(['#ffe2b0', '#fff1d8', '#ffd9a0', '#dfe9ff']) : '#141414'));
  const pane = (night) => canvas(1024, 256, (x, w, h) => {
    if (night) { x.fillStyle = '#000'; x.fillRect(0, 0, w, h); lit.forEach((c, k) => { x.fillStyle = c; x.fillRect(k * 128 + 6, 20, 116, 226); }); }
    else {
      x.fillStyle = '#1c2834'; x.fillRect(0, 0, w, h);
      const g = x.createLinearGradient(0, 0, w * 0.4, h); g.addColorStop(0, 'rgba(170,200,230,0.35)'); g.addColorStop(0.6, 'rgba(60,80,100,0.08)'); g.addColorStop(1, 'rgba(140,170,200,0.22)');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
    }
    x.fillStyle = night ? '#000' : '#4a525b';
    x.fillRect(0, 0, w, 14); x.fillRect(0, h - 8, w, 8);                       // transoms
    for (let k = 0; k <= 8; k++) x.fillRect(k * 128 - 3, 0, 6, h);               // mullions every 1.5 m
  });
  return { map: texture(pane(false)), emissiveMap: texture(pane(true)) };
}

let M = null;
const NO_SHADOW = new Set();
function materials() {
  if (M) return M;
  const crowd = crowdTexture(), glass = glazingTextures(), signA = signTexture(true), signB = signTexture(false);
  const std = (o) => new THREE.MeshStandardMaterial(o);
  M = {
    crowd: std({ map: crowd, emissiveMap: crowd, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.9 }),
    concrete: std({ color: 0xc4c8cc, roughness: 0.88 }),
    steel: std({ color: 0x8e959d, metalness: 0.7, roughness: 0.4 }),
    roof: std({ color: 0xdfe3e7, metalness: 0.35, roughness: 0.5 }),
    roofUnder: std({ color: 0xeef0f2, roughness: 0.7, emissive: 0xfff3e0, emissiveIntensity: 0 }),
    signA: std({ map: signA, emissiveMap: signA, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.5 }),
    signB: std({ map: signB, emissiveMap: signB, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.5 }),
    cladding: std({ map: claddingTexture(), roughness: 0.6, metalness: 0.3 }),
    glass: std({ map: glass.map, emissiveMap: glass.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.06, metalness: 0.25 }),
    balustrade: std({ color: 0x9fb7c8, transparent: true, opacity: 0.3, roughness: 0.05, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide }),
    garageFloor: std({ color: 0x70757b, roughness: 0.25, emissive: 0xb8bcc2, emissiveIntensity: 0 }),
    garage: std({ vertexColors: true, roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0x999999 }),
  };
  // the garage walls glow in their own colour at night (emissive × vertex colour)
  M.garage.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n  totalEmissiveRadiance *= vColor.rgb;\n#endif');
  };
  M.garage.customProgramCacheKey = () => 'apex-garage';
  // thin or inside surfaces: no shadows (cheaper, and they'd only add noise)
  for (const k of ['crowd', 'roofUnder', 'signA', 'signB', 'glass', 'balustrade', 'garageFloor', 'garage', 'lamp']) NO_SHADOW.add(M[k]);
  return M;
}

export function setVenueLights(v) {
  const m = materials();
  m.crowd.emissiveIntensity = 0.16 * v;     // the crowd in the light of the stands
  m.roofUnder.emissiveIntensity = 0.3 * v;
  m.signA.emissiveIntensity = m.signB.emissiveIntensity = 0.4 * v; // lit signs
  m.glass.emissiveIntensity = 0.9 * v;
  m.garage.emissiveIntensity = 0.35 * v;
  m.garageFloor.emissiveIntensity = 0.25 * v;
  m.lamp.color.setScalar(v > 0 ? 2 + 3 * v : 0.6);
}

// ---------- geometry helpers ----------
// Each 12–14 m piece of a stand or the pit building is built in its own frame (X along the track, Z away
// from it, Y up), then bent to meet its neighbours (see joins) and placed on the circuit.
// A w × h plane facing 'track' (towards the track), 'out', 'up', 'down', 'left' (−X) or 'right' (+X).
function plane(list, w, h, x, y, z, face, u = [0, 1], v = [0, 1], color = null) {
  const g = new THREE.PlaneGeometry(w, h);
  if (face === 'track') g.rotateY(Math.PI);
  else if (face === 'up') g.rotateX(-Math.PI / 2);
  else if (face === 'down') g.rotateX(Math.PI / 2);
  else if (face === 'left') g.rotateY(-Math.PI / 2);
  else if (face === 'right') g.rotateY(Math.PI / 2);
  const uv = g.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, u[0] + uv.getX(k) * (u[1] - u[0]), v[0] + uv.getY(k) * (v[1] - v[0]));
  list.push(paint(g.translate(x, y, z), color));
}
function block(list, w, h, d, x, y, z, color = null) {
  list.push(paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color));
}
// A solid with cross-section `pts` ([z, y] pairs) running along X from x0 to x1.
function prism(list, pts, x0, x1) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: x1 - x0, bevelEnabled: false, steps: 1 });
  list.push(g.rotateY(-Math.PI / 2).translate(x1, 0, 0)); // shape X → Z, extrusion → −X
}
function paint(g, color) {
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: g.attributes.position.count * 3 }, (_, k) => color[k % 3]), 3));
  return g;
}
const byMaterial = () => {
  const map = new Map();
  return { map, add: (mat) => { if (!map.has(mat)) map.set(mat, []); return map.get(mat); } };
};

// Where neighbouring pieces meet: each piece is stretched to reach its neighbours exactly and its ends
// are mitred like a picture frame, so a stand or building follows a bend with no gaps or overlaps.
// Per piece: half-length at the front (hl, hr) and how much each end leans per metre of depth (tl, tr).
function joins(frames, half) {
  const out = frames.map(() => ({ hl: half, hr: half, tl: 0, tr: 0, openL: true, openR: true }));
  const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m), axis = (m, k) => new THREE.Vector3().setFromMatrixColumn(m, k);
  for (let c = 0; c + 1 < frames.length; c++) {
    const a = frames[c], b = frames[c + 1], oa = pos(a), ob = pos(b);
    const dx = ob.x - oa.x, dz = ob.z - oa.z, d = Math.hypot(dx, dz);
    const za = axis(a, 2), zb = axis(b, 2);
    const angle = Math.acos(Math.max(-1, Math.min(1, za.x * zb.x + za.z * zb.z)));
    const spread = (zb.x - za.x) * dx + (zb.z - za.z) * dz >= 0 ? 1 : -1;   // outside of a bend: the backs spread apart
    const h = d / 2 + 0.06, t = spread * Math.tan(angle / 2);
    const xa = axis(a, 0), xb = axis(b, 0);
    const setEnd = (j, plus) => Object.assign(out[j], plus ? { hr: h, tr: t, openR: false } : { hl: h, tl: t, openL: false });
    setEnd(c, xa.x * dx + xa.z * dz > 0);
    setEnd(c + 1, -(xb.x * dx + xb.z * dz) > 0);
  }
  return out;
}
// Bend a piece's geometry to its joins (x from −half..half becomes the real lengths), place it with matrix
// m and add it to the merged lists.
function place(piece, into, m, j, half) {
  for (const [mat, list] of piece.map) {
    for (const g of list) {
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const x = p.getX(k), z = p.getZ(k), [h, t] = x >= 0 ? [j.hr, j.tr] : [j.hl, j.tl];
        p.setX(k, (x / half) * Math.max(0.15 * h, h + z * t));   // (never folds over on the inside of a tight bend)
      }
      into.add(mat).push(g.applyMatrix4(m));
    }
  }
}
function meshes(parts, group) { // one merged mesh per material
  for (const [mat, list] of parts.map) {
    if (!list.length) continue;
    const mixed = list.some((g) => !g.index);
    const geo = mergeGeometries(mixed ? list.map((g) => (g.index ? g.toNonIndexed() : g)) : list);
    list.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !NO_SHADOW.has(mat); mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// ---------- grandstands ----------
// Cross-section of a stand: pts (the stepped outline from the podium top to the parapet at the back),
// rows (where the crowd sits), bands (sponsor bands on balcony fronts) and the roof line.
function profile(size) {
  const S = VENUE.stand, count = (v) => Math.max(4, Math.round(v * S.scale));
  const rows = [], bands = [], pts = [[0, S.podium]];
  let z = 1.2, y = S.podium;                         // a 1.2 m walkway along the top of the podium
  pts.push([z, y]);
  const tier = (n, rise, tread) => {
    for (let r = 0; r < n; r++) { rows.push({ y, z }); pts.push([z + tread, y], [z + tread, y + rise]); z += tread; y += rise; }
  };
  let roofFront;
  if (size !== 'long') {
    tier(count(S.rows[size]), S.rise, S.tread);
    roofFront = rows[Math.min(3, rows.length - 1)].z;
  } else {
    tier(count(S.rows.lower), S.rise, S.tread);
    const zL = z, yL = y, slope = S.rise / S.tread;
    const over = Math.min(S.overhang, (zL - 1.2) * 0.6), zU = zL - over;
    const soffit = (zz) => S.podium + (zz - 1.2) * slope + 3;   // underside of the upper tier: 3 m above the rows below
    pts.push([zL + 3, yL], [zL + 3, soffit(zL + 3)], [zU, soffit(zU)], [zU, soffit(zU) + 1.4]); // concourse, underside, balcony front
    bands.push({ z: zU, y: soffit(zU), h: 1.4 });
    z = zU + 0.6; y = soffit(zU) + 1.4;
    pts.push([z, y]);
    tier(Math.max(count(S.rows.upper), Math.ceil((over + 4) / S.upperTread)), S.upperRise, S.upperTread);
    roofFront = zU - 3;
  }
  const top = y, back = z + 0.8;
  pts.push([back - 0.4, top], [back - 0.4, top + 1.2], [back, top + 1.2]);  // walkway and parapet at the back
  return { rows, bands, pts, top, back, roof: size === 'medium' || size === 'long', roofFront, yBack: top + S.roofHeight, yFront: top + S.roofHeight + 1.5 };
}

export function buildGrandstands(track, { sideFrame, footprintClear, heightAt, blocked }) {
  const mat = materials(), S = VENUE.stand, parts = byMaterial();
  seed = 31;
  for (const st of track.stands) {
    const chunks = Math.max(1, Math.round(st.len / 12)), clen = st.len / chunks;
    const spots = Array.from({ length: chunks }, (_, c) => {
      const i = sampleAt(track, st.s - st.len / 2 + (c + 0.5) * clen), off = (st.side > 0 ? track.wallL[i] : track.wallR[i]) + S.front;
      return { i, off, m: sideFrame(track, i, st.side, off) };
    });
    // as big as the space allows: the stand's own size if most of it fits, otherwise the next size down;
    // if not even the compact one fits along most of its length, the pieces that do fit are still built
    const sizes = st.len >= S.long ? ['long', 'medium', 'small'] : st.len >= S.medium ? ['medium', 'small'] : ['small'];
    let p = null;
    for (const size of sizes) {
      const t = profile(size);
      if (spots.filter(({ i, off, m }) => footprintClear(track, m, clen / 2, t.back + 2, i, off)).length >= chunks * 0.7) { p = t; break; }
    }
    p ??= profile('compact');
    const J = joins(spots.map((s) => s.m), clen / 2);
    const lane = track.pitLane, onLane = (i) => lane && lane.side === st.side && lane.range[i];
    spots.forEach(({ i, off, m }, c) => {
      if (onLane(i) || !footprintClear(track, m, clen / 2, p.back + 2, i, off)) return;   // (not on the pit lane)
      const mid = new THREE.Vector3(0, 0, p.back / 2).applyMatrix4(m);
      const bottom = -4 - 2 * Math.max(0, mid.y - heightAt(mid.x, mid.z));  // deeper footings on a raised (banked) corner
      const piece = byMaterial();
      grandstandPiece(piece.add, mat, clen, p, bottom, J[c].openR, c);
      place(piece, parts, m, J[c], clen / 2);
      blocked.push([mid.x, mid.z, clen + p.back]);
    });
  }
  return meshes(parts, new THREE.Group());
}

function grandstandPiece(add, mat, L, p, bottom, openEnd, c) {
  const S = VENUE.stand, x0 = -L / 2, x1 = L / 2;
  // the concrete structure: podium, every step, concourse, balcony, walkway and parapet, as one solid
  prism(add(mat.concrete), [[0, bottom], ...p.pts, [p.back, bottom]], x0, x1);
  // clad back wall
  const hb = p.top + 1.2 - bottom;
  plane(add(mat.cladding), L, hb, 0, bottom + hb / 2, p.back + 0.02, 'out', [0, L / 4], [0, hb / 4]);
  // sponsor bands along the podium and the balcony fronts
  const band = c % 2 ? mat.signB : mat.signA, other = c % 2 ? mat.signA : mat.signB;
  plane(add(band), L, 1.2, 0, S.podium - 0.9, -0.02, 'track', [0, L / 24]);
  for (const b of p.bands) plane(add(other), L, b.h, 0, b.y + b.h / 2, b.z - 0.02, 'track', [0, L / 24]);
  // the crowd: a seated row on every step, with an aisle at one end of each piece
  const w = L - S.aisle;
  for (const r of p.rows) {
    const off = rand() * 7;                       // each row starts at a different place in the texture
    plane(add(mat.crowd), w, 0.9, S.aisle / 2, r.y + 0.45, r.z + 0.25, 'track', [off, off + w / 12]);
  }
  if (!p.roof) return;
  // cantilever roof: columns behind the stand, a slab rising towards the track, tapered trusses on top,
  // a sponsor fascia along the front edge and lights underneath
  const zb = p.back + 0.8, zf = p.roofFront, yb = p.yBack, yf = p.yFront, span = zb - zf;
  const under = (z) => yf + ((yb - yf) * (z - zf)) / span - 0.06;   // underside height at z
  prism(add(mat.roof), [[zb, yb], [zf, yf], [zf, yf + 0.5], [zb, yb + 0.5]], x0, x1);
  prism(add(mat.roofUnder), [[zb, yb - 0.06], [zf, yf - 0.06], [zf, yf], [zb, yb]], x0, x1);
  for (const x of [x0 + 0.4, ...(openEnd ? [x1 - 0.4] : [])]) {
    block(add(mat.steel), 0.7, yb + 4.5 - bottom, 0.7, x, (yb + 4.5 + bottom) / 2, p.back + 0.4);                // column
    prism(add(mat.steel), [[zb, yb + 0.5], [zf, yf + 0.5], [zf, yf + 0.9], [zb, yb + 4.5]], x - 0.22, x + 0.22); // truss
  }
  plane(add(band), L, 2.2, 0, yf + 0.1, zf - 0.03, 'track', [0, L / 24]);                                       // fascia
  block(add(mat.lamp), L * 0.94, 0.12, 0.35, 0, under(zf + 1.2) - 0.06, zf + 1.2);                              // lights
}

// ---------- pit building ----------
const TEAM_COLOURS = [[0.86, 0.06, 0.08], [1, 0.5, 0], [0.04, 0.17, 0.4], [0, 0.63, 0.61], [0.12, 0.25, 1], [0.95, 0.95, 0.95], [0.07, 0.07, 0.08], [0, 0.45, 0.32], [0.42, 0.18, 0.7], [0.95, 0.8, 0.1]];
const WHITE = [0.92, 0.93, 0.95];

export function buildPits(track, { sideFrame, footprintClear, blocked, ribbon, pitLane }) {
  const mat = materials(), P = VENUE.pits, parts = byMaterial(), group = new THREE.Group();
  const side = track.infield, wallOf = (i) => (side > 0 ? track.wallL[i] : track.wallR[i]);
  const pl = track.pitLane, onLane = (i) => !!(pl && pl.side === side && pl.range[i]);
  const front = (i) => (pl && pl.side === side && pl.building[i] ? pl.out[i] : wallOf(i) + P.front); // garages on the pit lane's edge
  let bays = 0, tower = P.raceControl;
  for (const pit of [...track.pits].sort((a, b) => b.len - a.len)) {   // race control on the longest building
    const chunks = Math.max(1, Math.round(pit.len / 14)), clen = pit.len / chunks;
    const spots = Array.from({ length: chunks }, (_, c) => {
      const i = sampleAt(track, pit.s + (c + 0.5) * clen), off = front(i);
      return { i, off, m: sideFrame(track, i, side, off), from: sampleAt(track, pit.s + c * clen) };
    });
    const J = joins(spots.map((s) => s.m), clen / 2);
    const lane = new Uint8Array(track.n), steps = Math.round(clen / track.ds);
    spots.forEach(({ i, off, m, from }, c) => {
      if (!footprintClear(track, m, clen / 2, P.depth, i, off)) return;
      for (let k = 0; k <= steps; k++) if (!onLane((from + k) % track.n)) lane[(from + k) % track.n] = 1;
      const piece = byMaterial();
      pitPiece(piece.add, mat, clen, J[c], c, () => TEAM_COLOURS[Math.floor(bays++ / 3) % TEAM_COLOURS.length]);
      if (tower && c === Math.floor(chunks / 2)) { raceControl(piece.add, mat, clen); tower = false; }
      place(piece, parts, m, J[c], clen / 2);
      const e = new THREE.Vector3(0, 0, P.depth / 2).applyMatrix4(m); blocked.push([e.x, e.z, clen + P.depth]);
    });
    // a building away from the pit lane (a second pit building): tarmac in front of it
    if (ribbon && pitLane && lane.some((v) => v)) {
      const g = ribbon(track, (i) => side * (wallOf(i) + 1.2), (i) => side * (wallOf(i) + P.front + 1), 0.02, 12, lane);
      const mesh = new THREE.Mesh(g, pitLane); mesh.receiveShadow = true; group.add(mesh);
    }
  }
  return meshes(parts, group);
}

function pitPiece(add, mat, L, j, c, nextTeam) {
  const P = VENUE.pits, H1 = P.garage, GD = P.garageDepth, D = P.depth, base = -3;
  // garages: two bays per piece, each a lit room open to the pit lane, in its team's colours
  const bay = (L - 1.2) / 2, wallH = H1 - 1.5;
  for (const bx of [-bay / 2 - 0.3, bay / 2 + 0.3]) {
    const team = nextTeam();
    plane(add(mat.garageFloor), bay, GD, bx, 0.8, GD / 2, 'up');
    plane(add(mat.garage), bay, GD, bx, H1 - 0.7, GD / 2, 'down', [0, 1], [0, 1], WHITE);                    // ceiling
    plane(add(mat.garage), bay, wallH, bx, 0.8 + wallH / 2, GD - 0.02, 'track', [0, 1], [0, 1], team);       // back wall
    plane(add(mat.garage), GD, wallH, bx - bay / 2, 0.8 + wallH / 2, GD / 2, 'right', [0, 1], [0, 1], WHITE);
    plane(add(mat.garage), GD, wallH, bx + bay / 2, 0.8 + wallH / 2, GD / 2, 'left', [0, 1], [0, 1], WHITE);
    plane(add(mat.garage), bay, 0.5, bx, H1 - 0.45, -0.02, 'track', [0, 1], [0, 1], team);                    // team panel over the door
    for (let k = 0; k < 3; k++) block(add(mat.lamp), bay * 0.8, 0.08, 0.35, bx, H1 - 0.75, 2.5 + k * 4);      // ceiling lights
  }
  for (const x of [-L / 2 + 0.3, 0, L / 2 - 0.3]) block(add(mat.concrete), 0.6, H1 - base, 0.6, x, (H1 + base) / 2, 0.3); // pillars
  for (const [open, x] of [[j.openL, -L / 2 + 0.2], [j.openR, L / 2 - 0.2]]) if (open) block(add(mat.concrete), 0.4, H1 - base, GD, x, (H1 + base) / 2, GD / 2);
  block(add(mat.concrete), L, H1 - base, D - GD, 0, (H1 + base) / 2, GD + (D - GD) / 2);  // workshops behind the garages
  // the floors above: slab, glass front, the rooms behind (clad), a balcony where a floor steps back
  let y = H1, prev = 0;
  for (const f of P.floors) {
    block(add(mat.concrete), L, 0.4, D - prev, 0, y, prev + (D - prev) / 2);                              // floor slab
    plane(add(mat.glass), L, f.h - 0.4, 0, y + f.h / 2, f.back + 0.15, 'track', [0, L / 12]);
    block(add(mat.cladding), L, f.h, D - f.back - 0.3, 0, y + f.h / 2, f.back + 0.3 + (D - f.back - 0.3) / 2);
    if (f.back > prev) block(add(mat.balustrade), L, 1.1, 0.04, 0, y + 0.75, prev + 0.15);              // glass balustrade
    y += f.h; prev = f.back;
  }
  // roof canopy over everything, reaching out over the pit lane, sponsors along its edge, slim posts
  block(add(mat.roof), L, 0.7, D + P.canopy, 0, y + 0.15, (D - P.canopy) / 2);
  plane(add(mat.roofUnder), L, P.canopy + prev, 0, y - 0.21, (prev - P.canopy) / 2, 'down');
  plane(add(c % 2 ? mat.signA : mat.signB), L, 1.6, 0, y + 0.15, -P.canopy - 0.02, 'track', [0, L / 24]);
  const postFrom = H1 + P.floors[0].h;
  block(add(mat.steel), 0.3, y - postFrom, 0.3, -L / 2 + 0.15, (y + postFrom) / 2, 0.4);
  block(add(mat.lamp), L * 0.9, 0.1, 0.3, 0, y - 0.28, -P.canopy + 1);
}

// Race control: two more glass floors on top, set back from the front, with their own roof and sign.
function raceControl(add, mat, L) {
  const P = VENUE.pits, D = P.depth, y0 = P.garage + P.floors.reduce((s, f) => s + f.h, 0) + 0.5, z0 = 9, h = 4;
  for (let k = 0; k < 2; k++) {
    const y = y0 + k * h;
    block(add(mat.concrete), L, 0.4, D - z0 - 2, 0, y, z0 + (D - z0 - 2) / 2);
    plane(add(mat.glass), L, h - 0.4, 0, y + h / 2, z0 + 0.15, 'track', [0, L / 12]);
    block(add(mat.cladding), L, h, D - z0 - 2.3, 0, y + h / 2, z0 + 0.3 + (D - z0 - 2.3) / 2);
  }
  const yr = y0 + 2 * h;
  block(add(mat.roof), L + 1, 0.5, D - z0, 0, yr + 0.05, z0 - 1.5 + (D - z0) / 2);
  plane(add(mat.signA), L, 1.2, 0, yr + 0.05, z0 - 1.52, 'track', [0, L / 24]);
}

// ---------- the pit lane (where it runs: pitlane.js) ----------
// Tarmac from the pit wall to the garages, and the white lines: where the lane leaves and rejoins the
// track, along its outer edge, between the fast lane and the working lane, across it where the speed
// limit starts and ends, and a box in front of every garage. Adds the lane to `blocked` (no trees or
// buildings on it).
let LINE = null;
export function buildPitLane(track, { ribbon, pitLane, blocked }) {
  const p = track.pitLane, group = new THREE.Group();
  if (!p || !ribbon) return group;
  const { n, ds } = track, s = p.side, line = (LINE ??= withLightPools(new THREE.MeshStandardMaterial({
    color: 0xeeeeea, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
  // samples where `test` holds, trimmed by one at each end (a strip only covers steps with both ends inside)
  const mask = (test) => {
    const m = new Uint8Array(n);
    for (let k = 0; k <= p.steps; k++) { const i = (p.i0 + k) % n; m[i] = test(i) ? 1 : 0; }
    return m.map((v, i) => (v && m[(i + 1) % n] && m[(i + n - 1) % n] ? 1 : 0));
  };
  const strip = (from, to, where, y, mat) => {
    if (!where.some((v) => v)) return;
    const mesh = new THREE.Mesh(ribbon(track, (i) => s * from(i), (i) => s * to(i), y, 12, where), mat);
    mesh.receiveShadow = true; group.add(mesh);
  };
  // the tarmac: from under the pit wall (or the track edge, where it opens onto the track) to under the garages
  if (pitLane) strip((i) => p.wall[i] || p.inner[i] - 0.3, (i) => p.out[i] + 0.6, mask((i) => p.range[i]), 0.035, pitLane);
  // white lines (15 cm)
  const w = 0.075, y = 0.05;
  strip((i) => p.inner[i] + 0.1 - w, (i) => p.inner[i] + 0.1 + w, mask((i) => p.range[i] && !p.wall[i]), y, line);   // lane / track
  strip((i) => p.out[i] - 0.3 - w, (i) => p.out[i] - 0.3 + w, mask((i) => p.range[i] && !p.building[i]), y, line);  // outer edge
  const fast = (i) => p.inner[i] + PITLANE.fastLane;
  strip((i) => fast(i) - w, (i) => fast(i) + w, mask((i) => p.limit[i]), y, line);                                // fast | working lane
  // flat quads on the ground: `along` metres either way of distance d round the lap, between lat0 and lat1
  const pos = [], idx = [];
  const quad = (d, along, lat0, lat1) => {
    d = ((d % track.length) + track.length) % track.length;
    const i = Math.floor(d / ds) % n, t0 = d - i * ds, base = pos.length / 3;   // the sample, and how far past it
    for (const [u, l] of [[-along, lat0], [along, lat0], [-along, lat1], [along, lat1]]) {
      const lat = s * l, t = t0 + u;
      pos.push(track.cx[i] + track.nx[i] * lat + track.tx[i] * t, (track.h ? track.h[i] : 0) + bankLift(track, i, lat) + y,
        track.cz[i] + track.nz[i] * lat + track.tz[i] * t);
    }
    idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  };
  // the limiter lines, 60 cm wide, across the lane
  const lim = [];
  for (let k = 0; k <= p.steps; k++) { const i = (p.i0 + k) % n; if (p.limit[i]) lim.push(k); }
  for (const k of lim.length ? [lim[0], lim[lim.length - 1]] : []) {
    const i = (p.i0 + k) % n;
    quad(i * ds + ds / 2, 0.3, p.inner[i], p.out[i]);
  }
  // a box in front of every garage (two per 14 m of building, as in buildPits), in the working lane
  const chunks = Math.max(1, Math.round(p.pit.len / 14)), clen = p.pit.len / chunks;
  for (let c = 0; c < chunks * 2; c++) {
    const d = p.pit.s + (c + 0.5) * (clen / 2), i = sampleAt(track, d);
    if (!p.building[i]) continue;
    const a = fast(i) + 0.6, b = p.out[i] - 0.6, half = Math.min(2.8, clen / 4 - 0.6);
    if (b - a < 2) continue;
    quad(d - half, w, a, b); quad(d + half, w, a, b);        // the two ends
    quad(d, half, a, a + 2 * w); quad(d, half, b - 2 * w, b); // the two sides
  }
  if (idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    // faces must point up: flip if this side's winding points down
    if (g.attributes.normal.getY(0) < 0) { const ix = g.index.array; for (let k = 0; k < ix.length; k += 3) [ix[k + 1], ix[k + 2]] = [ix[k + 2], ix[k + 1]]; g.computeVertexNormals(); }
    const mesh = new THREE.Mesh(g, line); mesh.receiveShadow = true; group.add(mesh);
  }
  // keep trees and city buildings off the lane
  for (let k = 0; k <= p.steps; k += 4) {
    const i = (p.i0 + k) % n, mid = s * (p.inner[i] + p.out[i]) / 2;
    blocked?.push([track.cx[i] + track.nx[i] * mid, track.cz[i] + track.nz[i] * mid, (p.out[i] - p.inner[i]) / 2 + 3]);
  }
  return group;
}