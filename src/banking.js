// Banked corners: the road tilts toward the inside of the turn.
// Each circuit file lists them in `banking: [{ at, len, deg, name, ramp }]`, with
// positions in metres along the lap from its first point (same as stands).
// `at` to `at + len` is fully banked; the banking builds up over `ramp` metres before it and dies away over
// `ramp` metres after it (default RAMP). Steep, wide banking (an oval's 31°) needs a long ramp, ~150 m, or the
// outside edge climbs like a wall.
// The inside edge stays at road height and the outside edge rises, so a 19°
// bank lifts the outer kerb by several metres — just like the real thing.
//
// applyBanking() adds t.bank[i] (radians, + = banked for a left-hander).
// bankLift() / bankRoll() give the extra road height and tilt at any lateral offset.


const RAMP = 45;
const mod = (v, m) => ((v % m) + m) % m;
const smoothstep = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

// The banked surface is the tarmac plus kerbs (t.hw + t.kerb at each sample).
export function applyBanking(t, list, startAt) {
  t.bank = new Float32Array(t.n);
  for (const c of list ?? []) {
    const s0 = mod(c.at - startAt, t.length);
    // Which way does the corner turn? Bank toward the inside.
    let k = 0;
    for (let d = 0; d <= c.len; d += 4) k += t.curv[Math.floor(mod(s0 + d, t.length) / t.ds) % t.n];
    const angle = (Math.sign(k) || 1) * (c.deg * Math.PI) / 180;
    const ramp = Math.max(c.ramp ?? RAMP, 1);
    for (let d = -ramp; d <= c.len + ramp; d += t.ds / 2) {
      const w = d < 0 ? smoothstep((d + ramp) / ramp) : d > c.len ? smoothstep((c.len + ramp - d) / ramp) : 1;
      const i = Math.floor(mod(s0 + d, t.length) / t.ds) % t.n;
      if (Math.abs(angle * w) > Math.abs(t.bank[i])) t.bank[i] = angle * w;
    }
  }
  return t;
}

// Extra road height at sample i, `lateral` metres left (+) / right (−) of the centreline.
export function bankLift(t, i, lateral) {
  const b = t.bank ? t.bank[i] : 0;
  if (!b) return 0;
  const E = t.hw[i] + t.kerb, L = Math.max(-E, Math.min(E, lateral));
  return (E - L * Math.sign(b)) * Math.tan(Math.abs(b));
}

// Sideways tilt of the road surface (radians, + = left side up).
export function bankRoll(t, i, lateral) {
  const b = t.bank ? t.bank[i] : 0;
  return b && Math.abs(lateral) < t.hw[i] + t.kerb ? -b : 0;
}