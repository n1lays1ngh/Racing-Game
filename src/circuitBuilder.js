// Circuits for the menu without freezing it. The slow number crunching (the circuit's data and its ground) runs in a
// worker (trackWorker.js) while the menu and the live race behind it carry on, and the last few circuits are kept,
// so going back to one is instant (and so is starting a race on the one you're looking at).
//
//   const builder = new CircuitBuilder()
//   builder.key(def, setup)       → the circuit as built: its id, time of day and night lighting
//   builder.get(def, setup)       → Promise<{ track, ground } | null>  (null: something else was asked for since)
//   builder.cached(def, setup)    → { track, ground } or null, straight away
//   builder.now(def, setup)       → { track, ground }, built here and now if it isn't kept (a race is starting)
//
// def: a circuit (track.js getTrackDef); setup: { time, lighting } (cars/index.js raceSetup).
// track: track.js buildTrack's circuit; ground: terrain.js terrainGrid's numbers for its ground.
import { buildTrack } from './track.js';
import { terrainGrid } from './terrain.js';
import { forestLand } from './forest.js';

export const CIRCUIT_CACHE = 4; // circuits kept (the Nürburgring's is about 12 MB, most are 1–3 MB)

export class CircuitBuilder {
  constructor() {
    this.kept = new Map();   // key → { track, ground }, oldest first
    this.running = null;     // the worker's job: { key, promise, resolve }
    this.next = null;        // the one to do after it (only the latest: picking quickly through the list skips the rest)
    this.seq = 0;
    try {
      this.worker = new Worker(new URL('./trackWorker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.done(e.data);
      this.worker.onerror = (e) => { console.warn('Circuit worker failed, building circuits on the main thread.', e.message ?? e); this.giveUp(); };
    } catch (err) {
      console.warn('No circuit worker, building circuits on the main thread.', err);
      this.worker = null;
    }
  }

  key(def, setup) { return `${def.id}|${setup.time}|${setup.lighting}`; }

  cached(def, setup) {
    const key = this.key(def, setup), got = this.kept.get(key);
    if (got) { this.kept.delete(key); this.kept.set(key, got); } // most recently used last
    return got ?? null;
  }

  now(def, setup) {
    return this.cached(def, setup) ?? this.keep(this.key(def, setup), build(def, setup));
  }

  get(def, setup) {
    const key = this.key(def, setup), got = this.cached(def, setup);
    if (got) return Promise.resolve(got);
    if (!this.worker) return Promise.resolve(this.now(def, setup));
    if (this.running?.key === key) return this.running.promise;
    if (this.next?.key === key) return this.next.promise;
    this.next?.resolve(null); // skipped: something else was asked for before it started
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.next = { key, def, setup, promise, resolve };
    this.start();
    return promise;
  }

  start() {
    if (this.running || !this.next) return;
    const job = this.next; this.next = null;
    job.id = ++this.seq; this.running = job;
    this.worker.postMessage({ id: job.id, def: { id: job.def.id, time: job.setup.time, lighting: job.setup.lighting } });
  }

  done(msg) {
    const job = this.running;
    if (!job || msg.id !== job.id) return;
    this.running = null;
    if (msg.error) { // (shouldn't happen: the same code as on the main thread) build it here instead
      console.warn('Circuit worker:', msg.error);
      job.resolve(this.now(job.def, job.setup));
    } else job.resolve(this.keep(job.key, { track: msg.track, ground: msg.ground }));
    this.start();
  }

  giveUp() { // the worker can't run here: everything waiting is built on the main thread
    this.worker?.terminate(); this.worker = null;
    for (const job of [this.running, this.next]) if (job) job.resolve(this.now(job.def, job.setup));
    this.running = this.next = null;
  }

  keep(key, entry) {
    this.kept.set(key, entry);
    while (this.kept.size > CIRCUIT_CACHE) this.kept.delete(this.kept.keys().next().value);
    return entry;
  }
}

function build(def, setup) {
  const track = buildTrack({ ...def, time: setup.time, lighting: setup.lighting });
  return { track, ground: terrainGrid(track, forestLand(track)) };
}