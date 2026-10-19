// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LEAVE WITHOUT BEING SLASHED (2026-10-09: "Leave rounds, attestations, and custody without being
// slashed"). What the protocol slashes: a false or double signature, and a fee claimed for service not given (slash.js); a
// node absent from a round is not slashed ("a node that took nothing has cost nobody anything"). So a seat leaves by taking
// no new round from the moment its owner says so and serving every round it already holds to the end: past its end and its
// objection window, and - a paying round with entries - until its settlement is accepted. This answers what is still owed
// and from when the seat is free. Custody: a guardian may go only if the federation keeps its threshold without it
// (federation-slash.js haltsAt: f + 1 gone halts it, and a halt is what a guardian's bond answers for).
export const LEAVE_OWED_WHY = Object.freeze({ open: 'its entries or its run are not over yet', objection: 'its objection window is still open',
  settlement: 'its settlement is not accepted yet' });

/**
 * `rounds`: [{ id, endMs, objectionWindowMs, assigned, paying, entries, settlementAccepted }] - the rounds this seat holds;
 * `leavingAtMs` (null: not leaving); `custody`: { guardian, keys, threshold } or null. Answers what is owed and the custody
 * check; pure.
 */
export function leaveStatus({ rounds = [], nowMs, leavingAtMs = null, custody = null }) {
  const owed = [];
  for (const r of rounds) {
    if (!r.assigned) continue;
    const freeAtMs = Number(r.endMs) + Number(r.objectionWindowMs);
    const why = nowMs < Number(r.endMs) ? 'open' : nowMs < freeAtMs ? 'objection' : (r.paying && r.entries > 0 && !r.settlementAccepted) ? 'settlement' : null;
    if (why) owed.push({ id: r.id, why, freeAtMs: why === 'settlement' ? null : freeAtMs });
  }
  owed.sort((a, b) => (a.freeAtMs ?? Infinity) - (b.freeAtMs ?? Infinity));
  const waitingSettlement = owed.some((o) => o.freeAtMs === null);
  const freeAtMs = owed.length ? (waitingSettlement ? null : Math.max(...owed.map((o) => o.freeAtMs))) : nowMs;
  let custodyCheck = { guardian: false, allowed: true, why: 'this seat holds no custody' };
  if (custody && custody.guardian) {
    const n = (custody.keys || []).length, t = Number(custody.threshold);
    const left = n - 1;
    custodyCheck = left >= t
      ? { guardian: true, guardians: n, threshold: t, allowed: true, why: `without this guardian the federation keeps ${left} of ${n}, at or above its threshold ${t}` }
      : { guardian: true, guardians: n, threshold: t, allowed: false, why: `without this guardian the federation keeps ${left} of ${n}, below its threshold ${t}: it would halt, and a halt takes the guardians' bonds` };
  }
  return { leaving: leavingAtMs !== null, leavingAtMs, owed: owed.length, rounds: owed.slice(0, 200),
    freeAtMs, freeNow: owed.length === 0, waitingSettlement, custody: custodyCheck };
}

/** Whether a round may be taken by a seat that is leaving: only one whose committee was formed before the leave. */
export const takesRound = (contract, leavingAtMs) => leavingAtMs === null || leavingAtMs === undefined || BigInt(contract.committeeTimeMs) <= BigInt(leavingAtMs);
