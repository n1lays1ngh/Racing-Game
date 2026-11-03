// Voice chat with your friends in an online room: in the lobby and on the grid everyone hears everyone; in the race
// you hear the cars near you, from where they are (left, right, behind), fading out with distance.
//
// How it's connected: every pair of friends who have voice on gets a direct audio connection of its own (WebRTC, like
// the race data in peer.js), set up through the messages that already go through the host (session.js 'v'). The
// voices never go through the host, so its connection carries no more than before. A voice that's out of range in the
// race isn't sent at all (the sender stops sending, since both ends know where both cars are).
//
//   const voice = new VoiceChat({ notice })   notice(text): something to tell you (the microphone is blocked, say)
//   voice.attach(session | null)              joined a room / left it (main.js, the lobby's onSession)
//   voice.update(race, camera)                every frame: where the voices come from, who's talking, the indicator
//
// Settings (options.js; pause → Settings and the main menu's Settings):
//   voice      on / off: in voice chat at all (you hear your friends and they hear you)
//   mic        'ptt' (hold X, RB on a controller, Talk on a phone) | 'open' (always on) | 'muted' (listen only)
//   voiceRange 'near' (in the race: the cars near you) | 'all' (everyone, all race)
import { newConnection, gathered } from './peer.js';
import { OPTIONS, onOption } from '../options.js';
import { IS_MOBILE } from '../mobile/detect.js';

export const VOICE = {
  near: 30,          // m: full volume this close
  far: 260,          // m: silent this far away (and not sent at all)
  stopSending: 1.15, // … sending stops past far × this (and starts again inside far: no flicker at the edge)
  bitrate: 24000,    // bits/s: speech, plenty clear
  key: 'KeyX',       // push to talk (input.js: RB on a controller; touch.js: Talk on a phone)
  talkLevel: 0.012,  // loudness that counts as talking (the indicator)
  talkHold: 0.35,    // s: the indicator stays this long after they stop
  volume: 1.2,       // voices against the game's sound
  retries: 3,        // a connection that fails is tried again this many times
};

const ac = () => window.AudioContext || window.webkitAudioContext;
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const hex = (c) => '#' + (c ?? 0xffffff).toString(16).padStart(6, '0');
const typing = (e) => { const t = e.target; return t instanceof Element && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };

// Ask the other end's encoder for speech settings: silence isn't sent (DTX), mono, a modest bitrate
function speechSdp(sdp) {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!pt) return sdp;
  const extra = { usedtx: 1, stereo: 0, maxaveragebitrate: VOICE.bitrate };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (line, params) => {
      const have = new Set(params.split(';').map((p) => p.split('=')[0].trim()));
      const add = Object.entries(extra).filter(([k]) => !have.has(k)).map(([k, v]) => `${k}=${v}`);
      return add.length ? `${line};${add.join(';')}` : line;
    });
  }
  return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000[^\\r\\n]*)(\\r?\\n)`, 'i'),
    `$1$2a=fmtp:${pt} ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(';')}$2`);
}

export class VoiceChat {
  constructor({ notice = () => {} } = {}) {
    this.notice = notice;
    this.session = null;
    this.peers = new Map();  // player id → { id, pc, sender, nodes, sending, talking, … }
    this.mic = null;         // { stream, track, analyser }
    this.micAsk = null;      // asking for the microphone (a promise)
    this.ctx = null;         // the voices' own audio (not the engine's: M mutes the game, not your friends)
    this.ptt = false;        // push to talk held
    this.offers = 0; this.frame = 0; this.carOf = new Map(); this.carsOf = null;
    this.buf = new Float32Array(512);

    // the indicator: who's talking, and you (plus a Talk button off the race on a touch screen)
    const el = this.el = document.createElement('div');
    el.id = 'voice-hud'; el.className = 'hidden';
    el.innerHTML = '<div class="vh-me"><i class="vh-mic"></i><span></span></div><div class="vh-list"></div>' +
      '<button type="button" class="vh-talk">Hold to talk</button>';
    document.body.appendChild(el);
    this.meEl = el.querySelector('.vh-me'); this.listEl = el.querySelector('.vh-list'); this.talkBtn = el.querySelector('.vh-talk');
    this.shown = '';

    // push to talk: X (or a controller's RB / the Talk button: input.js and touch.js press X), or hold the button
    window.addEventListener('keydown', (e) => { if (e.code === VOICE.key && !typing(e)) this.ptt = true; });
    window.addEventListener('keyup', (e) => { if (e.code === VOICE.key) this.ptt = false; });
    window.addEventListener('blur', () => { this.ptt = false; });
    const hold = (on) => (e) => { e.preventDefault(); this.ptt = on; };
    this.talkBtn.addEventListener('pointerdown', hold(true));
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) this.talkBtn.addEventListener(t, hold(false));
    this.talkBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    // sound only starts after a click or a key: start the voices' audio on the next one if it's waiting
    const wake = () => { if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); };
    window.addEventListener('pointerdown', wake); window.addEventListener('keydown', wake);

    onOption((key) => { if (key === 'voice' || key === 'mic') this.sync(); });
  }

  get on() { return !!OPTIONS.voice && !!this.session && !this.session.closed && !!this.session.me; }

  attach(session) {
    if (session === this.session) return;
    this.closeAll(); this.stopMic();
    this.session = session;
    if (session) {
      session.on('voice', ({ from, d }) => { if (session === this.session) this.signal(from, d); });
      session.on('lobby', () => { if (session === this.session) this.sync(); });
    }
    this.sync();
  }

  // the voices' audio, made the first time it's needed
  audio() {
    if (!this.ctx) {
      const C = ac();
      if (!C) return null;
      this.ctx = new C();
      this.bus = this.ctx.createGain(); this.bus.gain.value = VOICE.volume;
      this.bus.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // ---------- who to be connected to ----------
  sync() {
    document.body.classList.toggle('voice-ptt', this.on && OPTIONS.mic === 'ptt');
    if (!this.on) {
      if (this.peers.size) { for (const p of this.peers.values()) this.send(p.id, { k: 'bye' }); this.closeAll(); }
      this.stopMic();
      return;
    }
    this.audio();
    if (OPTIONS.mic === 'muted') this.stopMic(); else this.startMic();
    const me = this.session.me.id, ids = new Set(this.session.players.map((p) => p.id).filter((id) => id !== me));
    for (const [id, p] of this.peers) if (!ids.has(id)) { this.closePeer(p); this.peers.delete(id); } // (left the room)
    for (const id of ids) if (!this.peers.has(id)) { this.peers.set(id, this.newPeer(id)); this.send(id, { k: 'hi' }); }
  }

  newPeer(id) { return { id, pc: null, sender: null, nodes: null, sending: true, talking: false, until: 0, tries: 0, offer: 0, retry: 0, calling: false }; }
  offerer(id) { return this.session.me.id < id; } // (of each pair, the one whose id sorts first makes the call)
  send(to, d) { this.session?.sendVoice?.(to, d); }

  // messages from the other end of a pair (through the host)
  async signal(from, d) {
    if (!this.on || !d) return;
    if (!this.session.players.some((p) => p.id === from)) return;
    let peer = this.peers.get(from);
    if (!peer) { peer = this.newPeer(from); this.peers.set(from, peer); }
    const dead = !peer.pc || ['failed', 'closed'].includes(peer.pc.connectionState);
    try {
      if (d.k === 'hi') {
        if (this.offerer(from)) { if (dead && !peer.calling) { peer.tries = 0; await this.call(peer); } }
        else if (!d.re) { if (dead) this.closePeer(peer); this.send(from, { k: 'hi', re: 1 }); } // (so they call)
      } else if (d.k === 'offer' && !this.offerer(from)) {
        await this.answer(peer, d);
      } else if (d.k === 'answer' && this.offerer(from)) {
        if (peer.pc && d.id === peer.offer && peer.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription({ type: 'answer', sdp: speechSdp(d.sdp) });
      } else if (d.k === 'bye') {
        this.closePeer(peer);
      }
    } catch (err) { console.warn('Voice:', err.message); }
  }

  // a connection with one friend (both ends: the caller adds the audio line, the other end finds it in the offer)
  async connection(peer) {
    this.closePeer(peer);
    const { pc } = await newConnection();
    peer.pc = pc;
    pc.ontrack = (e) => { if (peer.pc === pc) this.play(peer, e.streams[0] ?? new MediaStream([e.track])); };
    pc.addEventListener('connectionstatechange', () => {
      if (peer.pc !== pc || pc.connectionState !== 'failed') return;
      this.closePeer(peer);
      if (this.on && this.offerer(peer.id) && peer.tries < VOICE.retries) { // try again in a moment
        peer.tries++; clearTimeout(peer.retry);
        peer.retry = setTimeout(() => { if (this.on && this.peers.get(peer.id) === peer && !peer.pc) this.call(peer).catch(() => {}); }, 3000);
      }
    });
    return pc;
  }

  async call(peer) {
    if (peer.calling) return;
    peer.calling = true;
    try { await this.dial(peer); } finally { peer.calling = false; }
  }
  async dial(peer) {
    const pc = await this.connection(peer);
    const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
    peer.sender = tr.sender; this.feed(peer);
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    if (peer.pc !== pc) return;
    peer.offer = ++this.offers;
    this.send(peer.id, { k: 'offer', id: peer.offer, sdp: pc.localDescription.sdp });
  }

  async answer(peer, d) {
    const pc = await this.connection(peer);
    await pc.setRemoteDescription({ type: 'offer', sdp: speechSdp(d.sdp) });
    const tr = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio') ?? pc.getTransceivers()[0];
    if (!tr) return;
    tr.direction = 'sendrecv';
    peer.sender = tr.sender; this.feed(peer);
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    if (peer.pc !== pc) return;
    this.send(peer.id, { k: 'answer', id: d.id, sdp: pc.localDescription.sdp });
  }

  // what goes to a friend: your microphone, or nothing (muted, no microphone, or out of range in the race)
  feed(peer) {
    const track = peer.sending && this.mic ? this.mic.track : null;
    if (peer.sender && peer.sender.track !== track) peer.sender.replaceTrack(track).catch(() => {});
  }

  // a friend's voice: → how loud they are (the indicator) → their volume → where they are → your speakers
  play(peer, stream) {
    this.unplug(peer);
    const ctx = this.audio();
    // (Chrome only plays a connection's sound through Web Audio while it's also on an element: a silent one)
    const el = new Audio(); el.srcObject = stream; el.muted = true; el.play?.().catch(() => {});
    if (!ctx) { el.muted = false; peer.nodes = { el }; return; }
    try {
      const src = ctx.createMediaStreamSource(stream), analyser = ctx.createAnalyser(), gain = ctx.createGain(), panner = ctx.createPanner();
      analyser.fftSize = 512;
      panner.panningModel = IS_MOBILE ? 'equalpower' : 'HRTF';
      panner.distanceModel = 'linear'; panner.refDistance = VOICE.near; panner.maxDistance = VOICE.far; panner.rolloffFactor = 1;
      src.connect(analyser); src.connect(gain); gain.connect(panner); panner.connect(this.bus);
      peer.nodes = { el, src, analyser, gain, panner };
    } catch { el.muted = false; peer.nodes = { el }; } // (no Web Audio for it: plain, not placed)
  }

  unplug(peer) {
    const n = peer.nodes;
    if (!n) return;
    try { n.src?.disconnect(); n.gain?.disconnect(); n.panner?.disconnect(); } catch { /* gone */ }
    if (n.el) { n.el.srcObject = null; n.el.remove?.(); }
    peer.nodes = null; peer.talking = false;
  }

  closePeer(peer) {
    clearTimeout(peer.retry);
    this.unplug(peer);
    if (peer.pc) { const pc = peer.pc; peer.pc = null; try { pc.close(); } catch { /* closed */ } }
    peer.sender = null;
  }
  closeAll() { for (const p of this.peers.values()) this.closePeer(p); this.peers.clear(); }

  // ---------- your microphone ----------
  startMic() {
    if (this.mic || this.micAsk || !navigator.mediaDevices?.getUserMedia) {
      if (!navigator.mediaDevices?.getUserMedia && !this.micAsk && !this.micWarned) { this.micWarned = true; this.notice('No microphone here: you can listen, not talk'); }
      return;
    }
    const ask = this.micAsk = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    }).then((stream) => {
      if (this.micAsk !== ask || !this.on || OPTIONS.mic === 'muted') { for (const t of stream.getTracks()) t.stop(); return; }
      const track = stream.getAudioTracks()[0];
      let analyser = null;
      const ctx = this.audio();
      if (ctx) { try { analyser = ctx.createAnalyser(); analyser.fftSize = 512; this.micSrc = ctx.createMediaStreamSource(stream); this.micSrc.connect(analyser); } catch { analyser = null; } }
      track.enabled = false;
      this.mic = { stream, track, analyser };
      for (const p of this.peers.values()) this.feed(p);
    }).catch(() => {
      if (this.micAsk === ask) this.notice('Microphone blocked: allow it in your browser to talk (you can still listen)');
    }).finally(() => { if (this.micAsk === ask) this.micAsk = null; });
  }

  stopMic() {
    this.micAsk = null;
    if (!this.mic) return;
    for (const t of this.mic.stream.getTracks()) t.stop();
    try { this.micSrc?.disconnect(); } catch { /* gone */ }
    this.mic = null; this.micSrc = null;
    for (const p of this.peers.values()) this.feed(p);
  }

  get talkingNow() { return !!this.mic && (OPTIONS.mic === 'open' || (OPTIONS.mic === 'ptt' && this.ptt)); }

  level(analyser) {
    analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    return Math.sqrt(s / this.buf.length);
  }

  // ---------- every frame ----------
  update(race, camera) {
    if (this.session?.closed) this.attach(null);
    if (!this.on) { if (this.shown !== 'off') { this.shown = 'off'; this.el.classList.add('hidden'); } return; }
    const ctx = this.ctx, now = ctx?.currentTime ?? performance.now() / 1000;
    if (this.mic) this.mic.track.enabled = this.talkingNow;

    // you are where the camera is, looking where it looks
    const e = camera.matrixWorld.elements, L = ctx?.listener;
    const lx = e[12], ly = e[13], lz = e[14], fx = -e[8], fy = -e[9], fz = -e[10];
    if (L) {
      if (L.positionX) {
        L.positionX.value = lx; L.positionY.value = ly; L.positionZ.value = lz;
        L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz; L.upX.value = e[4]; L.upY.value = e[5]; L.upZ.value = e[6];
      } else { L.setPosition?.(lx, ly, lz); L.setOrientation?.(fx, fy, fz, e[4], e[5], e[6]); }
    }

    // in the race (lights out), near only: each voice from its car; otherwise everyone at full volume, in front of you
    const near = !!race && race.state !== 'countdown' && OPTIONS.voiceRange !== 'all';
    if (race !== this.carsOf) { this.carsOf = race; this.carOf.clear(); for (const c of race?.cars ?? []) if (c.humanId) this.carOf.set(c.humanId, c); }
    const mine = race?.player?.state;
    const read = (++this.frame & 1) === 0; // (how loud: every other frame is plenty)
    for (const p of this.peers.values()) {
      const car = near ? this.carOf.get(p.id) : null, s = car?.state;
      const d = s && mine ? Math.hypot(s.x - mine.x, s.z - mine.z) : 0;
      // out of range: stop sending to them (they stop sending to you too: both ends see the same distance)
      const send = !s || car.dnf ? true : p.sending ? d < VOICE.far * VOICE.stopSending : d < VOICE.far;
      if (send !== p.sending) { p.sending = send; this.feed(p); }
      const n = p.nodes;
      if (n?.panner) {
        const P = n.panner;
        const x = s ? s.x : lx + fx, y = s ? (s.y ?? 0) + 0.8 : ly + fy, z = s ? s.z : lz + fz;
        if (P.positionX) { P.positionX.value = x; P.positionY.value = y; P.positionZ.value = z; } else P.setPosition?.(x, y, z);
        if (read) {
          const audible = !s || d < VOICE.far;
          if (audible && this.level(n.analyser) > VOICE.talkLevel) p.until = now + VOICE.talkHold;
          p.talking = now < p.until;
        }
      } else p.talking = false;
    }
    if (read && this.mic?.analyser && this.talkingNow && this.level(this.mic.analyser) > VOICE.talkLevel) this.meUntil = now + VOICE.talkHold;
    this.draw(race, now);
    if (read) { // the lobby list and the name tags over the cars (both are drawn again now and then: so every time)
      for (const li of document.querySelectorAll('#lb-players li[data-id]')) li.classList.toggle('talking', !!this.peers.get(li.dataset.id)?.talking);
      for (const t of document.querySelectorAll('#nametags .ntag[data-id]')) t.classList.toggle('talking', !!this.peers.get(t.dataset.id)?.talking);
    }
  }

  // the indicator, name tags and the lobby list: who's talking
  draw(race, now) {
    const players = this.session.players, talking = [...this.peers.values()].filter((p) => p.talking).map((p) => p.id);
    const meLive = this.talkingNow, meLoud = meLive && now < (this.meUntil ?? 0);
    const touchTalk = IS_MOBILE && OPTIONS.mic === 'ptt' && !race; // (in the race: Talk is with the touch controls)
    const state = [talking.join(','), meLive, meLoud, OPTIONS.mic, !!this.mic, touchTalk, !!race].join('|');
    if (state === this.shown) return;
    this.shown = state;
    const el = this.el;
    // in the race only while someone's talking (or your mic is live); in the lobby always (how to talk)
    el.classList.toggle('hidden', !!race && !talking.length && !meLive && !document.body.classList.contains('hud-editing'));
    el.classList.toggle('in-race', !!race);
    this.meEl.className = `vh-me ${meLoud ? 'loud' : meLive ? 'live' : ''} ${!this.mic ? 'nomic' : ''}`;
    this.meEl.querySelector('span').textContent = !this.mic ? (OPTIONS.mic === 'muted' ? 'Listening' : 'No mic')
      : meLive ? (OPTIONS.mic === 'open' ? 'Mic on' : 'Talking') : IS_MOBILE ? 'Hold Talk' : 'Hold X to talk';
    this.listEl.innerHTML = talking.map((id) => {
      const p = players.find((x) => x.id === id);
      return p ? `<span class="vh-who"><i style="background:${hex(p.color)}"></i>${esc(p.name)}</span>` : '';
    }).join('');
    this.talkBtn.classList.toggle('hidden', !touchTalk || !this.mic);
  }
}