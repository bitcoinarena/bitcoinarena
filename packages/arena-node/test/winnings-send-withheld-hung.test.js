// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE WITHHELD SHARE OR ONE HUNG SEAT DOES NOT HOLD A WINNINGS SEND (kanban #1074, after #1070 and #1061 on the settlement). The committee's auth of a
// send (and a re-send's txid) is signed as the settlement was before 528920eaf: one nonce pair per message, one list per pair, every seat that commits on
// the list. And the peers were asked one at a time with no bound, so a seat that took the connection and stopped held the send up to undici's 300 s at
// each step; the address's LNURL endpoint had no bound either.
//
// Seven real WinningsSend instances with a real 5-of-7 FROST key: each seat's own commit, share and paid, reached through a fetcher that answers as
// server.js does at /send-commit, /send-share, /winnings-paid and /resend-sends, and misbehaves or hangs for the seats a test names. Only the message
// a seat rebuilds (the invoice's consensus hash, `messageFor`) is stubbed, not the signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { WinningsSend } from '../src/winnings-send.js';
import { encodeCommitments, decodeCommitments, encodeShare } from '../src/pool-wire.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x76);
const ENTRY = new Uint8Array(32).fill(0x77);
const MSG = new Uint8Array(32).fill(0xae);
const PREIMAGE = new Uint8Array(32).fill(0x78);
const HASH = toHex(sha256(PREIMAGE));
const GROUP = evenGroupSecret(0x10740n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const PUBLIC_SHARES = new Map(DEAL.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));
const BOUND_MS = 400;
const GRACE_MS = 100;

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));
const hang = (o) => new Promise((_, reject) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

/** One send's row, as every seat keeps it after the plan was agreed. */
function stubRound() {
  const row = { entryId: ENTRY, roundId: RID, attempt: 0, address: 'w@example.com', invoice: 'lnbcrt1', paymentHash: HASH, invoiceMsat: 900n, payoutMsat: 1000n,
    owedMsat: 1000n, gatewayUrl: 'http://gw', gatewayPk: '02'.padEnd(66, '1'), expiration: 500n, state: 'SENDING', txid: 'ab'.repeat(32), donation: false };
  const r = { row, paid: [], sendAttemptsOf: () => [row], sendPlansOf: () => [row], now: () => 0,
    markSend: (x) => { if (x.state === 'PAID') r.paid.push(x); }, putWinnings: () => {}, putSendPlan: () => {} };
  return r;
}

/** The seven seats. `misbehave(k, path, o)` answers for seat k at that door, throws, or hangs; undefined is the honest door. */
function seven({ misbehave = () => undefined, seed = 0x76, boundMs = BOUND_MS, wire = [], lnurlFetch = () => { throw new Error('no LNURL here'); } } = {}) {
  const seats = [];
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    const random = (n) => sha256(Uint8Array.from([seed, k, drawn++, n]));
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new WinningsSend({ round: stubRound(), port: null, curve, random, peersFor: () => peers, lnurlFetch, peerAskMs: boundMs, peerGraceMs: GRACE_MS, lnurlMs: boundMs,
      dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        const body = o && o.body ? (typeof o.body === 'string' ? new TextEncoder().encode(o.body) : new Uint8Array(o.body)) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        const own = misbehave(to, url.pathname, o);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, body);
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    s.messageFor = async () => MSG;
    s.built = { ok: true, claimPk: DEAL.groupPublicKey, needed: 5, contract: { nodes: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    seats.push(s);
  }
  return { seats, refusals, wire };
}

// WHAT server.js ANSWERS at /send-commit, /send-share, /winnings-paid and /resend-sends
async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  const eHex = url.searchParams.get('entry');
  const kind = url.searchParams.get('kind') === 'resend' ? 'resend' : 'auth';
  const attempt = url.searchParams.has('attempt') ? Number(url.searchParams.get('attempt')) : null;
  if (url.pathname === '/winnings-paid') {
    const got = seat.paid(rid, eHex, body);
    return got.ok ? new Response('kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/resend-sends') return new Response('taken', { status: 201 });
  if (url.pathname === '/send-commit') {
    const got = await seat.commit(rid, eHex, seat.built, kind, attempt, { hash: url.searchParams.get('hash') });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/send-share') {
    const got = await seat.share(rid, eHex, seat.built, decodeCommitments(body), kind, attempt);
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

const refused = () => new Response('this seat gives no share', { status: 503 });
const verifies = (got) => !!(got && got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)));
const sign = (w, k) => w.seats[k].sign(RID, w.seats[k].round.row, w.seats[k].built, 'auth');

async function within(p, ms) {
  const t0 = Date.now();
  let timer;
  const out = await Promise.race([p.then((value) => ({ value }), (e) => ({ value: { ok: false, why: `threw: ${e.message}` } })),
    new Promise((ok) => { timer = setTimeout(() => ok({ stuck: true }), ms); })]);
  clearTimeout(timer);
  return { ...out, ms: Date.now() - t0 };
}

// ---- #1070's point: one list per nonce pair

test('a seat that commits and gives no auth share goes off the list: the six others sign in the same ask', async () => {
  const w = seven({ misbehave: (k, path) => (k === 6 && path === '/send-share' ? refused() : undefined) });
  const got = await sign(w, 0);
  console.log(`  FACTS: one share withheld: ${got.ok ? 'auth signed' : got.why}`);
  assert.ok(verifies(got), got.why);
});

test('one share withheld, then the seat gone: no honest seat refuses another list, and no asker is stopped', async () => {
  let gone = false;
  const w = seven({ misbehave: (k, path) => {
    if (k !== 6) return undefined;
    if (gone) throw new Error('fetch failed');
    return path === '/send-share' ? refused() : undefined;
  } });
  const asks = [];
  let got = null;
  for (const asker of [0, 0, 1, 2]) {
    got = await sign(w, asker).catch((e) => ({ ok: false, why: e.message }));
    asks.push(`seat ${asker}: ${got.ok ? 'auth signed' : got.why}`);
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
  const w = seven({ misbehave: (k, path) => (k === 4 && path === '/send-share' ? new Response(encodeShare(1234567n)) : undefined) });
  const got = await sign(w, 0);
  console.log(`  FACTS: one bad share: ${got.ok ? 'auth signed' : got.why}`);
  assert.ok(verifies(got), got.why);
});

test('a connection that drops at the share goes off the list as a refusal does', async () => {
  const w = seven({ misbehave: (k, path) => { if (k === 3 && path === '/send-share') throw new Error('fetch failed'); return undefined; } });
  const got = await sign(w, 0).catch((e) => ({ ok: false, why: `threw: ${e.message}` }));
  console.log(`  FACTS: dropped at the share: ${got.ok ? 'auth signed' : got.why}`);
  assert.ok(verifies(got), got.why);
});

test('three withholding stop it, as the threshold says; when one comes back the auth is signed', async () => {
  let back = false;
  const w = seven({ misbehave: (k, path) => ((k === 4 || k === 5 || (k === 6 && !back)) && path === '/send-share' ? refused() : undefined) });
  const first = await sign(w, 0);
  console.log(`  FACTS: three withheld: ${first.ok ? 'auth signed' : first.why}`);
  assert.equal(first.ok, false);
  back = true;
  const next = await sign(w, 0);
  console.log(`  FACTS: one back: ${next.ok ? 'auth signed' : next.why}`);
  assert.ok(verifies(next), next.why);
});

test('a nonce pair still signs one list once: the same list gets the same share, another gets nothing, a spent pair is never offered again', async () => {
  const w = seven();
  const [a, b, c, d, e, f] = w.seats;
  const eHex = toHex(ENTRY);
  const of = async (s) => (await s.commit(RID, eHex, s.built, 'auth', 0)).commitment;
  const five = [await of(a), await of(b), await of(c), await of(d), await of(e)].sort((x, y) => x.id - y.id);
  // (a's commitment on `other` is the one `five` spent: each ask draws a fresh pair since kanban #1806)
  const other = [...five.filter((x) => x.id !== e.built.signerNode.id), await of(f)].sort((x, y) => x.id - y.id);
  const shared = await a.share(RID, eHex, a.built, five, 'auth', 0);
  assert.equal(shared.ok, true);
  assert.equal((await a.share(RID, eHex, a.built, five, 'auth', 0)).share, shared.share, 'the same list is answered with the same share');
  assert.match((await a.share(RID, eHex, a.built, other, 'auth', 0)).why, /keeps no second pair/);
  const fresh = await of(a);
  assert.notEqual(toHex(fresh.hiding), toHex(five.find((x) => x.id === fresh.id).hiding), 'a spent nonce was handed out again');
  assert.notEqual(toHex(fresh.binding), toHex(five.find((x) => x.id === fresh.id).binding), 'a spent nonce was handed out again');
  assert.equal((await a.share(RID, eHex, a.built, other, 'auth', 0)).ok, false, 'the old commitment signs nothing any more');
  const again = await a.share(RID, eHex, a.built, other.map((x) => (x.id === fresh.id ? fresh : x)), 'auth', 0);
  assert.equal(again.ok, true);
  assert.notEqual(again.share, shared.share);
});

// ---- #1061's point: the peers asked one at a time, with no bound

test('two seats that took the connection and never answer do not hold the auth: the five that answered sign it', async () => {
  const w = seven({ misbehave: (k, path, o) => (k === 2 || k === 3 ? hang(o) : undefined), boundMs: 30000 });
  const got = await within(sign(w, 0), 5000);
  console.log(`  FACTS: two hung of seven: ${got.stuck ? 'NOT SIGNED, still waiting' : got.value.ok ? 'auth signed' : got.value.why} after ${got.ms} ms`);
  assert.ok(!got.stuck, `the auth still waited on a hung seat after ${got.ms} ms`);
  assert.ok(verifies(got.value), got.value.why);
  assert.ok(got.ms < 3000, `the threshold had answered, and it waited ${got.ms} ms against a grace of ${GRACE_MS} ms and a bound of 30 s`);
});

test('a seat that hangs between its commitment and its share is left off the next list once the bound has passed, and the same ask signs', async () => {
  const w = seven({ misbehave: (k, path, o) => (k === 3 && path === '/send-share' ? hang(o) : undefined) });
  const got = await within(sign(w, 0), 5000);
  console.log(`  FACTS: hung at the share: ${got.stuck ? 'still waiting' : got.value.ok ? 'auth signed' : got.value.why} after ${got.ms} ms`);
  assert.ok(!got.stuck, `the share stage still waited after ${got.ms} ms`);
  assert.ok(verifies(got.value), got.value.why);
});

test('below the threshold it refuses inside the bound', async () => {
  const w = seven({ misbehave: (k, path, o) => (k === 2 || k === 3 || k === 4 ? hang(o) : undefined) });
  const got = await within(sign(w, 0), 3000);
  console.log(`  FACTS: three hung of seven: ${got.stuck ? 'still waiting' : got.value.why} after ${got.ms} ms`);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.equal(got.value.ok, false);
  assert.match(got.value.why, /4 of 5 signer nodes committed/);
  assert.ok(got.ms < BOUND_MS + 300, `${got.ms} ms against a bound of ${BOUND_MS}`);
});

test('a paid send is reported to every peer without waiting on a hung one', async () => {
  const w = seven({ misbehave: (k, path, o) => (k === 5 && path === '/winnings-paid' ? hang(o) : undefined), boundMs: 30000 });
  const s = w.seats[0];
  s.contractOf = async () => ({ txid: new Uint8Array(32).fill(1), outIdx: 0n });
  s.portFor = async () => ({ send: async () => ({ sent: true, preimage: PREIMAGE }) });
  const got = await within(s.sendAll(RID, s.built), 5000);
  console.log(`  FACTS: winnings-paid with a hung peer: ${got.stuck ? 'still waiting' : JSON.stringify(got.value.map((x) => x.state || x.why))} after ${got.ms} ms`);
  assert.ok(!got.stuck, `the send still waited on a hung peer after ${got.ms} ms`);
  assert.equal(got.value[0].state, 'PAID');
  assert.equal(w.seats.filter((x, k) => k !== 5 && x.round.paid.length).length, 6, 'every peer that answers keeps it as paid');
});

test('a re-send offered to the peers does not wait on a hung one, and names it', async () => {
  const w = seven({ misbehave: (k, path, o) => (k === 2 && path === '/resend-sends' ? hang(o) : undefined) });
  const got = await within(w.seats[0].offerResend(RID, w.seats[0].round.row), 3000);
  console.log(`  FACTS: offerResend with a hung peer: ${got.stuck ? 'still waiting' : got.value.join('; ')} after ${got.ms} ms`);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.equal(got.value.length, 1);
  assert.match(got.value[0], /^http:\/\/seat2: /);
});

test('an address whose LNURL endpoint never answers is refused within the bound, its pay request and its callback both', async () => {
  for (const at of ['pay request', 'callback', 'body']) {
    const lnurlFetch = (u, o) => {
      if (at === 'pay request') return hang(o);
      if (!u.includes('cb')) return new Response(JSON.stringify({ tag: 'payRequest', callback: 'https://example.com/cb', minSendable: 1, maxSendable: 1e12, metadata: '[["text/plain","x"]]' }));
      return at === 'callback' ? hang(o) : { ok: true, status: 200, json: () => hang(o), text: () => hang(o) };
    };
    const w = seven({ lnurlFetch });
    const got = await within(w.seats[0].invoiceFor('w@example.com', 1000n), 3000);
    console.log(`  FACTS: LNURL hung at the ${at}: ${got.stuck ? 'still waiting' : got.value.why} after ${got.ms} ms`);
    assert.ok(!got.stuck, `hung at the ${at}: still waiting after ${got.ms} ms`);
    assert.equal(got.value.ok, false);
    assert.ok(got.ms < BOUND_MS + 300, `${got.ms} ms against a bound of ${BOUND_MS}`);
  }
});

// ---- an honest send

test('an honest send sends the same bytes as before, one request per peer per step', async () => {
  const wire = [];
  const w = seven({ wire });
  const s = w.seats[0];
  s.contractOf = async () => ({ txid: new Uint8Array(32).fill(1), outIdx: 0n });
  s.portFor = async () => ({ send: async () => ({ sent: true, preimage: PREIMAGE }) });
  const got = await s.sendAll(RID, s.built);
  assert.equal(got[0].state, 'PAID', JSON.stringify(got));
  const resend = await s.offerResend(RID, s.round.row);
  assert.deepEqual(resend, []);
  const sorted = [...wire].sort();
  for (const p of ['/send-commit', '/send-share', '/winnings-paid', '/resend-sends']) assert.equal(sorted.filter((l) => l.includes(p)).length, 6, `six peers asked at ${p}`);
  // TAKEN FROM THE CODE BEFORE #1074, which asked one peer at a time
  const digest = toHex(sha256(new TextEncoder().encode(sorted.join('\n'))));
  console.log(`  FACTS: ${sorted.length} requests, digest ${digest}`);
  assert.equal(digest, 'cd6e1cd2d72ff9fef38e80dedc68c63167b029ca7f5867ba9152d05e308a60ad');
});
