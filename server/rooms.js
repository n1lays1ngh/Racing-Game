// Room codes for multiplayer.
// The host's browser runs the race. This tiny server only introduces browsers to each other:
// a friend types the room code, their browser leaves a connection "offer" for the host, the host
// leaves an "answer", and from then on the browsers talk directly (WebRTC). No game data goes through here.
//
//   Vercel:   api/room.js runs this, rooms are kept in Upstash Redis (free tier is plenty).
//   npm run dev / npm run preview:   runs inside Vite (vite.config.js), rooms kept in memory.
//
// It also hands out relay (TURN) server details. Some networks (offices, colleges, some mobile data)
// block direct browser-to-browser connections; a relay passes the race data along instead.
// Set ONE of these (Vercel → Settings → Environment Variables, or .env.local for npm run dev):
//   Cloudflare Realtime TURN (free up to 1,000 GB a month):  TURN_KEY_ID, TURN_KEY_API_TOKEN
//   Any other TURN server (Metered, your own…):              TURN_URLS (comma separated), TURN_USERNAME, TURN_CREDENTIAL
import { randomInt } from 'node:crypto';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1 (easy to mix up)
const CODE_LEN = 4;
const ROOM_TTL = 6 * 3600;  // seconds a room code lasts
const JOIN_TTL = 90;        // seconds a join request waits for the host
const MAX_SDP = 40000;      // connection offers are a few kB

const pick = (chars, n) => Array.from({ length: n }, () => chars[randomInt(chars.length)]).join('');
const newKey = (n) => pick('abcdefghijklmnopqrstuvwxyz0123456789', n);
const cleanCode = (c) => { const s = String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return s.length === CODE_LEN ? s : null; };
const cleanName = (n) => String(n ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, 14) || 'Driver';
const isToken = (t, n) => typeof t === 'string' && t.length === n && /^[a-z0-9]+$/.test(t);
const isSdp = (d, type) => d && d.type === type && typeof d.sdp === 'string' && d.sdp.length < MAX_SDP;
const reply = (status, data) => ({ status, data });

// ---------- relay (TURN) servers ----------
let relayCache = null; // Cloudflare credentials last a day; fetch new ones every 12 hours
export async function relayServers(env = process.env) {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    if (relayCache && relayCache.until > Date.now()) return relayCache.list;
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!r.ok) throw new Error(`Cloudflare TURN answered ${r.status}`);
    const j = await r.json();
    const list = (Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers])
      .filter(Boolean)
      .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) })) // browsers block port 53
      .filter((s) => s.urls.length && s.username); // the relay entries (STUN is already in the game)
    relayCache = { list, until: Date.now() + 12 * 3600 * 1000 };
    return list;
  }
  if (env.TURN_URLS) {
    return [{ urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }];
  }
  return [];
}

// body: { action, ... } → { status, data }
export async function handleRoom(body, store, env = process.env) {
  try {
    switch (body?.action) {
      case 'ice': { // relay servers for when a direct connection isn't possible (none set up = direct only)
        let iceServers = [];
        try { iceServers = await relayServers(env); } catch (err) { console.warn('TURN:', err.message); }
        return reply(200, { iceServers });
      }
      case 'create': { // host: get a room code (and a secret key only the host knows)
        const hostKey = newKey(24);
        for (let k = 0; k < 20; k++) {
          const code = pick(CODE_CHARS, CODE_LEN);
          if ((await store.cmd('SET', `room:${code}`, hostKey, 'NX', 'EX', ROOM_TTL)) === 'OK') return reply(200, { code, hostKey });
        }
        return reply(503, { error: 'No free room codes right now, try again' });
      }
      case 'join': { // friend: leave a connection offer for the host
        const code = cleanCode(body.code);
        if (!code) return reply(400, { error: `Room codes are ${CODE_LEN} letters` });
        if (!isSdp(body.offer, 'offer')) return reply(400, { error: 'Bad connection offer' });
        const hostKey = await store.cmd('GET', `room:${code}`);
        if (!hostKey) return reply(404, { error: `There's no room ${code}. Check the code with your host.` });
        const id = newKey(10), inbox = `inbox:${hostKey}`;
        await store.cmd('RPUSH', inbox, JSON.stringify({ id, name: cleanName(body.name), offer: body.offer }));
        await store.cmd('EXPIRE', inbox, JOIN_TTL);
        return reply(200, { id });
      }
      case 'inbox': { // host: collect waiting join requests (one Redis command per poll)
        if (!isToken(body.hostKey, 24)) return reply(400, { error: 'Bad host key' });
        const list = await store.cmd('LPOP', `inbox:${body.hostKey}`, '10');
        return reply(200, { joins: (list ?? []).map((s) => JSON.parse(s)) });
      }
      case 'answer': { // host: answer a join request
        const code = cleanCode(body.code);
        if (!code || !isToken(body.id, 10) || !isSdp(body.answer, 'answer')) return reply(400, { error: 'Bad answer' });
        if ((await store.cmd('GET', `room:${code}`)) !== body.hostKey) return reply(403, { error: 'Only the host can answer' });
        await store.cmd('SET', `answer:${body.id}`, JSON.stringify(body.answer), 'EX', JOIN_TTL);
        return reply(200, { ok: true });
      }
      case 'poll': { // friend: has the host answered yet?
        if (!isToken(body.id, 10)) return reply(400, { error: 'Bad id' });
        const a = await store.cmd('GETDEL', `answer:${body.id}`);
        return reply(200, { answer: a ? JSON.parse(a) : null });
      }
      case 'close': { // host: the room is finished
        const code = cleanCode(body.code);
        if (code && isToken(body.hostKey, 24) && (await store.cmd('GET', `room:${code}`)) === body.hostKey) {
          await store.cmd('DEL', `room:${code}`);
          await store.cmd('DEL', `inbox:${body.hostKey}`);
        }
        return reply(200, { ok: true });
      }
      default: return reply(400, { error: 'Unknown action' });
    }
  } catch (err) {
    return reply(500, { error: `Room server error: ${err.message}` });
  }
}

// ---------- where rooms are kept ----------
// Upstash Redis over its REST API (the Vercel "Upstash for Redis" integration sets these variables).
export function upstashStore(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return {
    async cmd(...args) {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(args.map(String)) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
      return j.result;
    },
  };
}

// In memory: for npm run dev (one server process, so this is all it needs).
export function memoryStore() {
  const kv = new Map(); // key → { v, exp }
  const live = (k) => { const e = kv.get(k); if (e && e.exp && e.exp < Date.now()) { kv.delete(k); return undefined; } return e; };
  return {
    async cmd(op, key, ...a) {
      switch (op) {
        case 'GET': return live(key)?.v ?? null;
        case 'SET': {
          const i = a.indexOf('EX'), exp = i >= 0 ? Date.now() + Number(a[i + 1]) * 1000 : 0;
          if (a.includes('NX') && live(key)) return null;
          kv.set(key, { v: a[0], exp }); return 'OK';
        }
        case 'GETDEL': { const e = live(key); kv.delete(key); return e?.v ?? null; }
        case 'RPUSH': { const e = live(key) ?? { v: [], exp: 0 }; e.v.push(...a); kv.set(key, e); return e.v.length; }
        case 'LPOP': { const e = live(key); if (!e?.v.length) return null; const out = e.v.splice(0, Number(a[0] ?? 1)); if (!e.v.length) kv.delete(key); return out; }
        case 'EXPIRE': { const e = live(key); if (!e) return 0; e.exp = Date.now() + Number(a[0]) * 1000; return 1; }
        case 'DEL': return kv.delete(key) ? 1 : 0;
        default: throw new Error(`memoryStore: ${op} not supported`);
      }
    },
  };
}

// ---------- Vite plugin: the same /api/room inside `npm run dev` and `npm run preview` ----------
// env: variables from .env / .env.local (vite.config.js passes them in)
export function roomServerPlugin(env = process.env) {
  const store = upstashStore(env) ?? memoryStore();
  const middleware = async (req, res) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 100000) { res.statusCode = 413; res.end(); return; } }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* sent as plain text by sendBeacon, or junk */ }
    const { status, data } = await handleRoom(body, store, env);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  };
  return {
    name: 'apex-room-server',
    configureServer(server) { server.middlewares.use('/api/room', middleware); },
    configurePreviewServer(server) { server.middlewares.use('/api/room', middleware); },
  };
}