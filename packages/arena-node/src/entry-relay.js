// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HEAD-TO-HEAD ENTRY REACHES EVERY SEAT OF ITS ROUND (kanban #1068). The player's client posts the handout, the entry and the locks to each seat
// once, and nothing else carried them: a post that was lost, or an entry that came before its handout had landed, left that seat short of the
// entry for good (measured over 7 days on 7 of the 14 seats: 18 of 114 two-entry rounds). A seat short of one entry decides the round without it
// (VOID, there is no second player), then answers a settlement plan with "no loser's lock is claimed", and two rounds' plans stopped at 4 of 5.
//
// So a seat that took an entry or a lock from a client hands it on to the round's other seats, through their ordinary doors: each seat checks
// it there as it checks a client's copy, entry close included, so this adds no trust in the seat that hands it. Only a copy from a client is
// handed on (RELAY_HEADER marks a seat's), and only to a seat that does not hold it. A market has its own way (order-batch.js replayOrder), and a
// replayed game's client sends its entry again with its batches.
import { peerJsonUpTo } from './peer-body.js';

export const RELAY_HEADER = 'x-arena-relayed';
const AFTER_MS = 700, SPREAD_MS = 500;      // after the client's own posts have had their time, and not all seats at the same moment
const LOCK_AFTER_MS = 1500;                 // and a lock after the entry it needs
const CLOSE_MARGIN_MS = 300;                // an entry taken just before entry close goes at once: the seats' doors shut there
const WAIT_MS = 4000, TRIES = 3, AGAIN_MS = 2000, KEPT = 2048;
const VIEW_WAIT_MS = 3000;                  // a dead peer may not hold a seat's close for longer than this
// AND NO PEER'S ANSWER IS READ PAST A CAP (kanban #1870, #1901; #1550/#1685's rule for every peer pull): membersKnown asks every peer's GET /api/round-result on
// every finality pass, and a bare r.json() let one seat stream 96 MiB in 420 ms into each seat that asked, pass after pass. A round's result lists each
// entry in a few hundred bytes: 1 MiB is far past any round and far short of a flood. A lock answer is a few hundred bytes.
export const VIEW_MAX_BYTES = 1024 * 1024;
export const LOCKS_MAX_BYTES = 64 * 1024;

// AND THE DOOR DECIDES NOTHING ABOUT WHO IS IN THE ROUND (kanban #1071, §17). A seat's door is its own: the backup rule, and every other refusal, says whether this
// seat takes a new entry now. Handing an entry on cannot help a door that refused it, so before a head-to-head seat signs anything it looks at the entries its peers
// hold (GET /api/round-result, which every build serves; a hint and nothing more):
//   an entry too many seats lack    `slots - needed` seats may lack an entry and it can still reach the threshold; one seat more and it never can. It is no member:
//                                   ENTRY_VOID where it is held. This changes no outcome a quorum could have reached: such an entry can gather no threshold.
//   an entry this seat lacks        waits for the threshold of signed results naming it, each checked (verify.js signersNaming). Then it is in, whatever this
//                                   seat's door said: the entry, its handout, its locks and the winner's address come from the peers, past the door, and every one
//                                   of them is checked as a client's copy is: the bytes to the id, the shares to the stake point, the locks with the federation, the
//                                   address and each item by their signatures. This seat then signs what the others signed.
//   nothing else in sight           too few seats answered to rule out an entry: this seat waits too. It never decides the round alone.
// Until the wait ends this seat signs nothing for the round. A wait that runs out at the result window leaves it silent, which a round survives.

/** ONE LOOK AT A ROUND'S MEMBERS. Answers { wait: why | null, took: [hex], voided: [hex], view } */
export async function lookAtMembers({ roundId, roundHex, peers, slots, needed, players, held, viewOf, take, voidEntry }) {
  const views = await Promise.all(peers.map((base) => viewOf(base, roundHex).catch(() => null)));
  const answered = views.filter(Boolean);
  const room = slots - needed;                             // how many seats may lack an entry that can still reach the threshold
  const lacking = (e) => (held.has(e) ? 0 : 1) + answered.filter((v) => !v.has(e)).length;
  const seen = new Set(held);
  for (const v of answered) for (const e of v) seen.add(e);
  const voided = [], took = [], waits = [];
  let members = 0;
  for (const e of seen) {
    if (lacking(e) > room) { if (held.has(e)) { await voidEntry(roundId, e); voided.push(e); } continue; }
    if (held.has(e)) { members++; continue; }
    const from = peers.filter((_, i) => views[i] && views[i].has(e));
    const got = await take(roundId, e, from);
    if (got.ok) { took.push(e); members++; } else waits.push(`${e.slice(0, 16)}: ${got.why}`);
  }
  // NOTHING IN SIGHT, AND SEATS ENOUGH SAID SO: an entry no seat that answered holds is lacked by all of them
  if (!waits.length && held.size && members < players && answered.length + 1 <= room) waits.push(`only ${answered.length + 1} of ${slots} seats answered`);
  return { wait: waits.length ? waits.join('; ') : null, took, voided, answered: answered.length };
}

/** A SEAT'S VIEW OF A ROUND: the entries it holds, as a Set of hex, or throws if it did not answer. */
export const seatView = (fetcher) => async (base, roundHex) => {
  const r = await fetcher(`${base}/api/round-result?round=${roundHex}`, { signal: AbortSignal.timeout(VIEW_WAIT_MS) });
  if (r.status === 404) return new Set();                  // it holds no such round, so it holds no entry of it
  if (!r.ok) { try { await r.body?.cancel(); } catch { /* gone */ } throw new Error(`${r.status}`); }
  const j = await peerJsonUpTo(r, VIEW_MAX_BYTES);       // kanban #1870, #1901: capped, not a bare r.json()
  return new Set((j.players || []).map((p) => String(p.entry)));
};

export function createEntryRelay({ peersOf, entryOf, handoutOf, locksOf, fetcher = (...a) => globalThis.fetch(...a), log = console.log, nowMs = () => Date.now(),
  afterMs = AFTER_MS, spreadMs = SPREAD_MS, lockAfterMs = LOCK_AFTER_MS, againMs = AGAIN_MS } = {}) {
  const entries = new Set(), lockPasses = new Set();
  const later = (ms, run) => { const t = setTimeout(() => { run().catch((e) => log(`[relay] ${e.message}`)); }, ms); if (t.unref) t.unref(); };
  const once = (set, k) => { if (set.has(k)) return false; if (set.size >= KEPT) set.delete(set.values().next().value); set.add(k); return true; };
  const ask = (url, init = {}) => fetcher(url, { ...init, signal: AbortSignal.timeout(WAIT_MS) });
  const post = (url, body) => ask(url, { method: 'POST', body, headers: { [RELAY_HEADER]: '1' } });
  const bases = (roundId) => peersOf(roundId).map((p) => String(p).replace(/\/+$/, ''));

  const handEntry = async (roundId, entryHex) => {
    const entry = entryOf(entryHex);
    if (!entry) return;
    const handout = handoutOf(entryHex);
    const said = await Promise.all(bases(roundId).map(async (base) => {
      try {
        const held = await ask(`${base}/entry?id=${entryHex}`);
        if (held.status !== 404) return null;
        if (handout) await post(`${base}/handout`, handout);
        const took = await post(`${base}/entry`, entry);
        return took.status === 201 ? 'took' : `${took.status}`;
      } catch (e) { return e.message; }
    }));
    const handed = said.filter((x) => x !== null);
    if (handed.length) log(`[relay] entry ${entryHex.slice(0, 16)}: ${handed.filter((x) => x === 'took').length} of ${handed.length} seats short of it took it`
      + `${handed.some((x) => x !== 'took') ? ` (${[...new Set(handed.filter((x) => x !== 'took'))].join(', ').slice(0, 80)})` : ''}`);
  };

  const handLocks = async (roundId, entryHex) => {
    const held = locksOf(entryHex);
    if (!held.stake && !held.fee) return;
    let left = bases(roundId), took = 0;
    for (let i = 0; i < TRIES && left.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, againMs));
      // A SEAT STILL WITHOUT THE ENTRY answers 404 to a lock: asked again, the entry may be on its way
      const again = await Promise.all(left.map(async (base) => {
        try {
          const r = await ask(`${base}/order-locks?entry=${entryHex}`);
          const has = r.status === 200 ? await peerJsonUpTo(r, LOCKS_MAX_BYTES) : r.status === 404 ? {} : null;   // capped (#1870, #1901)
          if (!has) return null;
          let short = false;
          for (const [door, have, fields] of [['lock', has.stake, held.stake], ['fee-lock', has.fee, held.fee]]) {
            if (have || !fields) continue;
            const p = await post(`${base}/${door}?entry=${entryHex}`, JSON.stringify(fields));
            if (p.status === 201) took++; else if (p.status === 404) short = true;
          }
          return short ? base : null;
        } catch { return null; }
      }));
      left = again.filter(Boolean);
    }
    if (took) log(`[relay] entry ${entryHex.slice(0, 16)}: ${took} lock(s) handed on`);
  };

  return {
    /** A client's copy of an entry was taken here. `closeMs`: the round's entry close. */
    entryTaken(roundId, entryHex, closeMs) {
      if (!once(entries, entryHex)) return;
      const left = Number(closeMs) - nowMs() - CLOSE_MARGIN_MS;
      later(Math.max(0, Math.min(afterMs + Math.random() * spreadMs, Number.isFinite(left) ? left : Infinity)), () => handEntry(roundId, entryHex));
    },
    /** A client's copy of a lock was verified here. Both of an entry's locks go in one pass. */
    lockTaken(roundId, entryHex) {
      if (!once(lockPasses, entryHex)) return;
      later(lockAfterMs + Math.random() * spreadMs, async () => { lockPasses.delete(entryHex); await handLocks(roundId, entryHex); });
    },
  };
}
