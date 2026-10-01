// Tyre marks: the rubber your car leaves on the tarmac. Every lap adds a little, so the line you drive
// slowly shows up on the track (a guide to your own line), and sliding or locking a wheel leaves a dark
// skid mark straight away. Only your car lays rubber, so it's your line you see.
//
// The marks live in a texture laid out along the track (distance round the lap × distance across it),
// which the road shader in scenery.js reads. One per circuit; the marks stay until you change circuit.
// main.js calls update() once a frame with your car.
import * as THREE from 'three';

export const MARKS = {
  enabled: true,
  lap: 0.09,        // how much darker a tyre makes the track each time it rolls over it (1 = fully rubbered)
  slide: 0.7,       // extra when sliding or locking up (skid marks)
  darkness: 0.5,    // how dark a fully rubbered strip is (0.5 = half as bright)
  tyre: 0.38,       // tyre width, metres
};

// Texture layout, shared with the road shader. One texel is 0.25 m along the lap and 0.125 m across,
// covering 10 m either side of the centre line. The lap is cut into strips (rows), and four strips share
// each texel, one per colour channel, so the texture stays small (about 5 MB for a 7 km circuit).
export const MARK_GRID = { along: 0.25, across: 0.125, lat: 10, cols: 160 };
const { along: CELL_S, across: CELL_L, lat: LAT, cols: COLS } = MARK_GRID;

// Where the wheels are relative to the car's centre: [metres forward, metres left, how much rubber]
const WHEELS = [[1.75, 0.8, 0.7], [1.75, -0.8, 0.7], [-1.75, 0.8, 1], [-1.75, -0.8, 1]];
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class TyreMarks {
  constructor(track) {
    this.track = track;
    const cells = Math.ceil(track.length / CELL_S) + 2;
    this.strips = Math.ceil(cells / 4096);            // strips of up to 4096 rows
    this.rows = Math.ceil(cells / this.strips);
    this.groups = Math.ceil(this.strips / 4);         // four strips per texel (R, G, B, A)
    this.width = this.groups * COLS;
    this.data = new Uint8Array(this.width * this.rows * 4);
    this.texture = new THREE.DataTexture(this.data, this.width, this.rows); // RGBA, one byte each
    this.texture.minFilter = THREE.LinearFilter; this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    this.dims = new THREE.Vector4(this.rows, this.strips, this.width, this.rows); // for the shader
    this.prev = [null, null, null, null];
    this.dirty = new Set();
  }

  // Call once a frame with your car's state (from physics.js).
  update(car) {
    if (!MARKS.enabled || car.trackIndex == null || car.s == null) return;
    const t = this.track, i = car.trackIndex, L = t.length;
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    const slide = car.lockF ? 1 : smooth(1.2, 5, car.slip ?? 0);
    const amount = MARKS.lap + MARKS.slide * slide;
    for (let w = 0; w < 4; w++) {
      const [f, l, k] = WHEELS[w];
      const ox = fx * f + fz * l, oz = fz * f - fx * l;  // wheel offset in the world
      let s = car.s + ox * t.tx[i] + oz * t.tz[i];
      const lat = car.lateral + ox * t.nx[i] + oz * t.nz[i];
      s = ((s % L) + L) % L;
      const p = this.prev[w];
      this.prev[w] = { s, lat };
      if (!p) continue;
      let ds = s - p.s;
      if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L; // across the start line
      if (Math.abs(ds) > 12 || Math.abs(lat - p.lat) > 6) continue; // reset or teleported: no streak
      const steps = Math.ceil(Math.abs(ds) / CELL_S);
      for (let n = 1; n <= steps; n++) {
        const q = n / steps, sq = p.s + ds * q, lq = p.lat + (lat - p.lat) * q;
        const idx = Math.min(t.n - 1, Math.floor((((sq % L) + L) % L) / t.ds));
        if (Math.abs(lq) < t.hw[idx]) this.stamp(sq, lq, amount * k); // tarmac only
      }
    }
    this.upload();
  }

  // Add rubber to the texels under one tyre at one spot.
  stamp(s, lat, amount) {
    const L = this.track.length;
    const c = Math.floor((((s % L) + L) % L) / CELL_S);
    const strip = Math.floor(c / this.rows), row = c - strip * this.rows, group = strip >> 2, ch = strip & 3;
    const x0 = (lat - MARKS.tyre / 2 + LAT) / CELL_L, x1 = (lat + MARKS.tyre / 2 + LAT) / CELL_L;
    const base = (row * this.width + group * COLS) * 4 + ch;
    for (let col = Math.max(0, Math.floor(x0)); col <= Math.min(COLS - 1, Math.floor(x1)); col++) {
      const cover = Math.min(col + 1, x1) - Math.max(col, x0); // how much of this texel the tyre covers
      const j = base + col * 4;
      this.data[j] = Math.min(255, this.data[j] + Math.round(amount * 255 * cover));
    }
    this.dirty.add(row * this.groups + group);
  }

  // Send only the changed rows to the graphics card.
  upload() {
    if (!this.dirty.size) return;
    for (const key of this.dirty) {
      const row = Math.floor(key / this.groups), group = key - row * this.groups;
      this.texture.addUpdateRange((row * this.width + group * COLS) * 4, COLS * 4);
    }
    this.dirty.clear();
    this.texture.needsUpdate = true;
  }

  clear() { this.data.fill(0); this.prev.fill(null); this.texture.needsUpdate = true; }
  dispose() { this.texture.dispose(); }
}