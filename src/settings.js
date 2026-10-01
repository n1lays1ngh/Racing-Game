// Graphics settings. If the game lags, lower these (roughly in order of how much they help).
export const GRAPHICS = {
  pixelRatio: 1.25,        // render resolution on high-DPI (Retina) screens: 2 = sharpest, 1 = fastest
  shadows: true,          // car and scenery shadows
  shadowMapSize: 1024,    // shadow sharpness: 512 = faster, 2048 = sharper
  antialias: true,        // smooth edges (needs a page reload to change)
  trees: 1,               // multiplies each circuit's scenery.trees (0.5 = half as many, 0 = none)
  buildings: 1.5,           // multiplies scenery.buildings on street circuits
  floodlightSpacing: 55,  // metres between light towers at night races (bigger = fewer)
  viewDistance: 8000,    // metres; things further away aren't drawn
};
// Also: press V in a race to turn the rear-view mirror off (it draws the scene a second time),
// and keep CAR_MODEL.forAI = false in carModel.js (the RB19 is heavier than the built-in car).