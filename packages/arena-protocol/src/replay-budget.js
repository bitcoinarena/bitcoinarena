// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE REPLAY BUDGET (§34): "Every committee member replays every run of its round ... a hard capacity relation rather than
// an assumption: max_players_per_round = (measured_replay_speed x result_window) / T_run". "Do not hard-code unsupported assumptions
// such as 20x realtime until the simulation core is benchmarked": the speed is what a seat measured on its own replays.
import { OBJECTION_WINDOW_MS } from './window.js';

/** The players one committee node can replay inside the result window: floor(speed x window / T_run); 0 without a measurement. */
export function maxPlayersPerRound({ speedX, runMs, windowMs = Number(OBJECTION_WINDOW_MS) }) {
  if (!(speedX > 0) || !(runMs > 0)) return 0;
  return Math.floor((speedX * windowMs) / runMs);
}

/** The median of measured speeds (game ms over wall ms per replay), or null with none. */
export function medianSpeed(samples) {
  const xs = (samples || []).filter((s) => s && s.wallMs > 0 && s.gameMs > 0).map((s) => s.gameMs / s.wallMs).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
