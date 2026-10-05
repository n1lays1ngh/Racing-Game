// Slipstream (the "tow"). A car punches a hole in the air; right behind it there's less air resistance,
// so the car following goes faster down the straights. The closer you are, and the more directly behind,
// the stronger the tow. Up close in corners the turbulent air ("dirty air") costs a little grip.
//
//   towFor(car, states) → 0…1: how strongly `car` is in someone's slipstream (race.js, every physics step)
//   physics.js then uses car.tow: drag × (1 − dragCut × tow), cornering grip × (1 − dirtyAir × tow)
//   The HUD shows yours (hud.js). It's the same for you, the AI and friends online.

export const SLIPSTREAM = {
    enabled: true,
    range: 60,        // metres behind a car where its wake still helps (strongest right behind it)
    width: 1.8,       // half-width of the wake just behind the car (metres)…
    spread: 0.035,    // …getting this much wider per metre further back
    dragCut: 0.12,    // up to this much less air resistance in the tow (0.12 ≈ +20 km/h top speed glued to a gearbox)
    dirtyAir: 0.04,   // up to this much less cornering grip right behind a car (0 = off)
    minSpeed: 25,     // m/s (90 km/h): below this there's no tow worth having
    falloff: 1.3,     // how quickly it fades with distance (1 = evenly, higher = mostly close up)
};

// How strongly car state `me` is in the slipstream of any of `states` (car states from physics.js).
export function towFor(me, states) {
    const S = SLIPSTREAM;
    if (!S.enabled || me.speed < S.minSpeed) return 0;
    const fx = Math.sin(me.h), fz = Math.cos(me.h), r2 = S.range * S.range;
    let best = 0;
    for (const o of states) {
        if (o === me || o.speed < S.minSpeed) continue;
        const dx = o.x - me.x, dz = o.z - me.z;
        if (dx * dx + dz * dz > r2) continue;
        const ahead = dx * fx + dz * fz;                  // metres in front of you
        if (ahead < 4 || ahead > S.range) continue;       // (closer than 4 m you're alongside or touching)
        const side = Math.abs(dx * fz - dz * fx), half = S.width + S.spread * ahead;
        if (side >= half) continue;                       // not in its wake
        const align = Math.sin(o.h) * fx + Math.cos(o.h) * fz;
        if (align < 0.85) continue;                       // it's pointing somewhere else (spinning, another bit of track)
        const s = (1 - ahead / S.range) ** S.falloff * (1 - (side / half) ** 2) * Math.min(1, (o.speed - S.minSpeed) / 15);
        if (s > best) best = s;
    }
    return best;
}