// Online rooms: the lobby, the start, and keeping everyone's race in step.
//
// The host's browser is the referee: it runs the AI cars and sends every car's position to
// everyone 20 times a second. Each player drives their own car on their own computer (so there's
// no input lag) and sends it to the host 30 times a second. Lap times are measured by whoever
// drives the car, on a clock shared with the host, so everyone's times and the order agree.
//
// Events (session.on(name, fn)):
//   lobby            players or settings changed
//   start (cfg)      a race is starting: build it, then call session.attach(race, cfg)
//   end              the host ended the race (everyone back to the lobby)
//   dnf (car)        someone retired or dropped out mid-race
//   closed (reason)  the room is gone (host left, connection lost)
import { HostRoom, joinRoom, NET } from './peer.js';
import { packSnapshot, packCar, unpack, SNAP, CAR, VERSION } from './protocol.js';
import { makeRemote, applyPacket } from './remote.js';

// One colour per driver: the tower, the map and the name tags use it
export const PLAYER_COLORS = [0xff2a1a, 0x2f7bff, 0xffd400, 0x00d26a, 0xff7a00, 0xb45cff, 0xff4fa3, 0x00e5ff, 0xf2f2f2, 0x9cff2e];
export const MAX_CARS = 20;                   // AI fill the grid up to this
const RATE = { snapshot: 1 / 20, car: 1 / 30 }; // seconds between position updates

export const cleanName = (n) => String(n ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, 14) || 'Driver';
function uniqueName(name, players) {
  let n = name, k = 2;
  while (players.some((p) => p.name.toLowerCase() === n.toLowerCase())) n = `${name.slice(0, 11)} ${k++}`;
  return n;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function within(promise, ms, message) {
  let t;
  return Promise.race([promise, new Promise((_, no) => { t = setTimeout(() => no(new Error(message)), ms); })]).finally(() => clearTimeout(t));
}

export class Session {
  constructor(role) {
    this.role = role; this.isHost = role === 'host';
    this.players = []; this.me = null; this.settings = null; this.code = '';
    this.phase = 'lobby';          // lobby | race
    this.handlers = {};
    this.links = new Map();        // host: player id → connection
    this.offset = 0; this.rtt = 0; this.pings = [];
    this.race = null; this.cfg = null; this.raceNo = 0; this.sendTimer = 0; this.lastSnap = -Infinity; this.inbox = [];
    this.closed = false;
  }
  on(type, fn) { (this.handlers[type] ??= []).push(fn); return this; }
  emit(type, ...args) { for (const fn of this.handlers[type] ?? []) fn(...args); }

  // The host's clock in ms. Start lights, lap times and packet ages all use it.
  now() { return performance.now() + this.offset; }

  // ================= host =================
  static async host(name, settings) {
    const s = new Session('host');
    s.room = await HostRoom.open((link) => s.greet(link));
    s.code = s.room.code;
    s.me = { id: 'host', name: cleanName(name), color: PLAYER_COLORS[0], host: true, ping: 0 };
    s.players = [s.me];
    s.settings = { ...settings };
    s.lobbyTimer = setInterval(() => s.phase === 'lobby' && s.broadcastLobby(), 2000); // fresh pings
    return s;
  }

  greet(link) {
    link.onCtl = (m) => this.fromPlayer(link, m);
    link.onState = (buf) => this.receive(buf, link);
    link.onClose = () => this.lost(link);
    this.links.set(link.id, link);
    setTimeout(() => { if (!link.player) link.drop('no hello'); }, 10000);
  }

  refuse(link, reason) { link.send({ t: 'reject', reason }); setTimeout(() => link.drop('refused'), 400); }

  fromPlayer(link, m) {
    switch (m.t) {
      case 'hello': {
        if (link.player) return;
        if (m.v !== VERSION) return this.refuse(link, 'You and the host have different versions of the game. Both of you refresh the page.');
        if (this.phase !== 'lobby') return this.refuse(link, 'The race has already started. Try again when it ends.');
        if (this.players.length >= NET.maxPlayers) return this.refuse(link, `The room is full (${NET.maxPlayers} drivers).`);
        const used = new Set(this.players.map((p) => p.color));
        const p = { id: link.id, name: uniqueName(cleanName(m.name), this.players),
          color: PLAYER_COLORS.find((c) => !used.has(c)) ?? 0xffffff, host: false, ping: 0 };
        link.player = p; this.players.push(p);
        link.send({ t: 'welcome', you: p, code: this.code, players: this.players, settings: this.settings, phase: this.phase });
        this.broadcastLobby();
        break;
      }
      case 'ping': link.send({ t: 'pong', c: m.c, h: performance.now() }); if (link.player) link.player.ping = Math.round(m.rtt ?? 0); break;
      case 'retire': this.retire(link.id); break;
      case 'bye': link.drop('left'); break;
    }
  }

  lost(link) {
    this.links.delete(link.id);
    const p = link.player;
    if (!p || this.closed) return;
    this.players = this.players.filter((x) => x !== p);
    this.retire(p.id); // mid-race: DNF
    this.broadcastLobby();
  }

  retire(id) {
    const car = this.race?.cars.find((c) => c.humanId === id);
    if (car && car.finishTime == null && !car.dnf) { car.dnf = true; this.emit('dnf', car); }
  }

  broadcastLobby() {
    if (!this.isHost || this.closed) return;
    const m = { t: 'lobby', players: this.players, settings: this.settings, phase: this.phase };
    for (const l of this.links.values()) if (l.player) l.send(m);
    this.emit('lobby');
  }

  setSettings(patch) {
    if (!this.isHost || this.phase !== 'lobby') return;
    Object.assign(this.settings, patch);
    this.broadcastLobby();
  }

  startRace() {
    if (!this.isHost || this.phase !== 'lobby') return;
    const st = this.settings;
    const humans = shuffle(this.players.map(({ id, name, color }) => ({ id, name, color }))); // random order at the back
    const cfg = {
      raceNo: (this.raceNo + 1) & 255, track: st.track, laps: st.laps, difficulty: st.difficulty,
      car: st.car, time: st.time,              // the car everyone races, and when (src/cars/)
      aiCount: Math.max(0, Math.min(st.ai, MAX_CARS - humans.length)), collisions: st.collisions, humans,
      lightsOutAt: 5.4 + Math.random() * 1.2,  // same random start for everyone
      startAt: performance.now() + 1500,       // host clock: time for everyone to build the race
    };
    this.phase = 'race'; this.room.accepting = false;
    for (const l of this.links.values()) if (l.player) l.send({ t: 'start', cfg });
    this.emit('start', { ...cfg, localId: this.me.id });
  }

  // Host: race over, everyone back to the lobby. Player: leave the race (counts as retiring).
  endRace() {
    if (this.isHost) {
      if (this.phase !== 'race') return;
      this.phase = 'lobby'; this.race = null; this.room.accepting = true;
      for (const l of this.links.values()) if (l.player) l.send({ t: 'end' });
      this.broadcastLobby();
    } else {
      if (this.race && this.race.player.finishTime == null) this.hostLink.send({ t: 'retire' });
      this.race = null;
    }
  }

  // ================= player =================
  static async join(code, name, onStatus = () => {}) {
    const { link } = await joinRoom(code, name, onStatus);
    const s = new Session('client');
    s.hostLink = link; s.code = String(code).toUpperCase();
    const welcomed = new Promise((resolve, reject) => { s.waiting = { resolve, reject }; });
    link.onCtl = (m) => s.fromHost(m);
    link.onState = (buf) => s.receive(buf, link);
    link.onClose = () => (s.waiting ? s.waiting.reject(new Error('The host closed the connection.')) : s.close('Lost the connection to the host.'));
    onStatus('Saying hello…');
    link.send({ t: 'hello', name: cleanName(name), v: VERSION });
    try {
      await within(welcomed, 10000, "The host didn't respond.");
    } catch (err) {
      s.closed = true; link.onClose = null; link.drop('failed');
      throw err;
    }
    s.ping(); s.pingTimer = setInterval(() => s.ping(), 1000);
    return s;
  }

  fromHost(m) {
    switch (m.t) {
      case 'welcome':
        this.me = m.you; this.players = m.players; this.settings = m.settings; this.phase = m.phase;
        this.waiting?.resolve(); this.waiting = null;
        this.emit('lobby'); break;
      case 'reject':
        if (this.waiting) { this.waiting.reject(new Error(m.reason)); this.waiting = null; } else this.close(m.reason);
        break;
      case 'lobby':
        this.players = m.players; this.settings = m.settings; this.phase = m.phase ?? this.phase;
        this.emit('lobby'); break;
      case 'start': this.phase = 'race'; this.emit('start', { ...m.cfg, localId: this.me.id }); break;
      case 'end': this.phase = 'lobby'; this.race = null; this.emit('end'); break;
      case 'pong': this.pong(m); break;
      case 'bye': this.close('The host closed the room.'); break;
    }
  }

  // Clock sync: the quickest round trip gives the most accurate reading of the host's clock.
  ping() { this.hostLink.send({ t: 'ping', c: performance.now(), rtt: this.rtt }); }
  pong(m) {
    const now = performance.now(), rtt = now - m.c;
    this.pings.push({ rtt, offset: m.h + rtt / 2 - now });
    if (this.pings.length > 15) this.pings.shift();
    this.offset = this.pings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
    this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
  }

  // ================= during a race (both) =================
  attach(race, cfg) {
    this.race = race; this.cfg = cfg; this.raceNo = cfg.raceNo;
    this.sendTimer = 0; this.lastSnap = -Infinity; this.inbox = [];
    race.lightsOutAt = cfg.lightsOutAt;
    race.countdownClock = () => (this.isHost || this.pings.length ? (this.now() - cfg.startAt) / 1000 : -1); // wait for the clock sync
    for (const car of race.cars) {
      const mine = car.isPlayer || (this.isHost && !car.isHuman); // the host drives the AI
      if (!mine) makeRemote(car, race.track);
    }
    if (this.isHost) { // anyone who dropped out while the race was being built
      for (const car of race.cars) if (car.isHuman && !car.isPlayer && !this.players.some((p) => p.id === car.humanId)) car.dnf = true;
    }
  }

  // Every frame, after race.step(). frameMs: the frame's timestamp (performance.now() time), which is
  // the moment the cars' positions now stand for.
  tick(dt, frameMs = performance.now()) {
    const race = this.race;
    if (!race) return;
    const now = frameMs + this.offset;
    // packets that arrived since the last frame, carried forward to this frame's moment
    for (const [p, link] of this.inbox.splice(0)) this.apply(p, link, (now - p.time) / 1000);
    // back onto the shared clock after a stall (a long frame, the tab in the background)
    if (race.state !== 'countdown') {
      const shared = (now - this.cfg.startAt) / 1000 - race.lightsOutAt;
      if (Math.abs(shared - race.time) > 0.25) race.time = shared;
    }
    // fastest lap of anyone (other people's laps are timed on their own computers)
    let best = null;
    for (const c of race.cars) if (c.bestLap != null && (!best || c.bestLap < best.time)) best = { time: c.bestLap, name: c.team.name };
    race.bestLapOverall = best;

    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = Math.max(0, this.sendTimer + (this.isHost ? RATE.snapshot : RATE.car));
    const t = now;
    if (this.isHost) {
      const buf = packSnapshot(race.cars, this.raceNo, t);
      for (const l of this.links.values()) if (l.player) l.sendState(buf);
    } else {
      this.hostLink.sendState(packCar(race.player, race.cars.indexOf(race.player), this.raceNo, t));
    }
  }

  receive(buf, link) {
    if (!this.race) return;
    const p = unpack(buf);
    if (p && p.raceNo === this.raceNo) this.inbox.push([p, link]); // used on the next frame
  }

  apply(p, link, age) {
    const race = this.race;
    if (this.isHost) {
      if (p.type !== CAR) return;
      const c = p.cars[0], car = race.cars[c.idx];
      if (!car?.net || car.humanId !== link.id || p.time <= car.net.lastTime) return; // only your own car, newest first
      car.net.lastTime = p.time;
      applyPacket(car, c, age);
    } else {
      if (p.type !== SNAP || p.time <= this.lastSnap) return; // packets can arrive out of order
      this.lastSnap = p.time;
      for (const c of p.cars) {
        const car = race.cars[c.idx];
        if (!car?.net) continue; // your own car: you drive it
        if (c.dnf && !car.dnf) this.emit('dnf', car);
        applyPacket(car, c, age);
      }
    }
  }

  // ================= leaving =================
  close(reason) { // the room is gone
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer); clearInterval(this.lobbyTimer);
    this.race = null;
    this.emit('closed', reason);
  }

  leave() { // we're going
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer); clearInterval(this.lobbyTimer);
    this.race = null;
    const bye = (l) => { l.onClose = null; l.send({ t: 'bye' }); setTimeout(() => l.drop('bye'), 300); };
    if (this.isHost) { for (const l of this.links.values()) bye(l); this.room.close(); }
    else bye(this.hostLink);
  }
}