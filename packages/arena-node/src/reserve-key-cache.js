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
// KEPT ACROSS A RESTART (kanban #2869, measured 2026-11-16 01:44-02:10Z: every old-Mac seat lost federation A's key with its restart and,
// unable to reach the guardian seats, named none for hours - each settlement paying the reserves refused): `store`, when given,
// { load() -> [{ fed, epoch, key }], save(fed, epoch|null, key|null) }, holds what is kept; a kept key still answers only for its own epoch.
export function reserveKeyCache({ store = null } = {}) {
  const kept = new Map();               // federation hex -> { epoch hex, key }
  const save = (fed, k) => { if (store) { try { store.save(fed, k ? k.epoch : null, k ? k.key : null); } catch { /* memory still holds it */ } } };
  if (store) { try { for (const r of store.load() || []) if (r && r.fed && r.key instanceof Uint8Array) kept.set(r.fed, { epoch: r.epoch ?? null, key: r.key }); } catch { /* none kept */ } }
  return {
    get: (fed) => (kept.has(fed) ? kept.get(fed).key : undefined),
    has: (fed) => kept.has(fed),
    keys: () => kept.keys(),
    values: () => [...kept.values()].map((k) => k.key)[Symbol.iterator](),
    getFor(fed, epoch) {
      const k = kept.get(fed);
      if (!k) return null;
      return epoch == null || k.epoch === epoch ? k.key : null;
    },
    setFor(fed, epoch, key) { const was = kept.get(fed); kept.set(fed, { epoch, key });
      if (!was || was.epoch !== epoch || !(was.key instanceof Uint8Array) || !(key instanceof Uint8Array) || was.key.length !== key.length || was.key.some((v, i) => v !== key[i])) save(fed, { epoch, key });
      return key; },
    dropMoved(epochOf) {
      const gone = [];
      for (const [fed, k] of kept) { const now = epochOf(fed); if (now && now !== k.epoch) { kept.delete(fed); gone.push(fed); save(fed, null); } }
      return gone;
    },
  };
}
