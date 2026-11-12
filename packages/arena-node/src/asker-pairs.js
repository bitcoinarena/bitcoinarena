// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NONCE PAIR IS DRAWN AND SPENT BY ONE ASKER (kanban #2386, #2389; WinningsSend's #2308, #2322 rule, for the settlement and the forfeit).
//
// POST /settle-commit and /forfeit-commit answer anyone, and one shared cap of pairs per message let a stranger refill it every keptMs, so every
// commit - the asker's own one first - was refused (503) and the settlement (or forfeit) never formed. And /settle-share and /forfeit-share spent a
// pair on the first list that carried its commitment, so one committee seat handed the asker's list re-posted it to every other seat with only its
// own commitment swapped: the honest seats signed that list, refused the asker's ("keeps no second pair") and the pass never reached the threshold.
//
// Now each pair belongs to the asker that drew it: this seat's own pass, a seat of the round that signs its commit ask (send-plan-ask.js), or - an
// unsigned ask, as a seat on an older build sends it - the one bucket all unsigned asks share. Each has its own bucket of `cap` pairs, and a pair is
// spent only on a list the same asker signs (an unsigned-drawn pair only on an unsigned list, as before; this seat's own only in its own pass).
// A stranger fills only the unsigned bucket; a peer seat's list spends nothing of anyone else's.

export const OWN = 'own';        // this seat's own pass (never from a door)
export const UNSIGNED = '';      // every ask that carries no signature
const refuse = (why, status = 409) => ({ ok: false, status, why });

/**
 * WHO ASKS A COMMIT: { ok, asker, askKey } or a refusal. `check()` verifies the header against the round's seats and answers { ok, who } (hex node
 * key) - called only when a header came. A signed ask names its ask id and clock; one further than keptMs from this seat's clock is not taken.
 */
export function commitAsker({ own = false, header = null, ask = null, at = null, now, keptMs, check }) {
  if (own) return { ok: true, asker: OWN, askKey: null };
  if (!header) return { ok: true, asker: UNSIGNED, askKey: null };
  if (!/^[0-9a-f]{16,64}$/i.test(String(ask || '')) || at === null || at === '' || !Number.isFinite(Number(at)))
    return refuse('a signed commit ask names its ask id and its time', 400);
  const by = check();
  if (!by.ok) return refuse(`this seat draws a nonce pair only for a seat of the round: ${by.why}`, 403);
  if (Math.abs(Number(now) - Number(at)) > keptMs) return refuse(`that commit ask is ${Number(now) - Number(at)} ms from this seat's clock: ask again`, 409);
  return { ok: true, asker: by.who, askKey: `${by.who}:${String(ask).toLowerCase()}` };
}

/** WHO ASKS A SHARE: { ok, by } or a refusal - this seat's own pass, the seat that signed the list, or nobody named. */
export function shareAsker({ own = false, header = null, check }) {
  if (own) return { ok: true, by: OWN };
  if (!header) return { ok: true, by: UNSIGNED };
  const c = check();
  return c.ok ? { ok: true, by: c.who } : refuse(`this seat signs a list only for a seat of the round: ${c.why}`, 403);
}

/** The refusal when `by` may not spend `pair`, else null. */
export function spendRefusal(pair, by) {
  return pair.asker === by ? null : refuse('that list is not signed by the asker this signer node\'s nonce pair was drawn for: it spends nothing', 403);
}

/** One message's pairs: every pair by its commitment key, each asker's bucket, and a signed ask's pair by its ask id (a replay gets the same pair). */
export class AskerPairs {
  constructor(message = null) {
    this.message = message;
    this.held = new Map();      // commitment key -> pair
    this.buckets = new Map();   // asker -> Map(commitment key -> pair), oldest first
    this.asks = new Map();      // asker:ask id -> pair
  }

  get size() { return this.held.size; }
  get(ck) { return this.held.get(ck) || null; }
  replayed(askKey) { return askKey ? this.asks.get(askKey) || null : null; }

  /**
   * ROOM FOR ONE MORE PAIR IN `asker`'s BUCKET: past `cap` only a pair older than keptMs goes (#1610 / #1611: no pair is pushed out while its
   * asker may still name it). `force` (this seat's own pass, the only filler of its bucket) drops the oldest even so. False when full.
   */
  room(asker, { now, keptMs, cap, force = false }) {
    const bucket = this.buckets.get(asker);
    if (!bucket) return true;
    for (const [k, p] of bucket) {
      if (bucket.size < cap || (!force && Number(now) - p.at < keptMs)) break;
      this.#drop(bucket, k, p);
    }
    return bucket.size < cap;
  }

  /** Keeps `pair` (its `asker`, `askKey` and `at` set) under commitment key `ck`. */
  keep(ck, pair) {
    let bucket = this.buckets.get(pair.asker);
    if (!bucket) { bucket = new Map(); this.buckets.set(pair.asker, bucket); }
    this.held.set(ck, pair); bucket.set(ck, pair);
    if (pair.askKey) this.asks.set(pair.askKey, pair);
  }

  #drop(bucket, k, p) {
    bucket.delete(k); this.held.delete(k);
    if (p.askKey) this.asks.delete(p.askKey);
  }
}
