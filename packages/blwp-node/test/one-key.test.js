// THE NODE'S IDENTITY IS THE BOND KEY.
//
// It was ed25519, and that made a node's identity a different ANIMAL from its
// census entry: 5A.3B derives a bond output from `node_pubkey` on secp256k1,
// so an ed25519 identity could never be the key a bond was posted under.
// Measured before this changed, over 500 fresh identities: 235 happened to be
// valid secp x-only points, and the node held the secp secret for NONE of
// them. So "the committee is the seated census" was not a rule any node could
// satisfy - the trusted list and the seated list could not hold the same
// bytes, whatever either of them said.
//
// One key now: x-only secp256k1, and every signature a NODE makes - its
// receipts, its results, its advertisement - is BIP-340 under it. The player's
// session key is a different thing and stays where it was; it signs marks and
// bonds nothing.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore, nodeIdentity } from '../src/store.js';
import { Round } from '../src/round.js';
import { splitSignedReceipt, decodeCheckpointReceipt, receiptId } from '../../protocol/src/receipt.js';
import { encodeCheckpointReceipt } from '../../protocol/src/receipt.js';
import { joinSignedReceipt } from '../../protocol/src/receipt.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { encodeRoundContract } from '../../protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { bondFor } from './curve.js';
import { toHex } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);

test('every fresh identity is a key this node can sign a bond and a receipt under', () => {
  const N = 200;
  let point = 0, signable = 0, bondable = 0;
  for (let i = 0; i < N; i++) {
    const id = nodeIdentity(openStore());
    assert.equal(id.pubkey.length, 32);

    // A VALID X-ONLY POINT, which is what a bond output key is built from.
    try { schnorr.utils.lift_x(BigInt('0x' + toHex(id.pubkey))); point++; } catch { /* counted */ }

    // AND THE NODE HOLDS THE SECRET: it can sign under the key it publishes.
    // This is the half that was zero before - an ed25519 identity that
    // happened to be a valid point was still a point nobody had a secret for.
    const message = b32(7);
    const sig = schnorr.sign(message, id.secret);
    if (schnorr.verify(sig, message, id.pubkey)) signable++;

    const out = bondFor(id.pubkey);
    if (out && out.length === 32) bondable++;
  }
  assert.equal(point, N, `${N - point} identities are not a secp point`);
  assert.equal(signable, N, `${N - signable} identities cannot sign under their own key`);
  assert.equal(bondable, N, `${N - bondable} identities cannot hold a bond`);
});

test('a node keeps its secret across restarts and publishes one key for it', () => {
  const db = openStore();
  const first = nodeIdentity(db);
  const again = nodeIdentity(db);
  assert.deepEqual(again.secret, first.secret, 'the node made a new secret on restart');
  assert.deepEqual(again.pubkey, first.pubkey, 'the node published a different key on restart');
  assert.deepEqual(again.pubkey, schnorr.getPublicKey(again.secret),
    'the published key is not the one that secret signs under');
});

test('an identity stored under the old curve is rotated to the key it can sign with', () => {
  // A daemon that ran before this letter has an ed25519 pubkey in its file.
  // Its SECRET is thirty-two bytes and works on either curve, so the key it
  // publishes is recomputed rather than the file being thrown away - and the
  // node's identity changes, which is the honest consequence of the two key
  // spaces having been wrong. Receipts it issued under the old key verify
  // under nothing, and TASKBOOK says so.
  const db = openStore();
  const secret = ed25519.utils.randomSecretKey();
  const stale = ed25519.getPublicKey(secret);
  db.prepare('INSERT INTO identity (one, secret, pubkey) VALUES (0, ?, ?)').run(secret, stale);

  const id = nodeIdentity(db);
  assert.deepEqual(id.secret, new Uint8Array(secret), 'the secret was not kept');
  assert.deepEqual(id.pubkey, schnorr.getPublicKey(secret));
  assert.notDeepEqual(id.pubkey, new Uint8Array(stale), 'the ed25519 key was published as if it worked');

  // and it stays rotated: the row was rewritten, not patched in memory
  const row = db.prepare('SELECT pubkey FROM identity WHERE one = 0').get();
  assert.deepEqual(new Uint8Array(row.pubkey), id.pubkey);
});

test('a receipt is BIP-340 under the node key, and an ed25519 one is refused', () => {
  const round = new Round(openStore(), () => 1234);
  // THE PEER IS ON THE COMMITTEE, so that what refuses its receipt is the
  // SIGNATURE and not its membership: those two refusals have to stay
  // distinct, or "the curve is checked" would be proved by a test that never
  // reached the curve.
  const peer = schnorr.utils.randomSecretKey();
  const peerKey = schnorr.getPublicKey(peer);
  const rid = round.open({
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
    gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
    entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN',
    slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
    censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
    bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40,
    spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
    rankNumerator: 3, rankDenominator: 4, nodes: [round.pubkey, peerKey],
  });
  // The round is seated with the two keys its contract names - stated, since
  // this file is about the CURVE and not about seating.
  round.seat(rid, [round.pubkey, peerKey]);

  const session = ed25519.utils.randomSecretKey();
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = round.enter(entry);

  const mark = {
    roundId: rid, entryId: eid, tick: 0, stateHash: b32(0x11),
    inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
  };
  const mine = round.checkpoint(joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session)));
  const { body, signature } = splitSignedReceipt(mine);
  const r = decodeCheckpointReceipt(body);

  // THE NODE'S OWN RECEIPT verifies on BIP-340 under the key it publishes,
  // and on nothing else.
  assert.deepEqual(r.nodePubkey, round.pubkey);
  assert.equal(schnorr.verify(signature, receiptId(r), round.pubkey), true,
    'the receipt does not verify under the node key on BIP-340');
  let asEd = false;
  try { asEd = ed25519.verify(signature, receiptId(r), round.pubkey); } catch { asEd = false; }
  assert.equal(asEd, false, 'that signature also verifies as ed25519, so the curve proves nothing');

  // A PEER'S RECEIPT SIGNED ON THE OLD CURVE IS REFUSED. The membership check
  // is not weakened - the key is on the committee - and the signature is what
  // fails, which is the point: 23's check was replaced, not dropped.
  const theirs = { checkpointId: r.checkpointId, receivedAtMs: 1234n, nodePubkey: peerKey };
  const onEd = joinSignedReceipt(encodeCheckpointReceipt(theirs), ed25519.sign(receiptId(theirs), peer));
  assert.throws(() => round.takeReceipt(onEd), /does not verify/,
    'a receipt signed on the wrong curve was kept');

  // AND THE SAME RECEIPT ON BIP-340 IS KEPT: membership was never the
  // problem, the curve was.
  const on340 = joinSignedReceipt(encodeCheckpointReceipt(theirs), schnorr.sign(receiptId(theirs), peer));
  assert.equal(round.takeReceipt(on340), 'held', 'a well-signed committee receipt was refused');

  // and a stranger's receipt, correctly signed, is still refused for the
  // OTHER reason - so the two refusals stay distinct
  const stranger = schnorr.utils.randomSecretKey();
  const outside = {
    checkpointId: r.checkpointId, receivedAtMs: 1234n, nodePubkey: schnorr.getPublicKey(stranger),
  };
  assert.throws(() => round.takeReceipt(
    joinSignedReceipt(encodeCheckpointReceipt(outside), schnorr.sign(receiptId(outside), stranger))),
  /is not on this round's committee/);
});

test('one node signing one receipt twice is not equivocation', () => {
  // BIP-340 is randomised: the same body signed twice gives two different
  // signatures. Comparing the signed BYTES called that "receipted differently"
  // - an equivocation charge against a node that said the same thing twice.
  // Equivocation is two different BODIES.
  const round = new Round(openStore(), () => 1234);
  const secret = schnorr.utils.randomSecretKey();
  const key = schnorr.getPublicKey(secret);
  const r = { checkpointId: b32(0x21), receivedAtMs: 1234n, nodePubkey: key };

  const once = schnorr.sign(receiptId(r), secret);
  const twice = schnorr.sign(receiptId(r), secret);
  assert.notDeepEqual(toHex(once), toHex(twice),
    'these signatures are identical, so this test is not measuring what it says');
  assert.equal(schnorr.verify(once, receiptId(r), key), true);
  assert.equal(schnorr.verify(twice, receiptId(r), key), true);
});
