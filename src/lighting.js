// Time of day. Each circuit file can set  time: 'day' | 'dusk' | 'night'  (default 'day').
//   applyTimeOfDay() – sky, sun/floodlight, fog, exposure and reflections (called when a circuit loads)
//   buildFloodlights() – light towers along the track for dusk and night races
//   darkenAwayFromTrack() – at night, ground, trees and buildings fade to dark away from the lit track
// To tweak the look, change the numbers in TIMES.
//
// Every time of day is lit by a real sky photo (an HDRI from Poly Haven, free to use, CC0) in
// public/hdri/: the blue of the sky from above, light bouncing up off the grass, and what the cars
// reflect. The sun itself comes from the directional light (so it casts the shadows), so the photo's
// own sun is toned down. At night the photo (a grass field under the night sky, with lamps along the
// horizon) only lights the scene, with the banks of floodlights added to what the cars reflect; the
// sky you see is drawn by a shader (nightDome) so the stars stay pin-sharp at any screen size.
// If a photo can't be loaded, a sky made in code is used instead.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GRAPHICS } from './settings.js';
import { loadModel, instanceModel, inScene } from './models.js';

export const TIMES = {
  //        sun angle (from overhead, compass), light colour and strength, sky/ground fill light, fog, exposure,
  //        reflections/sky light strength (env), sky photo (hdri) and how bright its sun may be (hdriSun)
  day:   { phi: 58, theta: 210, sun: 0xfff4e2, sunI: 3.0, hemiSky: 0xcfe6ff, hemiGround: 0x4a5a30, hemiI: 0.3,
           fog: 0xc3d3e4, fogNear: 500, fogFar: 5500, exposure: 1.0, env: 0.85, windows: 0,
           turbidity: 2.2, rayleigh: 1.5, hdri: 'rooitou_park_1k.hdr', hdriSun: 6 },
  dusk:  { phi: 85, theta: 250, sun: 0xffa45c, sunI: 2.2, hemiSky: 0x9aa4c8, hemiGround: 0x3a3226, hemiI: 0.4,
           fog: 0xc9a08a, fogNear: 350, fogFar: 3800, exposure: 1.1, env: 0.75, windows: 0.7, pools: 0.25,
           turbidity: 6, rayleigh: 2.2, hdri: 'spruit_sunrise_1k.hdr', hdriSun: 4 },
  // At night the "sun" is the floodlighting: bright, white and from high above.
  // pools: how bright the pools of light under the floodlights are (baked, see buildFloodlights).
  night: { phi: 20, theta: 200, sun: 0xf4f6ff, sunI: 0.85, hemiSky: 0x6a7ab0, hemiGround: 0x1c1d22, hemiI: 0.38, pools: 1.5,
           fog: 0x060a14, fogNear: 220, fogFar: 2400, exposure: 1.1, env: 0.7, windows: 1.3,
           hdri: 'moonless_golf_1k.hdr', hdriSun: 20, hdriGain: 0.4 }, // hdriGain: how bright the night photo lights things
};
// The night sky you see (nightDome below). Colours are linear light, so small numbers are normal.
export const NIGHT_SKY = {
  zenith: [0.001, 0.0016, 0.0042],   // straight up: deep navy
  glow: [0.012, 0.011, 0.014],       // near the horizon: the glow of the floodlights in the haze
  cityGlow: [0.03, 0.02, 0.015],     // street circuits: orange city glow
  stars: 1.0,                        // brightness of the stars (0 = none)
  milkyWay: 1.0,                     // brightness of the Milky Way (fainter at street circuits)
};
// Tone mapping: how the bright/dark range is squeezed onto the screen. 'neutral' keeps colours
// (liveries, grass, sky) true to life; 'aces' is punchier and more saturated; 'agx' is softer.
export const TONE = 'neutral';
const TONES = { neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping };

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

// What shiny surfaces (the cars) reflect at night: the night sky (or night photo) plus banks of floodlights all round.
function floodlitEnv(skyTex, photo = false) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide })));
  if (!photo) { // the photo has its own ground
    const ground = new THREE.Mesh(new THREE.CircleGeometry(100, 32), new THREE.MeshBasicMaterial({ color: 0x2a2c31 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -2; s.add(ground);
  }
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

// ---------- sky photos (HDRI) ----------
// Loaded once each. The photo's sun is capped at hdriSun so the directional light stays the only
// sharp sun, and we remember where it was so the photo can be turned to match our sun.
const hdriCache = new Map();
function loadHdri(world, name, sunCap) {
  if (!hdriCache.has(name)) {
    hdriCache.set(name, new HDRLoader().setDataType(THREE.FloatType).loadAsync(`/hdri/${name}`).then((t) => {
      const { data, width: W, height: H } = t.image;
      let best = -1, bi = 0;
      for (let i = 0; i < W * H; i++) {
        const l = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
        if (l > best) { best = l; bi = i; }
        if (l > sunCap) { const k = sunCap / l; data[i * 4] *= k; data[i * 4 + 1] *= k; data[i * 4 + 2] *= k; }
      }
      const sunAngle = (((bi % W) + 0.5) / W - 0.5) * Math.PI * 2; // compass angle of the photo's sun
      t.mapping = THREE.EquirectangularReflectionMapping; t.needsUpdate = true;
      const pmrem = new THREE.PMREMGenerator(world.renderer);
      const env = pmrem.fromEquirectangular(t).texture;
      pmrem.dispose(); t.dispose();
      return { env, sunAngle };
    }));
  }
  return hdriCache.get(name);
}

// Night: the photo, dimmed (hdriGain) and with any bright lamps capped (hdriSun), wrapped round the
// floodlight banks: that's what lights the scene and what the cars reflect.
// No rotation needed: there's no sun to line up.
function loadNightEnv(world, T) {
  const key = `night:${T.hdri}`;
  if (!hdriCache.has(key)) {
    hdriCache.set(key, new HDRLoader().setDataType(THREE.FloatType).loadAsync(`/hdri/${T.hdri}`).then((t) => {
      const { data: d, width: W, height: H } = t.image, gain = T.hdriGain ?? 0.4, cap = T.hdriSun ?? 20;
      const half = new Uint16Array(d.length); // half floats: smooth filtering works on every graphics card
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2], k = gain * (l > cap ? cap / l : 1);
        for (let c = 0; c < 3; c++) half[i + c] = THREE.DataUtils.toHalfFloat(d[i + c] * k);
        half[i + 3] = THREE.DataUtils.toHalfFloat(1);
      }
      t.dispose();
      const sky = new THREE.DataTexture(half, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
      sky.colorSpace = THREE.LinearSRGBColorSpace; sky.mapping = THREE.EquirectangularReflectionMapping;
      sky.minFilter = sky.magFilter = THREE.LinearFilter; sky.generateMipmaps = false; sky.flipY = true;
      sky.needsUpdate = true;
      const pmrem = new THREE.PMREMGenerator(world.renderer);
      const env = pmrem.fromScene(floodlitEnv(sky, true), 0.02).texture;
      pmrem.dispose(); sky.dispose();
      return { env, sunAngle: null };
    }));
  }
  return hdriCache.get(key);
}

// ---------- night sky ----------
// A sphere that follows the camera and is drawn behind everything. The stars are worked out per pixel
// (not a picture), so each one is a crisp dot one or two pixels wide at any resolution; bright ones
// get a little glow and they twinkle slightly. Plus a faint Milky Way and the floodlight glow on the horizon.
function nightDome() {
  const S = NIGHT_SKY, v3 = (a) => new THREE.Vector3(...a);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uZenith: { value: v3(S.zenith) }, uGlow: { value: v3(S.glow) },
      uStars: { value: S.stars }, uMilky: { value: S.milkyWay } },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime, uStars, uMilky;
      uniform vec3 uZenith, uGlow;
      varying vec3 vDir;
      float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
      vec3 hash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
      float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }
      // one layer of stars: at most one per cell of a grid wrapped round the sky
      vec3 stars(vec3 dir, float scale, float density, float bright, float px) {
        vec3 c = floor(dir * scale);
        float h = hash13(c);
        if (h > density) return vec3(0.0);
        vec3 sd = normalize(c + 0.2 + 0.6 * hash33(c));
        float d = length(dir - sd) / px;                       // distance from the star in pixels
        float mag = pow(hash13(c + 7.13), 7.0);                // a few bright stars, lots of faint ones
        float tw = 0.8 + 0.2 * sin(uTime * (1.3 + 4.0 * h / max(density, 1e-4)) + h * 60.0);
        vec3 tint = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.86, 0.68), hash13(c + 3.71));
        return tint * (exp(-d * d * 1.3) + mag * 0.12 * exp(-d * 0.8)) * (0.05 + bright * mag) * tw;
      }
      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y, px = max(length(fwidth(dir)), 1e-5);
        vec3 col = mix(uGlow, uZenith, 1.0 - exp(-max(h, 0.0) * 5.5));
        col *= 1.0 - 0.6 * smoothstep(0.0, -0.12, h);           // below the horizon (mostly hidden)
        float up = smoothstep(0.0, 0.3, h);                     // haze near the horizon hides the stars
        vec3 N = normalize(vec3(0.35, 0.55, 0.76));             // the Milky Way: a soft band of light
        float b = dot(dir, N), band = exp(-b * b / 0.018);
        if (band * uMilky * up > 0.01) {
          float cloud = 0.5 * vnoise(dir * 6.0) + 0.3 * vnoise(dir * 13.0) + 0.2 * vnoise(dir * 27.0);
          col += vec3(0.006, 0.0065, 0.008) * band * smoothstep(0.3, 0.8, cloud) * 2.0 * uMilky * up;
        }
        vec3 st = stars(dir, 55.0, 0.035, 3.0, px) + stars(dir, 130.0, 0.02, 0.8, px) + stars(dir, 260.0, 0.012 * band * uMilky, 0.4, px);
        col += st * uStars * up;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <dithering_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, dithering: true,
  });
  mat.fragmentShader = mat.fragmentShader.replace('uniform float uTime', '#include <common>\n      #include <dithering_pars_fragment>\n      uniform float uTime');
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), mat);
  dome.renderOrder = -1000; dome.frustumCulled = false; // always drawn first, behind everything
  dome.onBeforeRender = (renderer, scene, camera) => { // follow whichever camera is drawing (main view or mirror)
    dome.position.copy(camera.position); dome.updateMatrixWorld();
    mat.uniforms.uTime.value = performance.now() / 1000;
  };
  return dome;
}

// world = what buildWorld() returned. track = the built track (for its time and type).
export function applyTimeOfDay(world, track) {
  const time = TIMES[track.time] ? track.time : 'day', T = TIMES[time];
  const city = track.type === 'street';
  world.renderer.toneMapping = TONES[TONE] ?? THREE.NeutralToneMapping;
  world.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(T.phi), THREE.MathUtils.degToRad(T.theta));
  world.sun.color.setHex(T.sun); world.sun.intensity = T.sunI;
  world.hemi.color.setHex(T.hemiSky); world.hemi.groundColor.setHex(T.hemiGround); world.hemi.intensity = T.hemiI;
  world.scene.fog.color.setHex(T.fog); world.scene.fog.near = T.fogNear; world.scene.fog.far = T.fogFar;
  world.renderer.toneMappingExposure = T.exposure;

  const u = world.sky.material.uniforms;
  u.turbidity.value = T.turbidity ?? 3; u.rayleigh.value = T.rayleigh ?? 1.2;
  u.sunPosition.value.copy(world.sunDir);
  if (time === 'night') {
    world.nightSky ??= [nightSkyTexture(false), nightSkyTexture(true)]; // for reflections until the photo loads
    world.sky.visible = false;
    if (!world.nightDome) { world.nightDome = nightDome(); world.scene.add(world.nightDome); }
    world.nightDome.visible = true;
    world.nightDome.material.uniforms.uGlow.value.set(...(city ? NIGHT_SKY.cityGlow : NIGHT_SKY.glow));
    world.nightDome.material.uniforms.uMilky.value = NIGHT_SKY.milkyWay * (city ? 0.3 : 1);
    world.scene.background = null;
  } else {
    world.sky.visible = true;
    world.scene.background = null;
    if (world.nightDome) world.nightDome.visible = false;
  }
  world.scene.environment = envFor(world, time, city); // straight away; the sky photo replaces it once loaded
  world.scene.environmentRotation.set(0, 0, 0);
  world.scene.environmentIntensity = T.env * 0.6;
  world.timeOfDay = time;
  if (T.hdri) {
    (time === 'night' ? loadNightEnv(world, T) : loadHdri(world, T.hdri, T.hdriSun ?? 6)).then(({ env, sunAngle }) => {
      if (world.timeOfDay !== time) return; // switched circuit meanwhile
      world.scene.environment = env;
      // turn the photo so its bright side is where our sun is
      if (sunAngle != null) world.scene.environmentRotation.set(0, sunAngle - Math.atan2(world.sunDir.z, world.sunDir.x), 0);
      world.scene.environmentIntensity = T.env;
    }).catch((err) => console.warn(`Sky photo /hdri/${T.hdri} not loaded, using the built-in sky.`, err));
  }
  return T;
}

// ---------- floodlights ----------
// Light towers: the "Stadium Light" model (public/models/floodlight_tower.glb, by thundermind, CC BY 4.0,
// simplified for the game): a tall pole with three banks of five round floodlights aimed at the track.
// Until it has loaded (or if it can't be), towers drawn in code stand in: a galvanised pole with a head
// of eight LED floodlights. The lamp faces are very bright LED panels and have a soft glare
// that you only see when a lamp is pointing at you. The light they throw onto the track is worked out
// once when the circuit loads and stored in a texture (the "light pools"), which the ground, kerbs and
// barriers read, so it costs almost nothing while racing.
const poleMat = new THREE.MeshStandardMaterial({ color: 0x8d9299, metalness: 0.75, roughness: 0.42 }); // galvanised steel
const headMat = new THREE.MeshStandardMaterial({ color: 0x2c2f34, metalness: 0.5, roughness: 0.55 });  // painted housings
const FLOOD = { colour: 0xf2f5ff, lens: 9, glare: 0.55 }; // lamp colour, how bright the lamp faces look, glare strength
const towerMat = new THREE.MeshStandardMaterial({ color: 0x6d7279, metalness: 0.6, roughness: 0.45 }); // the model's pole and lamp housings
const towerLampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(FLOOD.colour).multiplyScalar(FLOOD.lens) }); // the model's lamp faces

let lensTex = null;
function lensTexture() { // an LED panel: rows of bright round LEDs in a dark housing
  if (lensTex) return lensTex;
  const c = document.createElement('canvas'); c.width = 64; c.height = 48;
  const x = c.getContext('2d');
  x.fillStyle = '#16181b'; x.fillRect(0, 0, 64, 48);
  for (let r = 0; r < 4; r++) for (let k = 0; k < 6; k++) {
    const g = x.createRadialGradient(6 + k * 10.4, 7 + r * 11, 0, 6 + k * 10.4, 7 + r * 11, 5);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, '#e8ecf5'); g.addColorStop(1, 'rgba(40,44,52,0)');
    x.fillStyle = g; x.fillRect(k * 10.4 + 1, r * 11 + 2, 10, 10);
  }
  lensTex = new THREE.CanvasTexture(c); lensTex.colorSpace = THREE.SRGBColorSpace; lensTex.anisotropy = 4;
  return lensTex;
}

// One tower head, in its own frame: +Z points at the track, the lamps are tilted down.
function headGeometry() {
  const housings = [], lenses = [], TILT = 0.42;
  const bar = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  housings.push(bar(4.3, 0.14, 0.14, 0, 0.72, -0.1), bar(4.3, 0.14, 0.14, 0, -0.72, -0.1), bar(0.16, 1.6, 0.16, 0, 0, -0.18));
  for (let r = 0; r < 2; r++) for (let k = 0; k < 4; k++) {
    const x = -1.62 + k * 1.08, y = r ? 0.36 : -0.36;
    const tilt = new THREE.Matrix4().makeRotationX(TILT + (r ? -0.06 : 0.06)).setPosition(x, y, 0);
    housings.push(new THREE.BoxGeometry(0.92, 0.62, 0.3).applyMatrix4(tilt));
    lenses.push(new THREE.PlaneGeometry(0.8, 0.52).translate(0, 0, 0.152).applyMatrix4(tilt));
  }
  const merge = (list) => { const g = mergeGeometries(list.map((q) => (q.index ? q.toNonIndexed() : q))); g.computeVertexNormals(); return g; };
  return { housings: merge(housings), lenses: mergeGeometries(lenses) };
}

// Glare: a soft glow round each head that only shows when the lamps face you, like a real floodlight.
function glareMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(FLOOD.colour).multiplyScalar(FLOOD.glare) }, uSize: { value: 9 }, uViewH: { value: 800 } },
    vertexShader: `
      attribute vec3 aDir;
      uniform float uSize, uViewH;
      varying float vFace;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 toCam = normalize(cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz);
        vFace = pow(max(dot(aDir, toCam), 0.0), 2.5) * exp(-length(mv.xyz) / 2500.0);
        gl_PointSize = uSize * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 1.0) * (0.45 + 0.55 * vFace);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vFace;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = exp(-d * d * 5.0) * 0.55 + exp(-d * 14.0) * 0.45;
        gl_FragColor = vec4(uColor * a * vFace, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return mat;
}

// ---------- light pools ----------
// Shared by every material that shows the floodlight pools (withLightPools). setLightPools() plugs in
// each circuit's pools; with no floodlights the colour is black and nothing is added.
const blankPools = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat); blankPools.needsUpdate = true;
export const POOLS = { tex: { value: blankPools }, box: { value: new THREE.Vector4(0, 0, 1, 1) }, color: { value: new THREE.Color(0, 0, 0) } };
const POOL_MAX = 3; // brightest light stored in the texture (stored as a square root for more detail in the dark)

// Adds the pools to a MeshStandardMaterial (keeps any shader changes it already has): the light
// falls on the surface's own colour, like real lighting.
export function withLightPools(m) {
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (sh, renderer) {
    prev.call(this, sh, renderer);
    Object.assign(sh.uniforms, { tPools: POOLS.tex, uPoolBox: POOLS.box, uPoolColor: POOLS.color });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vPoolXZ;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPoolXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tPools;\nuniform vec4 uPoolBox;\nuniform vec3 uPoolColor;\nvarying vec2 vPoolXZ;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uPoolColor.r + uPoolColor.g + uPoolColor.b > 0.0) {
          float pl = texture2D(tPools, (vPoolXZ - uPoolBox.xy) / uPoolBox.zw).r;
          totalEmissiveRadiance += diffuseColor.rgb * uPoolColor * pl * pl;
        }`);
  };
  m.customProgramCacheKey = function () { return prevKey.call(this) + '|pools'; };
  return m;
}

// pools = what buildFloodlights() stored in group.userData.pools (or null), strength from TIMES.
export function setLightPools(pools, strength = 1) {
  if (POOLS.tex.value !== blankPools && POOLS.tex.value !== pools?.texture) POOLS.tex.value.dispose();
  POOLS.tex.value = pools?.texture ?? blankPools;
  if (pools) POOLS.box.value.set(pools.x, pools.z, pools.size, pools.size);
  POOLS.color.value.set(pools ? FLOOD.colour : 0x000000).multiplyScalar(pools ? strength * POOL_MAX : 0);
}

// Light from every tower onto the ground, once per circuit. Each tower's lamps are aimed at two
// spots on the track (10 m either side of straight across), so the light falls in soft oval pools.
function bakePools(track, spots) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.cx[i]); maxX = Math.max(maxX, track.cx[i]);
    minZ = Math.min(minZ, track.cz[i]); maxZ = Math.max(maxZ, track.cz[i]);
  }
  const M = 90, size = Math.max(maxX - minX, maxZ - minZ) + 2 * M;
  const N = size > 2400 ? 2048 : 1024, cell = size / N, x0 = minX - M, z0 = minZ - M;
  const E = new Float32Array(N * N), R = 60, cosIn = Math.cos(0.26), cosOut = Math.cos(0.72);
  for (const p of spots) {
    for (const di of [-5, 5]) {
      const i = (p.i + di + track.n) % track.n;
      const ax = track.cx[i], az = track.cz[i], ay = track.h ? track.h[i] : 0;
      let dx = ax - p.x, dy = ay - p.top, dz = az - p.z;
      const dA = Math.hypot(dx, dy, dz); dx /= dA; dy /= dA; dz /= dA;
      const k = (dA * dA) / ((p.top - ay) / dA) / 2;             // each aim spot gets half the tower's light
      const c0 = Math.max(0, Math.floor((ax - R - x0) / cell)), c1 = Math.min(N - 1, Math.ceil((ax + R - x0) / cell));
      const r0 = Math.max(0, Math.floor((az - R - z0) / cell)), r1 = Math.min(N - 1, Math.ceil((az + R - z0) / cell));
      for (let r = r0; r <= r1; r++) {
        const z = z0 + (r + 0.5) * cell;
        for (let c = c0; c <= c1; c++) {
          const x = x0 + (c + 0.5) * cell;
          const px = x - p.x, py = ay - p.top, pz = z - p.z, d = Math.hypot(px, py, pz);
          const cosA = (px * dx + py * dy + pz * dz) / d;
          if (cosA <= cosOut) continue;
          const t = Math.min(1, (cosA - cosOut) / (cosIn - cosOut)), cone = t * t * (3 - 2 * t);
          E[r * N + c] += k * cone * (-py / d) / (d * d);
        }
      }
    }
  }
  const data = new Uint8Array(N * N);
  for (let j = 0; j < N * N; j++) data[j] = Math.round(Math.sqrt(Math.min(1, E[j] / POOL_MAX)) * 255);
  const texture = new THREE.DataTexture(data, N, N, THREE.RedFormat);
  texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
  return { texture, x: x0, z: z0, size };
}

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
  const tall = track.type === 'street' ? 16 : 24;
  const spots = [];
  let side = 1;
  for (let s = 0; s < track.length; s += spacing, side = -side) {
    const i = Math.floor(s / track.ds) % track.n;
    const wall = side > 0 ? track.wallL[i] : track.wallR[i];
    const off = wall + 3;
    const x = track.cx[i] + track.nx[i] * side * off, z = track.cz[i] + track.nz[i] * side * off;
    const near = nearest(x, z);                       // not in the middle of another part of the circuit
    if (near.i >= 0 && near.d < Math.max(track.wallL[near.i], track.wallR[near.i]) + 2) continue;
    const base = groundHeight(x, z), top = Math.max((track.h ? track.h[i] : 0) + tall, base + 10);
    spots.push({ i, x, z, base, top, yaw: Math.atan2(-track.nx[i] * side, -track.nz[i] * side) });
  }
  const group = new THREE.Group();
  const head = headGeometry();
  const pole = new THREE.CylinderGeometry(0.17, 0.34, 1, 10).translate(0, 0.5, 0);
  const poles = new THREE.InstancedMesh(pole, poleMat, spots.length);
  const heads = new THREE.InstancedMesh(head.housings, headMat, spots.length);
  const lensMat = new THREE.MeshBasicMaterial({ map: lensTexture(), color: new THREE.Color(FLOOD.colour).multiplyScalar(FLOOD.lens) });
  const lenses = new THREE.InstancedMesh(head.lenses, lensMat, spots.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const glowPos = [], glowDir = [];
  spots.forEach((p, k) => {
    poles.setMatrixAt(k, m.compose(v.set(p.x, p.base, p.z), q.identity(), new THREE.Vector3(1, p.top - p.base + 0.8, 1)));
    q.setFromAxisAngle(up, p.yaw);
    m.compose(v.set(p.x, p.top, p.z), q, one); heads.setMatrixAt(k, m); lenses.setMatrixAt(k, m);
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);  // lamps face the track, tilted down
    glowPos.push(p.x + fx * 0.3, p.top, p.z + fz * 0.3);
    const d = new THREE.Vector3(fx * Math.cos(0.42), -Math.sin(0.42), fz * Math.cos(0.42));
    glowDir.push(d.x, d.y, d.z);
  });
  for (const o of [poles, heads, lenses]) { o.castShadow = false; o.receiveShadow = o !== lenses; o.computeBoundingSphere(); }
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
  glowGeo.setAttribute('aDir', new THREE.Float32BufferAttribute(glowDir, 3));
  const glareMat = glareMaterial(), size = new THREE.Vector2();
  const glows = new THREE.Points(glowGeo, glareMat);
  glows.frustumCulled = false;
  glows.onBeforeRender = (renderer) => { // points are sized in pixels: keep them right in the mirror too
    const rt = renderer.getRenderTarget();
    glareMat.uniforms.uViewH.value = rt ? rt.height : renderer.getDrawingBufferSize(size).y;
  };
  group.add(poles, heads, lenses, glows);
  group.userData.ownMaterials = [glareMat, lensMat];
  group.userData.pools = bakePools(track, spots);
  // Swap in the tower model once it has loaded: scaled so the middle of its lamp banks is where the
  // lamps are aimed from (the glare and the light pools are worked out from there).
  loadModel('floodlight_tower.glb').then((model) => {
    if (!model || !inScene(group)) return;                       // no model, or the circuit has changed
    const lamp = model.parts.find((p) => p.material.name === 'Material.004') ?? model.parts[0];
    const mid = (lamp.geometry.boundingBox.min.y + lamp.geometry.boundingBox.max.y) / 2;
    const list = spots.map((p) => ({ x: p.x, y: p.base, z: p.z, yaw: p.yaw, s: (p.top - p.base) / mid }));
    const towers = instanceModel(model, list, { shadows: false, material: (m) => (m === lamp.material ? towerLampMat : towerMat) });
    for (const o of [poles, heads, lenses]) { group.remove(o); o.geometry.dispose(); o.dispose(); }
    towers.forEach((t) => group.add(t));
  });
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