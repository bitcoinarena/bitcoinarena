// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// (copied fixture, wf1489 r6) ONE WITHHELD SHARE OR ONE HUNG SEAT DOES NOT HOLD A FORFEIT (kanban #1074, after #1070 and #1061 on the settlement). A seat keeps one nonce pair per
// forfeit and the pair signs one commitment list; every seat that commits goes on the list and every seat on a list must give its share. And the peers
// were asked one at a time with no bound, so a seat that took the connection and stopped held the forfeit up to undici's 300 s at each step.
//
// Seven real Forfeit instances with a real 5-of-7 FROST key: each seat's own commit, share and take, reached through a fetcher that answers as server.js
// does at /forfeit-commit, /forfeit-share and /forfeit-signature, and misbehaves or hangs for the seats a test names. Only what a seat signs (`message`,
// the lock's contract id rebuilt from its own record) is stubbed, not the signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Forfeit, encodeCommitments, encodeShare } from '../src/forfeit.js';
import { decodeCommitments } from '../src/pool-wire.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x74);
const ENTRY = new Uint8Array(32).fill(0x75);
const MSG = new Uint8Array(32).fill(0xad);
const GROUP = evenGroupSecret(0x1074n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const PUBLIC_SHARES = new Map(DEAL.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));
const BOUND_MS = 400;
const GRACE_MS = 100;

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));
// A FETCH TO A PROCESS THAT TOOK THE CONNECTION AND STOPPED: it never answers, and only the caller's signal ends it, as with fetch
const hang = (o) => new Promise((_, reject) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

function stubRound() {
  const kept = new Map();
  return { forfeit: (key) => kept.get(toHex(key)) || null, putForfeit: (r) => { kept.set(toHex(r.entryId), r); }, entryVoid: () => null, kept };
}

/**
 * The seven seats. `misbehave(k, path, o)` answers for seat k at that door, throws as a dropped connection, or hangs; undefined is the honest door.
 * `wire` logs every request as bytes.
 */
function seven({ misbehave = () => undefined, seed = 0x74, boundMs = BOUND_MS, wire = [] } = {}) {
  const seats = [];
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    // A FIXED STREAM PER SEAT: the same nonces whichever order the peers are asked in, so the bytes on the wire can be compared
    const random = (n) => sha256(Uint8Array.from([seed, k, drawn++, n]));
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const f = new Forfeit(stubRound(), { curve, random, peersFor: () => peers, peerAskMs: boundMs, peerGraceMs: GRACE_MS,
      dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        const own = misbehave(to, url.pathname, o);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, body);
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    const bytes = { ok: true, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, nodes: [], signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    f.message = async () => bytes;
    seats.push(f);
  }
  return { seats, refusals, wire };
}

// WHAT server.js ANSWERS at /forfeit-commit, /forfeit-share and /forfeit-signature
async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  const eid = fromHex(url.searchParams.get('entry'));
  const kind = url.searchParams.get('lock') === 'fee' ? 'fee' : 'stake';
  if (url.pathname === '/forfeit-commit') {
    const got = await seat.commit(rid, eid, kind);
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/forfeit-share') {
    const got = await seat.share(rid, eid, decodeCommitments(body), kind);
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/forfeit-signature') {
    const got = await seat.take(rid, eid, body, kind);
    return got.ok ? new Response('forfeit kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

const refused = () => new Response('this seat gives no share', { status: 503 });
const verifies = (got) => !!(got && got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)));

/** The answer or, past `ms`, what it was doing: the measure works before the fix too, where the forfeit never answers. */
async function within(p, ms) {
  const t0 = Date.now();
  let timer;
  const out = await Promise.race([p.then((value) => ({ value }), (e) => ({ value: { ok: false, why: `threw: ${e.message}` } })),
    new Promise((ok) => { timer = setTimeout(() => ok({ stuck: true }), ms); })]);
  clearTimeout(timer);
  return { ...out, ms: Date.now() - t0 };
}


// wf1489 r6 entry-1: ONE SEAT OF SEVEN ANSWERS /forfeit-commit WITH A COMMITMENT UNDER ANOTHER SEAT'S FROST ID. The asker puts it on the list
// unchecked (decodeCommitments only checks the id is in range), the honest seat whose id it took finds the forged commitment first, refuses
// ("that list does not carry this signer node's own commitment") and is the one left out; the forger hands a junk share, so it is never
// blamed. Asked again, it takes the next honest seat's id. Six honest seats of seven, threshold five: the player's refund must still form.
test('wf1489 r6 entry-1: one seat that commits under another seat\'s id does not stop a forfeit six honest seats can sign', async () => {
  let next = 2;   // the seat (index) whose id the forger takes next: those after it in the asker's peer order
  const w = seven({ misbehave: (k, path) => {
    if (k !== 1) return undefined;
    if (path === '/forfeit-commit') {
      const victim = DEAL.shares[Math.min(next++, 6)].id;
      return new Response(encodeCommitments([{ id: victim, hiding: curve.pointFromScalar(777n + BigInt(next)), binding: curve.pointFromScalar(888n + BigInt(next)) }]));
    }
    if (path === '/forfeit-share') return new Response(encodeShare(1234567n));
    return undefined;
  } });
  const asks = [];
  let got = null;
  for (let i = 0; i < 3 && !(got && got.ok); i++) {
    next = 2;
    got = await w.seats[0].forfeit(RID, ENTRY).catch((e) => ({ ok: false, why: `threw: ${e.message}` }));
    asks.push(got.ok ? 'forfeit made' : got.why);
  }
  console.log(`  FACTS: ${asks.join(' | ')}`);
  console.log(`  FACTS: refusals between seats: ${w.refusals.slice(0, 4).join(' | ')}`);
  assert.ok(verifies(got), `six honest seats of seven, one forger: ${asks.join(' | ')}`);
});
