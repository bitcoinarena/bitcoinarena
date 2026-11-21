// Orange Pill Run - the scripted player (kanban #3246/#3247): the prototype's ghost bot without the
// stop-and-wait (the run is automatic). It jumps for cfg.jumpFrames steps when it sees a gap, a wall,
// spikes or a foe ahead. cfg is changed (cfg.hold), so give each run its own copy.
import { T, ROWS, PW, PH, TILE, isSolid } from "./constants.js";
import { tileAt } from "./world.js";

export const BOT_CONFIGS = [
  { name: "hodl_hanna", react: -12, jumpFrames: 12, billDist: 40 },
  { name: "satoshi_n", react: 6, jumpFrames: 18, billDist: 60 },
  { name: "stacker", react: 0, jumpFrames: 15, billDist: 30 },
];

export function botInput(W, cfg) {
  const p = W.p, ahead = p.x + PW + 10 + Math.max(0, p.vx) * 4;
  const feetRow = Math.floor((p.y + PH + 2) / T), tx = Math.floor(ahead / T);
  let gap = true; for (let ty = feetRow; ty < ROWS; ty++) { const v = tileAt(W, tx, ty); if (isSolid(v) || v === TILE.ONEWAY) { gap = v === TILE.RUG && ty === feetRow; break; } }
  const spike = p.ground && [0, 1].some((d) => tileAt(W, Math.floor((p.x + PW + 4) / T) + d, feetRow - 1) === TILE.SPIKE);
  let wall = spike; for (let ty = Math.floor(p.y / T) - 1; ty <= Math.floor((p.y + PH - 1) / T); ty++) if ([8, 20, 32].some((d) => isSolid(tileAt(W, Math.floor((p.x + PW + d + p.vx * 2) / T), ty)))) wall = true;
  const react = cfg.react || 0;
  const foe = W.L.enemies.some((e) => e.dead !== 0 && !e.dead && e.x - p.x > -4 && e.x - p.x < 50 + react && Math.abs((e.row * T - 20) - p.y) < 34);
  // money-printer bills flying at the runner (the prototype's bots did not see them)
  const bd = cfg.billDist || 0;
  const bill = bd > 0 && p.ground && W.bills.some((bl) => bl.x - (p.x + PW) > -6 && bl.x - (p.x + PW) < bd && (bl.by === undefined ? bl.y : bl.by) + 8 > p.y && (bl.by === undefined ? bl.y : bl.by) < p.y + PH + 2);
  if ((gap || wall || foe || bill) && !cfg.hold) cfg.hold = cfg.jumpFrames;
  if (cfg.hold > 0) cfg.hold--;
  return { jump: cfg.hold > 0 };
}
