// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ADVERTISEMENT UPDATE, NOT A NEW BOND - advert-update.js on its own (fifth surface; plan comment 183,
// accepted 2026-10-05). Until now it ran only inside arena-node's advert-update test (43.8% of its lines from protocol's own
// suite). Here: the payload pinned, every refusal the file gives by its exact words, one update accepted field by field,
// proved into a block, and the census's newest-update rule (height, then position) over a chain view.
// Fixtures are protocol's own tools/bond.js. Signatures are real BIP-340 from the noble library the nodes load - the only
// cross-package import - injected as `verify`, as the file requires.
//
// Measured before this file, on advert-update.js as it stood: checkAgainstBond with no bond threw "Cannot read properties
// of undefined (reading 'txid')", and acceptAdvertUpdate with no bond reached the same line; newestUpdates with no list of
// bonds called .map on undefined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import {
  advertUpdatePayload, readAdvertUpdatePayload, readAdvertUpdate, acceptAdvertUpdate, checkAgainstBond, newestUpdates,
  ADVERT_UPDATE_BYTES, ADVERT_UPDATE_MAGIC,
} from '../src/advert-update.js';
import { advertId } from '../src/advert.js';
import { parseTransaction, hash256 } from '../src/tx.js';
import { advertUpdateTransaction, bondTransaction, blockOf } from '../tools/bond.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const SECRET = b32(0x41), OTHER = b32(0x42);
const NODE = schnorr.getPublicKey(SECRET), OTHER_NODE = schnorr.getPublicKey(OTHER);
const FED = b32(0x33);
const key = (n) => Uint8Array.from([0x02, ...b32(n)]);
const advert = (guardianKey, timestamp = 1790000000000n, nodePubkey = NODE) => ({
  nodePubkey, operatorId: '2of2', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify', 'settlement'],
  endpoint: 'wss://node-1.example/', region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0,
  bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [{ federationId: FED, guardianKey }],
  guardianCapable: true, guardianEndpoint: 'wss://node-1.example/guardian', timestamp,
});
const signed = (a, secret = SECRET) => schnorr.sign(advertId(a), secret);
const BOND_ADVERT = advert(Uint8Array.from([0x03, ...b32(0x4d)]), 1788700000000n);
const BOND_TX = bondTransaction(BOND_ADVERT, { value: 50000, signature: signed(BOND_ADVERT) });
const BOND_TXID = parseTransaction(BOND_TX).txid;
const BOND = { txid: BOND_TXID, vout: 0, nodePubkey: NODE };
const NEW = advert(key(0x7a));
const update = (a, { secret = SECRET, bondTxid = BOND_TXID, bondVout = 0, previousTxid = b32(0xac), network = 'regtest' } = {}) =>
  advertUpdateTransaction(a, { bondTxid, bondVout, signature: signed(a, secret), previousTxid, network });
const opReturn = (payload) => Uint8Array.from([0x6a, payload.length, ...payload]);   // 72 bytes: one direct push
const outKey = (txid, vout = 0) => `${Array.from(txid).join(',')}:${vout}`;

// THE FIRST CHECK (plan 183): a missing bond is refused by name, never thrown.
test('checkAgainstBond with no bond refuses by name; it does not throw', async () => {
  const read = readAdvertUpdate(update(NEW));
  assert.equal(read.ok, true, read.why);
  const got = await checkAgainstBond(read, undefined, verify);
  assert.equal(got.ok, false);
  assert.match(got.why, /bond/);
  for (const bad of [{}, { txid: BOND_TXID }, { txid: BOND_TXID, vout: 0 }, { ...BOND, txid: b32(1).subarray(0, 31) }, { ...BOND, vout: -1 }])
    assert.equal((await checkAgainstBond(read, bad, verify)).ok, false, `a malformed bond ${JSON.stringify(Object.keys(bad))} was taken`);
});

test('acceptAdvertUpdate with no bond refuses by name; it does not throw', async () => {
  const got = await acceptAdvertUpdate({ transaction: update(NEW), network: 'regtest', bond: undefined, verify });
  assert.equal(got.ok, false);
  assert.match(got.why, /bond/);
});

test('newestUpdates with no list of bonds answers an empty result; it does not throw', () => {
  const view = { firstHeight: 100, blocks: [{ transactions: [BOND_TX] }, { transactions: [update(NEW)] }] };
  const got = newestUpdates(view, undefined, { atHeight: 101, verify });
  assert.ok(got instanceof Map);
  assert.equal(got.size, 0);
});

test('the payload: 72 bytes, "ARN" A, the bond outpoint and the advertisement id, pinned and read back', () => {
  const p = advertUpdatePayload({ bondTxid: b32(9), bondVout: 3, advertIdBytes: b32(8) });
  assert.equal(p.length, ADVERT_UPDATE_BYTES);
  assert.equal(hex(p), '41524e41' + '09'.repeat(32) + '03000000' + '08'.repeat(32));
  assert.equal(hex(ADVERT_UPDATE_MAGIC), '41524e41');
  const r = readAdvertUpdatePayload(p);
  assert.deepEqual([hex(r.bondTxid), r.bondVout, hex(r.advertId)], ['09'.repeat(32), 3, '08'.repeat(32)]);
  const big = advertUpdatePayload({ bondTxid: b32(9), bondVout: 0xfffffffe, advertIdBytes: b32(8) });
  assert.equal(readAdvertUpdatePayload(big).bondVout, 0xfffffffe);
});

test('building the payload refuses by name: a bond txid not 32 bytes, a bad output index, an advertisement id not 32 bytes', () => {
  const ok = { bondTxid: b32(9), bondVout: 3, advertIdBytes: b32(8) };
  for (const bondTxid of [b32(9).subarray(0, 31), undefined, 'x'])
    assert.throws(() => advertUpdatePayload({ ...ok, bondTxid }), { name: 'TypeError', message: 'an update names a 32-byte bond txid' });
  for (const bondVout of [-1, 1.5, undefined, '3'])
    assert.throws(() => advertUpdatePayload({ ...ok, bondVout }), { name: 'TypeError', message: 'an update names the bond output index' });
  for (const advertIdBytes of [b32(8).subarray(0, 31), undefined])
    assert.throws(() => advertUpdatePayload({ ...ok, advertIdBytes }), { name: 'TypeError', message: 'an update commits to a 32-byte advertisement id' });
});

test('reading the payload: null for non-bytes, a wrong length and a wrong magic', () => {
  const p = advertUpdatePayload({ bondTxid: b32(9), bondVout: 3, advertIdBytes: b32(8) });
  assert.equal(readAdvertUpdatePayload(undefined), null);
  assert.equal(readAdvertUpdatePayload([...p]), null, 'an array is not bytes');
  assert.equal(readAdvertUpdatePayload(p.subarray(0, 71)), null);
  assert.equal(readAdvertUpdatePayload(Uint8Array.from([...p, 0])), null);
  const wrong = Uint8Array.from(p); wrong[3] = 0x52;                                     // "BLWR": a round's kind byte
  assert.equal(readAdvertUpdatePayload(wrong), null);
});

test('reading an update transaction refuses by name: not a transaction, no update, two updates, no marker, the witness lacks the advertisement', () => {
  const r = (tx, o) => readAdvertUpdate(tx, o);
  const notTx = r(Uint8Array.from([1, 2, 3]));
  assert.equal(notTx.ok, false);
  assert.match(notTx.why, /^that is not a transaction: /);
  assert.deepEqual(r(BOND_TX), { ok: false, why: 'that transaction carries no advertisement update' });
  const tx = parseTransaction(update(NEW));
  const payload = advertUpdatePayload({ bondTxid: BOND_TXID, bondVout: 0, advertIdBytes: advertId(NEW) });
  assert.deepEqual(r({ ...tx, outputs: [...tx.outputs, { value: 0n, script: opReturn(payload) }] }),
    { ok: false, why: 'that transaction names more than one update' });
  assert.deepEqual(r(update(NEW, { network: 'testnet' })), { ok: false, why: 'an update pays the bond marker, and that transaction does not' });
  // the OP_RETURN names advertisement B while the witness carries A
  const otherId = advertUpdatePayload({ bondTxid: BOND_TXID, bondVout: 0, advertIdBytes: advertId(advert(key(0x11))) });
  const swapped = { ...tx, outputs: tx.outputs.map((o) => (o.script[0] === 0x6a ? { ...o, script: opReturn(otherId) } : o)) };
  assert.deepEqual(r(swapped), { ok: false, why: 'the update commits to an advertisement its witness does not carry' });
  // and the parsed form reads the same as the raw bytes
  assert.equal(hex(r(tx).txid), hex(r(update(NEW)).txid));
});

test('one update accepted: proved into a block, signed by the bond\'s key, every field checked', async () => {
  const raw = update(NEW);
  const txid = parseTransaction(raw).txid;
  const sibling = b32(0x99);
  const { header } = blockOf(hash256, [txid, sibling]);
  const got = await acceptAdvertUpdate({ transaction: raw, header, branch: [sibling], position: 0, network: 'regtest', bond: BOND, verify });
  assert.equal(got.ok, true, got.why);
  assert.equal(hex(got.txid), hex(txid));
  assert.equal(hex(got.bondTxid), hex(BOND_TXID));
  assert.equal(got.bondVout, 0);
  assert.equal(hex(got.advertId), hex(advertId(NEW)));
  assert.deepEqual(got.advert.guardianOf[0].guardianKey, key(0x7a));
  assert.equal(hex(got.nodePubkey), hex(NODE));
  assert.ok(verify(got.signature, got.advertId, NODE));
  // with no header, no proof is asked
  assert.equal((await acceptAdvertUpdate({ transaction: raw, network: 'regtest', bond: BOND, verify })).ok, true);
  // a read refusal comes straight back
  assert.deepEqual(await acceptAdvertUpdate({ transaction: BOND_TX, network: 'regtest', bond: BOND, verify }),
    { ok: false, why: 'that transaction carries no advertisement update' });
});

test('accepting an update that is not in the given block is refused by name', async () => {
  const { header } = blockOf(hash256, [b32(0x55), b32(0x99)]);
  assert.deepEqual(await acceptAdvertUpdate({ transaction: update(NEW), header, branch: [b32(0x99)], position: 0, network: 'regtest', bond: BOND, verify }),
    { ok: false, why: 'the update is not in that block' });
});

test('checkAgainstBond refuses by name: another txid or output, a node key not the bond\'s, no signature check, a signature not by the bond\'s key', async () => {
  const read = readAdvertUpdate(update(NEW));
  assert.deepEqual(await checkAgainstBond(read, { ...BOND, txid: b32(0x12) }, verify), { ok: false, why: 'the update names another bond' });
  assert.deepEqual(await checkAgainstBond(read, { ...BOND, vout: 1 }, verify), { ok: false, why: 'the update names another bond' });
  const foreign = readAdvertUpdate(update(advert(key(0x7a), 1790000000000n, OTHER_NODE), { secret: OTHER }));
  assert.deepEqual(await checkAgainstBond(foreign, BOND, verify),
    { ok: false, why: 'an update whose node key is not the bond\'s is not an update of that bond' });
  assert.deepEqual(await checkAgainstBond(read, BOND, undefined), { ok: false, why: 'no signature check was given, so no update is applied' });
  const byOther = readAdvertUpdate(update(NEW, { secret: OTHER }));
  assert.deepEqual(await checkAgainstBond(byOther, BOND, verify), { ok: false, why: 'the update is not signed by the bond\'s node key' });
  assert.equal((await checkAgainstBond(read, BOND, async (...a) => verify(...a))).ok, true, 'an async check is awaited');
});

// THE CENSUS: for each bond, the newest valid update at or below the census height - by height, then by position.
const A1 = advert(key(0x11), 1790000000000n), A2 = advert(key(0x12), 1790000001000n), A3 = advert(key(0x13), 1790000002000n);
const A4 = advert(key(0x14), 1790000003000n), A5 = advert(key(0x15), 1790000004000n);
const ENTRY = { txid: BOND_TXID, vout: 0, pubkey: NODE, height: 100 };
const VIEW = { firstHeight: 100, blocks: [
  { transactions: [BOND_TX] },                                                                       // 100: the bond
  { transactions: [update(A1, { previousTxid: b32(1) })] },                                          // 101
  { transactions: [update(A2, { previousTxid: b32(2) }), update(A3, { previousTxid: b32(3) })] },    // 102: two, A3 later
  { transactions: [update(A4, { previousTxid: b32(4) })] },                                          // 103: above the census
] };
const newest = (o = {}, entries = [ENTRY], view = VIEW) => newestUpdates(view, entries, { atHeight: 102, verify, ...o }).get(outKey(BOND_TXID));

test('newestUpdates: the newest valid update wins by height, then by position in the block', () => {
  const got = newest();
  assert.deepEqual({ height: got.height, position: got.position, key: got.advert.guardianOf[0].guardianKey }, { height: 102, position: 1, key: key(0x13) });
  assert.equal(hex(got.advertId), hex(advertId(A3)));
  assert.equal(hex(got.raw), hex(VIEW.blocks[2].transactions[1]));
  // a census one block earlier takes A1; the order inside block 102 decides between A2 and A3 regardless of timestamps
  assert.equal(newest({ atHeight: 101 }).advert.guardianOf[0].guardianKey[1], 0x11);
  const flipped = { ...VIEW, blocks: VIEW.blocks.map((b, i) => (i === 2 ? { transactions: [...b.transactions].reverse() } : b)) };
  assert.equal(newest({}, [ENTRY], flipped).advert.guardianOf[0].guardianKey[1], 0x12);
});

test('newestUpdates does not apply: no signature check or no blocks, above the census or below the bond, another bond or key, a bad or throwing signature, an unparsable entry', () => {
  assert.equal(newestUpdates(VIEW, [ENTRY], { atHeight: 102 }).size, 0, 'no signature check');
  assert.equal(newestUpdates(undefined, [ENTRY], { atHeight: 102, verify }).size, 0, 'no view');
  assert.equal(newestUpdates({ firstHeight: 100 }, [ENTRY], { atHeight: 102, verify }).size, 0, 'no blocks');
  assert.equal(newest({ atHeight: 100 }), undefined, 'an update above the census height was applied');
  assert.equal(newest({}, [{ ...ENTRY, height: 103 }]), undefined, 'an update below the bond\'s own height was applied');
  assert.equal(newest({}, [{ ...ENTRY, vout: 1 }]), undefined);
  assert.equal(newestUpdates(VIEW, [{ ...ENTRY, vout: 1 }], { atHeight: 102, verify }).size, 0, 'an update of another bond was applied');
  assert.equal(newest({}, [{ ...ENTRY, pubkey: OTHER_NODE }]), undefined, 'an update by another key was applied');
  const tail = (txs) => ({ ...VIEW, blocks: [...VIEW.blocks.slice(0, 2), { transactions: txs }] });
  const forged = tail([update(A5, { secret: OTHER, previousTxid: b32(5) })]);
  assert.equal(newest({}, [ENTRY], forged).height, 101, 'a forged update was applied');
  assert.equal(newest({ verify: (s, m, k) => { if (hex(m) === hex(advertId(A1))) throw new Error('bad'); return verify(s, m, k); } }, [ENTRY],
    { ...VIEW, blocks: VIEW.blocks.slice(0, 2) }), undefined, 'an update whose check threw was applied');
  assert.equal(newest({}, [ENTRY], tail([Uint8Array.from([1, 2, 3]), BOND_TX, update(NEW, { network: 'testnet' })])).height, 101,
    'an unparsable entry, a non-update or a marker-less update changed the answer');
});
