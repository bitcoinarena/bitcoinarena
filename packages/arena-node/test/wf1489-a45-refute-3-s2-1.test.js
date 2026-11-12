// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute-3 s2 #1 (harness copied from wf1489-a45-refute-3-s1-2)
// wf1489 a45 refute-3 #2 (copied fixture of wf1489-r6-entry-1, m.nodes a 7-seat committee as contract.nodes is) ONE WITHHELD SHARE OR ONE HUNG SEAT DOES NOT HOLD A FORFEIT (kanban #1074, after #1070 and #1061 on the settlement). A seat keeps one nonce pair per
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
    const bytes = { ok: true, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, nodes: [1, 2, 3, 4, 5, 6, 7].map((i) => `node${i}`), signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
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


// A COMMITMENT NO CURVE HOLDS, UNDER THE SEAT'S OWN ID (kanban #1807 "a throw while signing or aggregating is now a refusal"): decodeCommitments checks the id
// and the length, never that hiding / binding are points. misnamedSigners passes it (own id, in range, once), the asker's own share() runs signShare340 ->
// groupCommitment -> Point.fromBytes, which throws; #gatherShares catches it as a refusal with withheld [] (no duplicate, so no `kept` fallback),
// #leaveOut sees nothing fresh and gives up. The seat is never left out, and on every ask it does the same: one seat stops every forfeit until expiry.
const NOT_A_POINT = Uint8Array.from([0x02, ...new Array(32).fill(0xff)]);   // x >= p: no point of secp256k1
for (const [name, mk] of [
  ['a hiding point', (id) => ({ id, hiding: NOT_A_POINT, binding: curve.pointFromScalar(888n) })],
  ['a binding point', (id) => ({ id, hiding: curve.pointFromScalar(777n), binding: NOT_A_POINT })],
]) {
  test(`wf1489 a45 refute-3 s2 #1: a seat whose commitment carries ${name} that is not on the curve, under its OWN id, does not stop the forfeit`, async () => {
    const w = seven({ misbehave: (k, path) => {
      if (k !== 1) return undefined;
      if (path === '/forfeit-commit') return new Response(encodeCommitments([mk(DEAL.shares[1].id)]));
      return undefined;
    } });
    const asks = [];
    let got = null;
    for (let i = 0; i < 3 && !(got && got.ok); i++) {
      got = await w.seats[0].forfeit(RID, ENTRY).catch((e) => ({ ok: false, why: `threw: ${e.message}` }));
      asks.push(got.ok ? 'forfeit made' : got.why);
    }
    console.log(`  FACTS: ${asks.join(' | ')}`);
    assert.ok(verifies(got), asks.join(' | '));
  });
}

// the same with one seat down: the junk seat is the only thing between the asker and the five honest seats
test('wf1489 a45 refute-3 s2 #1c: one seat down, a seat with an off-curve commitment under its own id: five honest seats still sign', async () => {
  const w = seven({ misbehave: (k, path) => {
    if (k === 6) throw new Error('fetch failed');
    if (k !== 1) return undefined;
    if (path === '/forfeit-commit') return new Response(encodeCommitments([{ id: DEAL.shares[1].id, hiding: NOT_A_POINT, binding: NOT_A_POINT }]));
    return undefined;
  } });
  const asks = [];
  let got = null;
  for (let i = 0; i < 3 && !(got && got.ok); i++) {
    got = await w.seats[0].forfeit(RID, ENTRY).catch((e) => ({ ok: false, why: `threw: ${e.message}` }));
    asks.push(got.ok ? 'forfeit made' : got.why);
  }
  console.log(`  FACTS: ${asks.join(' | ')}`);
  assert.ok(verifies(got), asks.join(' | '));
});

// HONEST CHECKS (should pass): a duplicate-id forger kept or set aside either way, seven honest
for (const forger of [1, 5]) {
  test(`wf1489 a45 refute-3 s2 honest: seat ${forger} commits under seat 3's id (kept or set aside by list order), forfeit made`, async () => {
    const w = seven({ misbehave: (k, path) => {
      if (k !== forger) return undefined;
      if (path === '/forfeit-commit') return new Response(encodeCommitments([{ id: DEAL.shares[3].id, hiding: curve.pointFromScalar(777n), binding: curve.pointFromScalar(888n) }]));
      if (path === '/forfeit-share') return new Response(encodeShare(1234567n));
      return undefined;
    } });
    const asks = [];
    let got = null;
    for (let i = 0; i < 3 && !(got && got.ok); i++) {
      got = await w.seats[0].forfeit(RID, ENTRY).catch((e) => ({ ok: false, why: `threw: ${e.message}` }));
      asks.push(got.ok ? 'forfeit made' : got.why);
    }
    console.log(`  FACTS: ${asks.join(' | ')}`);
    assert.ok(verifies(got), asks.join(' | '));
  });
}
test('wf1489 a45 refute-3 s2 honest: seven honest seats, forfeit made on the first ask', async () => {
  const w = seven();
  const got = await w.seats[0].forfeit(RID, ENTRY);
  assert.ok(verifies(got), got.why);
});
