// Race replays (main menu → Race replays): your last few career races and quick races (replay.js keeps 3 of each),
// each to watch or record in the cinematic replay (cinema.js). Its own screen, apart from the best-lap cinematic replay.
//
//   const screen = new ReplaysScreen({ onWatch(id), onClose() })   (main.js)
//   screen.open(tab)   tab: 'career' | 'quick'
import { listReplays } from './replay.js';
import { getCar } from './cars/index.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const EMPTY = {
  career: 'No career races recorded yet. Every career race is recorded from now on: finish one and it shows up here.',
  quick: 'No quick races recorded yet. Finish a quick race (offline, with other cars) and it shows up here.',
};

export class ReplaysScreen {
  constructor({ onWatch, onClose }) {
    this.onWatch = onWatch; this.onClose = onClose; this.tab = 'career';
    this.el = $('replays');
    $('rp-back').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]'); if (t) { this.tab = t.dataset.tab; this.render(); return; }
      const w = e.target.closest('[data-replay]'); if (w) this.onWatch?.(w.dataset.replay);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !this.el.classList.contains('hidden')) { e.preventDefault(); this.close(); }
    });
  }
  open(tab = this.tab) {
    this.tab = tab; this.el.classList.remove('hidden'); this.render();
    $('rp-back').focus({ preventScroll: true });
  }
  close() { this.el.classList.add('hidden'); this.onClose?.(); }

  async render() {
    for (const b of $('rp-tabs').children) b.classList.toggle('on', b.dataset.tab === this.tab);
    const all = await listReplays(), list = all.filter((r) => (r.meta.kind ?? 'career') === this.tab);
    for (const b of $('rp-tabs').children) b.querySelector('small').textContent = all.filter((r) => (r.meta.kind ?? 'career') === b.dataset.tab).length;
    $('rp-list').innerHTML = !list.length ? `<p class="rp-empty">${EMPTY[this.tab]}</p>` : list.map(({ id, meta: m }) => {
      const me = m.results?.find((r) => r.isPlayer), car = (() => { try { return getCar(m.car).name; } catch { return m.car; } })();
      const when = new Date(m.at ?? 0).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const what = m.kind === 'quick' ? 'Quick race' : `${m.series ?? 'Career'}${m.round != null ? `, round ${m.round + 1}` : ''}`;
      return `<div class="cr-replay"><div><b>${esc(m.trackName ?? m.track)}</b>` +
        `<small>${esc(what)} · ${esc(car)} · ${m.laps} ${m.laps === 1 ? 'lap' : 'laps'} · ${clock(m.duration ?? 0)} · ${esc(when)}</small></div>` +
        `<span class="cr-res${me && !me.dnf && me.pos <= 3 ? ' podium' : ''}">${me ? (me.dnf ? 'DNF' : `P${me.pos}`) : ''}</span>` +
        `<button type="button" class="pm-btn" data-replay="${esc(id)}"><span>Watch</span></button></div>`;
    }).join('');
  }
}