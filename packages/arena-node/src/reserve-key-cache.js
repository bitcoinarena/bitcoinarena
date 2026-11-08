// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RESERVE KEY, KEPT WITH THE EPOCH IT BELONGS TO (kanban #803, measured 2026-10-30 07:3xZ on round e994c3c4, federation B):
// four of the five seated seats verified the entry's reserve output to 02efa760…, and second-host seat 5 refused it, "the output … is not 2000
// msat to key 02ef0576…". Its GET /reserves showed both: `key` 02efa760… (its own share for the current guardian seats, epoch
// 296aff8c) and `reserveKey` 02ef0576… - the key it had kept for the federation from an earlier set of guardian seats, kept for good,
// whatever the members became. A kept key now answers only for the epoch it was kept under; a federation whose epoch moved is read anew.

/**
 * The seat's kept reserve keys. `get(fed)`, `keys()` and `values()` read as the Map they replace (a key whatever its epoch, for a reader
 * with no census at hand); `getFor(fed, epoch)` answers only a key kept under that epoch; `setFor` keeps one with its epoch;
 * `dropMoved(epochOf)` lets go of every key whose federation's epoch is now another (`epochOf(fed)`: the current epoch, or null when
 * this seat cannot tell, which keeps the key).
 */
export function reserveKeyCache({ db = null } = {}) {
  const kept = new Map();               // federation hex -> { epoch hex, key }
  // EVERY KEY THIS SEAT HAS HELD FOR A FEDERATION, WITH ITS EPOCH (kanban #1246, audit 3 CONSENSUS-2): a settlement pays the key of its plan's
  // moment, and judging it later against the key of the epoch now made an honest settlement slashable after any epoch change. Kept in the
  // store when there is one, so a restart still knows the keys it paid to.
  const past = new Map();               // federation hex -> Set(key hex)
  // BY EPOCH (kanban #1359, audit 4 fixesB-7): which key belonged to which set of guardian seats, so a check can ask for the key of the round's
  // own epoch - not "any key this seat ever saw", which let a long-retired key pass and made a key this seat never read look like an offence
  const byEpoch = new Map();            // federation hex -> Map(epoch hex -> key hex)
  const keepEpoch = (fed, epoch, hex) => { if (epoch == null) return; const m = byEpoch.get(fed) || new Map(); if (!m.has(String(epoch))) m.set(String(epoch), hex); byEpoch.set(fed, m); };
  if (db) {
    try {
      db.exec('CREATE TABLE IF NOT EXISTS reserve_key_history (federation TEXT NOT NULL, epoch TEXT, key TEXT NOT NULL, first_ms INTEGER NOT NULL, PRIMARY KEY (federation, key))');
      for (const r of db.prepare('SELECT federation, epoch, key FROM reserve_key_history').all()) { const s = past.get(r.federation) || new Set(); s.add(r.key); past.set(r.federation, s); keepEpoch(r.federation, r.epoch, r.key); }
    } catch { /* memory only */ }
  }
  const remember = (fed, epoch, key) => {
    const hex = key instanceof Uint8Array ? Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('') : (typeof key === 'string' ? key.toLowerCase() : null);
    if (!hex) return;
    keepEpoch(fed, epoch, hex);
    const s = past.get(fed) || new Set(); if (s.has(hex)) return; s.add(hex); past.set(fed, s);
    if (db) { try { db.prepare('INSERT OR IGNORE INTO reserve_key_history (federation, epoch, key, first_ms) VALUES (?, ?, ?, ?)').run(fed, epoch == null ? null : String(epoch), hex, Date.now()); } catch { /* memory only */ } }
  };
  return {
    /** Every key (hex) this seat has held for `fed`, the current one among them (kanban #1246). */
    historyOf: (fed) => [...(past.get(fed) || [])],
    /** The key (hex) this seat held for `fed` under `epoch`, or null: never read here (kanban #1359). */
    keyOfEpoch: (fed, epoch) => (epoch == null ? null : ((byEpoch.get(fed) || new Map()).get(String(epoch)) || null)),
    get: (fed) => (kept.has(fed) ? kept.get(fed).key : undefined),
    has: (fed) => kept.has(fed),
    keys: () => kept.keys(),
    values: () => [...kept.values()].map((k) => k.key)[Symbol.iterator](),
    getFor(fed, epoch) {
      const k = kept.get(fed);
      if (!k) return null;
      return epoch == null || k.epoch === epoch ? k.key : null;
    },
    setFor(fed, epoch, key) { kept.set(fed, { epoch, key }); remember(fed, epoch, key); return key; },
    dropMoved(epochOf) {
      const gone = [];
      for (const [fed, k] of kept) { const now = epochOf(fed); if (now && now !== k.epoch) { kept.delete(fed); gone.push(fed); } }
      return gone;
    },
  };
}

/**
 * THE RESERVE KEYS A SETTLEMENT MAY HAVE PAID, FOR THE LEVEL-2 PAYEE CHECK (kanban #1246, audit 3 CONSENSUS-2): for each of the round's federations
 * the key now (`keysNow[i]`, hex or null) and every key this seat held for it (`historyOf(fed)`); null - unread, never an offence - when a federation
 * has neither. An empty set read as "read" made every reserve row of an honest settlement unpayable during key generation or after an epoch moved.
 */
export function payeeReserveKeys(feds, keysNow, historyOf = () => []) {
  const all = new Set();
  for (let i = 0; i < feds.length; i++) {
    const now = typeof keysNow[i] === 'string' && keysNow[i] ? keysNow[i].toLowerCase() : null;
    let had = []; try { had = historyOf(feds[i]) || []; } catch { had = []; }
    if (!now && !had.length) return null;
    if (now) all.add(now);
    for (const k of had) all.add(String(k).toLowerCase());
  }
  return all;
}

/**
 * THE RESERVE KEYS A SETTLEMENT MAY HAVE PAID, BY EPOCH (kanban #1359, audit 4 fixesB-7; replaces payeeReserveKeys' "every key ever held" for the
 * payee check). A round's settlement pays the reserve key of the federation's guardian seats between the round's census and its claim: the epoch
 * at the round's census height (`epochAt(fed)`) and the epoch now (`epochNow(fed)`), nothing older. Per federation:
 *   - the census epoch unknown, or its key never read here  -> null: unread, never an offence (a seat that was down or new in that epoch)
 *   - else that key, and the key now when the epoch has moved since (`keysNow[i]`, hex or null, or the key kept for the epoch now)
 * A key from an epoch before the round's census is not in the set, so a reserve row paying it is not read as payable.
 */
export function payeeReserveKeysAt(feds, { epochAt, epochNow = () => null, keyOfEpoch, keysNow = [] }) {
  const all = new Set();
  const low = (k) => (typeof k === 'string' && k ? k.toLowerCase() : null);
  for (let i = 0; i < feds.length; i++) {
    const f = feds[i];
    let e0 = null, en = null; try { e0 = epochAt(f); } catch { e0 = null; } try { en = epochNow(f); } catch { en = null; }
    if (!e0) return null;
    const now = low(keysNow[i]);
    const k0 = low(keyOfEpoch(f, e0)) || (en === e0 ? now : null);
    if (!k0) return null;
    all.add(k0);
    if (en && en !== e0) { const kn = now || low(keyOfEpoch(f, en)); if (kn) all.add(kn); }
  }
  return all;
}
