// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1699, #1764: A LISTED SEAT THAT SPENDS ITS PEERS' PAIRS AND THEN CLAIMS ITS OWN WAS SPENT TOO gives the asker no seat to suspect:
// the asker tries the lists that leave out one seat, then two, and the one without it signs (a seat outside the list sees no commitment but its own).
// Fixture from wf1489-v1-refute-27-s1-2.test.js (itself from forfeit-withheld-hung.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Forfeit, encodeCommitments, encodeShare, PAIRS_PER_FORFEIT } from '../src/forfeit.js';
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

for (const BAD of [1, 6]) {
  test(`a listed seat (${BAD}) that poisons every other listed pair and refuses as if poisoned too does not stop the forfeit`, async () => {
    let drawn = 0;
    const junk = (id) => ({ id, hiding: curve.pointFromScalar(BigInt(1000 + drawn++)), binding: curve.pointFromScalar(BigInt(5000 + drawn++)) });
    let bound = 0;
    let lists = 0;
    const w = seven({ misbehave: (k, path) => (k === BAD && path === '/forfeit-share'
      ? new Response('this signer node signed that forfeit over another list, and keeps no second pair', { status: 423 }) : undefined) });
    for (let k = 0; k < 7; k++) {
      const f = w.seats[k];
      const orig = f.fetcher;
      f.fetcher = async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        if (url.pathname === '/forfeit-share') {
          if (to === BAD) {
            lists += 1;
            const list = decodeCommitments(new Uint8Array(o.body));
            for (const c of list) {
              const s = w.seats.findIndex((x, i) => DEAL.shares[i].id === c.id);
              if (s === BAD || s === k) continue;
              const others = [1, 2, 3, 4, 5, 6, 7].filter((id) => id !== c.id).slice(0, 4).map(junk);
              const r = await w.seats[s].share(RID, ENTRY, [c, ...others].sort((a, b) => a.id - b.id), 'stake');
              if (r.ok) bound += 1;
            }
          } else {
            await new Promise((ok) => setTimeout(ok, 20));
          }
        }
        return orig(u, o);
      };
    }
    const got = await w.seats[0].forfeit(RID, ENTRY).catch((e) => ({ ok: false, why: e.message }));
    console.log(`  FACTS: seat ${BAD} read ${lists} list(s) and bound ${bound} honest pair(s); seat 0: ${got.ok ? 'forfeit made' : got.why}`);
    assert.ok(verifies(got), got.why);
    for (const s of w.seats.filter((_, i) => i !== BAD)) assert.ok(s.round.kept.get(toHex(ENTRY)), 'an honest seat did not keep the forfeit');
  });
}

test('an honest pair stays while its pool is full of young pairs: the next commit is refused, never the honest list', async () => {
  const w = seven();
  for (const f of w.seats) f.random = (n) => crypto.getRandomValues(new Uint8Array(n));
  const seat = w.seats[3];
  seat.pairHoldMs = 120000; // the hold of a seat on the default bounds (60 s ask, 3 s grace, twice over): the flood below takes seconds
  const honest = (await seat.commit(RID, ENTRY)).commitment;
  let refusedAt = null;
  for (let i = 0; i < PAIRS_PER_FORFEIT + 8; i++) {
    const c = await seat.commit(RID, ENTRY);
    if (!c.ok) { refusedAt = { i, status: c.status }; break; }
  }
  console.log(`  FACTS: the flood was refused at commit ${refusedAt && refusedAt.i} with ${refusedAt && refusedAt.status}`);
  assert.deepEqual(refusedAt, { i: PAIRS_PER_FORFEIT - 1, status: 503 });
  const list = [honest, ...[0, 1, 2, 4].map((k) => ({ id: DEAL.shares[k].id, hiding: curve.pointFromScalar(BigInt(7 + k)), binding: curve.pointFromScalar(BigInt(70 + k)) }))].sort((a, b) => a.id - b.id);
  assert.equal((await seat.share(RID, ENTRY, list)).ok, true, 'the honest pair was pushed out');
  // a spent pair makes room again
  assert.equal((await seat.commit(RID, ENTRY)).ok, true);
});
