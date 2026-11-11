// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE WITHHELD SHARE DOES NOT PIN A SETTLEMENT (kanban #1070). A seat keeps one nonce pair per settlement, and the pair signs one commitment list. A seat that committed
// and then gives no share therefore left every seat that had already signed that list refusing any other ("keeps no second pair") until it restarted, and the seat that
// went on committing was put back on every next list: one seat stopped a settlement the five others could sign.
//
// Seven real LockSettlement instances with a real 5-of-7 FROST key: each seat's own commit, share and take, reached through a fetcher that answers as server.js does, and
// misbehaves for the seats a test names. Only the settlement's bytes are stubbed (`message`), not the signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments } from '../src/settlement.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x70);
const MSG = new Uint8Array(32).fill(0xac);
const TXID = toHex(MSG);
const ENTRY = new Uint8Array(32).fill(0x71);
const FED = 'fe'.repeat(32);
const GROUP = evenGroupSecret(0x1070n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const PUBLIC_SHARES = new Map(DEAL.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));

/** What a stub round keeps, enough for a settlement, a late settlement and one federation's. */
function stubRound() {
  const rows = { settlement: null, late: null, fed: null };
  return {
    get: () => null, lockSettlement: () => rows.settlement, putLockSettlement: (r) => { rows.settlement = r; }, putLockSettlementMoves: () => {},
    lateLockSettlement: () => rows.late, putLateLockSettlement: (r) => { rows.late = r; },
    fedLockSettlement: () => rows.fed, putFedLockSettlement: (r) => { rows.fed = r; },
    rows,
  };
}

/** The seven seats. `misbehave(k, path, url)` answers for seat k at that door or throws as a dropped connection; undefined is the honest door. */
function seven({ misbehave = () => undefined, seed = 0x70 } = {}) {
  const seats = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ id: 'payout-0' }], locksAfter: [null] }; } };   // as the tool answers (kanban #1171)
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    const random = (n) => sha256(Uint8Array.from([seed, k, drawn++, n]));
    const round = stubRound();
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(round, { curve, random, port, peersFor: () => peers, dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        const own = misbehave(to, url.pathname, url);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, o && o.body ? new Uint8Array(o.body) : new Uint8Array());
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    const bytes = { ok: true, txid: TXID, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, claims: [], contract: { nodes: [] },
      plan: { payouts: [], claims: [], nonce: new Uint8Array(32), stakeShares: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    s.message = async () => bytes;
    s.lateMessage = async () => bytes;
    s.fedMessage = async () => bytes;
    s.turn = async () => ({ mine: true, place: k });
    seats.push(s);
  }
  return { seats, port, refusals };
}

// WHAT server.js ANSWERS at /settle-commit, /settle-share and /settle-signature
async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  const hex = url.searchParams.get('entry');
  const scope = { entry: hex ? fromHex(hex) : null, federation: url.searchParams.get('federation') };
  if (url.pathname === '/settle-commit') {
    const got = await seat.commit(rid, { txid: url.searchParams.get('txid'), ...scope });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/settle-share') {
    const got = await seat.share(rid, decodeCommitments(body), scope);
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/settle-signature') {
    const got = await seat.take(rid, body, scope);
    return got.ok ? new Response('kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

const refused = () => new Response('this seat gives no share', { status: 503 });
const signedOver = (w) => w.port.settled.map((x) => schnorr.verify(x.signature, MSG, DEAL.groupPublicKey.subarray(1)));

test('a seat that commits and gives no share goes off the list: the six others sign in the same pass', async () => {
  const w = seven({ misbehave: (k, path) => (k === 6 && path === '/settle-share' ? refused() : undefined) });
  const got = await w.seats[0].settle(RID);
  console.log(`  FACTS: one share withheld, ${got.state || 'refused'}: ${got.why}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
});

test('one share withheld, then the seat gone: no honest seat refuses another list, and no asker is stopped', async () => {
  let gone = false;
  const w = seven({ misbehave: (k, path) => {
    if (k !== 6) return undefined;
    if (gone) throw new Error('fetch failed');
    return path === '/settle-share' ? refused() : undefined;
  } });
  const passes = [];
  for (const asker of [0, 0, 1, 2]) {
    const got = await w.seats[asker].settle(RID).catch((e) => ({ ok: false, why: e.message }));
    passes.push(`seat ${asker}: ${got.state || 'refused'}${got.state === 'ACCEPTED' ? '' : `, ${got.why}`}`);
    gone = true;
    if (got.state === 'ACCEPTED') break;
  }
  console.log(`  FACTS: ${passes.join(' | ')}`);
  console.log(`  FACTS: ${w.refusals.length} refusals between seats, ${w.refusals.filter((x) => /keeps no second pair/.test(x)).length} of them "keeps no second pair"`);
  assert.deepEqual(signedOver(w), [true], passes.join(' | '));
  assert.equal(w.refusals.filter((x) => /keeps no second pair/.test(x)).length, 0, 'an honest seat stayed bound to the list the withheld share broke');
});

test('a share that does not combine costs the seat that gave it its place: the public shares name it', async () => {
  const w = seven({ misbehave: (k, path) => (k === 4 && path === '/settle-share' ? new Response(encodeShare(1234567n)) : undefined) });
  const got = await w.seats[0].settle(RID);
  console.log(`  FACTS: one bad share, ${got.state || 'refused'}: ${got.why}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
});

test('a connection that drops at the share goes off the list as a refusal does', async () => {
  const w = seven({ misbehave: (k, path) => { if (k === 3 && path === '/settle-share') throw new Error('fetch failed'); return undefined; } });
  const got = await w.seats[0].settle(RID).catch((e) => ({ ok: false, why: `threw: ${e.message}` }));
  console.log(`  FACTS: dropped at the share, ${got.state || 'refused'}: ${got.why}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
});

test('two seats withholding: the five left sign', async () => {
  const w = seven({ misbehave: (k, path) => ((k === 5 || k === 6) && path === '/settle-share' ? refused() : undefined) });
  const got = await w.seats[0].settle(RID);
  console.log(`  FACTS: two withheld, ${got.state || 'refused'}: ${got.why}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
});

test('three withholding stop it, as the threshold says, and leave nothing behind: the pass ends, and when one comes back the settlement goes', async () => {
  let back = false;
  const w = seven({ misbehave: (k, path) => ((k === 4 || k === 5 || (k === 6 && !back)) && path === '/settle-share' ? refused() : undefined) });
  const first = await w.seats[0].settle(RID);
  console.log(`  FACTS: three withheld, ${first.state || 'refused'}: ${first.why}`);
  assert.equal(first.ok, false);
  assert.equal(w.port.settled.length, 0);
  back = true;
  const next = await w.seats[0].settle(RID);
  console.log(`  FACTS: one back, ${next.state || 'refused'}: ${next.why}`);
  assert.equal(next.state, 'ACCEPTED', next.why);
  assert.deepEqual(signedOver(w), [true]);
});

test('an asker that took every share and went away pins nobody: the next asker signs another list', async () => {
  const w = seven({ misbehave: (k, path) => (k === 6 && path === '/settle-share' ? refused() : undefined) });
  const list = [];
  for (const s of w.seats) list.push((await s.commit(RID, { txid: TXID })).commitment);
  list.sort((a, b) => a.id - b.id);
  for (const s of w.seats) assert.equal((await s.share(RID, list)).ok, true);
  const got = await w.seats[0].settle(RID);
  console.log(`  FACTS: every seat signed one list for an asker that left, then ${got.state || 'refused'}: ${got.why}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
});

test('a list made up at the door pins nobody: three seats given a share over commitments nobody holds still sign the real one', async () => {
  const w = seven();
  // ANYONE WHO REACHES THE DOOR: a seat's own commitment and four invented ones. The door checks only that the seat's own is on it and that there are five.
  const invented = [0, 1, 2, 3].map((i) => ({ hiding: curve.pointFromScalar(BigInt(1000 + i)), binding: curve.pointFromScalar(BigInt(2000 + i)) }));
  for (const k of [1, 2, 3]) {
    const own = (await w.seats[k].commit(RID, { txid: TXID })).commitment;
    const others = DEAL.shares.map((s) => s.id).filter((id) => id !== own.id).slice(0, 4).map((id, i) => ({ id, ...invented[i] }));
    const list = [own, ...others].sort((a, b) => a.id - b.id);
    const answer = await serve(w.seats[k], new URL(`${base(k)}/settle-share?round=${toHex(RID)}`), encodeCommitments(list));
    assert.equal(answer.ok, true, 'the door takes such a list: this test measures what it leaves behind');
  }
  const got = await w.seats[0].settle(RID);
  console.log(`  FACTS: three seats pinned by a list from outside, then ${got.state || 'refused'}: ${got.why}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
});

test('a late settlement is not pinned either', async () => {
  const w = seven({ misbehave: (k, path) => (k === 6 && path === '/settle-share' ? refused() : undefined) });
  const got = await w.seats[0].settleLate(RID, ENTRY);
  console.log(`  FACTS: late, one withheld, ${got.state || 'refused'}: ${got.why}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
});

test('one federation\'s settlement is not pinned either', async () => {
  const nodes = [1, 2, 3, 4, 5, 6, 7].map((n) => new Uint8Array(32).fill(n));
  const contract = encodeRoundContract({ protocolVersion: 3, networkId: new Uint8Array(32).fill(0x4e), configHash: new Uint8Array(32).fill(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7,
    gameId: new Uint8Array(32).fill(0x67), simCoreHash: new Uint8Array(32).fill(1), startTimeMs: 1788200000000n, entryCloseMs: 1788200045000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
    slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: new Uint8Array(32).fill(0xd0), censusHeight: 964900,
    censusRoot: new Uint8Array(32).fill(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000n, bondMinSats: 100000n, blockTicks: 9000, exposureReference: 12451840,
    corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes });
  const w = seven({ misbehave: (k, path) => (k === 6 && path === '/settle-share' ? refused() : undefined) });
  for (const s of w.seats) {
    s.round.get = () => ({ contract });
    s.planOf = async () => ({ ok: true, plan: { stakeShares: [] }, split: { settlements: [{ federation: FED, claims: [], payouts: [], nonce: new Uint8Array(32), poolMsat: 0n, feePoolMsat: 0n }] } });
    s.portForFederation = async () => w.port;
  }
  const got = await w.seats[0].settle(RID);
  console.log(`  FACTS: one federation, one withheld, ${got.state || 'refused'}: ${got.why}`);
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.deepEqual(signedOver(w), [true]);
});

test('a nonce pair still signs one list once: the same list gets the same share, another gets nothing, a spent pair is never offered again', async () => {
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
  assert.notEqual(toHex(fresh.binding), toHex(five.find((x) => x.id === fresh.id).binding), 'a spent nonce was handed out again');
  assert.equal((await a.share(RID, other)).ok, false, 'the old commitment signs nothing any more');
  const again = await a.share(RID, other.map((x) => (x.id === fresh.id ? fresh : x)));
  assert.equal(again.ok, true);
  assert.notEqual(again.share, shared.share);
});

test('nobody withholding: one pass, every seat on the list, one request per peer per step', async () => {
  const asked = [];
  const w = seven({ misbehave: (k, path) => { asked.push(path); return undefined; } });
  const got = await w.seats[0].settle(RID);
  assert.equal(got.state, 'ACCEPTED', got.why);
  for (const p of ['/settle-commit', '/settle-share', '/settle-signature']) assert.equal(asked.filter((x) => x === p).length, 6, `six peers asked at ${p}`);
});
