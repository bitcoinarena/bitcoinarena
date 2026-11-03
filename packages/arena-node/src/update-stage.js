// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// UPDATES STAGED PER FEDERATION (kanban #1093 part 3, the owner 2026-11-03: "An update reaches at most f guardians of one federation at a time.
// A guardian's updater waits while f of its federation's guardians already run the new version without a healthy hour behind them. ... A
// release with a fault then never reaches the threshold before it shows.").
//
// A guardian's seat answers its updater (GET /update-stage?version=V) from what its fellow guardians' seats say about themselves (GET
// /release): the release each runs and since when. A fellow on V for less than STAGE_HEALTHY_MS - or on V and not answering for its health -
// is still on trial. While f fellows are on trial nobody else updates. The ones still on the old release go one after the other in the order of
// their node keys, so two guardians that ask at the same moment never both take the last free place.

/** A healthy hour: a guardian on the new release this long, answering, no longer counts against the stage. */
export const STAGE_HEALTHY_MS = 3_600_000;

/** f of a federation of n guardians (n = 3f + 1, rounded down): 7 -> 2, 10 -> 3, 4 -> 1. */
export const faultsOf = (n) => Math.max(0, Math.floor((Number(n) - 1) / 3));

const hexOf = (k) => (k instanceof Uint8Array ? Buffer.from(k).toString('hex') : String(k || '')).toLowerCase();

/**
 * Whether this guardian may take release `version` now.
 *  `self`     this guardian's node key (hex or bytes)
 *  `members`  every guardian node key of its federation, itself included
 *  `answers`  Map(node key hex -> { version, startedAtMs, healthy } | null): each fellow's GET /release, null when it did not answer
 * Answers { go, onTrial, f, waitingBefore, why }.
 */
export function stageDecision({ version, self, members, answers, nowMs = Date.now() }) {
  const me = hexOf(self);
  const keys = [...new Set((members || []).map(hexOf))].filter(Boolean);
  if (!keys.includes(me)) return { go: true, onTrial: 0, f: 0, waitingBefore: 0, why: 'not a guardian of a federation here: nothing to stage' };
  const f = faultsOf(keys.length);
  const fellows = keys.filter((k) => k !== me);
  const onTrial = fellows.filter((k) => {
    const a = answers instanceof Map ? answers.get(k) : null;
    if (!a || a.version !== version) return false;
    return !(Number(a.startedAtMs) > 0 && nowMs - Number(a.startedAtMs) >= STAGE_HEALTHY_MS && a.healthy !== false);
  });
  // the ones still to update, this one included, in node-key order: those before it go first
  const waiting = [me, ...fellows.filter((k) => { const a = answers instanceof Map ? answers.get(k) : null; return a && a.version !== version; })].sort();
  const waitingBefore = waiting.indexOf(me);
  if (f === 0) return { go: onTrial.length === 0 && waitingBefore === 0, onTrial: onTrial.length, f, waitingBefore,
    why: onTrial.length || waitingBefore ? `one guardian at a time in a federation of ${keys.length}` : 'go' };
  const go = onTrial.length + waitingBefore < f;
  return { go, onTrial: onTrial.length, f, waitingBefore,
    why: go ? `go: ${onTrial.length} of ${f} places on trial taken${waitingBefore ? `, ${waitingBefore} before this one` : ''}`
      : `wait: ${onTrial.length} guardian(s) of ${keys.length} run ${version} without a healthy hour yet${waitingBefore ? ` and ${waitingBefore} go before this one` : ''}; at most ${f} at a time` };
}
