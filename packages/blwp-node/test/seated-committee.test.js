// THE COMMITTEE IS WHOM THE CHAIN SEATED.
//
// A round's `nodes` list is what its author wrote down. Until this it was also
// what the node TRUSTED: `takeReceipt` checked membership against it and
// `verifiedFinal` counted against it, so a committee nobody bonded was served
// as readily as one the census produced.
//
// Letter 26's ruling: the seated set is the only list that counts, and
// `contract.nodes` is checked against it - exactly, both ways. This file is
// that check, and the 2-of-2 built the honest way: two daemons whose OWN
// identities are bonded on the chain and seated from the census, which step 1
// of this slice made possible by making a node's identity its bond key.
import { test } from 'node:test';
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
  payoutPubkey: b32(3), timestamp: 1788700000000n,
});
/** A real bond for a node's OWN identity key - possible since step 1. */
const bondOfKey = (key, n) => bondTransaction(advertFor(key, n), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(key),
});
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  // AND THE ROUND'S PUBLICATION, well below any beacon (5A.5, v4.6.2): a node
  // seats only a round its own chain shows published before the beacon block.
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};
const contractWith = (nodes, censusRoot) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  startTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 60500n,
  entryCloseMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0),
  censusHeight: HEIGHT, censusRoot, committeeTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40,
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

test('two daemons bond their own identities and are seated from the chain', async () => {
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
      const seated = roster.seatRound(rid);
      assert.equal(seated.ok, true, seated.why);

      // EXACTLY THE TWO, and they are the keys these daemons publish.
      assert.equal(seated.seats.length, 2);
      assert.deepEqual(seated.seats.map(toHex).sort(), keys.map(toHex).sort());
      assert.deepEqual(node.round.seats(rid).map(toHex).sort(), keys.map(toHex).sort(),
        'the seats were not kept where the trust checks read them');
    }
  } finally { await a.close(); await b.close(); }
});

test('a contract that names a stranger, or misses a seated node, is refused by name', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  try {
    const mine = node.round.pubkey;
    const other = new Round(openStore(':memory:'), () => AFTER_COMMITTEE).pubkey;
    const keys = [mine, other];
    const bonds = [bondOfKey(mine, 1), bondOfKey(other, 2)];
    const root = rootFor(bonds, keys);
    const roster = new Roster(node.round, { chainFor: ({ contract } = {}) => chainWith(bonds, contract), randomnessFor: ({ contract }) => beaconOf(bonds, contract) });

    const seat = (nodes) => {
      const c = contractWith(nodes, root);
      const rid = node.round.open(c);
      return { rid, seated: roster.seatRound(rid) };
    };

    // EQUAL TO THE SEATED SET: accepted.
    const good = seat(keys);
    assert.equal(good.seated.ok, true, good.seated.why);

    // A STRANGER: refused, and the refusal names the membership, not a later
    // signature check - the two are different failures and stay apart.
    const stranger = seat([mine, b32(0xee)]);
    assert.equal(stranger.seated.ok, false, 'a contract naming a stranger was seated');
    assert.match(stranger.seated.why, /1 the chain did not seat/);
    assert.match(stranger.seated.why, /1 seated node it does not name/);
    assert.equal(node.round.seats(stranger.rid).length, 0, 'a refused round was seated anyway');

    // A MISSING SEAT: one name against two seats.
    const short = seat([mine]);
    assert.equal(short.seated.ok, false, 'a one-name contract was seated against two seats');
    assert.match(short.seated.why, /names 1 committee key and the census seats 2/);
    assert.match(short.seated.why, /1 seated node it does not name/);

    // A DIFFERENT SET ENTIRELY, of the right size: refused, not accepted on
    // cardinality and not rewritten to what the chain says.
    const swapped = seat([b32(0xe1), b32(0xe2)]);
    assert.equal(swapped.seated.ok, false);
    assert.match(swapped.seated.why, /2 the chain did not seat/);

    // AND A ROUND THAT WAS REFUSED TRUSTS NOBODY: no seats, so no receipts.
    assert.equal(node.round.seats(swapped.rid).length, 0);
  } finally { await node.close(); }
});

test('the round door refuses a chain-unsupported committee, and seats a supported one', async () => {
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
    const good = contractWith(keys, root);
    const ok = await fetch(`http://127.0.0.1:${node.port}/round`,
      { method: 'POST', body: encodeRoundContract(good) });
    assert.equal(ok.status, 201, await ok.text());
    assert.equal(node.round.seats(roundId(good)).length, 2,
      'the door stored a round it never seated');

    const bad = contractWith([keys[0], b32(0xee)], root);
    const refused = await fetch(`http://127.0.0.1:${node.port}/round`,
      { method: 'POST', body: encodeRoundContract(bad) });
    assert.equal(refused.status, 409, 'a chain-unsupported committee was accepted');
    const why = await refused.text();
    assert.match(why, /the chain did not seat/);
    assert.equal(node.round.seats(roundId(bad)).length, 0);
  } finally { await node.close(); }
});

test('a seated key with a bad signature and a well-signed stranger fail differently', async () => {
  // The two refusals, pinned apart. A key the census seated is refused for its
  // SIGNATURE; a key it did not seat is refused for MEMBERSHIP, however well
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
  assert.equal(roster.seatRound(rid).ok, true);

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

  // SEATED, BADLY SIGNED: refused for the signature.
  const seated = receiptFrom(peer.pubkey, peer.identity.secret);
  const forged = new Uint8Array(seated.good);
  forged[forged.length - 1] ^= 0xff;
  assert.throws(() => round.takeReceipt(forged), /does not verify/);

  // NOT SEATED, WELL SIGNED: refused for membership.
  const outsider = new Round(openStore(':memory:'), () => AFTER_COMMITTEE);
  const away = receiptFrom(outsider.pubkey, outsider.identity.secret);
  assert.throws(() => round.takeReceipt(away.good), /is not on this round's committee/);

  // SEATED AND WELL SIGNED: kept.
  assert.equal(round.takeReceipt(seated.good), 'held');
});

test('a round nobody seated trusts nobody', async () => {
  // Found by a mutant: letting an unseated round accept receipts broke no
  // test, because every fixture seats. An unseated round is one this node
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
  // The contract NAMES both, and this node never seated it.
  const rid = round.open(contractWith(keys, b32(2)));
  assert.equal(round.seats(rid).length, 0);

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
  // committee for that round because it never seated one.
  assert.throws(() => round.takeReceipt(signed), /has not seated that round/,
    'an unseated round accepted a receipt on the author\'s word');
});

test('a verdict over an unseated round counts nothing, however the contract reads', async () => {
  // The same gap on the other path, found the same way: falling back to
  // `contract.nodes` when there are no seats put the author's list back in
  // charge of who counts towards a final.
  const { verifiedFinal } = await import('../src/verdict.js');
  const keys = [b32(0x71), b32(0x72)];
  const contract = contractWith(keys, b32(2));

  for (const seats of [undefined, [], null]) {
    const out = verifiedFinal([], { contract, seats });
    assert.equal(out.ok, false, `seats=${JSON.stringify(seats)} was counted against the contract`);
    assert.match(out.why, /no seated committee to count against/);
  }

  // and with seats it gets as far as the threshold, which is the next question
  const named = verifiedFinal([], { contract, seats: keys });
  assert.equal(named.ok, true, named.why);
  assert.equal(named.final, false, 'no records is not a final');
});
