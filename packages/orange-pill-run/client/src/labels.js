// Orange Pill Run - where the floating texts go (kanban #3251, owner 2026-11-22: "Die Labels kommen oft vor der Figur und man sieht dann
// nicht, was vor einem ist"). Pure layout in canvas CSS pixels, no drawing and no world state: the renderer measures the texts, asks here
// for their boxes and draws them; the tests ask the same functions. The rule every box keeps: nothing in the AHEAD zone - the 6 columns
// in front of the runner, at his height.

export const AHEAD_COLS = 6;
export const POP_LIFE = 48;              // a popup lives 48 steps = 0.8 s (60 steps a second), whatever the simulation's own fx timer says
export const POP_RISE = 0.6;             // px per step it drifts up
export const HINT_LIFE = 300, HINT_GAP = 320;

// the runner as drawn: { x: left, w: width, top, bottom } in CSS px; col: one column in CSS px
export function aheadZone(runner, col) {
  const x0 = runner.x + runner.w;
  return { x0, x1: x0 + AHEAD_COLS * col, y0: runner.top, y1: runner.bottom };
}
export const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
export const popSize = (small) => (small ? 12 : 16);

// pops: [{ text, w (measured at popSize), age (steps since it appeared) }], oldest first. Each one sits above the runner's head and
// BEHIND him (its right edge at his middle), the newest lowest, the older ones stacked above it, drifting up and fading out by POP_LIFE.
// A text too wide for the room behind him is pushed right to the canvas edge and lifted a whole column above his head.
export function layoutPops(pops, runner, col, small) {
  const size = popSize(small), h = Math.round(size * 1.35), zone = aheadZone(runner, col), out = [];
  const live = pops.filter((p) => p.age >= 0 && p.age < POP_LIFE);
  let stack = 0;
  for (let i = live.length - 1; i >= 0; i--) {
    const p = live[i], w = p.w + 6;
    let x1 = runner.x + runner.w / 2 - 2, x0 = x1 - w, lift = 6;
    if (x0 < 4) { x0 = 4; x1 = x0 + w; lift = col + 6; }
    const y1 = runner.top - lift - p.age * POP_RISE - stack, y0 = y1 - h;
    stack += h + 2;
    const r = { text: p.text, size, x0, x1, y0, y1, alpha: Math.min(1, (p.age + 1) / 5, (POP_LIFE - p.age) / 18), ref: p.ref };
    if (!overlaps(r, zone)) out.push(r);
  }
  return out;
}

// the one first-sight hint: a box in the HUD band's lower edge, centred. If the runner is up there himself (a high jump with the whole
// world on screen), it waits instead of covering what is in front of him.
export function layoutHint(w, cssW, hudTop, runner, col) {
  const bw = w + 20, x0 = Math.max(8, cssW / 2 - bw / 2), r = { x0, x1: Math.min(cssW - 8, x0 + bw), y0: hudTop + 4, y1: hudTop + 32 };
  return overlaps(r, aheadZone(runner, col)) ? null : r;
}

// the first-sight schedule (renderer-owned, never on the world): a kind is shown once a run, one at a time, HINT_GAP steps apart.
// seen: an object the renderer keeps per run; returns the age of `key`'s hint, or -1 if it is not on now.
export function hintAge(seen, key, f, onScreen) {
  const s = seen[key];
  if (s === undefined) { if (onScreen && f >= (seen.next || 0)) { seen[key] = f; seen.next = f + HINT_GAP; } return -1; }
  const age = f - s; return age >= 0 && age < HINT_LIFE ? age : -1;
}

// the HUD's free room for the power-up timers (#3251: "MOON BOOTS 10 s" in the pill row, no more text over the play band)
// slots: [{ x, y, end }], items: [{ full, short, wFull, wShort }] at the pill font; returns [{ text, x, y, w }] or null where none fit
export function layoutTimers(slots, items, padX, gap) {
  const room = slots.map((s) => ({ ...s }));
  return items.map((it) => {
    for (const [text, tw] of [[it.full, it.wFull], [it.short, it.wShort]]) {
      const w = tw + padX, s = room.find((r) => r.end - r.x >= w);
      if (s) { const out = { text, x: s.x, y: s.y, w }; s.x += w + gap; return out; }
    }
    return null;
  });
}
