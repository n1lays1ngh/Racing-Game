// Qualifying for career rounds (career.js), as each series does it. The sessions themselves are driven in race.js
// (a Race with `session`): out on track, the clock running down, everyone on their best lap. This file is the weekend
// around them: the format, who goes through to the next session, and the grid at the end.
//
//   Formula   Q1, Q2, Q3: the slowest five out after Q1, five more after Q2, the top ten fight for pole
//   Endurance Qualifying, then Hyperpole for the quickest ten
//   GT        one session (15 minutes)
//   MotoGP    Q1, then Q2 for the quickest twelve
// Every session's length can be set when you start a championship (QUALI.minutes); in a session you can end it early
// (pause → End session), and the AI's laps for the time left are worked out (each driver's pace from the laps they
// set: estimates). A session you're not in (knocked out) is worked out the same way, at once.
//
//   formatFor(series)                         the sessions: [{ name, minutes, out | keep }]
//   newWeekend(round, field)                  a round's qualifying, before the first session
//   sessionConfig(weekend, format, minutes)   the next session: { name, duration, field, cut } (race.js `session`)
//   recordSession(weekend, format, race)      a session just ended: its times, who's through; sessions you're not in run
//   gridOf(weekend)                           the grid, front to back (team names, '@me' for you)

export const QUALI = {
  formats: {
    formula: [{ name: 'Q1', minutes: 10, out: 5 }, { name: 'Q2', minutes: 8, out: 5 }, { name: 'Q3', minutes: 6 }],
    endurance: [{ name: 'Qualifying', minutes: 10, keep: 10 }, { name: 'Hyperpole', minutes: 8 }],
    gt: [{ name: 'Qualifying', minutes: 15 }],
    bike: [{ name: 'Q1', minutes: 10, keep: 12 }, { name: 'Q2', minutes: 10 }],
  },
  real: { formula: [18, 15, 12], endurance: [12, 10], gt: [15], bike: [15, 15] }, // (the real sessions' lengths)
  minutes: [3, 30],     // the shortest and longest a session can be set to
  spread: 0.0025,       // a worked-out lap: the driver's pace ± this much (one standard deviation)
};

export const formatFor = (kind) => QUALI.formats[kind] ?? QUALI.formats.gt;

const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

export function newWeekend(round, field) {
  return { round, k: 0, field: [...field], sessions: [], est: {}, grid: null, skipped: false };
}

// how many go through from session k (of a field of n)
function through(s, n) { return s.keep != null ? Math.min(n, s.keep) : s.out != null ? Math.max(1, n - s.out) : n; }

export function sessionConfig(w, format, minutes) {
  const s = format[w.k];
  if (!s) return null;
  const last = w.k === format.length - 1;
  return { name: s.name, k: w.k, of: format.length, duration: Math.max(60, (minutes?.[w.k] ?? s.minutes) * 60), field: [...w.field],
    cut: last ? null : through(s, w.field.length) };
}

// A session's driving is over (race.js: the flag and your last lap, or you ended it): everyone's best lap, the AI's
// laps for any time left worked out; then who goes through, and the sessions after it that you're not in
export function recordSession(w, format, race) {
  const S = race.session, left = Math.max(0, S.duration - (S.endedAt ?? S.duration));
  learnPace(w, race);
  const rows = race.cars.map((c) => {
    const who = c.isPlayer ? '@me' : c.team.name;
    let best = c.bestLap;
    if (!c.isPlayer && left > 0) { // ended early: the laps the AI would still have done
      const est = w.est[who];
      const laps = est ? Math.floor(left / (est * 1.9)) : 0; // (a flying lap and a slower one each)
      for (let k = 0; k < laps || (best == null && est && k < 1); k++) {
        const t = est * (1 + Math.abs(gauss()) * QUALI.spread * 0.6 + gauss() * QUALI.spread * 0.4);
        if (best == null || t < best) best = t;
      }
    }
    return { who, best };
  });
  finish(w, format, rows);
  // knocked out: the sessions you're not in happen without you
  while (w.k < format.length && !w.field.includes('@me')) finish(w, format, simulate(w));
  if (w.k >= format.length) w.grid = gridOf(w);
}

// each AI driver's lap time in this car here: its pace (race.js, ai.js skill) against the laps the field set
function learnPace(w, race) {
  const k = [];
  for (const c of race.cars) if (c.q && c.bestLap) k.push(c.bestLap * c.q.skill);
  if (!k.length) return;
  k.sort((a, b) => a - b);
  const K = k[Math.floor(k.length / 2)] * 0.998; // (their best laps: a touch better than the middle of the field's)
  for (const c of race.cars) if (c.q) w.est[c.team.name] = K / c.q.skill;
}

// a session without you: everyone's lap worked out
function simulate(w) {
  return w.field.map((who) => {
    const est = w.est[who];
    let best = null;
    for (let k = 0; k < 3 && est; k++) { const t = est * (1 + Math.abs(gauss()) * QUALI.spread * 0.6 + gauss() * QUALI.spread * 0.4); if (best == null || t < best) best = t; }
    return { who, best };
  });
}

// a session's classification and who goes through
function finish(w, format, rows) {
  const s = format[w.k], order = w.field;
  rows.sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity) || order.indexOf(a.who) - order.indexOf(b.who));
  const cut = w.k < format.length - 1 ? through(s, rows.length) : rows.length;
  w.sessions.push({ name: s.name, rows: rows.map((r, i) => ({ ...r, pos: i + 1, out: i >= cut })), cut: w.k < format.length - 1 ? cut : null,
    simulated: !rows.some((r) => r.who === '@me') });
  w.field = rows.slice(0, cut).map((r) => r.who);
  w.k++;
}

// The grid: the last session's order, then those knocked out of each session before it, in their order there
export function gridOf(w) {
  const grid = [];
  for (let k = w.sessions.length - 1; k >= 0; k--) for (const r of w.sessions[k].rows) if (!grid.includes(r.who)) grid.push(r.who);
  return grid;
}