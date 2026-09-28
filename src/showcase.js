// Behind the main menu: a live AI race on the selected circuit, filmed like a TV broadcast.
// The "director" cuts every few seconds between trackside cameras, a helicopter, low tracking
// shots, a front-on shot and the onboard T-cam, mostly following your car.
import * as THREE from 'three';
import { Race } from './race.js';
import { AIDriver } from './ai.js';
import { pointAt, sampleAt } from './track.js';
import { heightAtS } from './elevation.js';
import { createCarModel, syncCarModel, carCams } from './carModel.js';

const SHOTS = ['trackside', 'tracking', 'heli', 'trackside', 'front', 'tcam', 'trackside', 'tracking'];
const rand = (a, b) => a + Math.random() * (b - a);

export class Showcase {
    constructor(scene, camera) {
        this.scene = scene; this.camera = camera;
        this.race = null; this.models = [];
        this.fade = document.getElementById('cut-fade');
        this.caption = document.getElementById('live-caption');
        this.pos = new THREE.Vector3(); this.look = new THREE.Vector3(); this.lookSmooth = new THREE.Vector3();
    }

    start(track) {
        this.stop();
        this.track = track;
        const race = new Race(track, { laps: 50, difficulty: 'hard' });
        race.player.ai = new AIDriver(race.player.state, track, race.profile, 1.0, 1.12); // your car races too
        race.countdown = race.lightsOutAt;                                                 // lights out straight away
        this.race = race;
        this.models = race.cars.map((c) => {
            const m = createCarModel(c.team, { player: c.isPlayer });
            this.scene.add(m); syncCarModel(m, c.state);
            return m;
        });
        this.shotIndex = -1;
        this.cut('grid');
        if (this.caption) this.caption.textContent = `Live AI race · ${track.name}`;
    }

    stop() {
        for (const m of this.models) this.scene.remove(m);
        this.models = []; this.race = null;
    }

    // ---- the director ----
    cut(kind) {
        const race = this.race;
        this.shot = kind ?? SHOTS[(this.shotIndex = (this.shotIndex + 1) % SHOTS.length)];
        this.shotTime = 0;
        this.shotLength = this.shot === 'grid' ? 6 : rand(4.5, 7);
        // Follow your car most of the time, sometimes whoever is close to someone else (a battle)
        this.target = race.player;
        if (Math.random() < 0.35) {
            const st = race.standings;
            for (let i = 1; i < st.length; i++) if (st[i].gap - st[i - 1].gap < 0.8) { this.target = st[i]; break; }
        }
        const t = this.track, car = this.target.state;
        if (this.shot === 'trackside' || this.shot === 'grid') {
            // A camera beside the track ahead of the car, outside the barrier on the outside of the bend
            const ahead = this.shot === 'grid' ? 40 : Math.min(Math.max(Math.abs(car.vf) * 2.6, 70), 190);
            const s = car.s + ahead, i = sampleAt(t, s);
            const side = Math.sign(t.curv[i]) === 0 ? (Math.random() < 0.5 ? 1 : -1) : -Math.sign(t.curv[i]);
            const lateral = side * (this.shot === 'grid' ? t.hw[i] + t.kerb + 0.6 : (side > 0 ? t.wallL[i] : t.wallR[i]) + 3);
            const p = pointAt(t, s, lateral);
            this.fixed = new THREE.Vector3(p.x, heightAtS(t, s) + (this.shot === 'grid' ? 0.9 : rand(4, 7)), p.z); // above the catch fence
        }
        this.lastD = null; this.receding = false;
        this.orbit = rand(0, Math.PI * 2);
        this.side = Math.random() < 0.5 ? 1 : -1;
        if (this.fade) { this.fade.classList.remove('go'); void this.fade.offsetWidth; this.fade.classList.add('go'); }
        this.snap = true;
    }

    update(dt) {
        const race = this.race; if (!race) return;
        const steps = Math.ceil(dt / (1 / 120));
        for (let k = 0; k < steps; k++) race.step(dt / steps, { throttle: 0, brake: 0, steer: 0 });
        race.takeEvents();
        race.cars.forEach((c, i) => syncCarModel(this.models[i], c.state));

        this.shotTime += dt;
        if (this.shotTime > this.shotLength) this.cut();
        const s = this.target.state, y = s.y ?? 0;
        const fx = Math.sin(s.h), fz = Math.cos(s.h), lx = fz, lz = -fx; // forward and left
        const cam = this.camera, P = this.pos, L = this.look;
        let fov = 50, lag = 0; // lag: seconds the camera takes to catch up (0 = locked on)
        switch (this.shot) {
            case 'grid': case 'trackside': {
                P.copy(this.fixed); L.set(s.x, y + 0.6, s.z);
                const d = P.distanceTo(L);
                fov = THREE.MathUtils.clamp((2 * Math.atan(9 / d) * 180) / Math.PI, 8, 55); // long lens, keeps the car framed
                if (d > 320 || (this.shotTime > 2 && d > 140 && this.receding)) this.cut();  // car long gone: cut early
                this.receding = d > (this.lastD ?? d); this.lastD = d;
                break;
            }
            case 'tracking': { // low, beside the car, slowly swinging round
                const a = this.orbit + this.shotTime * 0.25 * this.side, r = 5.2;
                P.set(s.x + (lx * Math.cos(a) + fx * Math.sin(a)) * r, y + 0.75, s.z + (lz * Math.cos(a) + fz * Math.sin(a)) * r);
                L.set(s.x + fx * 1.5, y + 0.5, s.z + fz * 1.5); fov = 48; break;
            }
            case 'heli': {
                P.set(s.x - fx * 28 + lx * 22 * this.side, y + 30, s.z - fz * 28 + lz * 22 * this.side);
                L.set(s.x + fx * 12, y, s.z + fz * 12); fov = 42; lag = 0.5; break;
            }
            case 'front': { // just ahead of the nose, looking back at the car
                P.set(s.x + fx * 7.5 + lx * 1.2 * this.side, y + 0.9, s.z + fz * 7.5 + lz * 1.2 * this.side);
                L.set(s.x, y + 0.7, s.z); fov = 55; break;
            }
            case 'tcam': {
                const c = carCams(this.models[race.cars.indexOf(this.target)]).tcam;
                P.set(s.x + fx * c.z, y + c.y, s.z + fz * c.z);
                L.set(s.x + fx * 20, y + c.y - 0.5, s.z + fz * 20); fov = 62; break;
            }
        }
        if (this.snap) { cam.position.copy(P); this.lookSmooth.copy(L); this.snap = false; }
        else {
            cam.position.lerp(P, lag > 0 ? 1 - Math.exp(-dt / lag) : 1);
            this.lookSmooth.lerp(L, 1 - Math.exp(-dt * (this.shot === 'trackside' || this.shot === 'grid' ? 6 : 20)));
        }
        cam.lookAt(this.lookSmooth);
        if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 3); cam.updateProjectionMatrix(); }
    }
}