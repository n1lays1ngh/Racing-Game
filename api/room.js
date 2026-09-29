// Vercel Function: POST /api/room — room codes for multiplayer (see server/rooms.js).
// Needs Upstash Redis: Vercel dashboard → your project → Storage → "Upstash for Redis" → Connect.
// That adds KV_REST_API_URL and KV_REST_API_TOKEN, which is all this needs.
import { handleRoom, upstashStore } from '../server/rooms.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const store = upstashStore();
  if (!store) return res.status(503).json({ error: 'Multiplayer isn\'t set up on this site yet: connect Upstash Redis in the Vercel dashboard (see README).' });
  let body = req.body ?? {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } } // sendBeacon sends plain text
  const { status, data } = await handleRoom(body, store);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(data);
}