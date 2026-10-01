// Everything you see that isn't a car.
//   buildWorld()   – sky, sun, lights, ground: built once.
//   buildCircuit() – tarmac, kerbs, gravel, start gantry and trees for one circuit, plus the barriers
//                    (barriers.js), grandstands and pit building (venue.js) and city buildings (buildings.js).
//                    Rebuilt whenever you pick a different track.
// Tarmac, grass and gravel are photo scans from public/textures/ (see photoTextures() below), with the
// rubbered racing line, edge lines, skid marks and mowing stripes painted on top in the shaders.
// If a photo can't be loaded, that surface is drawn in code instead. Tweak the look with LOOK below.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SURFACES } from './track.js';
import { buildSpeedProfile } from './ai.js';
import { buildTerrain } from './terrain.js';
import { bankLift } from './banking.js';
import { TIMES, buildFloodlights, darkenAwayFromTrack, withLightPools, setLightPools } from './lighting.js';
import { buildBarriers } from './barriers.js';
import { buildCity, setWindowLights } from './buildings.js';
import { buildGrandstands, buildPits, buildPitLane, setVenueLights } from './venue.js';
import { GRAPHICS } from './settings.js';
import { TyreMarks, MARKS, MARK_GRID } from './tyreMarks.js';

export const LOOK = {
  asphaltTile: 2,       // metres per repeat of the asphalt texture (the real size of the scanned patch)
  rubber: 0.3,          // how much darker the racing line is (0 = not at all)
  skids: 0.35,          // skid marks in the braking zones
  edgeLine: 0.24,       // width of the white lines at the track edges (m)
  grassTile: 2,         // metres per repeat of the grass texture
  gravelTile: 3,        // metres per repeat of the gravel texture
  stripe: 7,            // width of the mowing stripes (m)
  stripeContrast: 0.14,
  forest: 6,            // trees in the woods further out, per tree near the track (0 = no woods)
  cityGreen: 0.45,      // street circuits: how much of the ground around the track is lawn (0–1), the rest is street
  cityStreet: 1.35,     // street circuits: brightness of the streets (the track's own asphalt is 1)
  clouds: 0.45,         // cloud cover in the sky (0 = none, 1 = overcast)
};

// ---------- procedural canvas textures (made once, shared by all circuits) ----------
function canvasTexture(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function noise(ctx, w, h, base, spread, count, size = 1) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const v = (Math.random() - 0.5) * spread;
    ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v)})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
}

// ---------- detailed surfaces, drawn pixel by pixel ----------
let seed = 1;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; // repeatable

// Smooth value noise that tiles seamlessly; cells = features across the texture
function valueNoise(size, cells, s = 1) {
  seed = s * 7919 + cells;
  const g = new Float32Array(cells * cells).map(() => rand());
  const out = new Float32Array(size * size), sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells, y0 = Math.floor(fy), ty = sm(fy - y0), y1 = (y0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, x0 = Math.floor(fx), tx = sm(fx - x0), x1 = (x0 + 1) % cells;
      const a = g[y0 * cells + x0], b = g[y0 * cells + x1], c = g[y1 * cells + x0], d = g[y1 * cells + x1];
      out[y * size + x] = a + (b - a) * tx + (c - a + (a - b - c + d) * tx) * ty;
    }
  }
  return out;
}
function fbm(size, cells, octaves, s = 1) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(size, cells << o, s + o * 13);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}
// round blob into a field, wrapping at the edges (keeps the texture tileable)
function blob(size, cx, cy, r, fn) {
  const r2 = r * r, ri = Math.ceil(r);
  for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    fn(((((cy + dy) % size) + size) % size) * size + ((((cx + dx) % size) + size) % size), 1 - d2 / r2);
  }
}
function pixels(size, fill) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  fill(img.data); ctx.putImageData(img, 0, 0);
  return c;
}
function tex(canvas, srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
// Bumps from a height field, packed like the photo textures: normal X/Y in red/green, roughness in blue.
function normalFromHeight(h, size, strength, rough = null) {
  return tex(pixels(size, (d) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let nx = (h[y * size + ((x + size - 1) % size)] - h[y * size + ((x + 1) % size)]) * strength;
      let ny = (h[((y + 1) % size) * size + x] - h[((y + size - 1) % size) * size + x]) * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz), i = (y * size + x) * 4;
      d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (rough ? rough[y * size + x] : 1) * 255; d[i + 3] = 255;
    }
  }), false);
}

// Asphalt: dark binder with light and dark stones
function asphaltTextures(size = 512) {
  const n = size * size, base = fbm(size, 16, 4, 3), blot = fbm(size, 4, 3, 5);
  const v = new Float32Array(n), h = new Float32Array(n), rough = new Float32Array(n).fill(0.92);
  for (let i = 0; i < n; i++) { v[i] = 0.22 + (base[i] - 0.5) * 0.05 + (blot[i] - 0.5) * 0.05; h[i] = base[i] * 0.15; }
  seed = 42;
  for (let k = 0; k < n / 22; k++) {
    const r = 0.7 + rand() ** 2 * 1.9, tone = rand() < 0.72 ? 0.31 + rand() * 0.22 : 0.12 + rand() * 0.06;
    blob(size, Math.floor(rand() * size), Math.floor(rand() * size), r, (i, f) => {
      v[i] = v[i] * (1 - f * 0.85) + tone * f * 0.85; h[i] = Math.max(h[i], 0.3 + f * 0.7); rough[i] = 0.72;
    });
  }
  const map = pixels(size, (d) => {
    for (let i = 0; i < n; i++) { const c = Math.min(1, Math.max(0, v[i] + (rand() - 0.5) * 0.03)) * 255; d[i * 4] = c; d[i * 4 + 1] = c * 0.99; d[i * 4 + 2] = c * 0.96; d[i * 4 + 3] = 255; } // neutral, slightly warm grey
  });
  return { map: tex(map), normalMap: normalFromHeight(h, size, 2.2, rough) };
}

// Grass: blades and patches (the mowing stripes are added in the shader)
function grassTextures(size = 512) {
  const n = size * size, patch = fbm(size, 6, 3, 11), fine = fbm(size, 48, 2, 12);
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = 0.21 + patch[i] * 0.1 + fine[i] * 0.05; g[i] = 0.31 + patch[i] * 0.1 + fine[i] * 0.07; b[i] = 0.12 + fine[i] * 0.04; h[i] = fine[i] * 0.3;
  }
  seed = 77;
  for (let k = 0; k < n / 5; k++) { // blades: short strokes with lighter tips
    const x = rand() * size, y = rand() * size, len = 3 + rand() * 7, a = -Math.PI / 2 + (rand() - 0.5) * 1.2;
    const shade = 0.8 + rand() * 0.45, yellow = rand() < 0.08 ? 0.12 : 0;
    for (let t = 0; t < len; t++) {
      const i = (Math.floor(y + Math.sin(a) * t + size) % size) * size + (Math.floor(x + Math.cos(a) * t + size) % size), k2 = shade * (0.85 + (t / len) * 0.3);
      r[i] = r[i] * 0.4 + (0.23 + yellow) * k2 * 0.6; g[i] = g[i] * 0.4 + 0.37 * k2 * 0.6; b[i] = b[i] * 0.4 + 0.12 * k2 * 0.6; h[i] = 0.4 + (t / len) * 0.6;
    }
  }
  const map = pixels(size, (d) => {
    for (let i = 0; i < n; i++) { d[i * 4] = Math.min(1, r[i]) * 255; d[i * 4 + 1] = Math.min(1, g[i]) * 255; d[i * 4 + 2] = Math.min(1, b[i]) * 255; d[i * 4 + 3] = 255; }
  });
  return { map: tex(map), normalMap: normalFromHeight(h, size, 1.4) };
}

// Gravel trap: pebbles
function gravelTextures(size = 256) {
  const n = size * size, v = new Float32Array(n).fill(0.5), h = new Float32Array(n), warm = new Float32Array(n);
  seed = 99;
  for (let k = 0; k < n / 12; k++) {
    const tone = 0.45 + rand() * 0.45, w = rand();
    blob(size, Math.floor(rand() * size), Math.floor(rand() * size), 1 + rand() * 2.2, (i, f) => { if (f > h[i]) { h[i] = f; v[i] = tone * (0.75 + f * 0.25); warm[i] = w; } });
  }
  const map = pixels(size, (d) => {
    for (let i = 0; i < n; i++) {
      const c = v[i] * (h[i] > 0 ? 1 : 0.55), w = warm[i];
      d[i * 4] = Math.min(255, c * (220 + w * 30)); d[i * 4 + 1] = Math.min(255, c * (200 + w * 15)); d[i * 4 + 2] = Math.min(255, c * (170 - w * 20)); d[i * 4 + 3] = 255;
    }
  });
  return { map: tex(map), normalMap: normalFromHeight(h, size, 3) };
}

// Plain noise in four channels (big soft patches on the ground, leaf dapples, skid marks)
let NOISE = null;
function noiseTexture(size = 256) {
  if (NOISE) return NOISE;
  const L = [fbm(size, 4, 4, 21), fbm(size, 8, 4, 22), fbm(size, 16, 3, 23), fbm(size, 32, 2, 24)];
  NOISE = tex(pixels(size, (d) => { for (let i = 0; i < size * size; i++) for (let k = 0; k < 4; k++) d[i * 4 + k] = L[k][i] * 255; }), false);
  return NOISE;
}

// ---------- photo-scanned surfaces (public/textures/) ----------
// Asphalt scanned from a real race track, a mown lawn and gravel (CC0: Poly Haven asphalt_track and
// gravel_ground_01, ambientCG Grass004), shrunk to 1024 px JPEGs, about 2.5 MB in all. Two files per surface:
//   <name>_color.jpg  the colour
//   <name>_nr.jpg     the bumps (normal map) in red/green and the roughness in blue: one texture instead of two
// They load in the background from the moment the game starts. Until they arrive the surface is just its
// average colour; if a file can't be loaded, that surface is drawn in code (the functions above) instead.
const PHOTOS = {
  asphalt: { color: [63, 62, 61], rough: 212, draw: () => asphaltTextures() },
  grass: { color: [74, 111, 42], rough: 224, draw: () => grassTextures() },
  gravel: { color: [149, 137, 115], rough: 222, draw: () => gravelTextures() },
};
function photoTextures(name) {
  const P = PHOTOS[name];
  const stand = (rgb, srgb) => { // one pixel of the average colour, until the image arrives
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const x = c.getContext('2d'); x.fillStyle = `rgb(${rgb})`; x.fillRect(0, 0, 1, 1);
    const t = tex(c, srgb); t.anisotropy = 16; // sharp tarmac at shallow angles
    return t;
  };
  const out = { map: stand(P.color, true), normalMap: stand([128, 128, P.rough], false) };
  // Same texture objects, new picture: every material using them (and their night copies) updates.
  // dispose() because the new image is a different size, so the GPU copy has to be made again.
  const show = (t, image) => { t.image = image; t.dispose(); t.needsUpdate = true; };
  const load = (file) => new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => ok(img)); // unpack the JPEG now, not mid-race
    img.onerror = () => fail(new Error(file));
    img.src = `/textures/${file}`;
  });
  Promise.all([load(`${name}_color.jpg`), load(`${name}_nr.jpg`)])
    .then(([color, nr]) => { show(out.map, color); show(out.normalMap, nr); })
    .catch((err) => {
      console.warn(`Texture ${err.message} not loaded, drawing the ${name} in code instead.`);
      const d = P.draw(); show(out.map, d.map.image); show(out.normalMap, d.normalMap.image);
    });
  return out;
}

// Ground laid out in world metres (so it's the right size everywhere) with big soft patches that hide
// the repeats, and optional mowing stripes: 'along' = across the run-off strips, 'world' = across the fields.
// normalMap is packed (bumps in red/green, roughness in blue). mix2: blend in a second, turned copy of the
// texture in patches so a texture with distinctive features doesn't show a grid of repeats (2 more lookups).
// layer2: { map, normalMap, tile, amount } – a second ground in big irregular patches with ragged edges
// (lawns and verges among city streets); amount = roughly how much of the ground it covers (0–1).
function worldMaterial({ map, normalMap, tile, stripes = null, patch = 0.22, color = 0xffffff, offset = 0, mix2 = false, layer2 = null }) {
  const m = new THREE.MeshStandardMaterial({ map, color, roughness: 1, normalScale: new THREE.Vector2(0.6, 0.6),
    polygonOffset: offset > 0, polygonOffsetFactor: offset, polygonOffsetUnits: offset * 4 });
  if (normalMap) m.normalMap = normalMap;
  const tNoise = noiseTexture();
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { tNoise: { value: tNoise }, uTile: { value: tile }, uStripe: { value: LOOK.stripe }, uStripeC: { value: LOOK.stripeContrast } });
    if (layer2) Object.assign(sh.uniforms, { tMap2: { value: layer2.map }, tNr2: { value: layer2.normalMap }, uTile2: { value: layer2.tile } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nvarying vec2 vStrip;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvStrip = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tNoise;\nuniform float uTile, uStripe, uStripeC;\nvarying vec3 vWorld;\nvarying vec2 vStrip;' +
        (layer2 ? '\nuniform sampler2D tMap2, tNr2;\nuniform float uTile2;' : ''))
      .replace('#include <map_fragment>', `
        float far = smoothstep(25.0, 140.0, length(vWorld - cameraPosition));
        vec2 tA = vWorld.xz / uTile;
        vec4 col = texture2D(map, tA);
        #ifdef USE_NORMALMAP
          vec4 nr = texture2D(normalMap, tA);
        #else
          vec4 nr = vec4(0.5, 0.5, 1.0, 1.0);
        #endif
        ${mix2 ? `
        vec2 tB = mat2(0.8, 0.6, -0.6, 0.8) * tA * 0.73 + 0.37;          // turned 37 degrees and a bit bigger
        float wB = smoothstep(0.42, 0.58, texture2D(tNoise, vWorld.xz / (uTile * 8.0)).g);
        col = mix(col, texture2D(map, tB), wB);
        #ifdef USE_NORMALMAP
          vec4 nB = texture2D(normalMap, tB);
          nB.xy = mat2(0.8, -0.6, 0.6, 0.8) * (nB.xy * 2.0 - 1.0) * 0.5 + 0.5; // turn its bumps back
          nr = mix(nr, nB, wB);
        #endif` : ''}
        float gL2 = 0.0;
        ${layer2 ? `
        vec4 lBig = texture2D(tNoise, vWorld.xz / 420.0), lEdge = texture2D(tNoise, vWorld.xz / 70.0);
        gL2 = smoothstep(0.47, 0.53, lBig.r * 0.75 + lEdge.b * 0.25 + ${(layer2.amount - 0.5).toFixed(3)});
        vec2 tL2 = vWorld.xz / uTile2;
        col = mix(col, texture2D(tMap2, tL2), gL2);
        nr = mix(nr, texture2D(tNr2, tL2), gL2);` : ''}
        diffuseColor *= mix(col, mix(texture2D(map, vWorld.xz / (uTile * 7.3)), col, gL2), far * 0.6);
        vec4 nz = texture2D(tNoise, vWorld.xz / 160.0);
        diffuseColor.rgb *= 1.0 - ${patch.toFixed(3)} * 0.5 + ${patch.toFixed(3)} * (nz.r * 0.7 + nz.g * 0.3);
        ${stripes === 'along' ? 'diffuseColor.rgb *= 1.0 + uStripeC * (step(0.5, fract(vStrip.y / uStripe)) - 0.5);' : ''}
        ${stripes === 'world' ? 'diffuseColor.rgb *= 1.0 + uStripeC * 0.7 * (step(0.5, fract((vWorld.x * 0.8 + vWorld.z * 0.6) / (uStripe * 1.6))) - 0.5) * (1.0 - far);' : ''}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * nr.b;')
      .replace('#include <normal_fragment_maps>', `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = vec3(nr.xy * 2.0 - 1.0, 0.0);
          mapN.z = sqrt(max(0.0, 1.0 - dot(mapN.xy, mapN.xy)));
          mapN.xy *= normalScale * (1.0 - far);
          // the texture runs along world X and Z, whatever the mesh's own UVs do
          vec3 axX = (viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz, axZ = (viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz;
          axX = normalize(axX - normal * dot(normal, axX)); axZ = normalize(axZ - normal * dot(normal, axZ));
          normal = normalize(mat3(axX, axZ, normal) * mapN);
        #endif`);
  };
  m.customProgramCacheKey = () => `apex-ground-${stripes}-${patch}-${mix2}-${layer2 ? layer2.amount : 'none'}`;
  return m;
}

// The track surface: asphalt at real scale, white edge lines, a darker rubbered racing line (heaviest in
// braking zones and corners) and skid marks where cars brake. Needs roadGeometry() below.
function roadMaterial(asphalt) {
  const m = new THREE.MeshStandardMaterial({ ...asphalt, roughness: 1, normalScale: new THREE.Vector2(0.7, 0.7) });
  const tNoise = noiseTexture();
  // your tyre marks (tyreMarks.js): buildCircuit() plugs in each circuit's marks texture
  const G = MARK_GRID, f = (v) => v.toFixed(3);
  m.userData.marks = { tex: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) }, dims: { value: new THREE.Vector4(1, 1, 1, 1) } };
  m.userData.marks.tex.value.needsUpdate = true;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { tNoise: { value: tNoise }, uRubber: { value: LOOK.rubber }, uSkids: { value: LOOK.skids }, uLine: { value: LOOK.edgeLine },
      tMarks: m.userData.marks.tex, uMarksDim: m.userData.marks.dims, uMarksDark: { value: MARKS.darkness } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRoad;\nattribute float aZone;\nvarying vec4 vRoad;\nvarying float vZone;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad; vZone = aZone;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tNoise, tMarks;\nuniform vec4 uMarksDim;\nuniform float uRubber, uSkids, uLine, uMarksDark;\nvarying vec4 vRoad;\nvarying float vZone;\nfloat gRubber, gLine, gMarks;')
      .replace('#include <map_fragment>', `
        #include <map_fragment>
        vec4 nr = texture2D(normalMap, vNormalMapUv);                        // bumps (red/green) + roughness (blue)
        vec4 nz = texture2D(tNoise, vRoad.xy / 90.0);
        diffuseColor.rgb *= 0.86 + 0.22 * nz.r + 0.1 * (nz.g - 0.5);        // big soft patches: no visible repeats
        diffuseColor.rgb *= 0.88 + 0.24 * texture2D(tNoise, vRoad.xy / 9.0).b; // and smaller blotches of wear
        float d = vRoad.x - vRoad.w;                                        // metres from the racing line
        float tyres = exp(-pow(abs(d) - 0.8, 2.0) / 0.06);                  // the two tyre tracks
        gRubber = clamp((exp(-d * d / 2.4) * 0.65 + tyres * 0.45) * (0.3 + 0.7 * vZone), 0.0, 1.0);
        float streak = smoothstep(0.52, 0.72, texture2D(tNoise, vec2(vRoad.x * 0.8, vRoad.y * 0.004)).b);
        diffuseColor.rgb *= 1.0 - uRubber * gRubber - uSkids * tyres * streak * smoothstep(0.35, 0.85, vZone);
        float mc = vRoad.y / ${f(G.along)};                                 // your tyre marks: find the texel
        float mStrip = floor(mc / uMarksDim.x), mGroup = floor(mStrip / 4.0), mCh = mStrip - mGroup * 4.0;
        float mCol = clamp((vRoad.x + ${f(G.lat)}) / ${f(G.across)}, 0.5, ${f(G.cols - 0.5)});
        vec4 mk = texture2D(tMarks, vec2((mGroup * ${f(G.cols)} + mCol) / uMarksDim.z, (mc - mStrip * uMarksDim.x) / uMarksDim.w));
        gMarks = dot(mk, vec4(equal(vec4(mCh), vec4(0.0, 1.0, 2.0, 3.0))));
        diffuseColor.rgb *= 1.0 - uMarksDark * gMarks;
        float e = vRoad.z - abs(vRoad.x);                                    // metres from the edge
        gLine = smoothstep(0.02, 0.05, e) * (1.0 - smoothstep(uLine, uLine + 0.03, e));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86), gLine);`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness * nr.b;
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.78, gRubber) * (1.0 - 0.25 * gMarks);
        roughnessFactor = mix(roughnessFactor, 0.5, gLine);`)
      .replace('#include <normal_fragment_maps>', `
        vec3 mapN = vec3(nr.xy * 2.0 - 1.0, 0.0);
        mapN.z = sqrt(max(0.0, 1.0 - dot(mapN.xy, mapN.xy)));
        mapN.xy *= normalScale * (1.0 - gLine * 0.7);                       // painted lines are smoother
        normal = normalize(tbn * mapN);`);
  };
  m.customProgramCacheKey = () => 'apex-road';
  return m;
}

let MATS = null;
function materials() {
  if (MATS) return MATS;
  const kerb = canvasTexture(128, 256, (x, w, h) => { // across the kerb: track side at the left
    x.fillStyle = '#cc1d1d'; x.fillRect(0, 0, w, h / 2);
    x.fillStyle = '#ececea'; x.fillRect(0, h / 2, w, h / 2);
    for (let i = 0; i < 260; i++) {                       // tyre rubber: dark streaks, most on the track side
      x.fillStyle = `rgba(18,18,18,${0.04 + Math.random() * 0.12})`;
      x.fillRect(Math.random() ** 1.8 * w * 0.8, Math.random() * h, 1 + Math.random() * 3, 10 + Math.random() * 90);
    }
    for (let i = 0; i < 160; i++) {                       // chipped paint
      x.fillStyle = `rgba(95,95,95,${0.15 + Math.random() * 0.25})`;
      x.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 3, 1 + Math.random() * 2);
    }
    const dust = x.createLinearGradient(w * 0.78, 0, w, 0); // dust on the outer edge
    dust.addColorStop(0, 'rgba(125,112,90,0)'); dust.addColorStop(1, 'rgba(125,112,90,0.4)');
    x.fillStyle = dust; x.fillRect(w * 0.78, 0, w * 0.22, h);
  });
  const checker = canvasTexture(128, 32, (x, w, h) => {
    const s = 8;
    for (let i = 0; i < w / s; i++) for (let j = 0; j < h / s; j++) {
      x.fillStyle = (i + j) % 2 ? '#111' : '#f5f5f5'; x.fillRect(i * s, j * s, s, s);
    }
  }, false);
  const sand = canvasTexture(512, 512, (x, w, h) => noise(x, w, h, '#cdb58a', 0.16, 50000, 2));
  const asphalt = photoTextures('asphalt'), grass = photoTextures('grass'), gravel = photoTextures('gravel');

  const std = (o) => new THREE.MeshStandardMaterial(o);
  MATS = {
    // withLightPools: these show the pools of light under the floodlights at night (lighting.js)
    road: withLightPools(roadMaterial(asphalt)),
    kerb: withLightPools(std({ map: kerb, roughness: 0.55 })),
    // grass, gravel, tarmac run-off, sand and paving: real-world scale with variation
    grass: withLightPools(worldMaterial({ ...grass, tile: LOOK.grassTile, stripes: 'world', patch: 0.35, offset: 2 })),
    runoff: withLightPools(worldMaterial({ ...grass, tile: LOOK.grassTile, stripes: 'along', offset: 1 })),
    runoffTarmac: withLightPools(worldMaterial({ map: asphalt.map, normalMap: asphalt.normalMap, tile: LOOK.asphaltTile, patch: 0.3, color: 0xe4e4e4 })),
    gravel: withLightPools(worldMaterial({ ...gravel, tile: LOOK.gravelTile, patch: 0.15, mix2: true })),
    checker: std({ map: checker, roughness: 0.8 }),
    steel: std({ color: 0x2a2d33, metalness: 0.7, roughness: 0.4 }),
  };
  MATS.terrains = { // scenery.ground in the circuit file
    grass: MATS.grass,
    sand: withLightPools(worldMaterial({ map: sand, tile: 9, patch: 0.3, offset: 2 })),
    // street circuits: city streets (the asphalt scan, a little lighter and more worn than the track)
    // with lawns and verges (the grass scan) in big irregular patches
    city: withLightPools(worldMaterial({ ...asphalt, tile: LOOK.asphaltTile, patch: 0.4, offset: 2, color: 0xffffff,
      layer2: { ...grass, tile: LOOK.grassTile, amount: LOOK.cityGreen } })),
  };
  MATS.terrains.city.color.setScalar(LOOK.cityStreet);
  return MATS;
}

// ---------- geometry helpers ----------
const at = (v, i) => (typeof v === 'function' ? v(i) : v);
// Road height at sample i and `lateral` metres from the centreline (hills + banking)
const hAt = (track, i, lateral = 0) => (track.h ? track.h[i] : 0) + bankLift(track, i, lateral);

// A strip following the track between two lateral offsets (numbers or per-sample functions).
function ribbon(track, inner, outer, y, vScale, include = null) {
  const pos = [], uv = [], idx = [];
  const n = track.n;
  let vert = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (include && !(include[i] || include[j])) continue;
    let ai = at(inner, i), bi = at(outer, i), aj = at(inner, j), bj = at(outer, j);
    let u0 = 0, u1 = 1;
    if (ai > bi) { [ai, bi, aj, bj] = [bi, ai, bj, aj]; [u0, u1] = [1, 0]; } // keep faces pointing up
    // follow the hills and banking
    pos.push(track.cx[i] + track.nx[i] * ai, y + hAt(track, i, ai), track.cz[i] + track.nz[i] * ai);
    pos.push(track.cx[i] + track.nx[i] * bi, y + hAt(track, i, bi), track.cz[i] + track.nz[i] * bi);
    pos.push(track.cx[j] + track.nx[j] * aj, y + hAt(track, j, aj), track.cz[j] + track.nz[j] * aj);
    pos.push(track.cx[j] + track.nx[j] * bj, y + hAt(track, j, bj), track.cz[j] + track.nz[j] * bj);
    const v0 = (i * track.ds) / vScale, v1 = ((i + 1) * track.ds) / vScale;
    uv.push(u0, v0, u1, v0, u0, v1, u1, v1);
    idx.push(vert, vert + 2, vert + 1, vert + 1, vert + 2, vert + 3);
    vert += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Kerbs with a real shape instead of a flat strip: a short ramp up from the track edge, a flat painted top
// about 3 cm high and a rounded drop at the outer edge; the ends slope down into the ground.
// Only looks: the physics doesn't see it. Profile: [fraction of the kerb width, height in metres].
const KERB_PROFILE = [[0, 0], [0.1, 0.02], [0.25, 0.032], [0.82, 0.032], [0.93, 0.022], [1, 0]];
function kerbGeometry(track, side, include) {
  const { n, ds } = track, P = KERB_PROFILE, C = P.length;
  const ramp = new Float32Array(n).fill(99); // samples to the nearest end of this kerb
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < 2 * n; k++) {
      const i = pass ? (2 * n - 1 - k) % n : k % n, prev = pass ? (i + 1) % n : (i + n - 1) % n;
      ramp[i] = include[i] ? Math.min(ramp[i], ramp[prev] + 1) : 0;
    }
  }
  const pos = new Float32Array((n + 1) * C * 3), uv = new Float32Array((n + 1) * C * 2), idx = [];
  for (let k = 0; k <= n; k++) { // row n repeats sample 0, so the paint doesn't jump at the start line
    const i = k % n, up = Math.min(1, ramp[i] / 3);
    for (let c = 0; c < C; c++) {
      const lat = side * (track.hw[i] + track.kerb * P[c][0]), v = k * C + c;
      pos.set([track.cx[i] + track.nx[i] * lat, 0.07 + P[c][1] * up + hAt(track, i, lat), track.cz[i] + track.nz[i] * lat], v * 3);
      uv.set([P[c][0], (k * ds) / 3.5], v * 2);
    }
  }
  for (let k = 0; k < n; k++) {
    if (!(include[k] || include[(k + 1) % n])) continue;
    for (let c = 0; c < C - 1; c++) {
      const a = k * C + c, b = a + 1, e = (k + 1) * C + c, f = e + 1;
      if (side > 0) idx.push(a, e, b, b, e, f); else idx.push(b, f, a, a, f, e); // faces up on both sides
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// The tarmac: like ribbon(), but with real-scale UVs and what the road shader needs per vertex:
// metres across the track, metres round the lap, the half-width, the racing line's offset and
// how much rubber is laid down there (heavy where cars brake and corner, light on the straights).
function roadGeometry(track, y) {
  const { n, ds } = track;
  const v = buildSpeedProfile(track), zone = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const brake = Math.max(0, v[i] - v[(i + 3) % n]) / (3 * ds) / 25; // ~1 = hard braking
    zone[i] = Math.min(1, brake * 1.2 + Math.min(1, track.rcurv[i] * 40) * 0.5);
  }
  for (let pass = 0; pass < 3; pass++) { const c = zone.slice(); for (let i = 0; i < n; i++) zone[i] = (c[(i + n - 1) % n] + c[i] * 2 + c[(i + 1) % n]) / 4; }
  const pos = new Float32Array((n + 1) * 6), uv = new Float32Array((n + 1) * 4), road = new Float32Array((n + 1) * 8), zn = new Float32Array((n + 1) * 2);
  for (let k = 0; k <= n; k++) {
    const i = k % n, hw = track.hw[i];
    for (let e = 0; e < 2; e++) {
      const lat = e ? hw : -hw, j = k * 2 + e;
      pos.set([track.cx[i] + track.nx[i] * lat, y + hAt(track, i, lat), track.cz[i] + track.nz[i] * lat], j * 3);
      uv.set([lat / LOOK.asphaltTile, (k * ds) / LOOK.asphaltTile], j * 2);
      road.set([lat, k * ds, hw, track.ro[i]], j * 4);
      zn[j] = zone[i];
    }
  }
  const idx = [];
  for (let k = 0; k < n; k++) { const a = k * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aRoad', new THREE.BufferAttribute(road, 4));
  g.setAttribute('aZone', new THREE.BufferAttribute(zn, 1));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function nearestTrack(track, x, z) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < track.n; i += 3) {
    const d = (x - track.cx[i]) ** 2 + (z - track.cz[i]) ** 2;
    if (d < best) { best = d; bi = i; }
  }
  return { d: Math.sqrt(best), i: bi };
}

// Local frame at sample i on one side: X along the track, Z away from the track.
function sideFrame(track, i, side, offset) {
  const dx = track.nx[i] * side, dz = track.nz[i] * side;
  const m = new THREE.Matrix4().makeRotationY(Math.atan2(dx, dz));
  m.setPosition(track.cx[i] + dx * offset, hAt(track, i, side * offset) - 0.7, track.cz[i] + dz * offset);
  return m;
}

// Is a building footprint (local X ±halfLen, Z 0..depth) clear of other parts of the circuit?
function footprintClear(track, m, halfLen, depth, i, minDist) {
  const p = new THREE.Vector3();
  for (const lx of [-halfLen, 0, halfLen]) for (const lz of [0, depth / 2, depth]) {
    p.set(lx, 0, lz).applyMatrix4(m);
    const near = nearestTrack(track, p.x, p.z);
    let di = Math.abs(near.i - i); di = Math.min(di, track.n - di);
    if (near.d < minDist && di * track.ds > 40) return false;
    if (near.d < track.hw[near.i] + track.kerb + 2) return false;
  }
  return true;
}

// ---------- trees: broadleaf trees and pines, palms at desert circuits, woods further out ----------
// Broadleaf and pine crowns are bundles of see-through "cards", each showing a painted cluster of leaves
// or a pine branch (leafAtlas below). The card normals point out of the crown, so a tree is lit like one
// big leafy shape while its outline stays ragged and you can see sky through the gaps.
// Each kind is one instanced mesh (one draw call however many trees there are).
function shadeTree(geo, cy, r, dark = 0.55, light = 1.08) { // darker low down and inside the crown
  const p = geo.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = (p.getY(i) - cy) / r, out = Math.hypot(p.getX(i), p.getY(i) - cy, p.getZ(i)) / r;
    col.fill(Math.min(light, Math.max(dark, dark + (light - dark) * (0.5 + y * 0.45) * (0.6 + out * 0.4))), i * 3, i * 3 + 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
const whiteColors = (g) => { g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3)); return g; };

// Leaf atlas, drawn once: left half a round cluster of leaves on twigs, top right a pine branch.
// Light, nearly grey greens: each tree's own colour (instance colour) tints it.
const LEAF_UV = [0, 0, 0.5, 1], PINE_UV = [0.5, 0, 1, 0.5];
let LEAVES = null;
function leafAtlas() {
  if (LEAVES) return LEAVES;
  const W = 1024, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  seed = 17;
  const rgb = (r, g, b) => `rgb(${Math.round(Math.min(1, r) * 255)},${Math.round(Math.min(1, g) * 255)},${Math.round(Math.min(1, b) * 255)})`;
  // leaf cluster
  x.lineCap = 'round';
  for (let k = 0; k < 16; k++) {
    const a = rand() * Math.PI * 2, r = 120 + rand() * 110;
    x.strokeStyle = '#4a3a2a'; x.lineWidth = 1.5 + rand() * 2.5;
    x.beginPath(); x.moveTo(256 + (rand() - 0.5) * 40, 290 + (rand() - 0.5) * 40); x.lineTo(256 + Math.cos(a) * r, 256 + Math.sin(a) * r); x.stroke();
  }
  for (let k = 0; k < 950; k++) {
    const a = rand() * Math.PI * 2, r = 238 * Math.pow(rand(), 0.62);
    const px = 256 + Math.cos(a) * r, py = 256 + Math.sin(a) * r * 0.96, len = 13 + rand() * 15;
    const v = (0.6 + rand() * 0.4) * (0.78 + 0.22 * (r / 238)) * (0.88 + 0.18 * (1 - py / 512));
    x.save(); x.translate(px, py); x.rotate(a + (rand() - 0.5) * 1.8);
    x.fillStyle = rgb(v * (0.84 + (rand() - 0.5) * 0.12), v, v * (0.6 + rand() * 0.12));
    x.beginPath(); x.ellipse(0, 0, len / 2, len * 0.21, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(255,255,230,0.25)'; x.lineWidth = 1; x.beginPath(); x.moveTo(-len * 0.45, 0); x.lineTo(len * 0.45, 0); x.stroke();
    x.restore();
  }
  // pine branch: a stem with sprays of needles, shorter towards the tip
  const bx0 = 520, bx1 = 1012, by = 128;
  const needles = (sx, sy, dirA, reach, count) => {
    for (let k = 0; k < count; k++) {
      const t = k / count, px = sx + Math.cos(dirA) * reach * t, py = sy + Math.sin(dirA) * reach * t, fade = 1 - t * 0.45;
      for (const s of [-1, 1]) {
        const na = dirA + s * (0.7 + rand() * 0.5), nl = (16 + rand() * 18) * fade, v = 0.55 + rand() * 0.45;
        x.strokeStyle = rgb(v * 0.82, v * 0.96, v * 0.8); x.lineWidth = 1.4 + rand() * 0.9;
        x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl); x.stroke();
      }
    }
  };
  x.strokeStyle = '#4b3b2c'; x.lineWidth = 5; x.beginPath(); x.moveTo(bx0, by); x.lineTo(bx1, by); x.stroke();
  for (let t = 0.08; t < 0.9; t += 0.11) { // side shoots
    const sx = bx0 + (bx1 - bx0) * t, reach = (1 - t) * 95 + 25;
    for (const s of [-1, 1]) {
      const a = s * (0.55 + rand() * 0.3);
      x.strokeStyle = '#4b3b2c'; x.lineWidth = 2; x.beginPath(); x.moveTo(sx, by); x.lineTo(sx + Math.cos(a) * reach, by + Math.sin(a) * reach); x.stroke();
      needles(sx, by, a, reach, Math.round(reach / 4));
    }
  }
  needles(bx0, by, 0, bx1 - bx0, 150);
  // fill the see-through pixels with the average leaf colour so edges don't get dark fringes when filtered
  const img = x.getImageData(0, 0, W, H), d = img.data;
  const avg = [0, 0, 0]; let cnt = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { avg[0] += d[i]; avg[1] += d[i + 1]; avg[2] += d[i + 2]; cnt++; }
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 0) { d[i] = avg[0] / cnt; d[i + 1] = avg[1] / cnt; d[i + 2] = avg[2] / cnt; }
  const t = new THREE.DataTexture(new Uint8Array(d.buffer), W, H); // row 0 = v 0 (not flipped)
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4;
  t.needsUpdate = true;
  LEAVES = t;
  return t;
}

// A bundle of cards. Each card: centre o, half-axes a (along the texture's U) and b (along V), an atlas
// rectangle uv, and the crown's normal and shade (darker inside and low down) at any point.
function cardGeometry(list, normalAt, shadeAt) {
  const pos = [], nor = [], uv = [], col = [], idx = [], p = new THREE.Vector3();
  for (const c of list) {
    const base = pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      p.copy(c.o).addScaledVector(c.a, su).addScaledVector(c.b, sv);
      pos.push(p.x, p.y, p.z);
      const nn = normalAt(p); nor.push(nn.x, nn.y, nn.z);
      const sh = shadeAt(p); col.push(sh, sh, sh);
      uv.push(c.uv[0] + ((su + 1) / 2) * (c.uv[2] - c.uv[0]), c.uv[1] + ((sv + 1) / 2) * (c.uv[3] - c.uv[1]));
    }
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
const randomUnit = (v = new THREE.Vector3()) => { const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z); return v.set(r * Math.cos(a), z, r * Math.sin(a)); };

// Leafy crown from overlapping lobes [x, y, z, radius]; cards sit mostly towards the outside of each lobe.
function leafCrown(lobes, centre, radius, perLobe, size) {
  const list = [], up = new THREE.Vector3(0, 1, 0);
  for (const [lx, ly, lz, r, sy = 1] of lobes) {
    const count = Math.max(4, Math.round(r * r * perLobe));
    for (let k = 0; k < count; k++) {
      const dir = randomUnit(), o = new THREE.Vector3(lx, ly, lz).add(dir.clone().multiplyScalar(r * (0.3 + 0.7 * Math.sqrt(rand()))).multiply(new THREE.Vector3(1, sy, 1)));
      const nrm = dir.clone().addScaledVector(randomUnit(), 0.9).normalize();
      const t = new THREE.Vector3().crossVectors(nrm, randomUnit()).normalize(), b = new THREE.Vector3().crossVectors(nrm, t);
      const s = (size[0] + rand() * (size[1] - size[0])) / 2;
      list.push({ o, a: t.multiplyScalar(s), b: b.multiplyScalar(s), uv: LEAF_UV });
    }
  }
  const n = new THREE.Vector3();
  return cardGeometry(list,
    (p) => n.copy(p).sub(centre).divideScalar(radius).addScaledVector(up, 0.35).normalize(),
    (p) => { const d = p.distanceTo(centre) / radius, h = (p.y - centre.y) / radius; return Math.min(1.05, Math.max(0.42, 0.45 + 0.45 * d + 0.18 * h)); });
}

let TREE_KIT = null;
function treeKit() {
  if (TREE_KIT) return TREE_KIT;
  seed = 3;
  const limb = (x0, y0, z0, x1, y1, z1, r0, r1) => { // a branch from one point to another
    const from = new THREE.Vector3(x0, y0, z0), d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), L = d.length();
    const g = new THREE.CylinderGeometry(r1, r0, L, 5, 1, true).translate(0, L / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    return g.translate(from.x, from.y, from.z).toNonIndexed();
  };
  const broadleaf = () => {
    const lobes = [[0, 6.2, 0, 2.6], [1.3, 5.4, 0.4, 1.9], [-1.1, 5.6, -0.6, 2.0], [0.2, 7.4, -0.3, 1.8], [-0.4, 5.0, 1.2, 1.7], [0.9, 6.6, -1.0, 1.6]];
    const crown = leafCrown(lobes, new THREE.Vector3(0, 6.2, 0), 3.6, 3.4, [1.5, 2.4]);
    const trunk = whiteColors(mergeGeometries([
      new THREE.CylinderGeometry(0.22, 0.38, 5, 6).translate(0, 2.5, 0).toNonIndexed(),
      limb(0, 3.8, 0, 1.3, 5.4, 0.4, 0.16, 0.07), limb(0, 4.2, 0, -1.1, 5.6, -0.6, 0.15, 0.07),
      limb(0, 4.6, 0, -0.4, 5.2, 1.2, 0.13, 0.06), limb(0, 4.9, 0, 0.9, 6.6, -1.0, 0.13, 0.06),
    ]));
    return { crown, trunk };
  };
  const pine = () => { // tiers of drooping branches, each two crossed cards so it looks full from the side too
    const list = [], TIERS = 13;
    for (let k = 0; k < TIERS; k++) {
      const t = k / (TIERS - 1), y = 2.6 + t * 7.8, L = 0.6 + Math.pow(1 - t, 1.1) * 2.4, count = t < 0.5 ? 6 : 5;
      for (let b = 0; b < count; b++) {
        const ang = k * 2.4 + (b / count) * Math.PI * 2 + (rand() - 0.5) * 0.4, droop = 0.18 + rand() * 0.25;
        const dir = new THREE.Vector3(Math.cos(ang) * Math.cos(droop), -Math.sin(droop), Math.sin(ang) * Math.cos(droop));
        const side = new THREE.Vector3(-Math.sin(ang), 0, Math.cos(ang)), across = new THREE.Vector3().crossVectors(dir, side).normalize();
        const o = dir.clone().multiplyScalar(L / 2).add(new THREE.Vector3(0, y, 0)), w = L * 0.26;
        list.push({ o, a: dir.clone().multiplyScalar(L / 2), b: side.multiplyScalar(w), uv: PINE_UV });
        list.push({ o: o.clone(), a: dir.clone().multiplyScalar(L / 2), b: across.multiplyScalar(w), uv: PINE_UV });
      }
    }
    for (const b of [new THREE.Vector3(0.32, 0, 0), new THREE.Vector3(0, 0, 0.32)]) // the tip
      list.push({ o: new THREE.Vector3(0, 10.9, 0), a: new THREE.Vector3(0, 0.85, 0), b, uv: PINE_UV });
    const n = new THREE.Vector3();
    const crown = cardGeometry(list,
      (p) => { const r = Math.hypot(p.x, p.z) || 1; return n.set((p.x / r) * 0.85, 0.55, (p.z / r) * 0.85).normalize(); },
      (p) => { const r = Math.hypot(p.x, p.z), reach = 0.6 + Math.pow(1 - (p.y - 2.6) / 7.8, 1.1) * 2.4; return Math.min(1.02, Math.max(0.4, 0.45 + 0.4 * Math.min(1, r / reach) + 0.2 * (p.y / 11))); });
    return { crown, trunk: whiteColors(new THREE.CylinderGeometry(0.14, 0.3, 10.5, 6).translate(0, 5.25, 0).toNonIndexed()) };
  };
  const palm = () => {
    const pts = []; for (let k = 0; k <= 6; k++) pts.push(new THREE.Vector3(Math.sin((k / 6) * 1.2) * 0.9, k * 1.6, 0));
    const top = pts[6], fronds = [];
    for (let f = 0; f < 9; f++) { // leaves that arch up then droop
      const a = (f / 9) * Math.PI * 2 + rand() * 0.3, len = 3.6 + rand() * 0.8, pos = [];
      const at = (t, w) => { const r = t * len, y = top.y + Math.sin(t * 2.2) * 1.1 - t * t * 2.2; return [top.x + Math.cos(a) * r - Math.sin(a) * w, y, top.z + Math.sin(a) * r + Math.cos(a) * w]; };
      for (let q = 0; q < 6; q++) {
        const t0 = q / 6, t1 = (q + 1) / 6, w0 = 0.55 * Math.sin(Math.PI * (0.15 + t0 * 0.85)), w1 = 0.55 * Math.sin(Math.PI * (0.15 + t1 * 0.85));
        pos.push(...at(t0, -w0), ...at(t1, -w1), ...at(t0, w0), ...at(t0, w0), ...at(t1, -w1), ...at(t1, w1));
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
      fronds.push(shadeTree(g, top.y, 3.5, 0.6, 1.05));
    }
    return { crown: mergeGeometries(fronds), trunk: whiteColors(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.22, 6, false).toNonIndexed()) };
  };
  // woods further out: one tall lobe, fewer and bigger cards (they're only seen from far away)
  const far = leafCrown([[0, 6.5, 0, 4.2, 1.3]], new THREE.Vector3(0, 6.5, 0), 4.8, 1.5, [2.6, 3.8]);
  // Leaves: the see-through leaf cards. Both sides use the crown's outward normal (no dark back faces),
  // and alpha-to-coverage softens the cut-out edges when antialiasing is on.
  const foliage = new THREE.MeshStandardMaterial({ map: leafAtlas(), vertexColors: true, roughness: 0.85, alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide });
  foliage.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', `
      float faceDirection = 1.0;
      vec3 normal = normalize(vNormal);
      vec3 nonPerturbedNormal = normal;`);
  };
  foliage.customProgramCacheKey = () => 'apex-foliage';
  foliage.color.setScalar(1.5); // the atlas is mid-grey-green; each tree's colour does the rest
  TREE_KIT = {
    broadleaf: broadleaf(), pine: pine(), palm: palm(), far, foliage,
    palmLeaf: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }),
    bark: new THREE.MeshStandardMaterial({ color: 0x4d3727, roughness: 1, vertexColors: true }),
    palmBark: new THREE.MeshStandardMaterial({ color: 0x8a7556, roughness: 1, vertexColors: true }),
  };
  return TREE_KIT;
}

// ok(x, z, extra): that spot is `extra` metres beyond the barriers and clear of buildings
function buildTrees(track, ground, count, ok, heightAt) {
  const K = treeKit(), group = new THREE.Group();
  seed = 11 + (Math.abs(Math.round(track.cx[0] * 7 + track.cz[0])) % 100000); // the same trees every time
  const beside = (from, to) => { // a spot from–to metres beyond the barrier, somewhere round the lap
    const i = Math.floor(rand() * track.n), side = rand() < 0.5 ? 1 : -1;
    const off = (side > 0 ? track.wallL[i] : track.wallR[i]) + from + rand() ** 1.4 * (to - from);
    return [track.cx[i] + track.nx[i] * side * off, track.cz[i] + track.nz[i] * side * off];
  };
  const kinds = ground === 'sand' ? [['palm', 0.85], ['broadleaf', 0.15]] : ground === 'city' ? [['broadleaf', 0.8], ['palm', 0.2]] : [['broadleaf', 0.62], ['pine', 0.38]];
  const pick = () => { let r = rand(); for (const [k, w] of kinds) if ((r -= w) <= 0) return k; return kinds[0][0]; };
  const spots = { broadleaf: [], pine: [], palm: [] };
  let placed = 0, tries = 0;
  while (placed < count && tries++ < count * 30) {
    const [x, z] = beside(9, 110);
    if (!ok(x, z, 8)) continue;
    const kind = pick();
    spots[kind].push({ x, z, y: heightAt(x, z), s: 0.75 + rand() * 0.75, rot: rand() * 6.3 }); placed++;
    if (ground !== 'sand' && rand() < 0.7) for (let k = 0; k < 3; k++) { // trees grow in clumps
      const nx = x + (rand() - 0.5) * 18, nz = z + (rand() - 0.5) * 18;
      if (ok(nx, nz, 8)) { spots[kind].push({ x: nx, z: nz, y: heightAt(nx, nz), s: 0.7 + rand() * 0.7, rot: rand() * 6.3 }); placed++; }
    }
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const meshes = [];
  const instanced = (geo, mat, list, colour, shadows) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((t, k) => {
      m.compose(p.set(t.x, t.y - 0.2, t.z), q.setFromAxisAngle(up, t.rot), sc.set(t.s * (0.9 + (k % 7) * 0.03), t.s, t.s * (0.9 + (k % 5) * 0.04)));
      mesh.setMatrixAt(k, m); mesh.setColorAt(k, colour());
    });
    mesh.castShadow = shadows; mesh.receiveShadow = true; mesh.computeBoundingSphere();
    group.add(mesh); meshes.push(mesh);
  };
  const leafColour = {
    broadleaf: () => new THREE.Color().setHSL(0.24 + rand() * 0.07, 0.42 + rand() * 0.15, 0.22 + rand() * 0.1),
    pine: () => new THREE.Color().setHSL(0.3 + rand() * 0.05, 0.35 + rand() * 0.1, 0.16 + rand() * 0.06),
    palm: () => new THREE.Color().setHSL(0.22 + rand() * 0.06, 0.45, 0.26 + rand() * 0.08),
  };
  const barkColour = () => new THREE.Color().setHSL(0.08, 0.2, 0.7 + rand() * 0.3);
  for (const kind of ['broadleaf', 'pine', 'palm']) {
    instanced(K[kind].trunk, kind === 'palm' ? K.palmBark : K.bark, spots[kind], barkColour, true);
    instanced(K[kind].crown, kind === 'palm' ? K.palmLeaf : K.foliage, spots[kind], leafColour[kind], true);
  }
  // woods further out (not at desert or city circuits): dense clumps 90–700 m beyond the barriers
  if (ground === 'grass' && LOOK.forest > 0) {
    const far = [], target = Math.round(count * LOOK.forest);
    tries = 0;
    while (far.length < target && tries++ < target * 12) {
      const [x, z] = beside(90, 700);
      if (!ok(x, z, 80)) continue;
      for (let k = 0, cl = 6 + Math.floor(rand() * 14); k < cl && far.length < target; k++) {
        const fx = x + (rand() - 0.5) * 55, fz = z + (rand() - 0.5) * 55;
        far.push({ x: fx, z: fz, y: heightAt(fx, fz), s: 1.1 + rand() * 0.9, rot: rand() * 6.3 });
      }
    }
    instanced(K.far, K.foliage, far, () => new THREE.Color().setHSL(0.26 + rand() * 0.06, 0.38, 0.17 + rand() * 0.07), false);
  }
  return { group, meshes };
}

// ---------- once: sky, sun, ground ----------
export function buildWorld(scene, renderer) {
  const sky = new Sky();
  sky.scale.setScalar(5000);
  const u = sky.material.uniforms;
  u.turbidity.value = 3; u.rayleigh.value = 1.2; u.mieCoefficient.value = 0.0025; u.mieDirectionalG.value = 0.8; // less milky haze
  u.cloudCoverage.value = LOOK.clouds; u.cloudDensity.value = 0.55; u.cloudScale.value = 0.00025; // fuller, softer clouds
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(210));
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

  scene.fog = new THREE.Fog(0xbfd4e6, 300, 3200);
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4a5a30, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2de, 2.6);
  sun.castShadow = GRAPHICS.shadows;
  sun.shadow.mapSize.set(GRAPHICS.shadowMapSize, GRAPHICS.shadowMapSize);
  const sc = sun.shadow.camera; sc.left = sc.bottom = -45; sc.right = sc.top = 45; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // Environment map from the sky so cars get nice reflections.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); const envSky = new Sky(); envSky.scale.setScalar(1000);
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envSky.material.uniforms.showSunDisc.value = 0;
  envScene.add(envSky);
  scene.environment = pmrem.fromScene(envScene).texture;
  scene.environmentIntensity = 0.6;

  const M = materials();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000, 90, 90), M.grass);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -150; // hidden in the haze beyond each circuit's terrain
  ground.receiveShadow = true;
  scene.add(ground);

  return { sun, sunDir, sky, hemi, scene, renderer }; // lighting.js changes these for dusk and night races
}

// ---------- per circuit ----------
export function buildCircuit(track) {
  const M = materials();
  const group = new THREE.Group();
  const add = (mesh) => { if (mesh) group.add(mesh); return mesh; };
  const wallL = (i) => track.wallL[i], wallR = (i) => -track.wallR[i];
  const hwL = (i) => track.hw[i], hwR = (i) => -track.hw[i];   // tarmac edges (width can vary)
  const n = track.n;

  // Ground that follows the hills (grass, desert sand or city paving)
  const terrain = buildTerrain(track, M.terrains[track.scenery.ground] ?? M.terrains.grass);
  add(terrain.mesh);

  // Run-off between the tarmac and the barriers: grass, tarmac or gravel (from the circuit file)
  const looks = [[SURFACES.grass, M.runoff, 0.0, 20], [SURFACES.tarmac, M.runoffTarmac, 0.01, 12], [SURFACES.gravel, M.gravel, 0.02, 12]];
  for (const [code, mat, y, vScale] of looks) {
    for (const [surf, inner, outer] of [[track.surfL, hwL, wallL], [track.surfR, hwR, wallR]]) {
      const mask = surf.map((v) => (v === code ? 1 : 0));
      if (mask.some((v) => v)) add(new THREE.Mesh(ribbon(track, inner, outer, y, vScale, mask), mat)).receiveShadow = true;
    }
  }

  // Tarmac: asphalt, edge lines, rubbered racing line and skid marks, and the marks your tyres leave
  add(new THREE.Mesh(roadGeometry(track, 0.06), M.road)).receiveShadow = true;
  const marks = new TyreMarks(track);
  M.road.userData.marks.tex.value = marks.texture; M.road.userData.marks.dims.value.copy(marks.dims);

  // Kerbs where the track bends
  const bend = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (Math.abs(track.curv[i]) > 0.006) for (let d = -12; d <= 12; d++) bend[(i + d + n) % n] = 1;
  }
  for (const s of [-1, 1]) {
    const g = kerbGeometry(track, s, bend);
    if (g) add(new THREE.Mesh(g, M.kerb)).receiveShadow = true;
  }

  // Barriers: concrete wall blocks with sponsor banners, and the debris fence on top (barriers.js)
  group.add(buildBarriers(track));

  // Start/finish line and gantry with the five start lights
  const h0 = Math.atan2(track.tx[0], track.tz[0]);
  const hw0 = track.hw[0];
  const line = add(new THREE.Mesh(new THREE.PlaneGeometry(hw0 * 2, 1.6), M.checker));
  line.rotation.x = -Math.PI / 2; line.rotation.z = h0;
  line.position.set(track.cx[0], 0.09 + hAt(track, 0), track.cz[0]);

  const gantry = new THREE.Group();
  gantry.position.set(track.cx[0], hAt(track, 0), track.cz[0]);
  gantry.rotation.y = h0;
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), M.steel);
    post.position.set(s * (hw0 + 2.5), 3.75, 0); post.castShadow = true; gantry.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(hw0 * 2 + 5.5, 1.2, 0.6), M.steel);
  beam.position.y = 7; beam.castShadow = true; gantry.add(beam);
  const lights = [];
  for (let i = 0; i < 5; i++) {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.8, 0.4), new THREE.MeshStandardMaterial({ color: 0x0b0b0b }));
    housing.position.set((i - 2) * 1.2, 5.6, -0.35); gantry.add(housing);
    for (const dy of [0.4, -0.4]) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1010, emissiveIntensity: 0 });
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.28, 20), mat);
      lamp.position.set((i - 2) * 1.2, 5.6 + dy, -0.56); lamp.rotation.y = Math.PI; gantry.add(lamp);
      lights.push({ index: i, mat });
    }
  }
  group.add(gantry);

  // Grandstands, the pit building and the pit lane's tarmac and lines (venue.js; the lane's layout is in
  // pitlane.js); before the trees and city buildings, which keep clear of them through `blocked`
  const blocked = [];
  const venue = { sideFrame, footprintClear, heightAt: terrain.heightAt, blocked, ribbon, pitLane: M.runoffTarmac };
  group.add(buildGrandstands(track, venue));
  group.add(buildPits(track, venue));
  group.add(buildPitLane(track, venue));

  // Trees (instanced: hundreds for the cost of two draw calls)
  const TREES = Math.round((track.scenery.trees ?? 350) * GRAPHICS.trees);   // GRAPHICS in settings.js
  const clearOfTrack = (x, z, extra) => { // beyond the barriers by `extra` metres?
    const near = nearestTrack(track, x, z);
    return near.d > Math.max(track.wallL[near.i], track.wallR[near.i]) + extra;
  };
  // City buildings (buildings.js), lined up with the nearest street; placed before the trees so the trees keep clear of them
  const BUILDINGS = Math.round((track.scenery.buildings ?? 0) * GRAPHICS.buildings);
  if (BUILDINGS > 0) {
    const city = buildCity(track, {
      count: BUILDINGS, heightAt: terrain.heightAt, nearest: (x, z) => nearestTrack(track, x, z), clear: clearOfTrack, blocked,
      tall: track.type === 'street' || track.scenery.ground === 'city' ? 70 : 28,
      frontage: track.type === 'street',                      // street circuits: a row of buildings right behind the barriers
    });
    group.add(city.group);
    if (track.time === 'night') darkenAwayFromTrack(track, city.meshes, 20, 120, 0.3); // lit mostly by their windows
  }

  const trees = buildTrees(track, track.scenery.ground ?? 'grass', TREES,
    (x, z, extra) => clearOfTrack(x, z, extra) && !blocked.some(([bx, bz, r]) => (x - bx) ** 2 + (z - bz) ** 2 < r * r),
    terrain.heightAt);
  group.add(trees.group);
  // Dusk and night races: floodlights, lit windows, and dark surroundings away from the track (lighting.js)
  const T = TIMES[track.time] ?? TIMES.day;
  setWindowLights(T.windows);
  setVenueLights(T.windows);                              // stand, garage and glass-floor lights
  const flood = track.time === 'dusk' || track.time === 'night' ? add(buildFloodlights(track, terrain.heightAt)) : null;
  setLightPools(flood?.userData.pools, T.pools ?? 0);      // pools of light on the track under the floodlights
  if (track.time === 'night') {
    const ground = terrain.mesh.material;
    darkenAwayFromTrack(track, [terrain.mesh, ...trees.meshes]);
    // that gives the ground its own copy of the material; keep the ground shader (real-size texture) on it
    Object.assign(terrain.mesh.material, { onBeforeCompile: ground.onBeforeCompile, customProgramCacheKey: ground.customProgramCacheKey });
  }

  return { group, lights, marks };
}

// Free GPU memory when switching circuits (materials/textures are shared, so keep them).
export function disposeCircuit(circuit) {
  circuit.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of o.userData.ownMaterials ?? []) m.dispose(); // per-circuit copies (night lighting)
  });
  circuit.group.removeFromParent();
  circuit.marks?.dispose();
}