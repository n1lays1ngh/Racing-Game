// Hills. Each circuit file has an `elevation` array: road height in metres,
// evenly spaced round the lap starting from its first point (empty = flat).
// applyElevation() turns it into per-sample height, gradient and vertical
// curvature on a built track; physics, AI and scenery read those arrays.


const mod = (v, m) => ((v % m) + m) % m;

function smooth(arr, radius) {
  const n = arr.length, src = Float32Array.from(arr);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += src[(i + k + n) % n];
    arr[i] = s / (2 * radius + 1);
  }
}

// Adds to track t:
//   h[i]     height of the road (m), relative to the circuit's average height
//   grade[i] slope along the lap (rise / run, + = uphill)
//   vcurv[i] vertical curvature (1/m, + = dip/compression, − = crest)
// startAt = distance of sample 0 from the circuit's first point.
export function applyElevation(t, data, startAt) {
  const { n, ds, length } = t;
  t.h = new Float32Array(n); t.grade = new Float32Array(n); t.vcurv = new Float32Array(n);
  if (!data || data.length < 2) return t; // flat
  const m = data.length;
  for (let i = 0; i < n; i++) {
    const f = (mod(startAt + i * ds, length) / length) * m; // position in the data array
    const a = Math.floor(f) % m, b = (a + 1) % m, u = f - Math.floor(f);
    t.h[i] = data[a] + (data[b] - data[a]) * u;
  }
  smooth(t.h, 12); // round off the corners of the 50 m data
  let mean = 0;
  for (let i = 0; i < n; i++) mean += t.h[i] / n;
  for (let i = 0; i < n; i++) t.h[i] -= mean;
  t.hMean = mean; // what was taken off (terrain.js shifts a circuit's real ground by the same)
  for (let i = 0; i < n; i++) t.grade[i] = (t.h[(i + 1) % n] - t.h[(i - 1 + n) % n]) / (2 * ds);
  smooth(t.grade, 8);
  for (let i = 0; i < n; i++) t.vcurv[i] = (t.grade[(i + 1) % n] - t.grade[(i - 1 + n) % n]) / (2 * ds);
  smooth(t.vcurv, 10);
  return t;
}

// Height of the road at distance s along the lap (smoothly interpolated).
export function heightAtS(t, s) {
  const f = mod(s, t.length) / t.ds;
  const i = Math.floor(f) % t.n, j = (i + 1) % t.n, u = f - Math.floor(f);
  return t.h[i] + (t.h[j] - t.h[i]) * u;
}