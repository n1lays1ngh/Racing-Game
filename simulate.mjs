// Headless check: runs a full race with AI in every seat and prints results.
// Usage: node tools/simulate.mjs [laps] [difficulty] [track id | all] [car id]
//   e.g. npm run sim -- 3 hard monza        (car: f1 unless you say otherwise; the cars are in src/cars/)
import { buildTrack, getTrackDef, TRACKS } from '../src/track.js';
import { Race, formatTime } from '../src/race.js';
import { AIDriver } from '../src/ai.js';

const laps = Number(process.argv[2] ?? 3), difficulty = process.argv[3] ?? 'medium';
const which = process.argv[4] ?? 'all', car = process.argv[5] ?? 'f1';
const defs = which === 'all' ? TRACKS : [getTrackDef(which)];

for (const def of defs) {
  const track = buildTrack(def);
  const race = new Race(track, { laps, difficulty, car });
  // 'You' = AI driving with the player's grip at full pace (roughly a perfect clean lap).
  race.player.ai = new AIDriver(race.player.state, track, race.playerProfile, 1.0); // no grip bonus: a perfect human

  const dt = 1 / 120;
  let grass = 0, walls = 0, maxSpeed = 0;
  const hit = new Map();
  for (let step = 0; step < 120 * 60 * 20; step++) {
    race.step(dt, { throttle: 0, brake: 0, steer: 0 });
    for (const c of race.cars) {
      if (!['road', 'kerb'].includes(c.state.surface)) grass++; // off the track (grass, gravel or run-off)
      if (c.state.hitWall > 0 && !hit.get(c)) { walls++; hit.set(c, true); }
      if (c.state.hitWall === 0) hit.set(c, false);
      maxSpeed = Math.max(maxSpeed, c.state.speed);
    }
    if (race.cars.every(c => c.finishTime != null)) break;
  }
  console.log(`\n${track.name} (${race.carDef.name}): ${track.length.toFixed(0)} m, top speed ${(maxSpeed * 3.6).toFixed(0)} km/h, off-track samples ${grass}, wall hits ${walls}`);
  for (const c of race.standings) {
    console.log(`  P${c.position} ${c.team.name.padEnd(8)} finish ${formatTime(c.finishTime)} best ${formatTime(c.bestLap)} laps ${c.lapsDone}`);
  }
}
