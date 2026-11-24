// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §13D COPIED RUN (spec ruling kanban #3615, 2026-11-24; #3612, feedback #445).
//
// In a shared world (§12: one world per round) the same inputs relative to the join tick are the same run and the same
// score, so a player who joins later and replays an earlier joiner's inputs takes a place he did not play for. The rule:
// the LATER entry (larger joinTick) forfeits - FORFEIT, score 0, the §13B stake path - when its inputs at tick - joinTick
// equal the earlier entry's, word for word and tick for tick, from its first input, for at least COPIED_RUN_MIN_WORDS
// non-empty input words. The match is the common prefix: it covers an exact copy, a copy that stops early, a copy that
// plays on after the earlier run ends, and copy-then-deviate. A tick idle in both (all five words 0) neither counts nor
// breaks it. Equal join ticks: neither forfeits (neither could have read the other). The earlier entry is never touched.
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

/** The fewest non-empty input words the shared prefix must hold before anything is decided (ruling (2)). */
export const COPIED_RUN_MIN_WORDS = 32;

export const COPIED_RUN_RULE_TEXT = 'ARENA rule copied-run v1 (§13D, kanban #3615, RULED 2026-11-24): in a shared-world round, an entry whose '
  + 'inputs at tick - joinTick equal, word for word and tick for tick from its first input, those of an entry that joined at an earlier tick '
  + `for at least ${COPIED_RUN_MIN_WORDS} non-empty input words (a tick idle in both neither counts nor breaks the match) forfeits (FORFEIT, `
  + 'score 0, its stake as §13B). Equal join ticks: neither forfeits. The earlier entry is never touched.';
/** The hash an entry into a round under §13D names (contracts.js `copiedRunRule`). */
export const COPIED_RUN_RULE_HASH = ruleHash(COPIED_RUN_RULE_TEXT);

/** Whether §13D governs a round: written at COPIED_RUN_VERSION or later AND its config shares one world (its game says which). */
export function copiedRunApplies(contract, sharedWorld) {
  const v = Number(contract && contract.protocolVersion);
  return Number.isInteger(v) && v >= COPIED_RUN_VERSION && worldIsShared(contract, sharedWorld || []);
}

/** A run's inputs as the rule reads them: `{ joinTick, firstTick, ticks }` - ticks the five-word rows from firstTick on, contiguous. */
export function runInputs(joinTick, flat) {
  return { joinTick, firstTick: flat.firstTick, ticks: flat.ticks };
}

const idle = (row) => row.every((v) => v === 0);
const rowAt = (run, rel) => {
  const i = run.joinTick + rel - run.firstTick;
  return i >= 0 && i < run.ticks.length ? run.ticks[i] : undefined;
};

/**
 * THE COMMON PREFIX OF TWO RUNS, RELATIVE TO EACH JOIN TICK: `{ words, endsAt }` - the non-empty words of the shared
 * prefix (ticks idle in both are skipped, not counted) and the relative tick where it ends (the first differing tick, or where
 * either run has no tick).
 */
export function sharedPrefix(a, b) {
  let words = 0, rel = 0;
  for (;; rel++) {
    const x = rowAt(a, rel), y = rowAt(b, rel);
    if (x === undefined || y === undefined) break;
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) break;
    if (idle(x)) continue;
    for (const v of x) if (v !== 0) words++;
  }
  return { words, endsAt: rel };
}

/**
 * DOES `later` COPY `earlier`? `{ copied, words, why }`. Only a later join can copy: equal join ticks, or `later` not later,
 * is never a copy.
 */
export function copiedRun(earlier, later) {
  if (!(later.joinTick > earlier.joinTick)) return { copied: false, words: 0, why: 'not a later join: neither could have read the other' };
  const p = sharedPrefix(earlier, later);
  if (p.words >= COPIED_RUN_MIN_WORDS) return { copied: true, words: p.words, why: `its first ${p.words} non-empty input words (to relative tick ${p.endsAt}) are the earlier run's` };
  return { copied: false, words: p.words, why: `${p.words} shared non-empty input words, under ${COPIED_RUN_MIN_WORDS}` };
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
    if (c.copied) return { of: o.entryId, words: c.words, why: c.why };
  }
  return null;
}
