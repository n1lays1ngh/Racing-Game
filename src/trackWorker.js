// Puts circuits together off the main thread, so the menu and the live race behind it carry on while you pick one
// (main.js, circuitBuilder below). Two pure number-crunching jobs, the slowest part of building a circuit:
//   • the circuit itself: track.js buildTrack (the centreline, the racing line, the walls…)
//   • its ground: terrain.js terrainGrid (the heights round the circuit, and the forest canopy's lift and tint)
// The 3D scenery is built from them on the main thread (scenery.js circuitSteps), a piece a frame.
//
// Message in:  { id, def: { id, time, lighting } }
// Message out: { id, track, ground } or { id, error }
import { buildTrack, getTrackDef } from './track.js';
import { terrainGrid } from './terrain.js';
import { forestLand } from './forest.js';

self.onmessage = (e) => {
  const { id, def } = e.data;
  try {
    const track = buildTrack({ ...getTrackDef(def.id), time: def.time, lighting: def.lighting });
    const ground = terrainGrid(track, forestLand(track));
    const moved = [ground.pos, ground.uv, ground.index, ground.normal, ground.col].filter(Boolean).map((a) => a.buffer);
    self.postMessage({ id, track, ground }, moved); // (the ground's arrays are handed over, not copied)
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack ?? err) });
  }
};