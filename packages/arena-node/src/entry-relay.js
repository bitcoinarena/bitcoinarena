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
export const RELAY_HEADER = 'x-arena-relayed';
const AFTER_MS = 700, SPREAD_MS = 500;      // after the client's own posts have had their time, and not all seats at the same moment
const LOCK_AFTER_MS = 1500;                 // and a lock after the entry it needs
const CLOSE_MARGIN_MS = 300;                // an entry taken just before entry close goes at once: the seats' doors shut there
const WAIT_MS = 4000, TRIES = 3, AGAIN_MS = 2000, KEPT = 2048;

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
          const has = r.status === 200 ? await r.json() : r.status === 404 ? {} : null;
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
