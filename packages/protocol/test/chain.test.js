// READING BITCOIN WITHOUT TRUSTING WHOEVER HANDED IT OVER.
//
// Real mainnet data, fetched once and written down here, so the test needs no
// network and no API: block 100000, its 80-byte header, and the merkle proof
// for the second transaction in it. If these primitives are wrong, a client
// takes an endpoint on a provider's word - and section 25.1 says why that is
// the failure with no symptom: such a client "behaves exactly like one that
// verifies - same screens, same rounds, same results - right up until the API
// returns a census that suits whoever runs it".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEADER_BYTES, hash256, merkleRootOf, previousHashOf, blockHashOf, workOf,
  chainWork, mostWork, merkleRootFromProof, provesTransaction, acceptAdvert,
} from '../src/chain.js';
import { encodeAdvert, decodeAdvert, advertId } from '../src/advert.js';
import { fromHex, toHex } from '../src/hash.js';

/** A txid as an API prints it is REVERSED from the way it is hashed. */
const txidBytes = (displayHex) => fromHex(displayHex).reverse();

// mainnet block 100000, from mempool.space, 2026-09-07
const HEADER_100000 = fromHex(
  '0100000050120119172a610421a6c3011dd330d9df07b63616c2cc1f1cd0020000000000'
  + '6657a9252aacd5c0b2940996ecff952228c3067cc38d4885efb5a4ac4247e9f337221b'
  + '4d4c86041b0f2b5710');
const TX_AT_1 = 'fff2525b8931402dd09222c50775608f75787bd2b87e56995a7bdd30f79702c4';
const BRANCH_FOR_1 = [
  '8c14f0db3df150123e6f3dbbf30f8b955a8249b62ac1d1ff16284aefa3d06d87',
  '8e30899078ca1813be036a073bbf80b86cdddde1c96e9e9c99e9e3782df4ae49',
].map(txidBytes);

test('a header is eighty bytes and nothing else is', () => {
  assert.equal(HEADER_100000.length, HEADER_BYTES);
  assert.throws(() => merkleRootOf(HEADER_100000.slice(0, 79)), /80 bytes/);
  assert.throws(() => merkleRootOf('not bytes'), /80 bytes/);
});

test('block 100000 hashes to the id everybody knows it by', () => {
  // The block id is displayed reversed from the way it is hashed, like a txid.
  assert.equal(toHex(blockHashOf(HEADER_100000).reverse()),
    '000000000003ba27aa200b1cecaad478d2b00432346c3f1f3986da1afd33e506');
  assert.equal(toHex(previousHashOf(HEADER_100000).reverse()),
    '000000000002d01c1fccc21636b607dfd930d31d01c3a62104612a1719011250');
});

test('a genuine transaction is proven to be in that block', () => {
  assert.ok(provesTransaction(HEADER_100000, txidBytes(TX_AT_1), BRANCH_FOR_1, 1),
    'the real proof for a real transaction did not verify');
  assert.deepEqual(merkleRootFromProof(txidBytes(TX_AT_1), BRANCH_FOR_1, 1),
    merkleRootOf(HEADER_100000));
});

test('one bit flipped in the branch and it does not', () => {
  const bent = BRANCH_FOR_1.map((b) => b.slice());
  bent[0][0] ^= 0x01;
  assert.equal(provesTransaction(HEADER_100000, txidBytes(TX_AT_1), bent, 1), false,
    'a forged branch verified');

  // and the position is part of the claim, not decoration
  assert.equal(provesTransaction(HEADER_100000, txidBytes(TX_AT_1), BRANCH_FOR_1, 0), false,
    'the same branch proved the wrong position');
  assert.equal(provesTransaction(HEADER_100000, txidBytes(TX_AT_1), BRANCH_FOR_1, 3), false);

  // a different transaction with this transaction's proof
  const other = txidBytes('8c14f0db3df150123e6f3dbbf30f8b955a8249b62ac1d1ff16284aefa3d06d87');
  assert.equal(provesTransaction(HEADER_100000, other, BRANCH_FOR_1, 1), false);
});

/**
 * BYTE ORDER IS THE TRAP, so it is pinned: what an API prints is reversed from
 * what is hashed, and a caller who passes the printed form gets a refusal
 * rather than a wrong answer.
 */
test('a txid in the order an API prints it simply does not verify', () => {
  assert.equal(provesTransaction(HEADER_100000, fromHex(TX_AT_1), BRANCH_FOR_1, 1), false,
    'display order verified, which means the byte order is not being respected');
});

test('most work wins, and a chain that does not link is not a chain', () => {
  const work = workOf(HEADER_100000);
  assert.ok(work > 0n, 'a real header must be worth some work');

  const linked = chainWork([HEADER_100000]);
  assert.equal(linked.ok, true);
  assert.equal(linked.work, work);

  // the same header twice does not follow itself
  const broken = chainWork([HEADER_100000, HEADER_100000]);
  assert.equal(broken.ok, false);
  assert.match(broken.why, /does not follow the one before it/);

  // a source offering a broken chain is not in the running at all
  const best = mostWork([[HEADER_100000, HEADER_100000], [HEADER_100000]]);
  assert.equal(best.at, 1, 'the broken source was preferred');
  assert.equal(best.work, work);
  assert.equal(mostWork([[HEADER_100000, HEADER_100000]]), null,
    'with nothing but a broken chain there is no answer, not a bad one');
});

test('hash256 is the double hash Bitcoin uses everywhere', () => {
  // the empty string, twice through sha256, is a value anybody can check
  assert.equal(toHex(hash256(new Uint8Array(0))),
    '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456');
});

/* ------------------------------------------------- the advertisement itself */

const b32 = (n) => new Uint8Array(32).fill(n);
const advert = (endpoint = 'wss://node.example:443') => ({
  nodePubkey: b32(1), operatorId: 'somebody', protocolVersions: [1],
  roles: ['game', 'verify'], endpoint, region: 'eu-west', capacityClass: 2,
  softwareHash: b32(3), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: txidBytes(TX_AT_1), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(4), timestamp: 1788700000000n,
});

test('an advertisement survives the wire unchanged', () => {
  const a = advert();
  const back = decodeAdvert(encodeAdvert(a));
  assert.deepEqual(back, a);
  assert.equal(advertId(a).length, 32);
  assert.throws(() => decodeAdvert(encodeAdvert(a).slice(0, 20)));
});

/**
 * AND THE WHOLE OF STEP 4. Both halves have to hold: the transaction is really
 * in the block, and the output really commits to THIS body. A swapped endpoint
 * is the invisible one - the node is real and the bond is real, and the player
 * connects to whoever the provider preferred - so it is refused by its own name.
 */
test('an endpoint is accepted only when the chain says so', () => {
  const a = advert();
  const ok = acceptAdvert({
    advert: a, commitment: advertId(a), header: HEADER_100000,
    txid: txidBytes(TX_AT_1), branch: BRANCH_FOR_1, position: 1,
  });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.endpoint, 'wss://node.example:443');

  // the provider swapped the endpoint and left the commitment alone
  const swapped = { ...a, endpoint: 'wss://whoever-the-provider-prefers:443' };
  const no = acceptAdvert({
    advert: swapped, commitment: advertId(a), header: HEADER_100000,
    txid: txidBytes(TX_AT_1), branch: BRANCH_FOR_1, position: 1,
  });
  assert.equal(no.ok, false);
  assert.match(no.why, /commits to a different advertisement/);

  // the provider invented the transaction
  const bent = BRANCH_FOR_1.map((b) => b.slice());
  bent[1][5] ^= 0x80;
  const nope = acceptAdvert({
    advert: a, commitment: advertId(a), header: HEADER_100000,
    txid: txidBytes(TX_AT_1), branch: bent, position: 1,
  });
  assert.equal(nope.ok, false);
  assert.match(nope.why, /not in that block/);

  // and an advertisement that points at some other bond
  const elsewhere = { ...a, bondTxid: b32(9) };
  const other = acceptAdvert({
    advert: elsewhere, commitment: advertId(elsewhere), header: HEADER_100000,
    txid: txidBytes(TX_AT_1), branch: BRANCH_FOR_1, position: 1,
  });
  assert.equal(other.ok, false);
  assert.match(other.why, /different bond transaction/);
});
