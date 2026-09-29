// Multiplayer lobby: create a room or join one with its code, see who's in, and (host) set up the race.
// The networking is in net/session.js; this file is only the screen.
import { Session, cleanName, MAX_CARS } from './net/session.js';
import { NET } from './net/peer.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const KEY = 'apex-circuit:lobby';
function load() { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...v })); } catch { /* private mode */ } }

export class Lobby {
  // hooks: previewTrack(id), onStart(cfg), onEnd(), onClosed(reason), onDnf(car), onSession(active)
  constructor({ tracks, ...hooks }) {
    this.tracks = tracks; this.hooks = hooks;
    this.session = null; this.busy = false;
    this.el = $('lobby');
    const options = (id) => [...$(id).options].map((o) => [o.value, o.textContent]);
    this.lapOptions = options('opt-laps');
    this.diffOptions = options('opt-diff');

    $('btn-mp').addEventListener('click', () => this.open());
    $('lb-back').addEventListener('click', () => this.back());
    $('lb-create').addEventListener('click', () => this.create());
    $('lb-join').addEventListener('click', () => this.join());
    $('lb-go').addEventListener('click', () => this.session?.startRace());
    $('lb-copy').addEventListener('click', () => this.copyInvite());
    $('lb-prev').addEventListener('click', () => this.stepTrack(-1));
    $('lb-next').addEventListener('click', () => this.stepTrack(1));
    const code = $('lb-code-in'), name = $('lb-name'), ai = $('lb-ai');
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });
    // typing in a box mustn't trigger game keys (Space = brake, arrows = circuit...)
    for (const el of [code, name, ai]) el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') { if (el === code) this.join(); else el.blur(); }
    });
    name.addEventListener('input', () => { // same name as the solo menu
      const menuName = $('opt-name'); menuName.value = name.value; menuName.dispatchEvent(new Event('input'));
    });
    ai.addEventListener('input', () => { this.showAi(); this.set({ ai: Number(ai.value) }); });
    this.el.addEventListener('keydown', (e) => { if (e.code === 'Escape' && !this.session) this.back(); });

    // Invite link: ?room=ABCD opens the lobby with the code filled in
    const invited = new URLSearchParams(location.search).get('room');
    if (invited) {
      history.replaceState(null, '', location.pathname);
      setTimeout(() => this.open(invited), 50);
    }
  }

  // ---------- screens ----------
  open(code) {
    $('menu').classList.add('hidden');
    this.el.classList.remove('hidden');
    $('lb-name').value = $('opt-name').value;
    if (code) $('lb-code-in').value = String(code).toUpperCase().slice(0, 4);
    this.render();
    if (!this.session) (code ? $('lb-name') : $('lb-code-in')).focus({ preventScroll: true });
  }
  show() { this.el.classList.remove('hidden'); this.render(); }
  hide() { this.el.classList.add('hidden'); }
  get visible() { return !this.el.classList.contains('hidden'); }

  back() {
    if (this.session) { this.leave(); this.status(''); return; }
    this.hide(); $('menu').classList.remove('hidden');
  }

  status(text, kind = '') {
    const el = $('lb-status');
    el.textContent = text; el.className = 'lb-status ' + kind;
  }

  // ---------- rooms ----------
  async create() {
    if (this.busy) return;
    this.busy = true; this.status('Opening a room…');
    const saved = load();
    const settings = {
      track: $('opt-track').value, laps: Number(saved.laps ?? $('opt-laps').value),
      difficulty: saved.difficulty ?? $('opt-diff').value, ai: saved.ai ?? 0, collisions: saved.collisions ?? true,
    };
    try { this.use(await Session.host(this.name(), settings)); this.status(''); }
    catch (err) { this.status(err.message, 'error'); }
    this.busy = false;
  }

  async join() {
    const code = $('lb-code-in').value.trim();
    if (this.busy) return;
    if (code.length !== 4) { this.status('Type the 4-letter code from your host.', 'error'); $('lb-code-in').focus(); return; }
    this.busy = true; this.render();
    try { this.use(await Session.join(code, this.name(), (t) => this.status(t))); this.status(''); }
    catch (err) { this.status(err.message, 'error'); }
    this.busy = false; this.render();
  }

  name() { return cleanName($('lb-name').value || $('opt-name').value || 'Driver'); }

  use(session) {
    this.session = session;
    let lastTrack = null;
    session
      .on('lobby', () => {
        if (session.settings.track !== lastTrack) { lastTrack = session.settings.track; this.hooks.previewTrack(lastTrack); }
        this.render();
      })
      .on('start', (cfg) => this.hooks.onStart(cfg))
      .on('end', () => this.hooks.onEnd())
      .on('dnf', (car) => this.hooks.onDnf?.(car))
      .on('closed', (reason) => {
        this.session = null; this.hooks.onSession?.(false);
        this.hooks.onClosed(reason);
        this.show(); this.status(reason, 'error');
      });
    this.hooks.onSession?.(true);
    session.emit('lobby');
  }

  leave() {
    if (!this.session) return;
    this.session.leave();
    this.session = null;
    this.hooks.onSession?.(false);
    this.render();
  }

  set(patch) {
    if (!this.session?.isHost) return;
    this.session.setSettings(patch);
    const { track, ...rest } = this.session.settings; save(rest);
  }

  stepTrack(step) {
    const s = this.session;
    if (!s?.isHost) return;
    const i = this.tracks.findIndex((t) => t.id === s.settings.track);
    this.set({ track: this.tracks[(i + step + this.tracks.length) % this.tracks.length].id });
  }

  async copyInvite() {
    if (!this.session) return;
    const link = `${location.origin}${location.pathname}?room=${this.session.code}`;
    let ok = false;
    try { await navigator.clipboard.writeText(link); ok = true; } catch { // not allowed on plain http: old way
      const t = document.createElement('textarea'); t.value = link; document.body.appendChild(t); t.select();
      try { ok = document.execCommand('copy'); } catch { /* give up */ }
      t.remove();
    }
    const b = $('lb-copy'); b.textContent = ok ? 'Link copied ✓' : link;
    clearTimeout(this.copyTimer); this.copyTimer = setTimeout(() => { b.textContent = 'Copy invite link'; }, 2500);
  }

  // ---------- drawing ----------
  showAi() {
    const ai = $('lb-ai'), n = Number(ai.value);
    $('lb-ai-label').textContent = n === 0 ? 'None' : n === Number(ai.max) ? `${n} · Full` : String(n);
    $('lb-skill-row').classList.toggle('off', n === 0);
  }

  seg(id, options, value, onPick) {
    const el = $(id), key = `${value}|${options.length}`;
    if (el.dataset.key === key) return; // unchanged: don't rebuild under the host's mouse
    el.dataset.key = key;
    el.innerHTML = options.map(([v, label]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? 'on' : ''}">${label}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (b && this.session?.isHost) onPick(b.dataset.v); };
  }

  render() {
    const s = this.session;
    this.el.dataset.view = s ? 'room' : 'start';
    $('lb-create').disabled = $('lb-join').disabled = this.busy;
    $('lb-back').textContent = s ? 'Leave room' : '‹ Menu';
    this.el.classList.toggle('guest', !!s && !s.isHost);
    if (!s || !s.settings) return;
    const host = s.isHost, st = s.settings;
    $('lb-head').textContent = host ? 'Your room' : 'Room';
    $('lb-code').textContent = s.code;
    $('lb-count').textContent = `${s.players.length} / ${NET.maxPlayers}`;

    // drivers
    const rows = s.players.map((p) => {
      const tags = (p.host ? '<em class="host">Host</em>' : '') + (p.id === s.me?.id ? '<em class="you">You</em>' : '');
      const ping = p.host ? '' : `<span class="ping ${p.ping > 150 ? 'bad' : p.ping > 80 ? 'meh' : ''}">${p.ping ? p.ping + ' ms' : '…'}</span>`;
      return `<li><i style="background:${hex(p.color)}"></i><span class="nm">${esc(p.name)}</span>${tags}${ping}</li>`;
    });
    for (let k = s.players.length; k < Math.min(NET.maxPlayers, s.players.length + 3); k++) rows.push('<li class="open"><i></i><span class="nm">Open seat</span></li>');
    $('lb-players').innerHTML = rows.join('');

    // race settings (the host picks, everyone else sees them)
    const def = this.tracks.find((t) => t.id === st.track) ?? this.tracks[0];
    $('lb-track').textContent = def.name;
    $('lb-track-sub').textContent = [def.country, def.time === 'night' ? 'Night race' : def.time === 'dusk' ? 'Twilight' : null].filter(Boolean).join(' · ');
    this.seg('lb-laps', this.lapOptions, st.laps, (v) => this.set({ laps: Number(v) }));
    this.seg('lb-diff', this.diffOptions, st.difficulty, (v) => this.set({ difficulty: v }));
    this.seg('lb-coll', [['1', 'On'], ['0', 'Off']], st.collisions ? '1' : '0', (v) => this.set({ collisions: v === '1' }));
    const ai = $('lb-ai'), maxAi = Math.max(0, MAX_CARS - s.players.length);
    ai.max = String(maxAi); ai.disabled = !host;
    if (document.activeElement !== ai) ai.value = String(Math.min(st.ai, maxAi));
    this.showAi();

    const racing = s.phase === 'race';
    $('lb-go').classList.toggle('hidden', !host);
    $('lb-go').disabled = racing;
    const hostName = s.players.find((p) => p.host)?.name ?? 'the host';
    $('lb-wait').textContent = racing ? 'Race in progress. You\'ll be back here when the host ends it.' : `Waiting for ${hostName} to start the race…`;
    $('lb-wait').classList.toggle('hidden', host && !racing);
  }
}