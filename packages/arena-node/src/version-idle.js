// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH SUPERSEDED GAME VERSIONS A START MAY LEAVE UNLOADED (kanban #3679, ruled in #3706): a local hosting choice, not a protocol rule -
// nothing a seat signs changes. A version is left unloaded only when all four hold at this seat:
//   (1) no round of it is open here and no series this seat holds names it (loadInstalled asks only for versions another installed
//       version supersedes, so it is the current version of no game);
//   (2) every round of it is past final_after (round_end + 600 s + 5 s) with no objection pending here and no market outcome still inside
//       its objection window;
//   (3) every round of it that took a stake is settled (its settlement ACCEPTED, or its retry SETTLED / EXPIRED) and nothing of it is still
//       being submitted;
//   (4) at least 24 h have passed since its last round ended, and since its last settlement was taken here.
// The store records no block height for a settlement, so "6 blocks deep" is read as (4)'s 24 h after the settlement was taken here
// (stake_expiry_blocks 144 = one day; 6 blocks is about an hour). Anything this cannot read keeps the version loaded. A version left
// unloaded is still hosted - its manifest, chain, files and every record stay - and its cores load on the first round, replay, re-run,
// objection or re-verify that reaches it (plugins.js loadKept).
import { OPEN } from './store.js';

/** 24 h: the least time since a version's last round end and last settlement before a start may leave it unloaded. */
export const KEEP_UNLOADED_AFTER_MS = 24 * 3600 * 1000;
/** final_after's distance past round_end (§13A: 600 s + 5 s). */
export const FINAL_AFTER_MS = 605 * 1000;
// a round contract's game_id: after its type (1 byte), protocol version (2) and network id (32) - substr is 1-based
const GAME_AT = 36;

/**
 * Of `ids` (game ids, hex), the versions a start may leave unloaded. `seriesGameIds`: the game ids (hex) of every series this seat
 * holds. Answers { idle: Set<hex>, why: Map<hex, string> } - why names what keeps each other id loaded.
 */
export function idleVersions(db, ids, { nowMs = Date.now(), seriesGameIds = new Set() } = {}) {
  const idle = new Set(), why = new Map();
  const want = [...new Set([...ids].map((x) => String(x).toLowerCase()).filter((x) => /^[0-9a-f]{64}$/.test(x)))];
  if (!want.length) return { idle, why };
  for (const id of want) if (seriesGameIds.has(id)) why.set(id, 'a series this seat holds names it');
  let rounds;
  try {
    rounds = db.prepare(`SELECT round_id, state, opened_ms, closed_ms, lower(hex(substr(contract, ${GAME_AT}, 32))) AS g FROM rounds
      WHERE substr(contract, ${GAME_AT}, 32) IN (${want.map(() => '?').join(', ')})`).all(...want.map((x) => Buffer.from(x, 'hex')));
  } catch (e) { for (const id of want) if (!why.has(id)) why.set(id, `its rounds cannot be read: ${e.message}`); return { idle, why }; }
  const one = (sql) => { const s = db.prepare(sql); return (rid) => s.get(rid); };
  const all = (sql) => { const s = db.prepare(sql); return (rid) => s.all(rid); };
  let q;
  try {
    q = {
      objection: one('SELECT 1 AS x FROM pending_objections WHERE round_id = ? LIMIT 1'),
      market: one("SELECT 1 AS x FROM market_states WHERE round_id = ? AND state = 'ATTESTED' LIMIT 1"),
      staked: one('SELECT 1 AS x FROM stake_locks WHERE round_id = ? LIMIT 1'),
      lock: one('SELECT state, made_ms FROM lock_settlements WHERE round_id = ?'),
      feds: all('SELECT state, made_ms FROM fed_lock_settlements WHERE round_id = ?'),
      retries: all('SELECT state, updated_ms FROM settle_retries WHERE round_id = ?'),
    };
  } catch (e) { for (const id of want) if (!why.has(id)) why.set(id, `its settlements cannot be read: ${e.message}`); return { idle, why }; }
  const old = (ms) => Number.isFinite(Number(ms)) && nowMs - Number(ms) >= KEEP_UNLOADED_AFTER_MS;
  const roundHolds = (r) => {
    if (r.state === OPEN || r.closed_ms === null || r.closed_ms === undefined) return 'a round of it is open';
    // (2) + (4): closed_ms is when this seat closed the round, at or after its round_end; 24 h is past final_after
    if (!old(r.closed_ms) || nowMs - Number(r.closed_ms) < FINAL_AFTER_MS) return 'a round of it ended under 24 h ago';
    const rid = r.round_id;
    if (q.objection(rid)) return 'an objection to a round of it is pending';
    if (q.market(rid)) return 'a market round of it is still inside its objection window';
    const retries = q.retries(rid), lock = q.lock(rid), feds = q.feds(rid);
    if (retries.some((t) => t.state !== 'SETTLED' && t.state !== 'EXPIRED')) return 'a settlement of it is still being retried';
    if (feds.some((f) => f.state !== 'ACCEPTED')) return 'a federation settlement of it is not accepted';
    if (lock && lock.state !== 'ACCEPTED') return 'a settlement of it is not accepted';
    const terminal = retries.some((t) => t.state === 'SETTLED' || t.state === 'EXPIRED') || (lock && lock.state === 'ACCEPTED') || feds.length > 0;
    if (q.staked(rid) && !terminal) return 'a staked round of it is not settled';
    // (3) read as 24 h after the settlement was taken here (see above)
    if ((lock && !old(lock.made_ms)) || feds.some((f) => !old(f.made_ms)) || retries.some((t) => !old(t.updated_ms))) return 'a settlement of it was taken under 24 h ago';
    return null;
  };
  for (const r of rounds) {
    if (why.has(r.g)) continue;
    let held;
    try { held = roundHolds(r); } catch (e) { held = `a round of it cannot be read: ${e.message}`; }
    if (held) why.set(r.g, held);
  }
  for (const id of want) if (!why.has(id)) idle.add(id);
  return { idle, why };
}
