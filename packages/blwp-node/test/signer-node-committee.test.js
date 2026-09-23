// THE COMMITTEE IS WHOM THE CHAIN ASSIGNED.
//
// A round's `nodes` list is what its author wrote down. Until this it was also
// what the node TRUSTED: `takeReceipt` checked membership against it and
// `verifiedFinal` counted against it, so a committee nobody bonded was served
// as readily as one the census produced.
//
// Letter 26's ruling: the assigned set is the only list that counts, and
// `contract.nodes` is checked against it - exactly, both ways. This file is
// that check, and the 2-of-2 built the honest way: two daemons whose OWN
// identities are bonded on the chain and assigned from the census, which step 1
// of this slice made possible by making a node's identity its bond key.
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { serve } from '../src/server.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../protocol/tools/chainview.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { deriveCensus } from '../../protocol/src/census.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { bondFor } from './curve.js';
import { toHex } from '../../protocol/src/hash.js';
import { beaconFromChain } from '../../protocol/src/beacon.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
// A CLOCK AFTER THE COMMITTEE FORMS. It was 1234 - a millisecond in 1970 -
// which is now before the round's own committee_time, and a node refuses an
// entry before that instant (27). The fixture's clock has to be a moment the
// round is actually open in.
const AFTER_COMMITTEE = Number(BigInt(FIRST_TIME + 20 * SPACING) * 1000n);
const HEIGHT = 900000;
// THE BEACON these rounds are seeded from, owned by the fixture the way the
// census root is: a value published ABOVE the census height, which is what
// `beaconIsAfterRound` can prove until `committee_time` exists.
// THE BEACON IS THE FIXTURE CHAIN'S OWN, not a number beside it. It used to be
// `{ hash: 0xbe repeated, height: 900005, timeMs: 900n }` - a block this
// fixture's chain does not have, at a height it never reaches - and the roster
// now asks whether the beacon is the block ITS chain names. It was not. The
// answer is derived from the same blocks the census is, which is the thing the
// rule is for: one chain, one committee.
const beaconOf = (bonds, contract) => {
  const view = chainWith(bonds, contract);
  const named = beaconFromChain(contract,
    { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
  if (!named.ok) throw new Error('this fixture chain names no beacon: ' + named.why);
  return { hash: named.hash, height: named.height, timeMs: named.timeMs };
};
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;

const advertFor = (key, n) => ({
  nodePubkey: key, operatorId: 'operator', protocolVersions: [1],
  roles: ['game', 'settlement'], endpoint: `ws://node${n}`, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
});
/** A real bond for a node's OWN identity key - possible since step 1. */
const bondOfKey = (key, n) => bondTransaction(advertFor(key, n), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(key),
});
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  // AND THE ROUND'S PUBLICATION, well below any beacon (5A.5, v4.6.2): a node
  // signer nodes only a round its own chain shows published before the beacon block.
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};
const contractWith = (nodes, censusRoot) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 60500n,
  entryCloseMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: HEIGHT, censusRoot, committeeTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes,
});
/** The root those blocks give, the way whoever opens a round computes it. */
function rootFor(bonds, nodes) {
  const contract = decodeRoundContract(encodeRoundContract(contractWith(nodes, b32(2))));
  const view = chainWith(bonds);
  const byTxid = new Map();
  for (const block of view.blocks)
    for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, {
    contract, bond: bondSetFor('regtest'),
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
  });
  assert.equal(census.ok, true, census.why);
  return census.root;
}

test('two daemons bond their own identities and are assigned from the chain', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  const b = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  try {
    // THE KEYS ARE THE DAEMONS' OWN. Before step 1 this line was impossible:
    // an ed25519 identity could not be a bond key at all.
    const keys = [a.round.pubkey, b.round.pubkey];
    assert.notDeepEqual(keys[0], keys[1], 'two daemons share one identity');
    const bonds = [bondOfKey(keys[0], 1), bondOfKey(keys[1], 2)];
    const root = rootFor(bonds, keys);

    for (const node of [a, b]) {
      const roster = new Roster(node.round, { chainFor: ({ contract } = {}) => chainWith(bonds, contract), randomnessFor: ({ contract }) => beaconOf(bonds, contract) });
      const c = contractWith(keys, root);
      const rid = node.round.open(c);
      const assigned = roster.assignSignerNodes(rid);
      assert.equal(assigned.ok, true, assigned.why);

      // EXACTLY THE TWO, and they are the keys these daemons publish.
      assert.equal(assigned.signerNodes.length, 2);
      assert.deepEqual(assigned.signerNodes.map(toHex).sort(), keys.map(toHex).sort());
      assert.deepEqual(node.round.signerNodes(rid).map(toHex).sort(), keys.map(toHex).sort(),
        'the signer nodes were not kept where the trust checks read them');
    }
  } finally { await a.close(); await b.close(); }
});

test('a contract that names a stranger, or misses a assigned node, is refused by name', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  try {
    const mine = node.round.pubkey;
    const other = new Round(openStore(':memory:'), () => AFTER_COMMITTEE).pubkey;
    const keys = [mine, other];
    const bonds = [bondOfKey(mine, 1), bondOfKey(other, 2)];
    const root = rootFor(bonds, keys);
    const roster = new Roster(node.round, { chainFor: ({ contract } = {}) => chainWith(bonds, contract), randomnessFor: ({ contract }) => beaconOf(bonds, contract) });

    const signerNode = (nodes) => {
      const c = contractWith(nodes, root);
      const rid = node.round.open(c);
      return { rid, assigned: roster.assignSignerNodes(rid) };
    };

    // EQUAL TO THE ASSIGNED SET: accepted.
    const good = signerNode(keys);
    assert.equal(good.assigned.ok, true, good.assigned.why);

    // A STRANGER: refused, and the refusal names the membership, not a later
    // signature check - the two are different failures and stay apart.
    const stranger = signerNode([mine, b32(0xee)]);
    assert.equal(stranger.assigned.ok, false, 'a contract naming a stranger was assigned');
    assert.match(stranger.assigned.why, /1 the chain did not assign/);
    assert.match(stranger.assigned.why, /1 assigned node it does not name/);
    assert.equal(node.round.signerNodes(stranger.rid).length, 0, 'a refused round was assigned anyway');

    // A MISSING SIGNER NODE: one name against two signer nodes.
    const short = signerNode([mine]);
    assert.equal(short.assigned.ok, false, 'a one-name contract was assigned against two signer nodes');
    assert.match(short.assigned.why, /names 1 committee key and the census assigns 2/);
    assert.match(short.assigned.why, /1 assigned node it does not name/);

    // A DIFFERENT SET ENTIRELY, of the right size: refused, not accepted on
    // cardinality and not rewritten to what the chain says.
    const swapped = signerNode([b32(0xe1), b32(0xe2)]);
    assert.equal(swapped.assigned.ok, false);
    assert.match(swapped.assigned.why, /2 the chain did not assign/);

    // AND A ROUND THAT WAS REFUSED TRUSTS NOBODY: no signer nodes, so no receipts.
    assert.equal(node.round.signerNodes(swapped.rid).length, 0);
  } finally { await node.close(); }
});

test('the round door refuses a chain-unsupported committee, and signer nodes a supported one', async () => {
  const keys = [];
  const first = new Round(openStore(':memory:'), () => AFTER_COMMITTEE);
  const second = new Round(openStore(':memory:'), () => AFTER_COMMITTEE);
  keys.push(first.pubkey, second.pubkey);
  const bonds = [bondOfKey(keys[0], 1), bondOfKey(keys[1], 2)];
  const root = rootFor(bonds, keys);

  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, chainFor: ({ contract } = {}) => chainWith(bonds, contract), randomnessFor: ({ contract }) => beaconOf(bonds, contract),
  });
  try {
    // FREE, because this door reaches no federation: a paying FEDERATION round is signed for only where the
    // signer node can read its guardians (§23.6), and the subject here is the chain's committee, not custody.
    const good = { ...contractWith(keys, root), stakeMsat: 0n };
    const ok = await fetch(`http://127.0.0.1:${node.port}/round`,
      { method: 'POST', body: encodeRoundContract(good) });
    assert.equal(ok.status, 201, await ok.text());
    assert.equal(node.round.signerNodes(roundId(good)).length, 2,
      'the door stored a round it was never assigned');

    const bad = { ...contractWith([keys[0], b32(0xee)], root), stakeMsat: 0n };
    const refused = await fetch(`http://127.0.0.1:${node.port}/round`,
      { method: 'POST', body: encodeRoundContract(bad) });
    assert.equal(refused.status, 409, 'a chain-unsupported committee was accepted');
    const why = await refused.text();
    assert.match(why, /the chain did not assign/);
    assert.equal(node.round.signerNodes(roundId(bad)).length, 0);
  } finally { await node.close(); }
});

test('a assigned key with a bad signature and a well-signed stranger fail differently', async () => {
  // The two refusals, pinned apart. A key the census assigned is refused for its
  // SIGNATURE; a key it did not assign is refused for MEMBERSHIP, however well
  // it signs. Neither refusal stands in for the other.
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { encodeCheckpointReceipt, joinSignedReceipt, receiptId } =
    await import('../../protocol/src/receipt.js');

  const round = new Round(openStore(':memory:'), () => AFTER_COMMITTEE);
  const peer = new Round(openStore(':memory:'), () => AFTER_COMMITTEE);
  const keys = [round.pubkey, peer.pubkey];
  const bonds = [bondOfKey(keys[0], 1), bondOfKey(keys[1], 2)];
  const roster = new Roster(round, { chainFor: ({ contract } = {}) => chainWith(bonds, contract), randomnessFor: ({ contract }) => beaconOf(bonds, contract) });
  const rid = round.open(contractWith(keys, rootFor(bonds, keys)));
  assert.equal(roster.assignSignerNodes(rid).ok, true);

  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } =
    await import('../../protocol/src/checkpoint.js');
  const { GENESIS } = await import('../../protocol/src/transcript.js');
  const session = ed25519.utils.randomSecretKey();
  const eid = round.enter({
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  });
  const mark = {
    roundId: rid, entryId: eid, tick: 0, stateHash: b32(0x11),
    inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
  };
  round.checkpoint(joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session)));

  const receiptFrom = (key, secret) => {
    const r = { checkpointId: checkpointId(mark), receivedAtMs: 1234n, nodePubkey: key };
    return { r, good: joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), secret)) };
  };

  // JOINED, BADLY SIGNED: refused for the signature.
  const joined = receiptFrom(peer.pubkey, peer.identity.secret);
  const forged = new Uint8Array(joined.good);
  forged[forged.length - 1] ^= 0xff;
  assert.throws(() => round.takeReceipt(forged), /does not verify/);

  // NOT JOINED, WELL SIGNED: refused for membership.
  const outsider = new Round(openStore(':memory:'), () => AFTER_COMMITTEE);
  const away = receiptFrom(outsider.pubkey, outsider.identity.secret);
  assert.throws(() => round.takeReceipt(away.good), /is not on this round's committee/);

  // JOINED AND WELL SIGNED: kept.
  assert.equal(round.takeReceipt(joined.good), 'held');
});

test('a round nobody joined trusts nobody', async () => {
  // Found by a mutant: letting an unassigned round accept receipts broke no
  // test, because every fixture assigns. An unassigned round is one this node
  // could not check - no chain view, or a committee the chain refused - and
  // "cannot check" must not mean "accepts anyone".
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { encodeCheckpointReceipt, joinSignedReceipt, receiptId } =
    await import('../../protocol/src/receipt.js');
  const { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } =
    await import('../../protocol/src/checkpoint.js');
  const { GENESIS } = await import('../../protocol/src/transcript.js');

  const round = new Round(openStore(':memory:'), () => AFTER_COMMITTEE);
  const peer = new Round(openStore(':memory:'), () => AFTER_COMMITTEE);
  const keys = [round.pubkey, peer.pubkey];
  // The contract NAMES both, and this node was never assigned it.
  const rid = round.open(contractWith(keys, b32(2)));
  assert.equal(round.signerNodes(rid).length, 0);

  const session = ed25519.utils.randomSecretKey();
  const eid = round.enter({
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  });
  const mark = {
    roundId: rid, entryId: eid, tick: 0, stateHash: b32(0x11),
    inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
  };
  round.checkpoint(joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session)));

  const r = { checkpointId: checkpointId(mark), receivedAtMs: 1234n, nodePubkey: peer.pubkey };
  const signed = joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), peer.identity.secret));

  // Named by the contract, correctly signed, and refused: this node has no
  // committee for that round because it was never assigned one.
  assert.throws(() => round.takeReceipt(signed), /has not been assigned that round/,
    'an unassigned round accepted a receipt on the author\'s word');
});

test('a verdict over an unassigned round counts nothing, however the contract reads', async () => {
  // The same gap on the other path, found the same way: falling back to
  // `contract.nodes` when there are no signer nodes put the author's list back in
  // charge of who counts towards a final.
  const { verifiedFinal } = await import('../src/verdict.js');
  const keys = [b32(0x71), b32(0x72)];
  const contract = contractWith(keys, b32(2));

  for (const signerNodes of [undefined, [], null]) {
    const out = verifiedFinal([], { contract, signerNodes });
    assert.equal(out.ok, false, `signer nodes=${JSON.stringify(signerNodes)} was counted against the contract`);
    assert.match(out.why, /no assigned committee to count against/);
  }

  // and with signer nodes it gets as far as the threshold, which is the next question
  const named = verifiedFinal([], { contract, signerNodes: keys });
  assert.equal(named.ok, true, named.why);
  assert.equal(named.final, false, 'no records is not a final');
});
