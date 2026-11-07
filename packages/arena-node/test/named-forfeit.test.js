// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROTOCOL-27 FORFEIT NAMES ITS SIGNERS (kanban #1044 B1, ruling #1131 3 "Cancel { signers, signature }", #1135 3, #1137). The lock is an Arena
// lock: its forfeit is the MuSig2 signature of exactly t named seats over the contract id under KeyAgg(claim_keys[S]), never the round's FROST key.
// Seven real Forfeit instances, each with its own node key and store, reach each other's doors as server.js serves them. Only the gate in front of
// the signing (final, qualifying, ...) is skipped: `message` is the real namedForfeitMessage over the lock each seat verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Forfeit, namedForfeitMessage, decodeForfeitBody, encodeNamedForfeit } from '../src/forfeit.js';
import { encodeCommitments, decodeCommitments, encodeShare } from '../src/pool-wire.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { namedKey } from '../src/named-claim.js';
import { arenaLockContractId, arenaLockFieldsToJson } from '../../arena-protocol/src/arena-lock.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x31);
const ENTRY = b32(0x32);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));

function lockFor(seatKeys, { roundId = RID, threshold = 5, keys = seatKeys } = {}) {
  const fields = { paymentImage: { kind: 'point', bytes: Uint8Array.from([0x02, ...b32(0x44)]) }, amountMsat: 95000n, expiration: 400, fallbackAfter: 259, roundId,
    claimKeys: keys.slice(), threshold, refundPk: Uint8Array.from([0x02, ...b32(0x55)]) };
  return { fields: arenaLockFieldsToJson(fields), contractId: toHex(arenaLockContractId(fields)), raw: fields };
}

async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  const eid = fromHex(url.searchParams.get('entry'));
  if (url.pathname === '/forfeit-commit') {
    const got = await seat.commit(rid, eid);
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/forfeit-share') {
    const got = await seat.share(rid, eid, decodeCommitments(body));
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/forfeit-signature') {
    const got = await seat.take(rid, eid, body);
    return got.ok ? new Response('forfeit kept', { status: 201 }) : new Response(got.why, { status: got.status || 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

/** Seven seats; `misbehave(k, path)` answers for seat k at that door (or throws, as a seat that is down). */
function world({ misbehave = () => undefined } = {}) {
  const stores = Array.from({ length: 7 }, () => new Round(openStore(':memory:')));
  const seatKeys = stores.map((r) => r.pubkey);
  const contract = { protocolVersion: 27, networkId: NETWORK_ID_REGTEST, censusHeight: 900000, federationId: b32(0xfe), nodes: seatKeys, settlementSlots: 7, minScore: 1 };
  const lock = lockFor(seatKeys);
  const seats = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    const random = (n) => sha256(Uint8Array.from([0x27, k, drawn++, n]));
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const f = new Forfeit(stores[k], { random, peersFor: () => peers, peerAskMs: 400, peerGraceMs: 100,
      fetcher: async (u, o) => {
        const url = new URL(u);
        const own = misbehave(seatOf(u), url.pathname);
        if (own !== undefined) return own;
        return serve(seats[seatOf(u)], url, o && o.body ? new Uint8Array(o.body) : new Uint8Array());
      } });
    f.message = async () => namedForfeitMessage({ contract, lock, roundId: RID, pubkey: stores[k].pubkey });
    seats.push(f);
  }
  return { seats, stores, seatKeys, lock, contract };
}

const standsFor = (w, got, signers) => got && got.ok && JSON.stringify(got.signers) === JSON.stringify(signers)
  && verify(got.signature, fromHex(w.lock.contractId), namedKey(w.seatKeys, 5, signers));

test('a protocol-27 forfeit is the five lowest committed seats\' MuSig2 over the contract id, kept by every seat with its signers', async () => {
  const w = world();
  const got = await w.seats[0].forfeit(RID, ENTRY);
  console.log(`  FACTS: forfeit ${got.ok ? `signed by ${got.signers.join(',')}` : got.why}`);
  assert.ok(standsFor(w, got, [0, 1, 2, 3, 4]), got.why);
  assert.equal(toHex(got.message), w.lock.contractId, 'a forfeit signs LNv2\'s forfeit message, the contract id');
  assert.equal(toHex(got.claimPk), '02' + toHex(namedKey(w.seatKeys, 5, [0, 1, 2, 3, 4])));
  for (let k = 0; k < 7; k++) {
    const kept = w.stores[k].forfeit(ENTRY);
    assert.ok(kept, `seat ${k} keeps the forfeit`);
    assert.deepEqual(kept.signers, [0, 1, 2, 3, 4], `seat ${k} keeps its signers`);
    assert.equal(toHex(kept.signature), toHex(got.signature));
  }
  // the kept one is answered again, signers and all (GET /forfeit's `kept`)
  const again = await w.seats[5].forfeit(RID, ENTRY);
  assert.equal(again.kept, true);
  assert.deepEqual(again.signers, [0, 1, 2, 3, 4]);
});

test('a seat that is down is not named: S is the next five, and an asker that is not among the lowest still gathers it', async () => {
  const w = world({ misbehave: (k) => { if (k === 1) throw new Error('fetch failed'); return undefined; } });
  const got = await w.seats[0].forfeit(RID, ENTRY);
  assert.ok(standsFor(w, got, [0, 2, 3, 4, 5]), got.why);
  const w2 = world();
  const by6 = await w2.seats[6].forfeit(RID, ENTRY);
  console.log(`  FACTS: asked at seat 6 with all up: signed by ${by6.ok ? by6.signers.join(',') : by6.why}`);
  assert.ok(standsFor(w2, by6, [0, 1, 2, 3, 4]), by6.why);
});

test('a partial that does not verify costs its seat its place: the next session names the next five', async () => {
  const w = world({ misbehave: (k, path) => (k === 3 && path === '/forfeit-share' ? new Response(encodeShare(1234567n)) : undefined) });
  const got = await w.seats[0].forfeit(RID, ENTRY);
  console.log(`  FACTS: seat 3 spoilt its partial: ${got.ok ? `signed by ${got.signers.join(',')}` : got.why}`);
  assert.ok(standsFor(w, got, [0, 1, 2, 4, 5]), got.why);
});

test('a member signs one list per nonce (#1137): a second list under the same commit is refused, and a list of the wrong form never signs', async () => {
  const w = world();
  const commits = [];
  for (let k = 0; k < 7; k++) commits.push((await w.seats[k].commit(RID, ENTRY)).commitment);
  assert.deepEqual(commits.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7], 'a named commitment carries its seat + 1');
  const a = commits.slice(0, 5), b = [commits[0], commits[1], commits[2], commits[3], commits[5]];
  const first = await w.seats[2].share(RID, ENTRY, a);
  assert.equal(first.ok, true, first.why);
  assert.equal((await w.seats[2].share(RID, ENTRY, a)).share, first.share, 'the same list is answered with the same partial');
  assert.match((await w.seats[2].share(RID, ENTRY, b)).why, /keeps no second pair/);
  // six seats, four seats, a descending list: each refused by its form, before the nonce is touched
  assert.match((await w.seats[3].share(RID, ENTRY, commits.slice(0, 6))).why, /exactly 5 signers/);
  assert.match((await w.seats[3].share(RID, ENTRY, commits.slice(0, 4))).why, /exactly 5 signers/);
  assert.match((await w.seats[3].share(RID, ENTRY, a.slice().reverse())).why, /ascending/);
  assert.equal((await w.seats[3].share(RID, ENTRY, a)).ok, true, 'the refused forms left seat 3\'s nonce unspent');
  // a list without the member's own nonce
  assert.match((await w.seats[6].share(RID, ENTRY, a)).why, /does not carry this signer node's own commitment/);
});

test('a handed forfeit is kept only with its signers and only under their KeyAgg; a bare 64-byte FROST-style forfeit is refused', async () => {
  const w = world();
  const got = await w.seats[0].forfeit(RID, ENTRY);
  assert.ok(got.ok, got.why);
  const fresh = world();
  const msg = fromHex(fresh.lock.contractId);
  // fresh seats over the same keys? no: a new world has new keys - so sign in the fresh world and hand variants to its seat 6
  const made = await fresh.seats[0].forfeit(RID, b32(0x99));
  assert.ok(made.ok, made.why);
  const r = await fresh.seats[1].take(RID, ENTRY, made.signature);
  assert.match(r.why, /names its signers/);
  const wrong = await fresh.seats[1].take(RID, ENTRY, encodeNamedForfeit(made.signature, [0, 1, 2, 3, 5]));
  assert.match(wrong.why, /does not verify under the KeyAgg/);
  const odd = await fresh.seats[1].take(RID, ENTRY, encodeNamedForfeit(made.signature, [0, 1, 2, 3]));
  assert.match(odd.why, /exactly 5 signers/);
  const right = await fresh.seats[1].take(RID, ENTRY, encodeNamedForfeit(made.signature, made.signers));
  assert.equal(right.ok, true, right.why);
  assert.ok(verify(made.signature, msg, namedKey(fresh.seatKeys, 5, made.signers)));
  assert.equal(decodeForfeitBody(new Uint8Array(70)), null, 'a body whose count does not match its length is no forfeit');
});

test('namedForfeitMessage: the lock this seat verified, rebuilt - its keys in seat order, the threshold, this round, this seat among them', () => {
  const stores = Array.from({ length: 7 }, () => new Round(openStore(':memory:')));
  const seatKeys = stores.map((r) => r.pubkey);
  const contract = { protocolVersion: 27, networkId: NETWORK_ID_REGTEST, censusHeight: 900000, nodes: seatKeys, settlementSlots: 7 };
  const good = lockFor(seatKeys);
  const m = namedForfeitMessage({ contract, lock: good, roundId: RID, pubkey: seatKeys[4] });
  assert.equal(m.ok, true, m.why);
  assert.equal(m.me, 4);
  assert.equal(toHex(m.message), good.contractId);
  assert.match(namedForfeitMessage({ contract, lock: lockFor(seatKeys, { keys: seatKeys.slice().reverse() }), roundId: RID, pubkey: seatKeys[0] }).why, /seat order/);
  assert.match(namedForfeitMessage({ contract, lock: lockFor(seatKeys, { threshold: 4 }), roundId: RID, pubkey: seatKeys[0] }).why, /seat order with its threshold/);
  assert.match(namedForfeitMessage({ contract, lock: lockFor(seatKeys, { roundId: b32(0x77) }), roundId: RID, pubkey: seatKeys[0] }).why, /another round/);
  assert.match(namedForfeitMessage({ contract, lock: { ...good, contractId: 'ab'.repeat(32) }, roundId: RID, pubkey: seatKeys[0] }).why, /not the one it verified/);
  assert.match(namedForfeitMessage({ contract, lock: good, roundId: RID, pubkey: b32(0x01) }).why, /not one of the round's settlement seats/);
  const stock = { fields: { paymentImage: { kind: 'point', bytes: '02' + '44'.repeat(32) }, amountMsat: '95000', expiration: 400, claimPk: '02' + '66'.repeat(32), refundPk: '02' + '55'.repeat(32), ephemeralPk: '02' + '77'.repeat(32) }, contractId: '00'.repeat(32) };
  assert.match(namedForfeitMessage({ contract, lock: stock, roundId: RID, pubkey: seatKeys[0] }).why, /stock contract/);
});
