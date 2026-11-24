// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §13D COPIED RUN (spec rulings kanban #3615 and #3663, 2026-11-24; #3612, feedback #445).
//
// In a shared world (§12: one world per round) the same inputs relative to the join tick are the same run and the same
// score, so a player who joins later and replays an earlier joiner's inputs takes a place he did not play for.
//
// THE MEASURE IS INPUT CHANGES (#3663): each entry's stream is reduced to its change list - (t - joinTick, word) for every
// tick whose word (the tick's five input values) differs from the word at the tick before; the first tick compares with "no
// input" (all five 0). A held key is one change when pressed and one when released; idle stretches add nothing; a release is a
// change like any other. The LATER entry (larger joinTick) forfeits - FORFEIT, score 0, the §13B stake path - when its change
// list and an earlier joiner's share a common prefix of at least COPIED_RUN_MIN_CHANGES changes: the same relative tick and the
// same word for each, starting with the first change of both. That covers an exact copy, a copy that stops early, one that plays
// on after the earlier run ends, and copy-then-deviate; two honest players holding throttle from their join are 1 change each.
// Equal join ticks: neither forfeits (neither could have read the other). The earlier entry is never touched.
//
// ONLY ON A SHARED-WORLD CONFIG, AND ONLY FOR A ROUND WRITTEN AT COPIED_RUN_VERSION OR LATER: under per-player worlds the same
// inputs play another world, and a round written before the rule closes exactly as it did (the scheme is the round's, never
// the seat's). The rule is bound into the Entry Contract (contracts.js `copiedRunRule`), as §13B's equivocation_rule_hash: an
// entry into such a round names this rule's hash, so its player accepted it before staking.
//
// Pure: no store, no core, no clock. Every seat of a committee runs this over the canonical transcripts it holds (§13C).
import { COPIED_RUN_VERSION } from './constants.js';
import { worldIsShared } from './seed.js';
import { ruleHash } from './rules.js';

/** The fewest shared input changes before anything is decided (#3663). */
export const COPIED_RUN_MIN_CHANGES = 32;

export const COPIED_RUN_RULE_TEXT = 'ARENA rule copied-run v2 (§13D, kanban #3615 and #3663, RULED 2026-11-24): in a shared-world round each '
  + 'entry\'s inputs are reduced to their change list, (tick - joinTick, word) for every tick whose five input values differ from the tick '
  + 'before (the first tick compared with no input; a release is a change). An entry whose change list shares a common prefix of at least '
  + `${COPIED_RUN_MIN_CHANGES} changes (same relative tick, same word, from the first change of both) with that of an entry that joined at an `
  + 'earlier tick forfeits (FORFEIT, score 0, its stake as §13B). Equal join ticks: neither forfeits. The earlier entry is never touched.';
/** The hash an entry into a round under §13D names (contracts.js `copiedRunRule`). */
export const COPIED_RUN_RULE_HASH = ruleHash(COPIED_RUN_RULE_TEXT);

/** Whether §13D governs a round: written at COPIED_RUN_VERSION or later AND its config shares one world (its game says which). */
export function copiedRunApplies(contract, sharedWorld) {
  const v = Number(contract && contract.protocolVersion);
  return Number.isInteger(v) && v >= COPIED_RUN_VERSION && worldIsShared(contract, sharedWorld || []);
}

const NO_INPUT = [0, 0, 0, 0, 0];
const sameWord = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

/**
 * A STREAM'S CHANGE LIST: `[[rel, word], ...]` for every tick whose word differs from the tick before, rel = tick - joinTick.
 * `rows` are the five-word rows from `firstTick` on, contiguous; the tick before the first is "no input".
 */
export function changeList(joinTick, firstTick, rows) {
  const out = [];
  let prev = NO_INPUT;
  for (let i = 0; i < rows.length; i++) {
    if (!sameWord(rows[i], prev)) out.push([firstTick + i - joinTick, rows[i]]);
    prev = rows[i];
  }
  return out;
}

/** A run as the rule reads it: `{ joinTick, changes }`, from a flattened transcript (transcript.js flatten). */
export function runInputs(joinTick, flat) {
  return { joinTick, changes: changeList(joinTick, flat.firstTick, flat.ticks) };
}

/** THE COMMON PREFIX OF TWO CHANGE LISTS, in changes: same relative tick and same word, from the first change of both. */
export function sharedChanges(a, b) {
  const n = Math.min(a.changes.length, b.changes.length);
  let k = 0;
  while (k < n && a.changes[k][0] === b.changes[k][0] && sameWord(a.changes[k][1], b.changes[k][1])) k++;
  return k;
}

/** DOES `later` COPY `earlier`? `{ copied, changes, why }`. Only a later join can copy. */
export function copiedRun(earlier, later) {
  if (!(later.joinTick > earlier.joinTick)) return { copied: false, changes: 0, why: 'not a later join: neither could have read the other' };
  const k = sharedChanges(earlier, later);
  if (k >= COPIED_RUN_MIN_CHANGES) return { copied: true, changes: k, why: `its first ${k} input changes are the earlier run's, tick for tick` };
  return { copied: false, changes: k, why: `${k} shared input changes, under ${COPIED_RUN_MIN_CHANGES}` };
}

/**
 * THE EARLIER ENTRY A RUN COPIES, among a round's other runs: the first (by join tick, then entry id) whose shared prefix
 * reaches the minimum, or null. `others` are `{ entryId (hex), run }`.
 */
export function copiedRunOf(run, others) {
  const sorted = [...others].filter((o) => o.run.joinTick < run.joinTick)
    .sort((x, y) => x.run.joinTick - y.run.joinTick || (x.entryId < y.entryId ? -1 : x.entryId > y.entryId ? 1 : 0));
  for (const o of sorted) {
    const c = copiedRun(o.run, run);
    if (c.copied) return { of: o.entryId, changes: c.changes, why: c.why };
  }
  return null;
}
