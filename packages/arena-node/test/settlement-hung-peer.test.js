// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HUNG SEAT DOES NOT HOLD A SETTLEMENT (kanban #1061). Measured on seven real seats (#1038): with two seats stopped by SIGSTOP after FINAL
// the settlement was ACCEPTED only once they came back. A stopped process still takes the connection (the kernel accepts it), so a fetch to
// it does not fail: it waits, up to undici's 300 s for the headers, and the peers were asked one at a time.
//
// Seven real LockSettlement instances with a real 5-of-7 FROST key: each seat's own commit, share and take, reached through a fetcher that
// answers as server.js does, and hangs for the seats a test names. Only the settlement's bytes are stubbed (`message`), not the signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { schnorr } from '@noble/curves/secp256k1.js';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments } from '../src/settlement.js';
import { StakeSecrets } from '../src/stake-secret.js';
import { askPeers } from '../src/peer-ask.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x61);
const MSG = new Uint8Array(32).fill(0xab);
const TXID = toHex(MSG);
const GROUP = evenGroupSecret(0x1061n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const BOUND_MS = 400;
const GRACE_MS = 100;

const base = (k) => `http://seat${k}`;
// A FETCH TO A PROCESS THAT TOOK THE CONNECTION AND STOPPED: it never answers, and only the caller's signal ends it, as with fetch
const hang = (o) => new Promise((_, reject) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

function stubRound() {
  const rows = { settlement: null };
  return {
    get: () => null, lockSettlement: () => rows.settlement, putLockSettlement: (r) => { rows.settlement = r; }, putLockSettlementMoves: () => {},
    rows,
  };
}

/** The seven seats; `hungAt(k, path)` says seat k does not answer that path; `wire` logs what is sent, as bytes. */
function seven({ hungAt = () => false, wire = [], seed = 0x61, boundMs = BOUND_MS, version = null } = {}) {
  const keys = [0, 1, 2, 3, 4, 5, 6].map((k) => sha256(Uint8Array.from([0x10, k])));
  const contract = version === null ? undefined : { protocolVersion: version, nodes: keys.map((x) => schnorr.getPublicKey(x)), settlementSlots: 7 };
  const seats = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ id: 'payout-0' }], locksAfter: [null] }; } };   // as the tool answers (kanban #1171)
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    // A FIXED STREAM PER SEAT: the same nonces whichever order the peers are asked in, so the bytes on the wire can be compared
    const random = (n) => sha256(Uint8Array.from([seed, k, drawn++, n]));
    const round = { ...stubRound(), identity: { secret: keys[k] }, pubkey: schnorr.getPublicKey(keys[k]) };
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(round, { curve, random, port, peersFor: () => peers, peerAskMs: boundMs, peerReadMs: boundMs, peerGraceMs: GRACE_MS,
      fetcher: (u, o) => {
        const url = new URL(u);
        const to = Number(url.hostname.slice(4));
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        if (hungAt(to, url.pathname)) return hang(o);
        return serve(seats[to], url, body);
      } });
    s.message = async () => ({ ok: true, contract, ackTable: { roundId: RID, rows: [] }, txid: TXID, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, claims: [],
      plan: { payouts: [], claims: [], nonce: new Uint8Array(32), stakeShares: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } });
    seats.push(s);
  }
  return { seats, port, wire };
}

// WHAT server.js ANSWERS at /settle-commit, /settle-share and /settle-signature
async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  if (url.pathname === '/settle-ack') {
    const got = await seat.ack(rid, { txid: url.searchParams.get('txid') });
    return got.ok ? new Response(got.bytes) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/settle-commit') {
    const got = await seat.commit(rid, { txid: url.searchParams.get('txid'), acks: body.length ? body : null });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/settle-share') {
    const got = await seat.share(rid, decodeCommitments(body));
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/settle-signature') {
    const got = await seat.take(rid, body);
    return got.ok ? new Response('kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

/** The answer or, past `ms`, what it was doing: the measure works before the fix too, where the settlement never answers. */
async function within(p, ms) {
  const t0 = Date.now();
  let timer;
  const out = await Promise.race([p.then((value) => ({ value })), new Promise((ok) => { timer = setTimeout(() => ok({ stuck: true }), ms); })]);
  clearTimeout(timer);
  return { ...out, ms: Date.now() - t0 };
}

const seatsKeep = (w) => w.seats.filter((s) => s.round.rows.settlement).length;

test('a seat that took the connection and never answers does not hold the settlement: the five that answered sign it, and it is submitted', async () => {
  const w = seven({ hungAt: (k) => k === 2 || k === 3, boundMs: 30000 });
  const got = await within(w.seats[0].settle(RID), 5000);
  console.log(`  FACTS: two hung of seven, settled ${got.stuck ? 'NOT AT ALL, still waiting' : got.value.state} after ${got.ms} ms; submissions ${w.port.settled.length}`);
  assert.ok(!got.stuck, `the settlement still waited on a hung seat after ${got.ms} ms`);
  assert.equal(got.value.state, 'ACCEPTED', got.value.why);
  assert.ok(got.ms < 3000, `the threshold had answered, and it waited ${got.ms} ms against a grace of ${GRACE_MS} ms and a bound of 30 s`);
  assert.equal(schnorr.verify(w.port.settled[0].signature, MSG, DEAL.groupPublicKey.subarray(1)), true);
  assert.equal(seatsKeep(w), 5, 'every seat that signed keeps the signature');
});

test('from protocol 22 the acks are gathered the same way: a hung seat does not hold them, and below the threshold nobody is asked to commit', async () => {
  const w = seven({ hungAt: (k) => k === 2 || k === 3, version: 22, boundMs: 30000 });
  const got = await within(w.seats[0].settle(RID), 5000);
  console.log(`  FACTS: two hung of seven, with acks: ${got.stuck ? 'still waiting' : got.value.state} after ${got.ms} ms`);
  assert.ok(!got.stuck, `the acks still waited on a hung seat after ${got.ms} ms`);
  assert.equal(got.value.state, 'ACCEPTED', got.value.why);
  assert.ok(got.ms < 3000, `${got.ms} ms against a grace of ${GRACE_MS} ms`);

  const short = seven({ hungAt: (k) => k === 2 || k === 3 || k === 4, version: 22 });
  const refused = await within(short.seats[0].settle(RID), 3000);
  assert.ok(!refused.stuck);
  assert.match(refused.value.why, /4 of the 5 signer nodes the settlement needs acked it/);
  assert.match(refused.value.why, /http:\/\/seat2: no answer in 400 ms/);
  assert.equal(short.wire.filter((l) => l.includes('/settle-commit')).length, 0);
});

test('below the threshold it refuses inside the bound and names who did not answer', async () => {
  const w = seven({ hungAt: (k) => k === 2 || k === 3 || k === 4 });
  const got = await within(w.seats[0].settle(RID), 3000);
  console.log(`  FACTS: three hung of seven, ${got.stuck ? 'still waiting' : got.value.why} after ${got.ms} ms`);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.equal(got.value.ok, false);
  assert.match(got.value.why, /4 of the 5 signer nodes/);
  assert.match(got.value.why, /http:\/\/seat2: no answer in 400 ms/);
  assert.ok(got.ms < BOUND_MS + 300, `${got.ms} ms against a bound of ${BOUND_MS}`);
  assert.equal(w.port.settled.length, 0);
});

test('a peer whose answer starts and whose body never comes is bound as well', async () => {
  const w = seven();
  const fetcher = w.seats[0].fetcher;
  w.seats[0].fetcher = async (u, o) => {
    if (!u.startsWith(base(1))) return fetcher(u, o);
    return { ok: true, status: 200, arrayBuffer: () => hang(o), text: () => hang(o), json: () => hang(o) };
  };
  const got = await within(w.seats[0].settle(RID), 3000);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.equal(got.value.state, 'ACCEPTED', got.value.why);
});

test('a seat that hangs between its commitment and its share is left off the next list once the bound has passed, and the same pass settles', async () => {
  const w = seven({ hungAt: (k, path) => k === 3 && path === '/settle-share' });
  const got = await within(w.seats[0].settle(RID), 5000);
  console.log(`  FACTS: hung at the share: ${got.stuck ? 'still waiting' : got.value.state} after ${got.ms} ms`);
  assert.ok(!got.stuck, `the share stage still waited after ${got.ms} ms`);
  assert.equal(got.value.state, 'ACCEPTED', got.value.why);
  assert.equal(schnorr.verify(w.port.settled[0].signature, MSG, DEAL.groupPublicKey.subarray(1)), true);
});

test('a nonce pair still signs one list once: a second list on a spent commitment is refused, and only a new commitment signs it', async () => {
  const w = seven();
  const [a, b, c, d, e, f] = w.seats;
  const of = async (s) => (await s.commit(RID, { txid: TXID })).commitment;
  const ofA = await of(a);
  const five = [ofA, await of(b), await of(c), await of(d), await of(e)].sort((x, y) => x.id - y.id);
  // the same commitment of a's on both lists: each commit hands out a pair of its own (kanban #1489), so a second list can only name the one already spent
  const other = [ofA, await of(b), await of(c), await of(d), await of(f)].sort((x, y) => x.id - y.id);
  const shared = await a.share(RID, five);
  assert.equal(shared.ok, true);
  assert.equal((await a.share(RID, five)).share, shared.share, 'the same list is answered with the same share');
  assert.match((await a.share(RID, other)).why, /keeps no second pair/);
  const fresh = await of(a);
  assert.notEqual(toHex(fresh.hiding), toHex(five.find((x) => x.id === fresh.id).hiding), 'a spent nonce was handed out again');
  assert.equal((await a.share(RID, other)).ok, false, 'the old commitment signs nothing any more');
  const next = other.map((x) => (x.id === fresh.id ? fresh : x));
  const again = await a.share(RID, next);
  assert.equal(again.ok, true);
  assert.notEqual(again.share, shared.share);
});

test('an honest settlement sends the same bytes as before, one request per peer per step', async () => {
  const w = seven();
  const got = await w.seats[0].settle(RID);
  assert.equal(got.state, 'ACCEPTED', got.why);
  const sorted = [...w.wire].sort();
  const paths = ['/settle-commit', '/settle-share', '/settle-signature'];
  for (const p of paths) assert.equal(sorted.filter((l) => l.includes(p)).length, 6, `six peers asked at ${p}`);
  // TAKEN FROM THE CODE BEFORE #1061, which asked one peer at a time
  const digest = toHex(sha256(new TextEncoder().encode(sorted.join('\n'))));
  console.log(`  FACTS: ${sorted.length} requests, digest ${digest}`);
  assert.equal(digest, 'cf197efaf791c8b3d09ffda5c071d74fe12e5441195588a7ea687c9bc6c6f9f2');
});

/** One seat with the plan's stubs: `answer(base, path)` is a peer's reply. */
function planner(answer) {
  const asked = [];
  const round = { ...stubRound(), identity: { secret: new Uint8Array(32).fill(1) }, pubkey: new Uint8Array(32).fill(2) };
  const s = new LockSettlement(round, { curve, random: (n) => new Uint8Array(n).fill(7), peersFor: () => ['http://p1', 'http://p2', 'http://p3'], peerAskMs: BOUND_MS, peerReadMs: BOUND_MS,
    peerGraceMs: GRACE_MS, fetcher: (u, o) => { asked.push(u); return answer(new URL(u).origin, new URL(u).pathname, o); } });
  return { s, asked };
}

test('the plan\'s read of the peers\' kept plans does not wait on a hung seat, and every peer is read', async () => {
  const { s } = planner((origin, path, o) => (origin === 'http://p1' ? hang(o) : new Response(JSON.stringify([{ invoice: origin, paymentHash: origin, attempt: 0 }]))));
  s.round.sendAttemptsOf = () => [];
  const seen = [];
  s.winnings = { check: async (_, __, rows) => { seen.push(rows); return { ok: false }; } };
  const got = await within(s.adoptPeerPlan(RID, {}), 3000);
  console.log(`  FACTS: adoptPeerPlan with a hung peer: ${got.stuck ? 'still waiting' : 'answered'} after ${got.ms} ms`);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.equal(seen.length, 2, 'the peers that answered were not read');
});

test('the plan handed to the seats goes on with the threshold, and a hung seat is named', async () => {
  const seats = [new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)];
  const { s, asked } = planner((origin, path, o) => (origin === 'http://p1' ? hang(o) : new Response(new Uint8Array(128))));
  const got = await within(s.planAgreed(RID, null, '[]', { nodes: seats, settlementSlots: 2 }, ['http://p1', 'http://p2'], toHex(RID)), 3000);
  console.log(`  FACTS: planAgreed with a hung peer: ${got.stuck ? 'still waiting' : `${got.value.agreed} of ${got.value.needed}`} after ${got.ms} ms; asked ${asked.length}`);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.ok(got.value.refused.some((x) => /http:\/\/p1: no answer once enough had/.test(x)), got.value.refused.join('; '));
  assert.ok(got.ms < BOUND_MS, `one of the two answered, and it waited ${got.ms} ms, the whole bound`);
});

test('a stake opened from the peers skips a hung seat, one peer at a time, and asks nobody past the threshold', async () => {
  const asked = [];
  const round = { pubkey: new Uint8Array(32).fill(2), entry: () => null };
  const secrets = new StakeSecrets(round, { curve, random: (n) => new Uint8Array(n), peersFor: () => ['http://p1', 'http://p2', 'http://p3'], shareAskMs: BOUND_MS,
    fetcher: (u, o) => { asked.push(new URL(u).origin); return u.startsWith('http://p1') ? hang(o) : new Response('refused', { status: 409 }); } });
  secrets.handoutOf = () => ({ ok: true, entry: {}, handout: {} });
  secrets.mine = async () => ({ ok: false });
  const got = await within(secrets.open({ roundId: RID, entryId: RID, needed: 2 }), 3000);
  console.log(`  FACTS: stake open with a hung peer first: ${got.stuck ? 'still waiting' : got.value.why} after ${got.ms} ms`);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.deepEqual(asked, ['http://p1', 'http://p2', 'http://p3'], 'one peer after the other, in order');
  assert.match(got.value.why, /p1: no answer in 400 ms/);
});

test('askPeers: at the same time, in the peers\' order, the bound on a real connection that never answers, and the rest in the grace', async () => {
  const silent = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((ok) => silent.once('listening', ok));
  const url = `http://127.0.0.1:${silent.address().port}`;
  try {
    const started = [];
    const t0 = Date.now();
    const got = await askPeers(['a', url, 'c'], (peer, signal) => {
      started.push(peer);
      return peer === url ? fetch(url, { method: 'POST', signal }) : Promise.resolve(peer.toUpperCase());
    }, { boundMs: BOUND_MS, enough: 3 });
    assert.deepEqual(started, ['a', url, 'c'], 'not all asked at once');
    assert.deepEqual(got.map((x) => x.value), ['A', undefined, 'C']);
    assert.match(got[1].error.message, /no answer in 400 ms/);
    assert.ok(Date.now() - t0 < BOUND_MS + 300);

    // ENOUGH ANSWERED: the slow one is still given the grace, and is in the answer when it makes it
    const slow = await askPeers(['a', 'b'], (peer) => new Promise((ok) => { setTimeout(() => ok(peer), peer === 'a' ? 0 : 30); }), { boundMs: 5000, enough: 1, graceMs: 200 });
    assert.deepEqual(slow.map((x) => x.value), ['a', 'b']);
    // PAST THE GRACE IT IS LEFT, and what it says after that changes nothing the caller holds
    const t1 = Date.now();
    const left = await askPeers(['a', 'b'], (peer, signal) => (peer === 'a' ? 'a' : hang({ signal })), { boundMs: 5000, enough: 1, graceMs: 50 });
    assert.ok(Date.now() - t1 < 1000, 'it waited for the bound with enough answered');
    assert.match(left[1].error.message, /no answer/);
    assert.deepEqual(await askPeers([], () => 1), []);
  } finally { silent.closeAllConnections?.(); silent.close(); }
});
