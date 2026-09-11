// Replaying the protocol vectors.
//
// This is the test that gives the stage-2 criterion teeth: if the vectors say
// a round_id is a particular 32 bytes and this code produces different bytes,
// one of the two is wrong and the difference is a protocol fork.
//
// A failure here is never "regenerate the vectors". It is a deliberate
// protocol change - in which case PROTOCOL_VERSION moves and they are
// regenerated on purpose - or it is a bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { readFileSync } from 'node:fs';
import { Writer } from '../src/encode.js';
import { taggedHash, toHex, fromHex } from '../src/hash.js';
import { commitCensus, leafHash, encodeEntry } from '../src/census.js';
import { selectCommittee, ticketFor, weightOf } from '../src/sortition.js';
import { computePayoutTable, rankWeights, DELIVERED, FAILED } from '../src/payout.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../src/contracts.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS } from '../src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId } from '../src/receipt.js';
import { chainOf as minedChain } from '../tools/chainview.js';

/**
 * A view spanning the census height: from it to `tip`. A view that begins
 * after `census_height` carries no block the census is about and is refused,
 * so a fixture cannot start at the tip and call itself a chain.
 */
const spanning = (from, tip) =>
  minedChain(Array.from({ length: tip - from + 1 }, () => ({ transactions: [] })), from);


const DIR = new URL('../../../test-vectors/protocol/', import.meta.url).pathname;
const load = (n) => JSON.parse(readFileSync(DIR + n + '.json', 'utf8'));
const b32 = (n) => new Uint8Array(32).fill(n);

test('tagged hashes match the vectors', () => {
  for (const c of load('tagged').cases)
    assert.equal(toHex(taggedHash(c.tag, fromHex(c.message))), c.digest,
      c.tag + ' over ' + (c.message || '<empty>'));
});

test('the primitive encoding matches the vector byte for byte', () => {
  const v = load('encoding');
  const w = new Writer();
  w.u8(1).u16(513).u32(70000).u64(1099511627776n).str('mempool').bytes32(b32(7));
  assert.equal(toHex(w.finish()), v.hex);
});

test('the census root matches, and so does every leaf', () => {
  const v = load('census');
  const mk = (n, bond, height) => ({
    txid: b32(n), vout: n % 3, pubkey: b32(200 - n), advertId: b32(n + 60),
    bondSats: BigInt(bond), height, roles: ['game', 'verify'], spent: false,
  });
  const c = commitCensus(
    [mk(7, 100000, 800007), mk(3, 500000, 800003), mk(11, 100000, 800011), mk(5, 2000000, 800005)],
    { contract: { censusHeight: 900000, censusConfirmations: 6 }, view: spanning(900000, 900100) });

  assert.equal(c.entries.length, v.entries.length);
  c.entries.forEach((e, i) => {
    assert.equal(toHex(encodeEntry(e)), v.entries[i].encoded, 'entry ' + i + ' encodes differently');
    assert.equal(toHex(leafHash(e)), v.entries[i].leaf, 'leaf ' + i);
  });
  assert.equal(toHex(c.root), v.root);
});

test('tickets, weights and the chosen committee match', () => {
  const v = load('sortition');
  const mk = (n, bond) => ({ txid: b32(n), vout: 0, pubkey: b32(n),
                             bondSats: BigInt(bond), height: 1, roles: ['game'], spent: false });
  const entries = [mk(1, 5000000), mk(2, 100000), mk(3, 100000), mk(4, 300000), mk(5, 100000)];
  const seed = fromHex(v.committeeSeed);

  entries.forEach((e, i) => {
    assert.equal(weightOf(e.bondSats, BigInt(v.bondMin)).toString(), v.tickets[i].weight);
    assert.equal(ticketFor(seed, e, 'game').toString(), v.tickets[i].ticket);
  });
  const picked = selectCommittee({
    entries, role: 'game',
    // The vector pins the LOTTERY - seed, weights, tickets - and the round it
    // is drawn for names its network like any other, because the census
    // minimum is a genesis fact. Five entries clear regtest's two. The seed is
    // an argument now: a beacon fixes it, and no contract names it.
    contract: { gameVerifySlots: 3, bondMinSats: BigInt(v.bondMin), networkId: NETWORK_ID_REGTEST },
    committeeSeed: seed });
  assert.deepEqual(picked.map((e) => toHex(e.txid)), v.selected);
});

test('the payout table matches the specification worked example', () => {
  const v = load('payout');
  const money = {
    stakeMsat: BigInt(v.input.stakeMsat),
    feeMsat: BigInt(v.input.feeMsat),
    donationMsat: BigInt(v.input.donationMsat),
  };
  const entries = [];
  for (let i = 0; i < v.input.delivered_low_score; i++)
    entries.push({ pubkey: b32(i), ...money, outcome: DELIVERED, score: 50 });
  for (let i = 0; i < v.input.delivered_high_score; i++)
    entries.push({ pubkey: b32(100 + i), ...money, outcome: DELIVERED, score: 900 });
  for (let i = 0; i < v.input.failed; i++)
    entries.push({ pubkey: b32(200 + i), ...money, outcome: FAILED, score: 0 });

  const r = computePayoutTable({ roundId: fromHex(v.roundId), entries, minScore: v.minScore });
  assert.equal(r.pool.toString(), v.pool);
  assert.equal(r.qualifiers, v.qualifiers);
  assert.equal(r.payingRanks, v.payingRanks);
  assert.deepEqual(rankWeights(r.payingRanks).map(String), v.rankWeights);
  assert.equal(r.table.reduce((s, t) => s + t.amountMsat, 0n).toString(), v.totalPaidMsat);
});

test('the contracts encode to the vectors, and so do their ids', () => {
  const v = load('contracts');
  const c = {
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: new Uint8Array(32).fill(0xd0),
    censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000,
    exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792,
    timeFloor: 16384, timeCeil: 98304, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [b32(4), b32(7), b32(9)],
  };
  assert.equal(toHex(encodeRoundContract(c)), v.roundContract.hex);
  assert.equal(toHex(roundId(c)), v.roundContract.roundId);

  const e = {
    roundId: roundId(c), playerPubkey: b32(21), sessionPubkey: b32(22),
    stakeCommitment: b32(23), stakeMsat: 100000n, feeMsat: 2000n,
    donationMsat: 1000n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
  };
  assert.equal(toHex(encodeEntryContract(e)), v.entryContract.hex);
  assert.equal(toHex(entryId(e)), v.entryContract.entryId);
});

test('the checkpoint vectors replay', () => {
  const v = load('checkpoint');
  const first = {
    roundId: b32(7), entryId: b32(9), tick: 600,
    stateHash: b32(0x5a), inputChainHash: b32(0x1c), previousHash: NO_PREVIOUS,
  };
  assert.equal(toHex(encodeCheckpoint(first)), v.first.hex);
  assert.equal(toHex(checkpointId(first)), v.first.checkpointId);
  assert.equal(encodeCheckpoint(first).length, v.bytesOnTheWire);

  const second = { ...first, tick: 660, stateHash: b32(0x5b), previousHash: checkpointId(first) };
  assert.equal(toHex(encodeCheckpoint(second)), v.second.hex);
  assert.equal(toHex(checkpointId(second)), v.second.checkpointId,
    'the chain is part of the digest, so a re-parented checkpoint is a different one');

  // Same round, entry and tick; different state. Two objects, which is what
  // makes section 13B's forfeit a proof rather than an accusation.
  const forged = { ...first, stateHash: b32(0x5b) };
  assert.equal(toHex(checkpointId(forged)), v.equivocation.checkpointId);
  assert.notEqual(toHex(checkpointId(forged)), toHex(checkpointId(first)));
});

test('the receipt vectors replay', () => {
  const v = load('receipt');
  const marked = {
    roundId: b32(7), entryId: b32(9), tick: 600,
    stateHash: b32(0x5a), inputChainHash: b32(0x1c), previousHash: NO_PREVIOUS,
  };
  const one = {
    checkpointId: checkpointId(marked),
    receivedAtMs: 1788600000000n,
    nodePubkey: b32(0x2b),
  };
  assert.equal(toHex(encodeCheckpointReceipt(one)), v.receipt.hex);
  assert.equal(toHex(receiptId(one)), v.receipt.receiptId);
  assert.equal(encodeCheckpointReceipt(one).length, v.bytesOnTheWire);

  const otherNode = { ...one, nodePubkey: b32(0x2c) };
  assert.equal(toHex(receiptId(otherNode)), v.fromAnotherNode.receiptId);
  assert.notEqual(toHex(receiptId(otherNode)), toHex(receiptId(one)),
    'the signer is part of the receipt, so two nodes give two objects');
});
