// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE WITHHELD SHARE OR ONE HUNG SEAT DOES NOT HOLD A FORFEIT (kanban #1074, after #1070 and #1061 on the settlement). A seat keeps one nonce pair per
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
    // NO WRAP AT 256 DRAWS (kanban #1699): the first 256 draws hash the bytes they always did
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from(d < 256 ? [seed, k, d, n] : [seed, k, d & 255, n, (d >> 8) & 255, (d >> 16) & 255, (d >> 24) & 255])); };
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

// ---- #1070's point: one list per nonce pair

test('a seat that commits and gives no share goes off the list: the six others sign the forfeit in the same ask', async () => {
  const w = seven({ misbehave: (k, path) => (k === 6 && path === '/forfeit-share' ? refused() : undefined) });
  const got = await w.seats[0].forfeit(RID, ENTRY);
  console.log(`  FACTS: one share withheld: ${got.ok ? 'forfeit made' : got.why}`);
  assert.ok(verifies(got), got.why);
});

test('one share withheld, then the seat gone: no honest seat refuses another list, and no asker is stopped', async () => {
  let gone = false;
  const w = seven({ misbehave: (k, path) => {
    if (k !== 6) return undefined;
    if (gone) throw new Error('fetch failed');
    return path === '/forfeit-share' ? refused() : undefined;
  } });
  const asks = [];
  let got = null;
  for (const asker of [0, 0, 1, 2]) {
    got = await w.seats[asker].forfeit(RID, ENTRY).catch((e) => ({ ok: false, why: e.message }));
    asks.push(`seat ${asker}: ${got.ok ? 'forfeit made' : got.why}`);
    gone = true;
    if (got.ok) break;
  }
  const pinned = [...w.refusals, ...asks].filter((x) => /keeps no second pair/.test(x)).length;
  console.log(`  FACTS: ${asks.join(' | ')}`);
  console.log(`  FACTS: ${w.refusals.length} refusals between seats; "keeps no second pair" ${pinned} time(s), at the doors and at the askers`);
  assert.ok(verifies(got), asks.join(' | '));
  assert.equal(pinned, 0, 'an honest seat stayed bound to the list the withheld share broke');
});

test('a share that does not combine costs the seat that gave it its place: the public shares name it', async () => {
  const w = seven({ misbehave: (k, path) => (k === 4 && path === '/forfeit-share' ? new Response(encodeShare(1234567n)) : undefined) });
  const got = await w.seats[0].forfeit(RID, ENTRY);
  console.log(`  FACTS: one bad share: ${got.ok ? 'forfeit made' : got.why}`);
  assert.ok(verifies(got), got.why);
});

test('a connection that drops at the share goes off the list as a refusal does', async () => {
  const w = seven({ misbehave: (k, path) => { if (k === 3 && path === '/forfeit-share') throw new Error('fetch failed'); return undefined; } });
  const got = await w.seats[0].forfeit(RID, ENTRY).catch((e) => ({ ok: false, why: `threw: ${e.message}` }));
  console.log(`  FACTS: dropped at the share: ${got.ok ? 'forfeit made' : got.why}`);
  assert.ok(verifies(got), got.why);
});

test('three withholding stop it, as the threshold says; when one comes back the forfeit is made', async () => {
  let back = false;
  const w = seven({ misbehave: (k, path) => ((k === 4 || k === 5 || (k === 6 && !back)) && path === '/forfeit-share' ? refused() : undefined) });
  const first = await w.seats[0].forfeit(RID, ENTRY);
  console.log(`  FACTS: three withheld: ${first.ok ? 'forfeit made' : first.why}`);
  assert.equal(first.ok, false);
  back = true;
  const next = await w.seats[0].forfeit(RID, ENTRY);
  console.log(`  FACTS: one back: ${next.ok ? 'forfeit made' : next.why}`);
  assert.ok(verifies(next), next.why);
});

test('a list made up at the door pins nobody: three seats given a share over commitments nobody holds still sign the real one', async () => {
  const w = seven();
  const invented = [0, 1, 2, 3].map((i) => ({ hiding: curve.pointFromScalar(BigInt(1000 + i)), binding: curve.pointFromScalar(BigInt(2000 + i)) }));
  for (const k of [1, 2, 3]) {
    const own = (await w.seats[k].commit(RID, ENTRY)).commitment;
    const others = DEAL.shares.map((s) => s.id).filter((id) => id !== own.id).slice(0, 4).map((id, i) => ({ id, ...invented[i] }));
    const list = [own, ...others].sort((a, b) => a.id - b.id);
    const answer = await serve(w.seats[k], new URL(`${base(k)}/forfeit-share?round=${toHex(RID)}&entry=${toHex(ENTRY)}`), encodeCommitments(list));
    assert.equal(answer.ok, true, 'the door takes such a list: this test measures what it leaves behind');
  }
  const got = await w.seats[0].forfeit(RID, ENTRY);
  console.log(`  FACTS: three seats pinned by a list from outside: ${got.ok ? 'forfeit made' : got.why}`);
  assert.ok(verifies(got), got.why);
});

test('a nonce pair still signs one list once: the same list gets the same share, another gets nothing, a spent pair is never offered again', async () => {
  const w = seven();
  const [a, b, c, d, e, f] = w.seats;
  const of = async (s) => (await s.commit(RID, ENTRY)).commitment;
  // ONE ASKER'S COMMITMENT FROM a ON BOTH LISTS: since kanban #1521 every ask draws its own pair, so the second list must carry the same one
  const ca = await of(a);
  const five = [ca, await of(b), await of(c), await of(d), await of(e)].sort((x, y) => x.id - y.id);
  const other = [ca, await of(b), await of(c), await of(d), await of(f)].sort((x, y) => x.id - y.id);
  const shared = await a.share(RID, ENTRY, five);
  assert.equal(shared.ok, true);
  assert.equal((await a.share(RID, ENTRY, five)).share, shared.share, 'the same list is answered with the same share');
  assert.match((await a.share(RID, ENTRY, other)).why, /keeps no second pair/);
  const fresh = await of(a);
  assert.notEqual(toHex(fresh.hiding), toHex(five.find((x) => x.id === fresh.id).hiding), 'a spent nonce was handed out again');
  assert.notEqual(toHex(fresh.binding), toHex(five.find((x) => x.id === fresh.id).binding), 'a spent nonce was handed out again');
  assert.equal((await a.share(RID, ENTRY, other)).ok, false, 'the old commitment signs nothing any more');
  const again = await a.share(RID, ENTRY, other.map((x) => (x.id === fresh.id ? fresh : x)));
  assert.equal(again.ok, true);
  assert.notEqual(again.share, shared.share);
});

// ---- #1061's point: the peers asked one at a time, with no bound

test('two seats that took the connection and never answer do not hold the forfeit: the five that answered sign it', async () => {
  const w = seven({ misbehave: (k, path, o) => (k === 2 || k === 3 ? hang(o) : undefined), boundMs: 30000 });
  const got = await within(w.seats[0].forfeit(RID, ENTRY), 5000);
  console.log(`  FACTS: two hung of seven: ${got.stuck ? 'NOT MADE, still waiting' : got.value.ok ? 'forfeit made' : got.value.why} after ${got.ms} ms`);
  assert.ok(!got.stuck, `the forfeit still waited on a hung seat after ${got.ms} ms`);
  assert.ok(verifies(got.value), got.value.why);
  assert.ok(got.ms < 3000, `the threshold had answered, and it waited ${got.ms} ms against a grace of ${GRACE_MS} ms and a bound of 30 s`);
});

test('a seat that hangs between its commitment and its share is left off the next list once the bound has passed, and the same ask signs', async () => {
  const w = seven({ misbehave: (k, path, o) => (k === 3 && path === '/forfeit-share' ? hang(o) : undefined) });
  const got = await within(w.seats[0].forfeit(RID, ENTRY), 5000);
  console.log(`  FACTS: hung at the share: ${got.stuck ? 'still waiting' : got.value.ok ? 'forfeit made' : got.value.why} after ${got.ms} ms`);
  assert.ok(!got.stuck, `the share stage still waited after ${got.ms} ms`);
  assert.ok(verifies(got.value), got.value.why);
});

test('below the threshold it refuses inside the bound and names who did not answer', async () => {
  const w = seven({ misbehave: (k, path, o) => (k === 2 || k === 3 || k === 4 ? hang(o) : undefined) });
  const got = await within(w.seats[0].forfeit(RID, ENTRY), 3000);
  console.log(`  FACTS: three hung of seven: ${got.stuck ? 'still waiting' : got.value.why} after ${got.ms} ms`);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.equal(got.value.ok, false);
  assert.match(got.value.why, /4 of the 5 signer nodes/);
  assert.match(got.value.why, /http:\/\/seat2: no answer in 400 ms/);
  assert.ok(got.ms < BOUND_MS + 300, `${got.ms} ms against a bound of ${BOUND_MS}`);
});

test('a peer whose answer starts and whose body never comes is bound as well', async () => {
  const w = seven({ misbehave: (k, path, o) => (k === 1 ? { ok: true, status: 200, arrayBuffer: () => hang(o), text: () => hang(o) } : undefined) });
  const got = await within(w.seats[0].forfeit(RID, ENTRY), 3000);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.ok(verifies(got.value), got.value.why);
});

// ---- an honest forfeit

test('an honest forfeit sends the same bytes as before, one request per peer per step', async () => {
  const w = seven();
  const got = await w.seats[0].forfeit(RID, ENTRY);
  assert.ok(verifies(got), got.why);
  const sorted = [...w.wire].sort();
  for (const p of ['/forfeit-commit', '/forfeit-share', '/forfeit-signature']) assert.equal(sorted.filter((l) => l.includes(p)).length, 6, `six peers asked at ${p}`);
  // TAKEN FROM THE CODE BEFORE #1074, which asked one peer at a time
  const digest = toHex(sha256(new TextEncoder().encode(sorted.join('\n'))));
  console.log(`  FACTS: ${sorted.length} requests, digest ${digest}`);
  assert.equal(digest, 'a79b9bceb7eb0eaabef5902237f7e0a416efd71585614786534d3b1a0dbf77ab');
  for (const s of w.seats.slice(1)) assert.ok(s.round.kept.get(toHex(ENTRY)), 'a peer did not keep the forfeit');
});
