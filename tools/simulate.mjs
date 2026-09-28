// Headless check: runs a full race with AI in every seat and prints results.
// Usage: node tools/simulate.mjs [laps] [difficulty]
import { buildTrack } from '../src/track.js';
import { Race, formatTime } from '../src/race.js';
import { AIDriver } from '../src/ai.js';

const laps = Number(process.argv[2] ?? 3), difficulty = process.argv[3] ?? 'medium';
const track = buildTrack();
const race = new Race(track, { laps, difficulty });
// Let an AI drive the player's car too.
race.player.ai = new AIDriver(race.player.state, track, race.profile, 0.95);

const dt = 1 / 120;
let wallHits = 0, grass = 0, maxSpeed = 0;
for (let step = 0; step < 120 * 60 * 12; step++) {
  race.step(dt, { throttle: 0, brake: 0, steer: 0 });
  for (const c of race.cars) {
    if (c.state.hitWall > 0.99 - 1e-9 && c.state.hitWall < 1) {}
    if (c.state.surface === 'grass') grass++;
    maxSpeed = Math.max(maxSpeed, c.state.speed);
  }
  if (race.cars.every(c => c.finishTime != null)) break;
}
for (const c of race.cars) if (c.state.hitWall > 0) wallHits++;
console.log(`track ${track.length.toFixed(0)} m, top speed ${(maxSpeed * 3.6).toFixed(0)} km/h, grass samples ${grass}`);
for (const c of race.standings) {
  console.log(`P${c.position} ${c.team.name.padEnd(8)} finish ${formatTime(c.finishTime)} best ${formatTime(c.bestLap)} laps ${c.lapsDone}`);
}
