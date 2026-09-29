// Direct browser-to-browser connections for multiplayer (WebRTC data channels).
// The room server (/api/room, see server/rooms.js) only passes each connection's offer and answer
// between the two browsers. After that, race data goes straight from browser to browser.
//
// Each connection has two channels:
//   ctl   – reliable, in order: lobby, start, pings (JSON)
//   state – fire-and-forget: car positions many times a second (binary). A late packet is useless,
//           so lost ones are never re-sent.
export const NET = {
  api: '/api/room',
  maxPlayers: 10,
  // STUN servers let two browsers find each other through home routers. That's enough for most home
  // and phone connections. Networks that block direct connections (offices, colleges, some mobile
  // data) need a relay (TURN): set one up on the room server (see server/rooms.js and the README) and
  // every player gets it automatically.
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  // Testing: open the game with ?relay at the end of the address to force everything through the relay
  forceRelay: typeof location !== 'undefined' && new URLSearchParams(location.search).has('relay'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(action, data = {}) {
  let r;
  try {
    r = await fetch(NET.api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
  } catch {
    throw new Error("Can't reach the room server. Check your internet connection.");
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && !j.error) throw new Error('No room server here. Multiplayer works with npm run dev, npm run preview or on Vercel.');
  if (!r.ok) throw new Error(j.error || `Room server error (${r.status})`);
  return j;
}

// STUN + the room server's relay servers (if it has any). Fetched once, then reused for an hour.
let ice = null;
async function iceConfig() {
  if (!ice || ice.until < Date.now()) {
    let relay = [];
    try { relay = (await api('ice')).iceServers ?? []; } catch { /* no relay: direct connections only */ }
    ice = { servers: [...NET.iceServers, ...relay], relay: relay.length > 0, until: Date.now() + 3600 * 1000 };
  }
  return ice;
}
async function newConnection() {
  const { servers, relay } = await iceConfig();
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: NET.forceRelay && relay ? 'relay' : 'all' });
  return { pc, relay };
}

// Wait until the browser has found its network addresses (ICE candidates), so they can all be sent
// in one go with the offer/answer. Usually well under a second.
function gathered(pc, ms = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function timeout(promise, ms, message) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(t));
}

// One connection to another player (for a friend: to the host; for the host: one per friend).
export class Link {
  constructor(pc, id, name) {
    this.pc = pc; this.id = id; this.name = name;
    this.ch = {}; this.isOpen = false; this.closed = false;
    this.onCtl = null; this.onState = null; this.onClose = null;
    this.opened = new Promise((resolve) => { this.resolveOpen = resolve; });
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      clearTimeout(this.lost);
      if (s === 'failed' || s === 'closed') this.drop(s);
      else if (s === 'disconnected') this.lost = setTimeout(() => this.drop('lost'), 8000); // it often comes back
    });
  }

  attach(ch) {
    ch.binaryType = 'arraybuffer';
    this.ch[ch.label] = ch;
    ch.onmessage = (e) => {
      if (typeof e.data === 'string') { let m; try { m = JSON.parse(e.data); } catch { return; } this.onCtl?.(m); }
      else this.onState?.(e.data);
    };
    ch.onopen = () => this.checkOpen();
    ch.onclose = () => this.drop('closed');
    this.checkOpen();
  }

  checkOpen() {
    if (!this.isOpen && this.ch.ctl?.readyState === 'open' && this.ch.state?.readyState === 'open') {
      this.isOpen = true; this.resolveOpen();
    }
  }

  send(msg) { if (this.ch.ctl?.readyState === 'open') this.ch.ctl.send(JSON.stringify(msg)); }
  sendState(buf) { // skip if the connection is backed up: newer positions are on the way
    const c = this.ch.state;
    if (c?.readyState === 'open' && c.bufferedAmount < 64 * 1024) c.send(buf);
  }

  drop(reason = 'closed') {
    if (this.closed) return;
    this.closed = true; this.isOpen = false;
    clearTimeout(this.lost);
    try { this.pc.close(); } catch { /* already closed */ }
    this.onClose?.(reason);
  }
}

// ---------- host side: a room that friends can join ----------
export class HostRoom {
  static async open(onJoin) {
    const { code, hostKey } = await api('create');
    await iceConfig(); // fetch relay details now, so answering the first friend is quick
    return new HostRoom(code, hostKey, onJoin);
  }

  constructor(code, hostKey, onJoin) {
    this.code = code; this.hostKey = hostKey; this.onJoin = onJoin;
    this.accepting = true; // false during a race: late joiners are told to wait
    this.closed = false;
    this.poll();
  }

  async poll() {
    while (!this.closed) {
      if (this.accepting) {
        try {
          const { joins } = await api('inbox', { hostKey: this.hostKey });
          for (const j of joins) this.accept(j).catch((e) => console.warn('Join failed:', e.message));
        } catch (e) { console.warn('Room server:', e.message); }
      }
      await sleep(1500);
    }
  }

  async accept({ id, name, offer }) {
    const { pc } = await newConnection();
    const link = new Link(pc, id, name);
    pc.ondatachannel = (e) => link.attach(e.channel);
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    await api('answer', { code: this.code, hostKey: this.hostKey, id, answer: { type: 'answer', sdp: pc.localDescription.sdp } });
    try { await timeout(link.opened, 20000, 'timed out'); } catch { link.drop('timeout'); return; }
    if (this.closed) { link.drop('closed'); return; }
    this.onJoin(link);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const body = JSON.stringify({ action: 'close', code: this.code, hostKey: this.hostKey });
    // sendBeacon still gets through while the page is closing
    if (!(navigator.sendBeacon && navigator.sendBeacon(NET.api, body))) api('close', { code: this.code, hostKey: this.hostKey }).catch(() => {});
  }
}

// ---------- friend side: join a room by its code ----------
export async function joinRoom(code, name, onStatus = () => {}) {
  code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  onStatus('Finding your connection…');
  const { pc, relay } = await newConnection();
  const link = new Link(pc, 'host', 'Host');
  link.attach(pc.createDataChannel('ctl'));
  link.attach(pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }));
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    onStatus(`Knocking on room ${code}…`);
    const { id } = await api('join', { code, name, offer: { type: 'offer', sdp: pc.localDescription.sdp } });
    let answer = null;
    for (const until = Date.now() + 25000; !answer; ) {
      if (Date.now() > until) throw new Error("The host didn't answer. Their race may already be running: try again when it ends.");
      await sleep(800);
      ({ answer } = await api('poll', { id }));
    }
    onStatus('Connecting to the host…');
    await pc.setRemoteDescription(answer);
    await timeout(link.opened, 15000, relay
      ? "Couldn't connect to the host, even through the relay. Check both of you are online, then try again."
      : "Couldn't connect to the host. This network blocks direct connections (common on office and college Wi-Fi): set up a relay server (see README), or try another network.");
    return { link, id };
  } catch (err) {
    link.onClose = null; link.drop('failed');
    throw err;
  }
}