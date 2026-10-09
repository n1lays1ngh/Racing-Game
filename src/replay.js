// Race replays (career races and offline quick races): where every car was, REPLAY.rate times a second, from lights out to when you left the
// race, so the cinematic replay (cinema.js) can film the whole race afterwards. The last REPLAY.keep races of each kind
// (meta.kind: 'career' or 'quick') are kept in this browser (IndexedDB, with the ghost laps: ghost.js); a new one
// replaces the oldest of its kind. Main menu → Race replays (replays.js), the career screen, the results screen.
//
//   const rec = new ReplayRecorder(race, meta)   main.js, a career race starting (meta: track, car, time of day, round…)
//   rec.record()                                 every frame
//   rec.snapshot()                               the replay so far: { id, meta, samples }
//   saveReplay(replay) / loadReplay(id) / listReplays() → [{ id, meta }] newest first
//
// samples: one Float32Array. Each sample is the race time, then RF numbers for each car (race.cars order):
//   x, y, z, heading, pitch, roll, speed, steer, progress (metres since the start: laps × length + distance), flags
//   flags: 1 out of the race, 2 parked by the track (when out), 4 in the pit lane, 8 × (tyre compound + 1)
import { db } from './ghost.js';

export const REPLAY = { rate: 20, keep: 7 };
export const RF = 10;
export const COMPOUNDS = ['soft', 'medium', 'hard'];

export class ReplayRecorder {
  constructor(race, meta = {}) {
    this.race = race; this.n = race.cars.length; this.stride = 1 + this.n * RF;
    this.id = `r${Date.now()}`;
    this.meta = {
      ...meta, laps: race.laps, length: race.track.length, at: Date.now(),
      cars: race.cars.map((c) => ({ name: c.team.name, color: c.team.color, accent: c.team.accent ?? 0xffffff, number: c.team.number ?? 0, isPlayer: c.isPlayer })),
    };
    this.chunks = []; this.cur = new Float32Array(this.stride * 512); this.k = 0; this.next = 0; this.count = 0;
  }
  // every frame: a sample each time the race clock passes the next 1/rate of a second
  record() {
    const r = this.race;
    if (r.state === 'countdown' || r.time < this.next) return;
    this.next = r.time + 1 / REPLAY.rate;
    if (this.k + this.stride > this.cur.length) { this.chunks.push(this.cur); this.cur = new Float32Array(this.stride * 512); this.k = 0; }
    const a = this.cur; let o = this.k;
    a[o++] = r.time;
    for (const c of r.cars) {
      const s = c.state, comp = COMPOUNDS.indexOf(s.tyres?.compound);
      a[o++] = s.x; a[o++] = s.y ?? 0; a[o++] = s.z; a[o++] = s.h; a[o++] = s.pitch ?? 0; a[o++] = s.roll ?? 0;
      a[o++] = s.vf ?? s.speed; a[o++] = s.steer ?? 0; a[o++] = c.progress ?? 0;
      a[o++] = (c.dnf ? 1 : 0) | (c.parked ? 2 : 0) | (s.inPitLane ? 4 : 0) | ((comp + 1) << 3);
    }
    this.k = o; this.count++;
  }
  // the replay so far, in one array (the recorder carries on)
  snapshot(extra = {}) {
    const samples = new Float32Array(this.count * this.stride); let o = 0;
    for (const c of this.chunks) { samples.set(c, o); o += c.length; }
    samples.set(this.cur.subarray(0, this.k), o);
    const st = this.race.standings ?? this.race.cars;
    const results = st.map((c, k) => ({ name: c.team.name, pos: k + 1, dnf: !!c.dnf, isPlayer: c.isPlayer }));
    return { id: this.id, meta: { ...this.meta, ...extra, results, duration: samples.length ? samples[samples.length - this.stride] : 0 }, samples };
  }
}

// ---------- storage: 'index' (the list, small) and 'data:<id>' (each replay) ----------
async function store(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('replays', mode), r = fn(tx.objectStore('replays'));
    tx.oncomplete = () => resolve(r?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function listReplays() {
  try { return (await store('readonly', (s) => s.get('index'))) ?? []; } catch { return []; }
}
export async function saveReplay(replay) {
  try {
    const all = (await listReplays()).filter((r) => r.id !== replay.id), seen = {}, drop = [];
    all.unshift({ id: replay.id, meta: replay.meta });
    const list = all.filter((r) => { // the newest REPLAY.keep of each kind
      const k = r.meta.kind ?? 'career';
      if ((seen[k] = (seen[k] ?? 0) + 1) <= REPLAY.keep) return true;
      drop.push(r); return false;
    });
    await store('readwrite', (s) => {
      s.put({ meta: replay.meta, samples: replay.samples }, `data:${replay.id}`);
      for (const r of drop) s.delete(`data:${r.id}`);
      return s.put(list, 'index');
    });
    return true;
  } catch (err) { console.warn('Replay not saved:', err); return false; }
}
export async function loadReplay(id) {
  try { const r = await store('readonly', (s) => s.get(`data:${id}`)); return r ? { id, ...r } : null; } catch { return null; }
}