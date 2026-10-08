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
  targetOf, meetsTarget,
} from '../src/chain.js';
import {
  encodeAdvert, decodeAdvert, advertId, joinSignedAdvert,
} from '../src/advert.js';
import { parseTransaction } from '../src/tx.js';
import { fromHex, toHex } from '../src/hash.js';
import { bondTransaction, blockOf } from '../tools/bond.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

// There is no BLWP bond on mainnet to point at, so the bond transaction is
// built - by `tools/bond.js`, which is not part of the protocol - and put in a
// two-transaction block of its own. What reads it is measured against real
// mainnet bytes in tx.test.js and below; only the shape is assembled here.
// A body offered BESIDE the transaction, the way a page hands one over. It
// arrives signed or it is not an advertisement; whether the signature is any
// good is the client's question, not this package's - no curve lives here.
const courier = (a, signature = new Uint8Array(64)) =>
  joinSignedAdvert(encodeAdvert(a), signature);

const blockAround = (txid, sibling = new Uint8Array(32).fill(0x99)) => ({
  ...blockOf(hash256, [txid, sibling]), branch: [sibling], position: 0,
});

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
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify'], endpoint, region: 'eu-west', capacityClass: 2,
  softwareHash: b32(3), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: txidBytes(TX_AT_1), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(4), guardianOf: [], guardianCapable: false, guardianEndpoint: '', timestamp: 1788700000000n,
});

test('an advertisement survives the wire unchanged', () => {
  const a = advert();
  const back = decodeAdvert(encodeAdvert(a));
  assert.deepEqual(back, a);
  assert.equal(advertId(a).length, 32);
  assert.throws(() => decodeAdvert(encodeAdvert(a).slice(0, 20)));
});

/* ------------------------------------ and the whole of step 4, on real bytes */

// mainnet block 500000 and the merkle proof for its coinbase, fetched once.
// A real transaction, really in a real block, that commits to something that
// is not an advertisement - which is what almost every transaction on Bitcoin
// is, and therefore the case a reader meets most often.
// mainnet block 500000, its coinbase, as in tx.test.js.
const COINBASE_500000 = fromHex(
  '01000000000101000000000000000000000000000000000000000000000000000000'
  + '0000000000ffffffff4b0320a107046f0a385a632f4254432e434f4d2ffabe6d6dbd'
  + 'd0ee86f9a1badfd0aa1b3c9dac8d90840cf973f7b2590d6c9adde1a6e0974a010000'
  + '000000000001283da9a172020000000000ffffffff02c994bb5e0000000017a91422'
  + '8f554bbf766d6f9cc828de1126e3d35d15e5fe870000000000000000266a24aa21a9'
  + 'ed10109f4b82aa3ed7ec9d02a2a90246478b3308c8b85daf62fe501d58d05727a401'
  + '20000000000000000000000000000000000000000000000000000000000000000000'
  + '000000');
const HEADER_500000 = fromHex(
  '000000201929eb850a74427d0440cf6b518308837566cd6d06627900000000000000'
  + '00001f6231ed3de07345b607ec2a39b2d01bec2fe10dfb7f516ba4958a42691c9531'
  + '6d0a385a459600185599fc5c');
const BRANCH_FOR_COINBASE = [
  'fe6c48bbfdc025670f4db0340650ba5a50f9307b091d9aaa19aa44291961c69f',
  '7c343e2d73c945204dbba26d4d270ccc607b3d2390471f064366bb812ac811fc',
  'd85eaeedd2a212e8e0dfa163026bb485816f8a6ab6a588425921a0e6ca88adce',
  '5c85ad415712389a75c2a29cfb82d4793b7747bcb3e37090e67685d25cc8bbdf',
  'c8c85eda3df7d7c4bf105f3d0db8a4dbfcca798811ae903598cf093ff44d0575',
  'be2a2e75e200878839736a4e8242bbdac5ece9434335b3298af2922faca4040e',
  'f28ac132df10d4c5e02a648ea4b99832aebbc4e7999859771a10785b23f43ecb',
  '8620b2fd60bcf1ba0bbac2ccbd6b7e301870d335faa17e0e258b3ffc93b43ae6',
  '9141cff8144ecb7a804ce63c6a34ff1a75c741292fa8f99ebf6291565115cbd8',
  '377a893c2d5446106cc25840ba4e98c47a293a2a6586d8e0ed483d7fdacd38bd',
  'd9af63a572e83ecfdf88aa74c6640a444684acf048e6f7184c3cab8e39e9f593',
  '6fa2420ff6d2fa3a41c5a41ecdc76ef880a97d7083d2484bdf0b79dc8b667596',
].map(txidBytes);

/**
 * THE PART THAT USED TO BE THEATRE.
 *
 * This function took `commitment` and `txid` as arguments. Whoever handed over
 * the advertisement handed those over too, so a page could publish any endpoint
 * it liked behind a real block and every check passed: it supplied the hash of
 * the body it wanted believed. Both are now COMPUTED from the transaction -
 * the txid by hashing it, the commitment by reading its outputs - and the only
 * things a caller supplies are bytes whose hashes it does not control.
 */
test('the endpoint comes out of the transaction, not out of the caller', () => {
  const a = { ...advert(), bondTxid: new Uint8Array(32) };
  const raw = bondTransaction(a);
  const txid = parseTransaction(raw).txid;
  const { header, branch, position } = blockAround(txid);

  // nothing handed in but bytes: the body is read from the witness
  const ok = acceptAdvert({ transaction: raw, header, branch, position });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.endpoint, 'wss://node.example:443');
  assert.equal(toHex(ok.txid), toHex(txid));
});

test('a page that swaps the endpoint is refused, and cannot supply the hash', () => {
  const a = { ...advert(), bondTxid: new Uint8Array(32) };
  const swapped = { ...a, endpoint: 'wss://whoever-the-provider-prefers:443' };

  // the transaction carries no body at all, so the page offers its own
  const raw = bondTransaction(a, { body: new Uint8Array(0) });
  const { header, branch, position } = blockAround(parseTransaction(raw).txid);

  const no = acceptAdvert({
    transaction: raw, signedAdvert: courier(swapped), header, branch, position,
  });
  assert.equal(no.ok, false);
  assert.match(no.why, /commits to a different advertisement/);

  // the honest body, offered the same way, is taken - the page is a courier
  const yes = acceptAdvert({
    transaction: raw, signedAdvert: courier(a), header, branch, position,
  });
  assert.equal(yes.ok, true, yes.why);

  // and when the transaction does carry the body, offering another changes
  // nothing: the committed one wins
  const carried = bondTransaction(a);
  const b = blockAround(parseTransaction(carried).txid);
  const still = acceptAdvert({
    transaction: carried, signedAdvert: courier(swapped), header: b.header,
    branch: b.branch, position: b.position,
  });
  assert.equal(still.ok, true, still.why);
  assert.equal(still.endpoint, 'wss://node.example:443');
});

test('a real mainnet transaction in a real block advertises nothing', () => {
  const seen = acceptAdvert({
    transaction: COINBASE_500000, signedAdvert: courier(advert()), header: HEADER_500000,
    branch: BRANCH_FOR_COINBASE, position: 0,
  });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /commits to a different advertisement/);
});

test('an invented transaction, and one that is not a transaction, are refused', () => {
  const a = { ...advert(), bondTxid: new Uint8Array(32) };
  const raw = bondTransaction(a);
  const { header, branch, position } = blockAround(parseTransaction(raw).txid);

  const bent = branch.map((x) => x.slice());
  bent[0][5] ^= 0x80;
  const nope = acceptAdvert({ transaction: raw, header, branch: bent, position });
  assert.equal(nope.ok, false);
  assert.match(nope.why, /not in that block/);

  const rubbish = acceptAdvert({
    transaction: raw.slice(0, 40), header, branch, position,
  });
  assert.equal(rubbish.ok, false);
  assert.match(rubbish.why, /not a transaction/);
});

test('an advertisement pointing at some other bond, or at no output, is refused', () => {
  const elsewhere = { ...advert(), bondTxid: b32(9) };
  const raw = bondTransaction(elsewhere);
  const at = blockAround(parseTransaction(raw).txid);
  const other = acceptAdvert({
    transaction: raw, header: at.header, branch: at.branch, position: at.position,
  });
  assert.equal(other.ok, false);
  assert.match(other.why, /different bond transaction/);

  // the bond output it names is not in the transaction that carries it
  const past = { ...advert(), bondTxid: new Uint8Array(32), bondVout: 7 };
  const raw2 = bondTransaction(past);
  const at2 = blockAround(parseTransaction(raw2).txid);
  const no = acceptAdvert({
    transaction: raw2, header: at2.header, branch: at2.branch, position: at2.position,
  });
  assert.equal(no.ok, false);
  assert.match(no.why, /no such output/);

  // AND THE OUTPUT IT NAMES HAS TO BE A BOND. This door used to check only
  // that the vout existed, so an advertisement declaring the OP_RETURN as its
  // bond was accepted and its ENDPOINT handed back - a transaction with no
  // bond in it presented to a client as a bonded node. 25.1 step 2 is "which
  // nodes count? Bitcoin: bond outputs", and step 4 reads the endpoint from
  // that same transaction.
  const atReturn = { ...advert(), bondTxid: new Uint8Array(32), bondVout: 2 };
  const raw3 = bondTransaction(atReturn);
  const tx3 = parseTransaction(raw3);
  assert.equal(tx3.outputs[2].value, 0n, 'vout 2 is not the OP_RETURN');
  const at3 = blockAround(tx3.txid);
  const empty = acceptAdvert({
    transaction: raw3, header: at3.header, branch: at3.branch, position: at3.position,
  });
  assert.equal(empty.ok, false, 'an endpoint was handed back for a bond that is an OP_RETURN');
  assert.match(empty.why, /not a taproot output/);
});

/**
 * And the bond it accepted comes back measured, not merely accepted: the
 * output's own value, and the three rules the chain cannot show.
 */
test('an accepted advertisement carries the bond it was proven against', () => {
  // the all-zero txid, the reading 25.1 forces: the body rides in the
  // transaction it names, so the txid is not knowable when the body is signed
  const raw = bondTransaction({ ...advert(), bondTxid: new Uint8Array(32) });
  const tx = parseTransaction(raw);
  const at = blockAround(tx.txid);
  const ok = acceptAdvert({
    transaction: raw, header: at.header, branch: at.branch, position: at.position,
  });

  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.bondVout, 0);
  assert.equal(ok.bondSats, tx.outputs[0].value);
  assert.equal(ok.unchecked.length, 2);
  assert.match(ok.unchecked[0], /bond script template/);
});

/**
 * A BODY ARRIVES SIGNED OR IT IS NOT AN ADVERTISEMENT. 5A.1 ends the object
 * with "signature - by node_pubkey over all of the above", so 64 bytes ride
 * beside it. This package does not say whether they are GOOD - there is no
 * curve in here, on purpose - it says they are there and hands them back, and
 * a caller that ignored them would be ignoring something it was given.
 */
test('an unsigned body is not an advertisement, and the signature comes back', () => {
  const a = { ...advert(), bondTxid: new Uint8Array(32) };
  const signature = new Uint8Array(64).fill(0xa7);

  const signed = bondTransaction(a, { signature });
  const at = blockAround(parseTransaction(signed).txid);
  const ok = acceptAdvert({
    transaction: signed, header: at.header, branch: at.branch, position: at.position,
  });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(toHex(ok.signature), toHex(signature));

  // the same body with nothing beside it: the witness item is the bare
  // encoding, which is not a signed advertisement and is not read as one
  const bare = bondTransaction(a, { body: encodeAdvert(a) });
  const there = blockAround(parseTransaction(bare).txid);
  const no = acceptAdvert({
    transaction: bare, header: there.header, branch: there.branch,
    position: there.position,
  });
  assert.equal(no.ok, false);
  assert.match(no.why, /commits to a different advertisement/);
});

/**
 * WAS IT MINED? The question that makes "most work wins" mean anything.
 *
 * The difficulty lives in four bytes of the header, so it is written by
 * whoever hands the header over. Until the hash is compared against it, the
 * work of a chain is a number somebody chose - and the number they can choose
 * is not slightly bigger, it is thirty-two orders of magnitude bigger than the
 * whole of Bitcoin.
 */
test('a header is only worth its work if the work was actually done', () => {
  // the three real headers below are mined, and are the proof this is not
  // simply refusing everything
  assert.equal(meetsTarget(HEADER_100000), true);
  assert.equal(meetsTarget(HEADER_500000), true);
  assert.equal(chainWork([HEADER_100000]).ok, true);

  // a header nobody mined, claiming a target of 1
  const fake = new Uint8Array(80);
  fake[72] = 0x01; fake[75] = 0x03;
  assert.equal(targetOf(fake), 1n);
  assert.equal(meetsTarget(fake), false);
  // and the work it CLAIMS is 2^256 / 2, which is why the claim cannot stand
  assert.equal(workOf(fake), (1n << 256n) / 2n);
  assert.ok(workOf(fake) > workOf(HEADER_500000) * 10n ** 30n);

  const no = chainWork([fake]);
  assert.equal(no.ok, false);
  assert.match(no.why, /was not mined: its hash does not meet the target it claims/);
  assert.equal(no.work, 0n);
});

test('an unmined chain is not in the running, however much it claims', () => {
  const fake = new Uint8Array(80);
  fake[72] = 0x01; fake[75] = 0x03;
  const best = mostWork([[fake], [HEADER_500000]]);
  assert.equal(best.at, 1);
  assert.deepEqual(best.headers, [HEADER_500000]);
  assert.equal(mostWork([[fake]]), null);
});

test('a target that is zero or negative is not a target', () => {
  const zero = new Uint8Array(80);           // mantissa 0
  assert.equal(targetOf(zero), 0n);
  assert.equal(workOf(zero), 0n);
  assert.equal(meetsTarget(zero), false);

  const negative = new Uint8Array(80);       // the mantissa's high bit is a sign
  negative[72] = 0x00; negative[73] = 0x00; negative[74] = 0x80; negative[75] = 0x1d;
  assert.equal(targetOf(negative), 0n);
  assert.equal(meetsTarget(negative), false);
});
