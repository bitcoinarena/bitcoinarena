// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2608 (spec ruling #2600, comment 7660; the backdating of #2599): a guardian's departure notice counts from the height at which
// its hash is confirmed on chain - OP_RETURN "ARN" 'L' || departure_id in any transaction - read from the seat's own chain. posted_at is
// the guardian's word: signed at tip T with posted_at T - 432, the old rule let him leave at once and keep his bond. From the network's
// DEPARTURE_ANCHOR_HEIGHT on, a notice without an anchor is no notice; below it, the old rule holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  signDeparture, departureStands, departureId, departureAnchorScript, departureAnchorOf, encodeDepartureAnchor,
  DEPARTURE_ANCHOR_HEIGHT, departureAnchorHeight, DEPARTURE_ANCHOR_SLACK,
} from '../../arena-protocol/src/absence.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { createAbsences, departureHex, readDepartureHex, dueDeparture } from '../src/absences.js';
import { noticeTriggers } from '../src/founding-seat.js';
import { ownDeparture } from '../src/absence-producer.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x26);
const keys = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 11); return { secret, pub: schnorr.getPublicKey(secret) }; });
const peerOf = (i) => Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]);
const record = { federationId: FED, nominal: 4, guardians: keys.map((k, i) => ({ peerKey: peerOf(i), nodePubkey: k.pub })) };
const NOTICE = 432;                                  // departure_notice (mainnet / testnet4)
const GATE = DEPARTURE_ANCHOR_HEIGHT.testnet4;
const notice = ({ postedAt, leaveAfter, i = 0 }) => signDeparture({ federationId: FED, peerKey: peerOf(i), leaveAfterHeight: leaveAfter, postedAt, nodePubkey: keys[i].pub },
  (m) => schnorr.sign(m, keys[i].secret));

// A RAW TRANSACTION (legacy form) with one input and the given output scripts
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
function rawTx(scripts) {
  const b = [...u32le(2), 1, ...new Array(32).fill(0x11), ...u32le(0), 0, ...u32le(0xffffffff), scripts.length];
  for (const s of scripts) b.push(...new Array(8).fill(0), s.length, ...s);
  b.push(...u32le(0));
  return Uint8Array.from(b);
}
// A SEAT'S CHAIN: anchor transactions by (txid, block hash) -> { raw, height }; what main.js confirmedTx answers from bitcoind
function chainWith() {
  const txs = new Map();
  let n = 0;
  return {
    anchor(d, height, extra = []) {
      const raw = rawTx([...extra, departureAnchorScript(d)]);
      const txid = toHex(Uint8Array.from(parseTransaction(raw).txid).reverse());
      const blockHash = toHex(new Uint8Array(32).fill(++n));
      txs.set(`${txid}:${blockHash}`, { raw, height });
      return { txid, blockHash };
    },
    put(raw, height) {
      const txid = toHex(Uint8Array.from(parseTransaction(raw).txid).reverse());
      const blockHash = toHex(new Uint8Array(32).fill(++n));
      txs.set(`${txid}:${blockHash}`, { raw, height });
      return { txid, blockHash };
    },
    confirmedTx: async (txid, blockHash) => txs.get(`${txid}:${blockHash}`) || null,
  };
}

test('#2608 the gate: testnet4 at 161 600 (~600 above the tip of 2026-11-13), regtest and mainnet from their first block', () => {
  assert.equal(GATE, 161600);
  assert.deepEqual([departureAnchorHeight('testnet4'), departureAnchorHeight('regtest'), departureAnchorHeight('mainnet'), departureAnchorHeight('signet')], [161600, 0, 0, 0]);
  const d = notice({ postedAt: 1, leaveAfter: 500 });
  const a = encodeDepartureAnchor(d);
  assert.deepEqual([a.length, toHex(a.subarray(0, 4)), toHex(a.subarray(4))], [36, '41524e4c', toHex(departureId(d))], '"ARN" \'L\' || departure_id, 36 bytes');
});

test('#2608 a backdated notice is refused after the gate: signed at T with posted_at T - 432, anchored at T, leaving at T is not a departure', async () => {
  const T = GATE + 100;
  const back = notice({ postedAt: T - NOTICE, leaveAfter: T });
  // THE HOLE, as it was: posted_at alone, the notice stands and is due at once
  assert.equal(departureStands(back, { record, departureNotice: NOTICE, verify }).ok, true, 'the old rule takes posted_at on the guardian\'s word');
  const chain = chainWith();
  const ref = chain.anchor(back, T);
  const seat = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  assert.equal((await seat.offerAnchored({ ...back, anchor: ref })).kept, true);
  for (const h of [T, T + 1, T + NOTICE - 1]) {
    const due = seat.departureFor(record, peerOf(0), NOTICE, h);
    assert.equal(due.ok, false, `not due at ${h}`);
  }
  // judged at any height: leave_after T is short of its anchor (T) + 432, so it never stands - the guardian who leaves is ABANDONED
  const st = departureStands(back, { record, departureNotice: NOTICE, verify, height: T + 5000, gate: GATE, anchorHeight: T });
  assert.equal(st.ok, false);
  assert.match(st.why, new RegExp(`after it was posted at ${T} \\(its anchor's height\\)`));
  // a named block hash is no anchor: the notice "posted" at T - 432 naming that block's hash, with no "ARN" 'L' anchor of it there
  const other = chain.put(rawTx([Uint8Array.from([0x6a, 32, ...new Uint8Array(32).fill(7)])]), T - NOTICE);
  const named = await seat.anchorDeparture({ ...back, anchor: other });
  assert.equal(named.anchor.height, undefined, 'a block of the right age that carries no anchor of the notice gives it no height');
});

test('#2608 an anchored notice counts from its anchor\'s height, whatever posted_at says', async () => {
  const T = GATE + 50, A = T + 3;
  const chain = chainWith();
  // honest: posted at T, leave_after A + 432 (the producer adds the slack); anchored at A
  const d = notice({ postedAt: T, leaveAfter: A + NOTICE });
  const seat = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  await seat.offerAnchored({ ...d, anchor: chain.anchor(d, A) });
  assert.equal(seat.departureFor(record, peerOf(0), NOTICE, A + NOTICE - 1).ok, false, 'not yet due');
  const due = seat.departureFor(record, peerOf(0), NOTICE, A + NOTICE);
  assert.deepEqual([due.ok, due.sinceHeight, toHex(due.id)], [true, A + NOTICE, toHex(departureId(d))], 'DEPARTED from its leave_after');
  assert.equal(departureStands(d, { record, departureNotice: NOTICE, verify, height: A + NOTICE, gate: GATE, anchorHeight: A }).postedHeight, A);
  // posted_at is not what counts: the same leave_after with an anchor 3 blocks later than posted_at + 0 stands, while a notice of
  // exactly posted_at + 432 anchored later than posted_at does not
  const tight = notice({ postedAt: T, leaveAfter: T + NOTICE, i: 1 });
  const s2 = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  await s2.offerAnchored({ ...tight, anchor: chain.anchor(tight, A) });
  assert.equal(s2.departureFor(record, peerOf(1), NOTICE, T + 5000).ok, false, 'leave_after T + 432 < anchor A + 432');
  // an anchor confirmed after the height a record is judged at does not count there
  assert.match(departureStands(d, { record, departureNotice: NOTICE, verify, height: A - 1, gate: GATE, anchorHeight: A }).why, /after the height/);
  // a later copy that names an earlier anchor of the same notice moves it; a later anchor does not
  const s3 = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  await s3.offerAnchored({ ...d, anchor: chain.anchor(d, A + 10) });
  assert.equal((await s3.offerAnchored({ ...d, anchor: chain.anchor(d, A) })).kept, true);
  assert.equal((await s3.offerAnchored({ ...d, anchor: chain.anchor(d, A + 20) })).kept, false);
  assert.equal(s3.departureFor(record, peerOf(0), NOTICE, A + NOTICE).ok, true);
  // the producer's notice past the gate carries the slack
  const own = ownDeparture({ own: { federation: toHex(FED), peerKey: peerOf(2) }, tip: T, departureNotice: NOTICE, nodePubkey: keys[2].pub, sign: (m) => schnorr.sign(m, keys[2].secret), slack: DEPARTURE_ANCHOR_SLACK });
  assert.equal(own.leaveAfterHeight, T + NOTICE + DEPARTURE_ANCHOR_SLACK);
});

test('#2608 a notice without an anchor does not count after the gate', async () => {
  const T = GATE + 10;
  const d = notice({ postedAt: T, leaveAfter: T + NOTICE });
  const chain = chainWith();
  const seat = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  assert.equal(seat.offerDeparture(d).kept, true, 'kept - it may be anchored later');
  const due = seat.departureFor(record, peerOf(0), NOTICE, T + NOTICE + 1000);
  assert.equal(due.ok, false);
  assert.match(due.why, /no "ARN" 'L' anchor/);
  // an anchor reference to a transaction that carries another notice's anchor, or one this seat's chain does not hold, gives no height
  const another = notice({ postedAt: T, leaveAfter: T + NOTICE + 1 });
  const wrong = chain.anchor(another, T);
  assert.equal((await seat.anchorDeparture({ ...d, anchor: wrong })).anchor.height, undefined);
  assert.equal((await seat.anchorDeparture({ ...d, anchor: { txid: wrong.txid, blockHash: 'ab'.repeat(32) } })).anchor.height, undefined, 'a block off this seat\'s chain');
  assert.equal(departureAnchorOf({ raw: rawTx([departureAnchorScript(another)]), height: T, notice: d }).ok, false);
  // handed along by a gatherer: the hex carries only where to look, never a height
  const handed = readDepartureHex(departureHex({ ...d, anchor: { ...chain.anchor(d, T + 1), height: 1 } }));
  assert.equal(handed.anchor.height, undefined, 'a height is never read off the wire');
  assert.equal(dueDeparture([handed], { record, peerKey: peerOf(0), departureNotice: NOTICE, height: T + 5000, verify, gate: GATE }).ok, false);
  // the founding's trigger: past the gate an unanchored notice triggers nothing; an anchored one triggers at its anchor's height
  const held = [{ federation: toHex(FED), status: 'OPEN', record }];
  assert.equal(noticeTriggers({ held, notices: [d], departureNotice: NOTICE, verify, gate: GATE, tip: T + 5 }).length, 0);
  const anchored = await seat.anchorDeparture({ ...notice({ postedAt: T - 400, leaveAfter: T + 2 + NOTICE }), anchor: undefined });
  const ref = chain.anchor(anchored, T + 2);
  const rows = noticeTriggers({ held, notices: [await seat.anchorDeparture({ ...anchored, anchor: ref })], departureNotice: NOTICE, verify, gate: GATE, tip: T + 5 });
  assert.deepEqual(rows.map((r) => r.height), [T + 2], 'the anchor\'s height, not posted_at T - 400');
});

test('#2608 an offline seat that pulls the bytes later still accepts the notice: no freshness window', async () => {
  const A = GATE + 7;
  const chain = chainWith();
  const d = notice({ postedAt: A - 1, leaveAfter: A + NOTICE });
  const ref = chain.anchor(d, A);
  const online = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  await online.offerAnchored({ ...d, anchor: ref });
  const wire = online.listDepartures()[0];
  assert.equal(wire.length, (108 + 64 + 64) * 2, 'the notice, its signature, and its anchor\'s txid and block hash');
  // the seat was down the whole time; it comes back 5 000 blocks later and pulls the hex from a peer
  let file = null;
  const store = { read: () => (file ? JSON.parse(file) : null), write: (v) => { file = JSON.stringify(v); } };
  const back = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE, store });
  assert.equal((await back.offerAnchored(readDepartureHex(wire))).kept, true);
  const due = back.departureFor(record, peerOf(0), NOTICE, A + 5000);
  assert.deepEqual([due.ok, due.sinceHeight], [true, A + NOTICE], 'DEPARTED, read from the chain');
  // and after its own restart, from its file, with no chain read at all
  const again = createAbsences({ verify, confirmedTx: async () => null, anchorGate: GATE, store });
  assert.equal(again.departureFor(record, peerOf(0), NOTICE, A + 5000).ok, true, 'the anchor height kept beside the notice');
  // a file whose anchor height was altered against another reference is not trusted
  const v = JSON.parse(file); const id = Object.keys(v.departureAnchors)[0]; v.departureAnchors[id] = { ...v.departureAnchors[id], txid: '00'.repeat(32) }; file = JSON.stringify(v);
  assert.equal(createAbsences({ verify, confirmedTx: async () => null, anchorGate: GATE, store }).departureFor(record, peerOf(0), NOTICE, A + 5000).ok, false);
});

test('#2608 before the gate the old rule holds: posted_at as written, no anchor needed', async () => {
  const T = GATE - 600;
  const d = notice({ postedAt: T, leaveAfter: T + NOTICE });
  const seat = createAbsences({ verify, anchorGate: GATE });
  seat.offerDeparture(d);
  const due = seat.departureFor(record, peerOf(0), NOTICE, T + NOTICE);
  assert.deepEqual([due.ok, due.sinceHeight], [true, T + NOTICE], 'judged below the gate: DEPARTED on posted_at');
  // the residual the ruling leaves standing below the gate: a backdated notice still stands there
  const back = notice({ postedAt: T - NOTICE, leaveAfter: T, i: 1 });
  seat.offerDeparture(back);
  assert.equal(seat.departureFor(record, peerOf(1), NOTICE, T).ok, true);
  // the same notices judged at the gate: no anchor, no notice
  assert.equal(seat.departureFor(record, peerOf(0), NOTICE, GATE).ok, false);
  // no gate given (a seat with no chain named): the old rule at any height, byte for byte the old wire form
  const old = createAbsences({ verify });
  old.offerDeparture(d);
  assert.equal(old.departureFor(record, peerOf(0), NOTICE, GATE + 10000).ok, true);
  assert.equal(old.listDepartures()[0].length, (108 + 64) * 2);
  assert.deepEqual(readDepartureHex(departureHex(d)), d);
  // and the founding trigger below the gate: posted_at
  const held = [{ federation: toHex(FED), status: 'OPEN', record }];
  assert.deepEqual(noticeTriggers({ held, notices: [d], departureNotice: NOTICE, verify, gate: GATE, tip: T + 1 }).map((r) => r.height), [T]);
});
