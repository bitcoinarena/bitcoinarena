// Orange Pill Run - the frame clock and the drawn-between-steps positions (kanban #3335, owner 2026-11-22: "Das Spiel ruckelt auf dem
// laptop"). The simulation stays at a fixed 60 steps per second (src/sim, deterministic, the log and the score never change);
// the screen runs at its own rate (120 Hz on a ProMotion display). Drawing the state of the last whole step showed the same picture on
// every other frame at 120 Hz (measured: 50 % of the frames without camera movement) and 0/2-step pairs at 60 Hz (10 %).
// Now every frame draws the moving things between the step before and the last step, at alpha = the unspent time / STEP.
// The positions are set for the draw only and put back exactly (the same numbers) before anything steps again.

// clock.advance(now, speed, paused, can, step): adds the time since the last frame (at most maxDt, nothing while paused), runs step() while
// a whole step is due and can() holds, returns the steps taken. clock.alpha(): how far the screen is between the last two steps (0..1).
export function makeClock(STEP, maxDt = .1) {
  let acc = 0, last = 0;
  return {
    reset(now) { acc = 0; last = now; },
    advance(now, speed, paused, can, step) {
      const dt = Math.max(0, Math.min(maxDt, (now - last) / 1000)); last = now;
      if (!paused) acc += dt * speed;
      let n = 0; while (acc >= STEP && can()) { step(); acc -= STEP; n++; }
      return n;
    },
    alpha: () => Math.max(0, Math.min(1, acc / STEP)),
  };
}

// what moves between steps: the runner, the enemies, the printers' bills, the FUD clouds, the rising and magnet-pulled items and coins
const KEYS = ["x", "y", "by"];
const movers = (W) => [W.p, ...W.L.enemies, ...W.bills, ...W.L.clouds, ...W.L.items, ...W.L.coins];
// a jump longer than this between two steps is a teleport (a respawn at the checkpoint, a bear put back), never drawn in between
export const TELEPORT = 48;

// the positions before a step, by object
export function snapMovers(W) {
  const m = new Map();
  for (const o of movers(W)) m.set(o, [o.x, o.y, o.by]);
  return m;
}

// draw(frame) with every mover at prev + (now - prev) * alpha; frame = the step count between the two steps, for the animations.
// Each changed number is put back afterwards, also if draw throws.
export function drawBetween(W, prev, alpha, draw) {
  const back = [];
  if (prev && alpha < 1) {
    for (const o of movers(W)) {
      const s = prev.get(o); if (!s) continue;
      for (let k = 0; k < 3; k++) {
        const key = KEYS[k], was = s[k], cur = o[key];
        if (typeof was !== "number" || typeof cur !== "number" || was === cur || !Number.isFinite(was) || !Number.isFinite(cur) || Math.abs(cur - was) > TELEPORT) continue;
        back.push(o, key, cur); o[key] = was + (cur - was) * alpha;
      }
    }
  }
  const frame = prev ? Math.max(0, W.f - 1 + alpha) : W.f;
  try { return draw(frame); }
  finally { for (let i = 0; i < back.length; i += 3) back[i][back[i + 1]] = back[i + 2]; }
}
