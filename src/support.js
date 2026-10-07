// "Support me": a link to my Buy Me a Coffee page on every menu: the main menu's top bar (every page of it), the
// multiplayer lobby, Your stats, Controls, the pause menu and the results. They're the buttons with `data-support` in
// index.html (data-support="end": the cup goes after the words); this gives each one the coffee cup and opens the
// page in a new tab, so a race stays paused behind it. Change the address here.
//
// Now and then the results screen also asks, in a small card (#res-ask in index.html): never before you've finished
// a few races, then at most once every couple of weeks, never again after "Don't ask again" or once you've pressed
// any Support me button. SUPPORT_ASK below has the numbers; what it remembers is kept in this browser.
export const SUPPORT_URL = 'https://buymeacoffee.com/nilaysingh';

export const SUPPORT_ASK = {
  after: 3,        // finished races before it first asks (a practice session counts)
  everyRaces: 10,  // then only once you've finished this many more …
  everyDays: 14,   // … and this many days have gone by since it last asked
};
const KEY = 'apex-circuit:support';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* a private window: not kept */ } };

const CUP = '<svg class="cup" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M8.2 2.6c-.9 1 .9 1.6 0 2.8M11.4 2.6c-.9 1 .9 1.6 0 2.8M14.6 2.6c-.9 1 .9 1.6 0 2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
  '<path d="M4.5 8h13l-1.3 10.2A3 3 0 0 1 13.2 21H8.8a3 3 0 0 1-3-2.8Z" fill="currentColor"/>' +
  '<path d="M17.2 10.2h1.3a2.4 2.4 0 0 1 0 4.8h-1.9" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

export function setupSupport() {
  for (const b of document.querySelectorAll('[data-support]')) {
    if (!b.querySelector('.cup')) b.insertAdjacentHTML(b.dataset.support === 'end' ? 'beforeend' : 'afterbegin', CUP);
    b.title = 'Buy me a coffee (opens buymeacoffee.com in a new tab)';
    b.setAttribute('aria-label', 'Support me: buy me a coffee (opens in a new tab)');
    b.addEventListener('click', () => {
      const tab = window.open(SUPPORT_URL, '_blank');
      if (tab) { tab.opener = null; if (b.closest('#res-ask')) thank(); }
      else showAddress(b); // the browser blocked the new tab (it can, for a controller's button): show where to go
      b.blur(); // (so Space or Enter in a race can't press it again)
      const s = load(); s.supported = Date.now(); save(s); // thank you: it won't ask again
    });
  }
  const $ = (id) => document.getElementById(id);
  $('res-ask-later')?.addEventListener('click', () => closeAsk(true));
  $('res-ask-never')?.addEventListener('click', () => { const s = load(); s.never = true; save(s); closeAsk(true); });
}

// You've finished a race (or a practice session): count it
export function raceFinished() {
  const s = load(); s.races = (s.races ?? 0) + 1; save(s);
}

// The results screen has just opened: ask this time? (shows the card in place of the Support me button) → true if so
export function askOnResults() {
  const s = load(), A = SUPPORT_ASK, races = s.races ?? 0, now = Date.now();
  const due = !s.never && !s.supported && races >= A.after &&
    (s.askedAt == null || (races - (s.askedRaces ?? 0) >= A.everyRaces && now - s.askedAt >= A.everyDays * 86400e3));
  if (due) { s.askedAt = now; s.askedRaces = races; save(s); } // (just showing it counts, whatever you press)
  showAsk(due);
  return due;
}
function showAsk(on) {
  document.getElementById('res-ask')?.classList.toggle('hidden', !on);
  document.querySelector('#results .res-support')?.classList.toggle('hidden', on);
}
function thank() { // (from the card's own button)
  const card = document.getElementById('res-ask');
  card.classList.add('thanked');
  card.querySelector('b').textContent = 'Thank you!';
  card.querySelector('p').textContent = 'It means a lot, and it keeps Apex Circuit going.';
  document.getElementById('btn-again')?.focus({ preventScroll: true });
}
function closeAsk(focus) {
  showAsk(false);
  if (focus) document.getElementById('btn-again')?.focus({ preventScroll: true }); // (a controller keeps its place)
}

// The page's address on the button for a few seconds, to type in or click again with the mouse
function showAddress(b) {
  const label = b.querySelector('span') ?? b;
  if (b.dataset.was == null) b.dataset.was = label.textContent;
  label.textContent = SUPPORT_URL.replace(/^https:\/\//, '');
  clearTimeout(b.restore);
  b.restore = setTimeout(() => { label.textContent = b.dataset.was; delete b.dataset.was; }, 6000);
}