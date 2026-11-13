// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2612 (feedback #041, owner decision on option (c)): #2608 anchored only H(notice), so a guardian could anchor in secret at A with
// leave_after A + 432, keep serving, and show the notice at A + 432 - every seat took it as due at once and the federation never had the
// period to found a replacement. Now the anchor carries the whole signed notice (OP_RETURN "ARN" 'L' || notice || signature, 176 bytes),
// every seat reads it off its own chain at the anchor's block (absences.js scanDepartures), and a hash-only anchor anchors nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  signDeparture, departureId, departureAnchorScript, encodeDepartureAnchor, decodeDepartureAnchor, departuresInBlock, departureAnchorOf,
  DEPARTURE_ANCHOR_HEIGHT, DEPARTURE_ANCHOR_BYTES, DEPARTURE_ANCHOR_SLACK,
} from '../../arena-protocol/src/absence.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { createAbsences, departureHex, readDepartureHex, SCAN_LOOKBACK } from '../src/absences.js';
import { noticeTriggers } from '../src/founding-seat.js';
import { ownDeparture } from '../src/absence-producer.js';
import { createDepartureAnchors } from '../src/departure-anchor.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x2c);
const keys = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 71); return { secret, pub: schnorr.getPublicKey(secret) }; });
const peerOf = (i) => Uint8Array.from([2, ...new Uint8Array(32).fill(0x90 + i)]);
const record = { federationId: FED, nominal: 4, threshold: 3, guardians: keys.map((k, i) => ({ peerKey: peerOf(i), nodePubkey: k.pub })) };
const held = [{ federation: toHex(FED), status: 'OPEN', record }];
const NOTICE = 432;
const GATE = DEPARTURE_ANCHOR_HEIGHT.testnet4;
const notice = ({ postedAt, leaveAfter, i = 0 }) => signDeparture({ federationId: FED, peerKey: peerOf(i), leaveAfterHeight: leaveAfter, postedAt, nodePubkey: keys[i].pub },
  (m) => schnorr.sign(m, keys[i].secret));

const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
let coin = 0;
function rawTx(scripts) {
  const prev = new Array(32).fill(0); prev[0] = ++coin & 255; prev[1] = (coin >> 8) & 255;
  const b = [...u32le(2), 1, ...prev, ...u32le(0), 0, ...u32le(0xffffffff), scripts.length];
  for (const s of scripts) b.push(...new Array(8).fill(0), s.length, ...s);
  b.push(...u32le(0));
  return Uint8Array.from(b);
}
const txidOf = (raw) => toHex(Uint8Array.from(parseTransaction(raw).txid).reverse());
const hashOnlyScript = (d) => Uint8Array.from([0x6a, 36, 0x41, 0x52, 0x4e, 0x4c, ...departureId(d)]);   // the #2608 form

// A SEAT'S CHAIN: blocks by height (each a coinbase and the transactions put in it), served as main.js serves them from bitcoind
function chainOf(base) {
  const blocks = new Map();      // height -> { hash, txs: [raw] }
  let tip = base;
  const ensure = (h) => { if (!blocks.has(h)) blocks.set(h, { hash: toHex(Uint8Array.from([...u32le(h), ...new Array(28).fill(0xbb)])), txs: [rawTx([Uint8Array.from([0x51])])] }); return blocks.get(h); };
  return {
    put(raw, h) { ensure(h).txs.push(raw); if (h > tip) tip = h; return { txid: txidOf(raw), blockHash: ensure(h).hash }; },
    mineTo(h) { for (let x = tip + 1; x <= h; x++) ensure(x); tip = Math.max(tip, h); },
    get tip() { return tip; },
    rawBlock(h) { const b = ensure(h); const parts = [new Uint8Array(80), Uint8Array.from([b.txs.length]), ...b.txs]; const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; },
    scanner() {
      return { tipHeight: async () => tip, blockHashAt: async (h) => (h <= tip ? ensure(h).hash : null),
        departuresAt: async (h, hash) => { assert.equal(hash, ensure(h).hash); return departuresInBlock(this.rawBlock(h), h); } };
    },
    confirmedTx: async (txid, blockHash) => { for (const [h, b] of blocks) if (b.hash === blockHash) { const t = b.txs.find((r) => txidOf(r) === txid); return t ? { raw: t, height: h } : null; } return null; },
  };
}

// passes of the seat's chain read (64 blocks each, as server.js runs one a minute) until it is at the tip; the found and taken summed
async function scanAll(seat, chain) {
  const sum = { found: 0, took: 0, passes: 0 };
  for (;;) { const r = await seat.scanDepartures(chain.scanner()); sum.passes++; sum.found += r.found; sum.took += r.took; if (r.to === null || r.to >= chain.tip) return sum; }
}

test('#2612 the anchor is the notice: OP_RETURN, OP_PUSHDATA1 176 bytes - "ARN" \'L\', the 108-byte notice, its 64-byte signature', () => {
  const d = notice({ postedAt: GATE, leaveAfter: GATE + NOTICE + DEPARTURE_ANCHOR_SLACK });
  const s = departureAnchorScript(d);
  assert.equal(DEPARTURE_ANCHOR_BYTES, 176);
  assert.equal(s.length, 179);
  assert.equal(toHex(s), `6a4cb041524e4c${departureHex(d)}`);
  const back = decodeDepartureAnchor(encodeDepartureAnchor(d));
  assert.deepEqual(back, { ...d });
  assert.throws(() => encodeDepartureAnchor({ ...d, signature: undefined }), /signature/);
  // the #2608 hash-only payload is no notice
  assert.equal(decodeDepartureAnchor(hashOnlyScript(d).subarray(2)), null);
});

test('#2612 feedback #041: a guardian anchors at A and shows nothing - every seat reads the notice off its chain at A, the founding triggers at A', async () => {
  const A = GATE + 200;
  const chain = chainOf(A - 5);
  const d = notice({ postedAt: A - 1, leaveAfter: A + NOTICE });
  // THE ATTACK: the anchor confirmed at A, no POST /departure, no peer serves it; the guardian keeps serving
  chain.put(rawTx([departureAnchorScript(d)]), A);
  chain.mineTo(A + 1);
  const seat = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  assert.equal(seat.listDepartures().length, 0, 'nothing posted to the seat');
  const r = await scanAll(seat, chain);
  assert.deepEqual([r.found, r.took], [1, 1], 'the seat read it in block A');
  // THE FEDERATION SEES IT FROM A: the founding of the replacement triggers at A, with the whole notice period before it is due
  // (server.js hands the founding seat absences.departureNotices(): the notices with the anchor heights this seat read)
  const rows = noticeTriggers({ held, notices: seat.departureNotices(), departureNotice: NOTICE, verify, gate: GATE, tip: A + 1 });
  assert.deepEqual(rows.map((x) => x.height), [A]);
  // the same through the seat's own record of it (the anchor height it read, kept beside the notice)
  assert.equal(seat.departureFor(record, peerOf(0), NOTICE, A + NOTICE - 1).ok, false, 'not due before A + 432');
  assert.deepEqual([seat.departureFor(record, peerOf(0), NOTICE, A + NOTICE).ok, seat.departureFor(record, peerOf(0), NOTICE, A + NOTICE).sinceHeight], [true, A + NOTICE]);
  // REVEALED AT A + 432 by POST: nothing changes - the seat has held it since A
  const [kept] = seat.departureNotices();
  const late = await seat.offerAnchored(readDepartureHex(departureHex({ ...d, anchor: { txid: kept.anchor.txid, blockHash: kept.anchor.blockHash } })));
  assert.equal(late.kept, false);
  assert.equal(seat.departureNotices()[0].anchor.height, A);
  // the hex round trip alone carries no height: the founding reads the held objects, never the wire form
  assert.equal(noticeTriggers({ held, notices: seat.listDepartures().map(readDepartureHex), departureNotice: NOTICE, verify, gate: GATE, tip: A + 1 }).length, 0);
});

test('#2612 a hash-only (#2608 form) or secret anchor does not count: no height from it, nothing read off the chain, not due', async () => {
  const A = GATE + 300;
  const chain = chainOf(A - 1);
  const d = notice({ postedAt: A - 1, leaveAfter: A + NOTICE });
  const ref = chain.put(rawTx([hashOnlyScript(d)]), A);
  chain.mineTo(A + NOTICE + 10);
  const seat = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  const r = await seat.scanDepartures(chain.scanner(), { max: 1000 });
  assert.deepEqual([r.found, r.took], [0, 0], 'a hash on chain is no notice on chain');
  // revealed at A + 432 naming that hash-only transaction: no anchor height, not due - the guardian who stops serving is ABANDONED
  const shown = await seat.anchorDeparture({ ...d, anchor: ref });
  assert.equal(shown.anchor.height, undefined);
  assert.match(departureAnchorOf({ raw: (await chain.confirmedTx(ref.txid, ref.blockHash)).raw, height: A, notice: d }).why, /does not carry this notice/);
  await seat.offerAnchored({ ...d, anchor: ref });
  const due = seat.departureFor(record, peerOf(0), NOTICE, A + NOTICE + 5);
  assert.equal(due.ok, false); assert.match(due.why, /no "ARN" 'L' anchor/);
  assert.equal(noticeTriggers({ held, notices: [shown], departureNotice: NOTICE, verify, gate: GATE, tip: A + NOTICE + 5 }).length, 0);
  // the notice's bytes on chain under a signature that is not the leaver's: read, refused
  const forged = { ...d, signature: schnorr.sign(departureId(d), keys[1].secret) };
  chain.put(rawTx([departureAnchorScript(forged)]), A + NOTICE + 11);
  const r2 = await seat.scanDepartures(chain.scanner(), { max: 1000 });
  assert.deepEqual([r2.found, r2.took], [1, 0]);
  // a valid POSTed copy naming that forged anchor takes the chain's signature - and is refused
  const fblock = A + NOTICE + 11;
  const fhash = await chain.scanner().blockHashAt(fblock);
  const ftx = departuresInBlock(chain.rawBlock(fblock), fblock)[0].txid;
  const s3 = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  assert.equal((await s3.offerAnchored({ ...d, anchor: { txid: ftx, blockHash: fhash } })).ok, false);
});

test('#2612 a notice read from its anchor transaction counts from that block\'s height; the POSTed copy takes the chain\'s bytes', async () => {
  const A = GATE + 400;
  const chain = chainOf(A - 1);
  const d = notice({ postedAt: A - 300, leaveAfter: A + NOTICE + 1, i: 1 });     // posted_at dated back: the chain's height counts
  const raw = rawTx([Uint8Array.from([0x00, 0x14, ...new Array(20).fill(3)]), departureAnchorScript(d)]);
  const ref = chain.put(raw, A);
  chain.mineTo(A + 2);
  // in the raw block, read as main.js reads it (getblock verbosity 0)
  const inBlock = departuresInBlock(chain.rawBlock(A), A);
  assert.equal(inBlock.length, 1);
  assert.deepEqual([inBlock[0].txid, inBlock[0].height, toHex(departureId(inBlock[0].notice))], [ref.txid, A, toHex(departureId(d))]);
  const seat = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  await scanAll(seat, chain);
  const kept = readDepartureHex(seat.listDepartures()[0]);
  assert.deepEqual(kept.anchor, { txid: ref.txid, blockHash: ref.blockHash });
  assert.equal(seat.departureFor(record, peerOf(1), NOTICE, A + NOTICE).ok, false, 'A + 432 is one short of leave_after');
  const due = seat.departureFor(record, peerOf(1), NOTICE, A + NOTICE + 1);
  assert.deepEqual([due.ok, due.sinceHeight], [true, A + NOTICE + 1]);
  // a copy POSTed with another valid signature of the same notice: the seat reads the anchor and keeps the chain's signature
  const other = signDeparture({ ...d, signature: undefined }, (m) => schnorr.sign(m, keys[1].secret, new Uint8Array(32).fill(9)));
  assert.notEqual(toHex(other.signature), toHex(d.signature));
  const read = await seat.anchorDeparture({ ...other, anchor: ref });
  assert.deepEqual([read.anchor.height, toHex(read.signature)], [A, toHex(d.signature)]);
  // judged at a height before the anchor: it does not count there
  const s2 = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  await s2.offerAnchored({ ...d, anchor: ref });
  assert.equal(noticeTriggers({ held, notices: s2.departureNotices(), departureNotice: NOTICE, verify, gate: GATE, tip: A - 1 }).length, 0);
  assert.deepEqual(noticeTriggers({ held, notices: s2.departureNotices(), departureNotice: NOTICE, verify, gate: GATE, tip: A }).map((x) => x.height), [A]);
});

test('#2612 the chain read: from the gate, a week back on a first pass, the newest 6 again each pass, its height kept across a restart', async () => {
  // below the gate: nothing read
  const low = chainOf(GATE - 10);
  const s0 = createAbsences({ verify, anchorGate: GATE });
  assert.equal((await s0.scanDepartures(low.scanner())).from, null);
  assert.equal((await createAbsences({ verify }).scanDepartures(low.scanner())).from, null, 'no gate: the old rule, no chain read');
  const T = GATE + 5000;
  const chain = chainOf(T);
  let file = null;
  const store = { read: () => (file ? JSON.parse(file) : null), write: (v) => { file = JSON.stringify(v); } };
  const seat = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE, store });
  const first = await seat.scanDepartures(chain.scanner(), { max: 2000 });
  assert.deepEqual([first.from, first.to], [T - SCAN_LOOKBACK, T]);
  // a notice anchored 3 blocks below the tip after the pass (a reorg's new block): the next pass reads it
  const d = notice({ postedAt: T - 3, leaveAfter: T + NOTICE, i: 2 });
  chain.put(rawTx([departureAnchorScript(d)]), T - 2);
  const again = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE, store });
  assert.equal(again.scannedTo(), T, 'kept across a restart');
  const r = await again.scanDepartures(chain.scanner());
  assert.deepEqual([r.from, r.took], [T - 5, 1]);
  assert.equal(again.departureFor(record, peerOf(2), NOTICE, T + NOTICE).ok, true);
  // an RPC that does not answer stops the pass with nothing skipped
  chain.mineTo(T + 20);
  const flaky = { ...chain.scanner(), departuresAt: async () => { throw new Error('work queue depth exceeded'); } };
  await assert.rejects(again.scanDepartures(flaky));
  assert.equal(again.scannedTo(), T);
});

test('#2612 the poster writes the transaction the reader takes: funded, confirmed, read off the block by a seat that was never told', async () => {
  const T = GATE + 700;
  const chain = chainOf(T);
  const d = ownDeparture({ own: { federation: toHex(FED), peerKey: peerOf(3) }, tip: T, departureNotice: NOTICE, nodePubkey: keys[3].pub, sign: (m) => schnorr.sign(m, keys[3].secret), slack: DEPARTURE_ANCHOR_SLACK });
  const mempool = [];
  // a wallet that funds what it is asked to (as Core writes a `data` output: OP_RETURN OP_PUSHDATA1 above 75 bytes)
  const wallet = { name: 'test wallet',
    build: async (x) => { const p = encodeDepartureAnchor(x); const raw = rawTx([Uint8Array.from([0x6a, 0x4c, p.length, ...p]), Uint8Array.from([0x00, 0x14, ...new Array(20).fill(4)])]); return { ok: true, hex: toHex(raw), feeSats: '400' }; },
    send: async (hex) => { mempool.push(hex); return txidOf(fromHex(hex)); } };
  const published = [];
  const blockAt = async (h) => (h <= chain.tip ? { hash: (await chain.scanner().blockHashAt(h)), txids: departuresInBlock(chain.rawBlock(h), h).map((x) => x.txid) } : null);
  const anchors = createDepartureAnchors({ wallet, chain: { tip: async () => chain.tip, blockAt }, confirmedTx: chain.confirmedTx,
    publish: async (x) => { published.push(x); return { postedTo: 1, of: 1 }; } });
  const sent = await anchors.anchor(d);
  assert.equal(sent.phase, 'sent');
  assert.equal(anchors.planOf(d).payload, toHex(encodeDepartureAnchor(d)));
  const A = T + 1;
  const ref = chain.put(fromHex(mempool[0]), A);
  const [p] = await anchors.pass();
  assert.deepEqual([p.phase, p.height, p.txid], ['published', A, ref.txid]);
  // a seat that got no POST at all: it reads the same transaction off its chain
  const seat = createAbsences({ verify, confirmedTx: chain.confirmedTx, anchorGate: GATE });
  assert.equal((await scanAll(seat, chain)).took, 1);
  assert.equal(seat.departureFor(record, peerOf(3), NOTICE, d.leaveAfterHeight).ok, true);
  assert.equal(seat.departureFor(record, peerOf(3), NOTICE, d.leaveAfterHeight - 1).ok, false);
  // and the published copy is the same notice, with its anchor, taken as already held
  assert.equal((await seat.offerAnchored(published[0])).kept, false);
});
