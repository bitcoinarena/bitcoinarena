// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT AS ONE OF ITS ROUND'S DRAWN ATTESTORS (kanban #630, protocol 21; 2026-10-24: "Atteststiom should also be pre deterministic
// and be drawed randomly, not a fixed set of nodes ... 5 of 7 is needed"). A game whose manifest names a draw (manifest.js attestDraw) has
// no attestor daemons: each round's 7 attestors are node keys of its census (sortition.js drawAttestors), and a seat drawn for a round
// does what arena-attestor's daemon does for a fixed key:
//
//   READ.    Its own price, every READ_MS (the seat's feed read, cents), kept for KEEP_MS - a window and the minute before it.
//   SIGN.    Once the round's window has ended (+ SETTLE_MS), the market's rule over its own readings (up-down.js upDownOutcome) and
//            the attestation body {round, outcome, observed_at = the window's end}, signed BIP-340 with its node key. One word a
//            round: kept, never signed again differently.
//   SERVE.   GET /attestation-word?round= answers that word (wordToJson), so the other drawn seats can combine it.
//   COMBINE. It asks the round's other drawn attestors for theirs; once 5 of the 7 signed one body, that attestation is held here
//            (the /outcome intake, which checks it against the draw) and handed to every seat of the round.
//
// Honest seats whose readings agree sign the same bytes. Seats that read a near tie differently sign different bodies; only 5 over
// ONE body make an attestation, and a round with none by its deadline is refunded as any unattested market is.
import { attestationBodyId } from '../../arena-protocol/src/attested.js';
import { upDownOutcome } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { combine, wordToJson, wordFromJson } from '../../arena-attestor/src/attestor.js';

export const READ_MS = 10000;
export const KEEP_MS = 40 * 60 * 1000;
export const SETTLE_MS = 5000;
export const ASK_MS = 4000;

export class DrawnAttestor {
  /**
   * `readPrice()` cents or null; `selfKey` this seat's node key (hex); `sign(digest)` its BIP-340 signature (bytes);
   * `attestorsFor(roundIdBytes)` the round's 7 drawn keys (hex) or null; `peersFor(roundIdBytes)` the drawn attestors' base URLs
   * (this seat's left out); `due()` the rounds to attest now, [{ roundId (bytes), window { startMs, endMs } }]; `hold(bytes, roundId)`
   * takes a combined attestation (this seat's intake, then every seat); `threshold` 5.
   */
  constructor({ readPrice, selfKey, sign, attestorsFor, peersFor, due, hold, threshold = 5, fetcher = (u, o) => fetch(u, o), now = () => Date.now() }) {
    Object.assign(this, { readPrice, selfKey, sign, attestorsFor, peersFor, due, hold, threshold, fetcher, now });
    this.samples = [];          // [{ atMs, price }] BigInt, this seat's own readings
    this.words = new Map();     // round hex -> this seat's word
    this.held = new Set();      // round hex: an attestation of it is held - nothing more to do
  }

  async read() {
    let cents = null;
    try { cents = await this.readPrice(); } catch { cents = null; }
    const at = this.now();
    // a reader answers cents, or { cents, atMs } (the seat's feed: the exchange ticker's last trade)
    if (cents && typeof cents === 'object') cents = cents.cents;
    if (Number.isFinite(Number(cents)) && Number(cents) > 0) this.samples.push({ atMs: BigInt(at), price: BigInt(Math.round(Number(cents))) });
    const keepFrom = BigInt(at - KEEP_MS);
    while (this.samples.length && this.samples[0].atMs < keepFrom) this.samples.shift();
  }

  /** This seat's word on a round: signed once, once its window has ended; null when it is not drawn or cannot read the outcome. */
  wordFor(roundId, window) {
    const id = toHex(roundId);
    if (this.words.has(id)) return this.words.get(id);
    const drawn = this.attestorsFor(roundId);
    if (!drawn || !drawn.includes(this.selfKey)) return null;
    if (BigInt(this.now()) < window.endMs + BigInt(SETTLE_MS)) return null;
    const out = upDownOutcome(this.samples, window);
    if (!out.ok) { this.words.set(id, null); return null; }
    const body = { roundId, outcome: out.outcome, observedAtMs: window.endMs };
    const word = { body, key: this.selfKey, signature: toHex(this.sign(attestationBodyId(body))), priceToBeat: out.priceToBeat, endPrice: out.endPrice, label: out.label };
    this.words.set(id, word);
    return word;
  }

  /** GET /attestation-word's answer for a round, or null. */
  served(roundId) { const w = this.words.get(toHex(roundId)); return w ? wordToJson(w) : null; }

  /** One pass: every due round's word made, the others' asked for, and an attestation of 5 held. */
  async pass() {
    const done = [];
    for (const r of this.due()) {
      const id = toHex(r.roundId);
      if (this.held.has(id)) continue;
      const mine = this.wordFor(r.roundId, r.window);
      if (!mine) continue;
      const drawn = this.attestorsFor(r.roundId) || [];
      const theirs = await Promise.all((this.peersFor(r.roundId) || []).map(async (base) => {
        try {
          const res = await this.fetcher(`${String(base).replace(/\/+$/, '')}/attestation-word?round=${id}`, { signal: AbortSignal.timeout(ASK_MS) });
          return res.status === 200 ? wordFromJson(await res.json()) : null;
        } catch { return null; }
      }));
      const got = combine([mine, ...theirs], { attestors: drawn, threshold: this.threshold });
      if (!got) continue;
      try { if (await this.hold(got.bytes, r.roundId)) { this.held.add(id); done.push({ round: id, signers: got.signers, outcome: got.body.outcome }); } } catch { /* asked again next pass */ }
    }
    for (const id of [...this.words.keys()].slice(0, Math.max(0, this.words.size - 512))) this.words.delete(id);
    return done;
  }
}
