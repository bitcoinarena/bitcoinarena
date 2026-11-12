// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NONCE PAIRS A SEAT HANDS OUT FOR A THRESHOLD SIGNATURE, ONE RULE FOR EVERY SIGNING (kanban #1489, #1996, #2011, #2044).
//
// The forfeit (forfeit.js), the settlement (settlement.js) and the winnings send (winnings-send.js) each sign in two rounds: a commit door
// hands out a nonce commitment, a share door signs one commitment list with the pair that list carries. Both doors answer anybody. Three
// copies of the pair rules drifted apart, and each copy was stopped by a stranger in its own way:
// - one unspent pair for every asker (winnings-send before this): a stranger asked for it and at once spent it on a list of made-up
//   commitments, and every honest list was refused ("keeps no second pair") - #1521, fixed in the forfeit only;
// - the oldest pair dropped past a small cap (the settlement's 64, the forfeit's 256 before #1699): a stranger who asked cap + 1
//   commitments between an honest commit and its share pushed the honest pair out, and the list was refused at every seat;
// - a young unspent pair never dropped and a full pool refusing (the forfeit after #1699): a stranger who kept the pool full - 4096
//   commits within the 126 s hold, about 33 a second - had every honest commit refused (503).
//
// THE RULE NOW, in this one place:
// - every commit draws its own pair, kept by its commitment; a share spends only the pair its own list carries (a stranger spends the
//   pair he was given and no other), and a spent pair keeps its list and share, never its nonces;
// - a commit is never refused for room: a spent pair, or an unspent one past the hold, makes room first; past those, ONE YOUNG UNSPENT
//   PAIR IS DROPPED AT RANDOM, never one of the oldest quarter of its pool and never the seat's own (the pair of a signing this seat asks).
//   A flood before an honest commit cannot keep it out, a flood right after it cannot push it out (it is among the oldest), and a steady
//   flood drops it only by chance: at r commits a second and a gap of g seconds between its commit and its share, it stays with
//   probability about exp(-r g / (0.75 x PAIRS_PER_KEY)) per seat, and the asker asks again with fresh pairs. The draw is the seat's own
//   (crypto), so no asker can choose which pair goes;
// - the pool is wide: PAIRS_PER_KEY per signing, PAIRS_ALL over all of them (memory, not a gate).
// No wire or protocol rule changes: a pair is still a pair, and an honest signing's bytes are the same.
//
// AND EACH PAIR BELONGS TO THE ASKER THAT DREW IT (kanban #2308, #2322, #2386, #2389; asker-pairs.js): this seat's own pass, a seat of the round
// that signs its commit ask, or the one bucket every unsigned ask shares. Each asker has its own pool of PAIRS_PER_KEY under the rule above, so a
// stranger's flood lands in the unsigned pool only, and a pair is spent only on a list the same asker signs (asker-pairs.js spendRefusal). A
// signed ask's id gives a replay the same pair (`askKey`).
import { toHex } from '../../arena-protocol/src/hash.js';

export const PAIRS_PER_KEY = 4096;
export const PAIRS_ALL = 65536;
// A LIST THAT FAILED BECAUSE A LISTED SEAT SPENT ITS PEERS' PAIRS (kanban #1699, #1764): at most this many other lists are tried in one ask
export const LIST_TRIALS = 32;
// The refusal of a pair already spent on another list: its own status, so the asker can tell a poisoned pair from a withheld share
export const BOUND_ELSEWHERE = 423;
export const boundElsewhere = (x) => !!(x && x.value && (x.value.status === BOUND_ELSEWHERE || /keeps no second pair/.test(String(x.value.why || ''))));

/** A commitment's key: the pair it was drawn with (kanban #1521). */
export const commitmentKey = (c) => `${toHex(c.hiding)}:${toHex(c.binding)}`;

/** A uniform draw in [0, n) from the seat's own randomness: never the signing's `random`, whose stream a test fixes. */
function below(n) {
  if (n <= 1) return 0;
  const lim = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) { globalThis.crypto.getRandomValues(buf); if (buf[0] < lim) return buf[0] % n; }
}

export class NoncePool {
  /** `holdMs()`: how long an unspent pair is surely kept for its asker (read at each commit, so a seat's bound can change). */
  constructor({ perKey = PAIRS_PER_KEY, all = PAIRS_ALL, holdMs = () => Infinity } = {}) {
    this.perKey = perKey;
    this.all = all;
    this.holdMs = holdMs;
    this.pools = new Map();   // signing key (and asker) -> Map(commitment key -> pair), oldest first
    this.subs = new Map();    // signing key -> Set(its pools' keys, one per asker)
    this.asks = new Map();    // a signed ask's key -> [pool key, commitment key] (kanban #2386: a replay gets the same pair)
    this.count = 0;           // pairs kept over every signing
  }

  /** The pool of `key` for `asker`: the unsigned asks' pool is `key` itself (kanban #2386). */
  static poolKey(key, asker = '') { return asker ? `${key}\u0001${asker}` : key; }

  #forget(pk) {
    this.pools.delete(pk);
    const key = pk.includes('\u0001') ? pk.slice(0, pk.indexOf('\u0001')) : pk;
    const set = this.subs.get(key);
    if (set) { set.delete(pk); if (!set.size) this.subs.delete(key); }
  }

  /** The pair a signed ask drew before (kanban #2386, #2389), or null. */
  replayed(askKey) {
    if (!askKey) return null;
    const at = this.asks.get(askKey);
    if (!at) return null;
    const pair = this.pools.get(at[0])?.get(at[1]) || null;
    if (!pair) this.asks.delete(askKey);
    return pair;
  }

  /**
   * A NEW PAIR KEPT FOR ITS ASKER: `pair` carries `commitment` (and its nonces); `own` marks the seat's own pair for a signing it asks.
   * Room is made first (spent and old pairs, then one young unspent pair at random). { ok: true } or a refusal when the draw repeats.
   */
  add(key, pair, { own = false, asker = '', askKey = null } = {}) {
    const pk = NoncePool.poolKey(key, asker);
    let held = this.pools.get(pk);
    if (!held) {
      held = new Map(); this.pools.set(pk, held);
      let set = this.subs.get(key); if (!set) { set = new Set(); this.subs.set(key, set); } set.add(pk);
    }
    const ck = commitmentKey(pair.commitment);
    // A PAIR IS NEVER DRAWN OVER ANOTHER (kanban #1699): a repeated draw would put a spent pair's nonces back in play
    if (held.has(ck)) return { ok: false, status: 500, why: 'this signer node drew a nonce pair it already holds: its randomness repeats, and it hands out nothing' };
    if (held.size >= this.perKey) { this.#sweep(held); if (held.size >= this.perKey) this.#dropOne(held); }
    if (this.count >= this.all) {
      for (const [k, map] of this.pools) {
        if (this.count < this.all) break;
        this.#sweep(map);
        if (!map.size && map !== held) this.#forget(k);
      }
      while (this.count >= this.all) {
        // ONE YOUNG UNSPENT PAIR OF A SIGNING DRAWN BY ITS SIZE: a flood over many signings drops its own pairs most. A draw that lands on a
        // signing with nothing to drop (its oldest quarter, or the seat's own) is drawn again; past a few, the first signing that can drop one
        let dropped = false;
        for (let t = 0; t < 8 && !dropped; t++) {
          let at = below(this.count);
          for (const [k, map] of this.pools) {
            if (at >= map.size) { at -= map.size; continue; }
            dropped = this.#dropOne(map);
            if (dropped && !map.size && map !== held) this.#forget(k);
            break;
          }
        }
        for (const [k, map] of this.pools) {
          if (dropped) break;
          dropped = this.#dropOne(map);
          if (dropped && !map.size && map !== held) this.#forget(k);
        }
        if (!dropped) break;
      }
    }
    held.set(ck, { ...pair, at: Date.now(), own: !!own, asker, askKey: askKey || null, list: pair.list || null, share: pair.share || null });
    this.count += 1;
    if (askKey) {
      this.asks.set(askKey, [pk, ck]);
      if (this.asks.size > this.all) this.asks.delete(this.asks.keys().next().value);
    }
    return { ok: true };
  }

  /** The pair `commitment` names under `key` - in `asker`'s pool when one is named, else in any asker's - or null. */
  get(key, commitment, asker) {
    if (!commitment) return null;
    const ck = commitmentKey(commitment);
    if (asker !== undefined) return this.pools.get(NoncePool.poolKey(key, asker))?.get(ck) || null;
    for (const pk of this.subs.get(key) || []) { const p = this.pools.get(pk)?.get(ck); if (p) return p; }
    return null;
  }

  /** Whether `key` holds any pair, of any asker. */
  holds(key) { for (const pk of this.subs.get(key) || []) { const held = this.pools.get(pk); if (held && held.size) return true; } return false; }

  /** Every pair kept under `key`, of every asker, dropped (a plan replaced: its pairs sign nothing). */
  drop(key) {
    for (const pk of [...(this.subs.get(key) || [])]) {
      const held = this.pools.get(pk);
      if (held) this.count -= held.size;
      this.#forget(pk);
    }
  }

  /** A pair signed a list: it keeps the list and the share, never the nonces (kanban #1699). */
  static spend(pair, list, share) {
    pair.list = list;
    pair.share = share;
    pair.hiding = null;
    pair.binding = null;
  }

  /** Every spent pair, and every unspent one past the hold, dropped from `map`. */
  #sweep(map) {
    const now = Date.now();
    const hold = this.holdMs();
    for (const [k, p] of map) {
      if (p.list === null && !(now - p.at > hold)) continue;
      map.delete(k); this.count -= 1;
    }
  }

  /** ONE YOUNG UNSPENT PAIR DROPPED AT RANDOM, never of the oldest quarter, never the seat's own. Whether one went. */
  #dropOne(map) {
    const skip = Math.floor(map.size / 4);
    const some = [];
    let i = 0;
    for (const [k, p] of map) { if (i++ >= skip && !p.own) some.push(k); }
    if (!some.length) return false;
    map.delete(some[below(some.length)]);
    this.count -= 1;
    return true;
  }
}

/** Exclusion sets of `peers` of growing size (1, then 2, ...), each leaving at least `keep` of them: the lists tried when a listed seat poisons the rest. */
export function* exclusions(peers, keep) {
  const n = peers.length;
  for (let e = 1; n - e >= keep; e++) {
    const idx = Array.from({ length: e }, (_, i) => i);
    for (;;) {
      yield new Set(idx.map((i) => peers[i]));
      let i = e - 1;
      while (i >= 0 && idx[i] === n - e + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < e; j++) idx[j] = idx[j - 1] + 1;
    }
  }
}

/**
 * WHICH SEATS GO ON THE NEXT LIST (kanban #1070, #1074, #1699, #1764), one copy for every signing: a seat that gave this asker no share,
 * or one whose share does not stand, is left off the next list while the threshold remains. A list refused because a listed seat spent
 * the others' pairs on lists of its own (423) leaves out first the seats that gave a share meanwhile (only a listed seat reads the list),
 * then the lists that leave out one seat, two, ..., at most LIST_TRIALS lists in one signing.
 */
export class SignerLists {
  constructor({ trials = LIST_TRIALS } = {}) {
    this.trials = trials;
    this.withheld = new Map();   // a signing's query -> the peers left out of its next list
    this.tries = new Map();      // a signing's query -> { tried, gen } of its poisoned lists
  }

  /** A signing asked afresh: its poisoned-list count starts again (the peers left out stay). */
  begin(q) { this.tries.delete(q); }

  /** A signing done, or given up: everything kept for it dropped. */
  done(q) { this.withheld.delete(q); this.tries.delete(q); }

  /** The seats that sign this list: those that committed, less any left out while enough others remain. */
  listed(q, signers, needed) {
    const out = this.withheld.get(q);
    if (!out) return signers;
    const kept = signers.filter((s) => !out.has(s.base));
    return kept.length >= needed ? kept : signers;
  }

  /** A list that failed at a seat: true when that seat is now left out and enough others remain; it grows by a seat each time, so it ends. */
  leaveOut(q, failed, listed, needed) {
    const out = this.withheld.get(q) || new Set();
    const fresh = (failed.withheld || []).filter((base) => !out.has(base));
    for (const base of fresh) out.add(base);
    if (!fresh.length || listed.filter((s) => !out.has(s.base)).length < needed) { this.withheld.delete(q); return false; }
    this.withheld.set(q, out);
    if (this.withheld.size > 4096) this.withheld.delete(this.withheld.keys().next().value);
    return true;
  }

  /** After a failed list: true to ask again at once (the next list is set), false to give up with that refusal. `peers` every peer of the signing. */
  again(q, failed, listed, needed, peers) {
    if (!failed.poisoned) {
      if (this.leaveOut(q, failed, listed, needed)) return true;
      this.tries.delete(q);
      return false;
    }
    let t = this.tries.get(q);
    if (!t) {
      t = { tried: 0, gen: null };
      this.tries.set(q, t);
      if (this.tries.size > 4096) this.tries.delete(this.tries.keys().next().value);
    }
    if (++t.tried > this.trials) { this.done(q); return false; }
    if (this.leaveOut(q, { withheld: [...(failed.withheld || []), ...(failed.sharers || [])] }, listed, needed)) return true;
    if (!t.gen) t.gen = exclusions(peers, needed - 1);
    const next = t.gen.next();
    if (next.done) { this.done(q); return false; }
    this.withheld.set(q, next.value);
    return true;
  }
}

/**
 * A ROUND-TWO ANSWER SET READ (kanban #1699): the seats that gave no share; `poisoned` when any of them found the pair drawn for this list
 * spent on another (the refusing seat is not at fault, who else read the list is). Answers null when every seat gave its share.
 */
export function sharesRefused(asked, what = 'share') {
  const none = asked.filter((x) => !x.value || !('share' in x.value));
  if (!none.length) return null;
  const bound = none.filter(boundElsewhere);
  if (bound.length) {
    return { ok: false, status: 409, why: `${bound.length} listed seat(s) found the pair drawn for this list spent on another list (${bound[0].peer}: ${bound[0].value.why})`,
      poisoned: true, withheld: none.filter((x) => !boundElsewhere(x)).map((x) => x.peer),
      sharers: asked.filter((x) => x.value && 'share' in x.value).map((x) => x.peer) };
  }
  return { ok: false, status: 409, why: `${none[0].peer} gave no ${what}: ${none[0].value ? none[0].value.why : none[0].error.message}`, withheld: none.map((x) => x.peer) };
}
