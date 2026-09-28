// HTML overlay: speed, gear, rev bar, lap/position, timing, standings,
// minimap and the start lights. Updated every frame from the race state.
import { formatTime } from './race.js';
import { gearbox } from './physics.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor(track) {
    this.el = {
      hud: $('hud'), speed: $('speed'), gear: $('gear'), rev: $('rev-fill'),
      lap: $('lap'), pos: $('pos'), cur: $('t-cur'), last: $('t-last'), best: $('t-best'),
      standings: $('standings'), toast: $('toast'), lights: $('lights'),
      wrong: $('wrongway'), cam: $('cam-name'),
    };
    this.lamps = [...this.el.lights.querySelectorAll('.lamp')];
    this.toastTimer = 0;
    this.setupMinimap(track);
    this.frame = 0;
  }

  setupMinimap(track) {
    const c = $('minimap'); this.map = c; this.mapCtx = c.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = 180; c.width = c.height = size * dpr; c.style.width = c.style.height = size + 'px';
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < track.n; i++) {
      minX = Math.min(minX, track.cx[i]); maxX = Math.max(maxX, track.cx[i]);
      minZ = Math.min(minZ, track.cz[i]); maxZ = Math.max(maxZ, track.cz[i]);
    }
    const pad = 14 * dpr, span = Math.max(maxX - minX, maxZ - minZ);
    const scale = (c.width - pad * 2) / span;
    const ox = pad + ((span - (maxX - minX)) * scale) / 2, oz = pad + ((span - (maxZ - minZ)) * scale) / 2;
    // Mirror X so the map matches what you see from the chase camera.
    this.toMap = (x, z) => [c.width - (ox + (x - minX) * scale), oz + (maxZ - z) * scale];
    // Pre-render the circuit once.
    const bg = document.createElement('canvas'); bg.width = bg.height = c.width;
    const g = bg.getContext('2d');
    g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i <= track.n; i += 2) {
      const [px, py] = this.toMap(track.cx[i % track.n], track.cz[i % track.n]);
      i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
    }
    g.closePath();
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 8 * dpr; g.stroke();
    g.strokeStyle = '#e9ecef'; g.lineWidth = 3.5 * dpr; g.stroke();
    const [sx, sy] = this.toMap(track.cx[0], track.cz[0]);
    g.fillStyle = '#e10600'; g.fillRect(sx - 5 * dpr, sy - 1.5 * dpr, 10 * dpr, 3 * dpr);
    this.mapBg = bg; this.dpr = dpr;
  }

  drawMinimap(race) {
    const g = this.mapCtx, dpr = this.dpr;
    g.clearRect(0, 0, this.map.width, this.map.height);
    g.drawImage(this.mapBg, 0, 0);
    // Draw player last so it sits on top.
    const cars = [...race.cars].sort((a, b) => (a.isPlayer ? 1 : 0) - (b.isPlayer ? 1 : 0));
    for (const car of cars) {
      const [x, y] = this.toMap(car.state.x, car.state.z);
      g.beginPath(); g.arc(x, y, (car.isPlayer ? 5.5 : 4) * dpr, 0, Math.PI * 2);
      g.fillStyle = '#' + car.team.color.toString(16).padStart(6, '0'); g.fill();
      g.lineWidth = 1.5 * dpr; g.strokeStyle = car.isPlayer ? '#fff' : 'rgba(0,0,0,0.7)'; g.stroke();
    }
  }

  update(race, dt) {
    const p = race.player, s = p.state;
    const kmh = Math.round(Math.abs(s.vf) * 3.6);
    const gb = gearbox(Math.abs(s.vf));
    const gear = s.vf < -0.5 ? 'R' : gb.gear;
    this.el.speed.textContent = kmh;
    this.el.gear.textContent = gear;
    this.el.rev.style.transform = `scaleX(${((gb.rpm - 4000) / 9000).toFixed(3)})`;
    this.el.rev.classList.toggle('redline', gb.rpm > 12300);

    const lap = Math.min(Math.max(p.lapsDone + 1, 1), race.laps);
    this.el.lap.innerHTML = `${lap}<small>/${race.laps}</small>`;
    this.el.pos.innerHTML = `${p.position}<small>/${race.cars.length}</small>`;
    const running = race.state === 'racing' && p.finishTime == null;
    this.el.cur.textContent = running ? formatTime(race.time - p.lapStart) : formatTime(p.finishTime ?? 0);
    this.el.last.textContent = formatTime(p.lastLap);
    this.el.best.textContent = formatTime(p.bestLap);

    // Standings every few frames (DOM writes are the slow part).
    if (this.frame++ % 10 === 0 && race.standings) {
      this.el.standings.innerHTML = race.standings.map((c) => {
        const gap = c.position === 1 ? 'Leader' : c.gap > 0 ? '+' + c.gap.toFixed(1) : '';
        const colour = '#' + c.team.color.toString(16).padStart(6, '0');
        return `<li class="${c.isPlayer ? 'me' : ''}"><span class="p">${c.position}</span>` +
          `<span class="sw" style="background:${colour}"></span><span class="n">${c.team.name}</span>` +
          `<span class="g">${c.finishTime != null ? '🏁 ' : ''}${gap}</span></li>`;
      }).join('');
    }

    // Start lights
    const showLights = race.state === 'countdown' || (race.time < 1.2 && race.state === 'racing');
    this.el.lights.classList.toggle('show', showLights);
    this.lamps.forEach((l, i) => l.classList.toggle('on', race.state === 'countdown' && i < race.lightsOn));

    // Wrong way: facing against the track direction while moving
    const t = race.track, i = Math.max(0, s.trackIndex);
    const facing = Math.sin(s.h) * t.tx[i] + Math.cos(s.h) * t.tz[i];
    this.el.wrong.classList.toggle('show', race.state === 'racing' && facing < -0.3 && s.speed > 4);

    if (this.toastTimer > 0) { this.toastTimer -= dt; if (this.toastTimer <= 0) this.el.toast.classList.remove('show'); }
    this.drawMinimap(race);
  }

  toast(text, seconds = 2.2) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('show');
    this.toastTimer = seconds;
  }

  setCamera(name) { this.el.cam.textContent = name; }
  show(v) { this.el.hud.classList.toggle('hidden', !v); }
}
