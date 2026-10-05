// Graphics settings: three presets, Low / Medium / High.
// Switch between them on the main menu, in the pause menu, or press G during a race. The choice is
// remembered in this browser. Press F to show the frame rate.
//
// To tweak a preset, change its numbers below. Roughly in order of how much they help:
//   pixelRatio     render resolution on high-DPI (Retina) screens: 2 = sharpest, 1 = fastest, < 1 = softer still
//   mirror         rear-view mirror on at the start (it draws the whole scene a second time; V still toggles it)
//   mirrorScale    mirror resolution (1 = full, 0.5 = half)       mirrorSamples  mirror edge smoothing (0 = off, 4 = on)
//   shadowCasters  which scenery casts shadows: 'all', 'noTrees' or 'cars' (only the cars; cheapest)
//   shadowMapSize  shadow sharpness: 512 = faster, 2048 = sharper
//   antialias      smooth edges (changes when the page loads: picking it on the main menu reloads the page)
//   trees          multiplies each circuit's scenery.trees (0.5 = half as many, 0 = none)
//   forest         multiplies the woods further out (LOOK.forest in scenery.js)
//   buildings      multiplies scenery.buildings on street circuits
//   viewDistance   metres; things further away aren't drawn (the haze is pulled in to match)
//   detailedCars   how many other cars get the full model at once, the rest the light car (carLod.js): friends'
//                  cars online, and AI Hypercars and GT3s
//   blur           frosted-glass blur behind the HUD and menu panels (redrawn every frame over the 3D view)
// Per circuit, scenery.trees / scenery.buildings in its file still set the base numbers.

export const PRESETS = {
  low: {
    pixelRatio: 0.8, antialias: false,
    shadows: true, shadowMapSize: 512, shadowCasters: 'cars',
    trees: 0.4, forest: 0.15, buildings: 0.6,
    viewDistance: 3000,
    mirror: false, mirrorScale: 0.5, mirrorSamples: 0,
    detailedCars: 1, blur: false,
  },
  medium: {
    pixelRatio: 1, antialias: true,
    shadows: true, shadowMapSize: 1024, shadowCasters: 'noTrees',
    trees: 0.7, forest: 0.5, buildings: 1,
    viewDistance: 5000,
    mirror: true, mirrorScale: 0.6, mirrorSamples: 0,
    detailedCars: 2, blur: false,
  },
  high: { // the game's original look
    pixelRatio: 1.25, antialias: true,
    shadows: true, shadowMapSize: 1024, shadowCasters: 'all',
    trees: 1, forest: 1, buildings: 1.5,
    viewDistance: 8000,
    mirror: true, mirrorScale: 1, mirrorSamples: 4,
    detailedCars: 3, blur: true,
  },
};
export const PRESET_ORDER = ['low', 'medium', 'high'];
export const PRESET_NAMES = { low: 'Low', medium: 'Medium', high: 'High' };
export const DEFAULT_PRESET = 'medium'; // first visit

// The same in every preset
const COMMON = {
  floodlightSpacing: 55,  // metres between light towers at night races (bigger = fewer)
};

const KEY = 'apex-circuit:graphics';
function savedPreset() {
  try { const v = localStorage.getItem(KEY); return PRESETS[v] ? v : null; } catch { return null; } // (not in Node / private mode)
}

// The live settings. Other files read these when they build things, so this object is updated in
// place when you switch preset (main.js then applies what changed).
const start = savedPreset() ?? DEFAULT_PRESET;
export const GRAPHICS = { preset: start, ...COMMON, ...PRESETS[start] };

export function setGraphicsPreset(name) {
  if (!PRESETS[name]) return false;
  Object.assign(GRAPHICS, COMMON, PRESETS[name], { preset: name });
  try { localStorage.setItem(KEY, name); } catch { /* private mode: just not remembered */ }
  return true;
}