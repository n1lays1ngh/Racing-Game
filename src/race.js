// Race logic: grid, start lights, laps, timing, positions, car-to-car contact.
// No rendering here, so a whole race can be simulated headless.
import { createCarState, stepCar, placeCar, CAR } from './physics.js';
import { AIDriver, buildSpeedProfile } from './ai.js';

// The grid: you plus 19 AI drivers (made-up teams). Add or remove entries to change the field size.
// The tower shows the first three letters of each name, so keep those unique.
export const TEAMS = [
  { name: 'You',      color: 0xe10600, accent: 0xffffff, number: 1 },
  { name: 'Vortex',   color: 0x1e41ff, accent: 0xffd400, number: 7 },
  { name: 'Solaris',  color: 0xff8000, accent: 0x111111, number: 4 },
  { name: 'Kestrel',  color: 0x00a19b, accent: 0xe8e8e8, number: 22 },
  { name: 'Nimbus',   color: 0xe8e8e8, accent: 0x0090ff, number: 11 },
  { name: 'Ferro',    color: 0x2b2b2b, accent: 0xff2d55, number: 33 },
  { name: 'Aurora',   color: 0x7a2bd6, accent: 0x00e5ff, number: 16 },
  { name: 'Titan',    color: 0x1b5e20, accent: 0xffd700, number: 14 },
  { name: 'Zephyr',   color: 0x3fb4ff, accent: 0x0b1a3a, number: 23 },
  { name: 'Onyx',     color: 0x121212, accent: 0xd4af37, number: 55 },
  { name: 'Halcyon',  color: 0xff4fa3, accent: 0x1e1e1e, number: 10 },
  { name: 'Raptor',   color: 0xc62828, accent: 0xf5f5f5, number: 31 },
  { name: 'Cobalt',   color: 0x0d47a1, accent: 0xff6d00, number: 2 },
  { name: 'Mistral',  color: 0x9ccc65, accent: 0x263238, number: 27 },
  { name: 'Pulsar',   color: 0xffeb3b, accent: 0x212121, number: 44 },
  { name: 'Ember',    color: 0xff5722, accent: 0x3e2723, number: 18 },
  { name: 'Glacier',  color: 0xb3e5fc, accent: 0x01579b, number: 63 },
  { name: 'Phantom',  color: 0x5d4037, accent: 0xffcc80, number: 81 },
  { name: 'Tempest',  color: 0x00897b, accent: 0xff1744, number: 12 },
  { name: 'Vanta',    color: 0x455a64, accent: 0xaeea00, number: 43 },
];

// How fast the AI is. pace = how close to its own limit it drives (1 = on the limit);
// grip = grip bonus over you (racing games do this so the AI can keep up with a fast human);
// safety = how close to the cornering limit it plans; brakeUse = how late it brakes (1 = latest).
export const DIFFICULTY = {
  easy:   { pace: 0.93, grip: 1.0,  safety: 0.96, brakeUse: 0.85 },
  medium: { pace: 0.97, grip: 1.02, safety: 0.98, brakeUse: 0.92 },
  hard:   { pace: 1.0,  grip: 1.06, safety: 1.0,  brakeUse: 1.0 },
  expert: { pace: 1.0,  grip: 1.15, safety: 1.0,  brakeUse: 1.0 },
};

export class Race {
  constructor(track, { laps = 3, difficulty = 'medium', playerColor } = {}) {
    this.track = track;
    this.laps = laps;
    this.state = 'countdown';     // countdown → racing → finished
    this.time = 0;                // race clock, starts at lights out
    this.countdown = 0;           // time since the lights sequence began
    this.lightsOutAt = 5 + 0.4 + Math.random() * 1.2;
    this.lightsOn = 0;
    const diff = DIFFICULTY[difficulty] ?? DIFFICULTY.medium;
    this.profile = buildSpeedProfile(track, diff.grip, diff.safety, diff.brakeUse);
    this.playerProfile = buildSpeedProfile(track); // for the cool-down lap
    this.cars = [];
    this.leaderTimes = new Float32Array(Math.ceil(((laps + 1) * track.length) / 10) + 10).fill(-1);
    this.events = [];             // messages for the HUD ("New best lap" etc.)

    // Grid: two columns, 8 m between rows, just behind the start line.
    // AI in team order, you at the back of the grid
    const order = [...TEAMS.keys()].filter((k) => k !== 0).concat(0);
    order.forEach((teamIdx, slot) => {
      const team = { ...TEAMS[teamIdx] };
      if (teamIdx === 0 && playerColor != null) team.color = playerColor;
      const state = createCarState(0, 0, 0);
      placeCar(state, track, track.length - 10 - slot * 8, slot % 2 === 0 ? 2.8 : -2.8);
      const car = {
        id: teamIdx, team, state, isPlayer: teamIdx === 0,
        lapsDone: -1, prevS: state.s, progress: 0,
        lapStart: 0, lastLap: null, bestLap: null, finishTime: null,
        position: slot + 1, gap: 0,
      };
      if (!car.isPlayer) {
        const skill = diff.pace * (0.975 + Math.random() * 0.035) * (1 - slot * 0.0015); // front-runners a touch quicker
        car.ai = new AIDriver(state, track, this.profile, Math.min(skill, 1.02), diff.grip);
      }
      this.cars.push(car);
    });
    this.player = this.cars.find(c => c.isPlayer);
    this.bestLapOverall = null;
    this.updatePositions();
    this.cars.forEach((c, i) => { c.position = i + 1; }); // grid order until the start
    this.standings = [...this.cars];
  }

  step(dt, playerInput) {
    if (this.state === 'countdown') {
      this.countdown += dt;
      this.lightsOn = Math.min(5, Math.floor(this.countdown));
      if (this.countdown >= this.lightsOutAt) {
        this.state = 'racing'; this.lightsOn = 0; this.time = 0;
        this.events.push({ type: 'go' });
      }
      for (const c of this.cars) c.state.throttle = c.isPlayer ? playerInput.throttle : 0.4;
      return;
    }

    this.time += dt;
    const states = this.cars.map(c => c.state);
    for (const car of this.cars) {
      const input = car.ai ? car.ai.update(dt, states) : playerInput;
      stepCar(car.state, input, this.track, dt);
      this.updateLap(car);
      if (car.ai) { // AI wedged against a wall or another car for a while: put it back on the track (like pressing R)
        car.stuck = car.state.speed < 1.5 ? (car.stuck ?? 0) + dt : 0;
        if (car.stuck > 2.5) {
          const hw = this.track.hw[car.state.trackIndex] ?? 5;
          placeCar(car.state, this.track, car.state.s, (car.id % 2 ? 1 : -1) * Math.min(2, hw - 1.5));
          car.stuck = 0;
        }
      }
    }
    this.resolveContacts();
    this.updatePositions();
  }

  updateLap(car) {
    const L = this.track.length, s = car.state.s;
    if (car.prevS > L * 0.75 && s < L * 0.25) {
      car.lapsDone++;
      if (car.lapsDone >= 1 && car.finishTime == null) {
        const lap = this.time - car.lapStart;
        car.lastLap = lap; car.lapStart = this.time;
        if (car.bestLap == null || lap < car.bestLap) {
          car.bestLap = lap;
          if (car.isPlayer) this.events.push({ type: 'bestLap', time: lap });
        }
        if (this.bestLapOverall == null || lap < this.bestLapOverall.time) {
          this.bestLapOverall = { time: lap, name: car.team.name };
        }
      }
      if (car.lapsDone >= this.laps && car.finishTime == null) {
        car.finishTime = this.time;
        if (car.isPlayer) {
          this.state = 'finished';
          this.events.push({ type: 'finish' });
          // Hand the player's car to the AI for a cool-down lap.
          car.ai = new AIDriver(car.state, this.track, this.playerProfile, 0.7);
        }
      } else if (car.isPlayer && car.lapsDone === this.laps - 1 && car.lapsDone >= 1) {
        this.events.push({ type: 'finalLap' });
      }
    } else if (car.prevS < L * 0.25 && s > L * 0.75) {
      car.lapsDone--; // crossed the line backwards
    }
    car.prevS = s;
    car.progress = car.lapsDone * L + s;
  }

  updatePositions() {
    const sorted = [...this.cars].sort((a, b) => {
      if (a.finishTime != null && b.finishTime != null) return a.finishTime - b.finishTime;
      if (a.finishTime != null) return -1;
      if (b.finishTime != null) return 1;
      return b.progress - a.progress;
    });
    const L = this.track.length;
    // Leader's timestamp every 10 m → real time gaps for everyone else.
    const lead = sorted[0];
    const idx = Math.floor((lead.progress + L) / 10);
    for (let k = Math.max(0, idx - 3); k <= idx && k < this.leaderTimes.length; k++) {
      if (this.leaderTimes[k] < 0) this.leaderTimes[k] = this.time;
    }
    sorted.forEach((c, i) => {
      c.position = i + 1;
      if (i === 0) { c.gap = 0; return; }
      if (c.finishTime != null) { c.gap = c.finishTime - lead.finishTime; return; }
      const k = Math.floor((c.progress + L) / 10);
      const t = this.leaderTimes[Math.max(0, Math.min(k, this.leaderTimes.length - 1))];
      c.gap = t >= 0 ? this.time - t : 0;
    });
    this.standings = sorted;
  }

  // Each car is two circles (front and rear). Push overlapping cars apart
  // and exchange momentum along the contact normal.
  resolveContacts() {
    const r = CAR.radius, cars = this.cars;
    for (let a = 0; a < cars.length; a++) {
      for (let b = a + 1; b < cars.length; b++) {
        const A = cars[a].state, B = cars[b].state;
        if ((A.x - B.x) ** 2 + (A.z - B.z) ** 2 > 64) continue;
        for (const oa of [1.4, -1.4]) {
          for (const ob of [1.4, -1.4]) {
            const ax = A.x + Math.sin(A.h) * oa, az = A.z + Math.cos(A.h) * oa;
            const bx = B.x + Math.sin(B.h) * ob, bz = B.z + Math.cos(B.h) * ob;
            let dx = bx - ax, dz = bz - az;
            const d = Math.hypot(dx, dz);
            if (d >= 2 * r || d < 1e-4) continue;
            dx /= d; dz /= d;
            const push = (2 * r - d) / 2;
            A.x -= dx * push; A.z -= dz * push;
            B.x += dx * push; B.z += dz * push;
            const rel = (B.vx - A.vx) * dx + (B.vz - A.vz) * dz;
            if (rel < 0) {
              const j = -rel * 0.6; // mostly inelastic
              A.vx -= dx * j; A.vz -= dz * j;
              B.vx += dx * j; B.vz += dz * j;
              if (cars[a].isPlayer || cars[b].isPlayer) {
                const p = cars[a].isPlayer ? A : B;
                p.hitWall = Math.max(p.hitWall, Math.min(1, -rel / 10));
              }
            }
          }
        }
      }
    }
  }

  resetPlayer() {
    const s = this.player.state;
    placeCar(s, this.track, s.s, 0);
  }

  takeEvents() { const e = this.events; this.events = []; return e; }
}

export function formatTime(t) {
  if (t == null || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}