// Protocol test vectors.
//
// The acceptance criterion for stage 2 is that a second implementation could be
// written from these alone. So each vector carries a prose description of what
// it demonstrates, the inputs in hex, the expected encoding, and the expected
// digest - never a reference to this code.

import { writeFileSync, mkdirSync } from 'node:fs';
import { Writer } from '../src/encode.js';
import { taggedHash, toHex } from '../src/hash.js';
import { TAG, PROTOCOL_VERSION } from '../src/constants.js';
import { buildCensus, leafHash, encodeEntry } from '../src/census.js';
import { selectCommittee, ticketFor, weightOf } from '../src/sortition.js';
import { computePayoutTable, rankWeights, DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../src/contracts.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS } from '../src/checkpoint.js';

const DIR = new URL('../../../test-vectors/protocol/', import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

const b32 = (n) => new Uint8Array(32).fill(n);
const out = {};

/* ------------------------------------------------------------------ hashes */
out.tagged = {
  what: 'Tagged hash. H_tag(x) = sha256(sha256(tag) || sha256(tag) || x).',
  cases: [
    { tag: TAG.roundContract, message: '', digest: toHex(taggedHash(TAG.roundContract, new Uint8Array(0))) },
    { tag: TAG.roundContract, message: '010203', digest: toHex(taggedHash(TAG.roundContract, new Uint8Array([1, 2, 3]))) },
    { tag: TAG.entryContract, message: '010203', digest: toHex(taggedHash(TAG.entryContract, new Uint8Array([1, 2, 3]))) },
  ],
  note: 'The last two share a body and differ only by tag. Any implementation that produces one digest for both has dropped the tag.',
};

/* ---------------------------------------------------------------- encoding */
{
  const w = new Writer();
  w.u8(1).u16(513).u32(70000).u64(1099511627776n).str('mempool').bytes32(b32(7));
  out.encoding = {
    what: 'Fixed-width big-endian primitives, then a u16-prefixed UTF-8 string, then 32 raw bytes.',
    sequence: ['u8 1', 'u16 513', 'u32 70000', 'u64 1099511627776', 'str "mempool"', 'bytes32 0x07*32'],
    hex: toHex(w.finish()),
    rules: [
      'u64 takes a BigInt only; a Number must be refused even when it would fit.',
      'str rejects unpaired surrogates rather than substituting U+FFFD.',
      'A vec is u16 count then items, and where the protocol says sorted the encoder asserts it.',
    ],
  };
}

/* ------------------------------------------------------------------ census */
{
  const mk = (n, bond, height) => ({
    txid: b32(n), vout: n % 3, pubkey: b32(200 - n),
    bondSats: BigInt(bond), height, roles: ['game', 'verify'], spent: false,
  });
  const entries = [mk(7, 100000, 800007), mk(3, 500000, 800003),
                   mk(11, 100000, 800011), mk(5, 2000000, 800005)];
  const c = buildCensus(entries, { censusHeight: 900000, minConfirmations: 6, tipHeight: 900100 });
  out.census = {
    what: 'Census canonicalisation: filter by height, maturity and spentness; sort by (txid, vout); Merkle-root the tagged leaves.',
    entries: c.entries.map((e) => ({
      txid: toHex(e.txid), vout: e.vout, bondSats: e.bondSats.toString(),
      height: e.height, roles: e.roles, encoded: toHex(encodeEntry(e)), leaf: toHex(leafHash(e)),
    })),
    root: toHex(c.root),
    rules: [
      'Sort by (txid, vout). NOT by H(pubkey): a pubkey can be ground until its hash lands where the operator wants, a txid cannot be chosen after funding.',
      'An odd level PROMOTES the last node. Duplicating it makes two leaf sets share a root, which is CVE-2012-2459.',
    ],
  };
}

/* --------------------------------------------------------------- sortition */
{
  const mk = (n, bond) => ({ txid: b32(n), vout: 0, pubkey: b32(n),
                             bondSats: BigInt(bond), height: 1, roles: ['game'], spent: false });
  const entries = [mk(1, 5000000), mk(2, 100000), mk(3, 100000), mk(4, 300000), mk(5, 100000)];
  const seed = b32(42);
  out.sortition = {
    what: 'Committee selection. score = ticket / weight, compared by cross-multiplication so no division ever happens.',
    committeeSeed: toHex(seed),
    bondMin: '100000',
    tickets: entries.map((e) => ({
      txid: toHex(e.txid), bondSats: e.bondSats.toString(),
      weight: weightOf(e.bondSats, 100000n).toString(),
      ticket: ticketFor(seed, e, 'game').toString(),
    })),
    selected: selectCommittee({ entries, committeeSeed: seed, role: 'game', slots: 3, bondMin: 100000n })
      .map((e) => toHex(e.txid)),
    rules: [
      'Weight is bond / bond_min, floored, minimum one. LINEAR.',
      'Square root weighting is wrong and looks right: four bonds at 1x total weight 4 against one at 4x with weight 2, so splitting doubles the chances.',
      'Compare a.ticket * b.weight against b.ticket * a.weight. Computing the quotient as a float is a consensus bug that only shows when two scores are close.',
    ],
  };
}

/* ------------------------------------------------------------------ payout */
{
  const pk = (n) => b32(n);
  const entries = [];
  for (let i = 0; i < 50; i++) entries.push({ pubkey: pk(i), stakeMsat: 100000n, outcome: DELIVERED, score: 50 });
  for (let i = 0; i < 25; i++) entries.push({ pubkey: pk(100 + i), stakeMsat: 100000n, outcome: DELIVERED, score: 900 });
  for (let i = 0; i < 25; i++) entries.push({ pubkey: pk(200 + i), stakeMsat: 100000n, outcome: FAILED, score: 0 });
  const r = computePayoutTable({ roundId: b32(9), entries, minScore: 1 });

  out.payout = {
    what: 'The worked example from specification 18A.6: 100 players at 100 sat, fifty on the quiet route and all arriving, fifty in the corridor with half of them lost.',
    roundId: toHex(b32(9)),
    minScore: 1,
    input: { delivered_low_score: 50, delivered_high_score: 25, failed: 25, stakeMsat: '100000' },
    pool: r.pool.toString(),
    qualifiers: r.qualifiers,
    payingRanks: r.payingRanks,
    rankWeights: rankWeights(r.payingRanks).map(String),
    totalPaidMsat: r.table.reduce((s, t) => s + t.amountMsat, 0n).toString(),
    distinctAmounts: [...new Set(r.table.map((t) => t.amountMsat.toString()))].sort(),
    rules: [
      'Millisatoshi BigInt only.',
      'Rank weights are 3^(i-1) * 4^(K-i): the geometric curve with r = 3/4, multiplied through so it is exact.',
      'K = ceil(qualifiers / 4), at least one.',
      'Floor each share, then hand the leftover out one millisatoshi at a time in ascending H(round_id || pubkey).',
      'sum(payouts) must equal sum(activated stakes). Fees are charged on top at entry and never appear here. A node that cannot satisfy this refuses to sign.',
    ],
  };
}

/* --------------------------------------------------------------- contracts */
{
  const c = {
    simCoreHash: b32(1), startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n,
    censusHeight: 964900, censusRoot: b32(2), committeeSeed: b32(3),
    stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000,
    exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792,
    timeFloor: 16384, timeCeil: 98304, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [b32(4), b32(7), b32(9)],
  };
  const e = {
    roundId: roundId(c), playerPubkey: b32(21), sessionPubkey: b32(22),
    stakeCommitment: b32(23), stakeMsat: 100000n, feeMsat: 2000n,
    donationMsat: 1000n, joinTick: 0,
  };
  out.contracts = {
    what: 'RoundContract and EntryContract. The RoundContract digest is the round_id.',
    protocolVersion: PROTOCOL_VERSION,
    roundContract: { hex: toHex(encodeRoundContract(c)), roundId: toHex(roundId(c)) },
    entryContract: { hex: toHex(encodeEntryContract(e)), entryId: toHex(entryId(e)) },
    rules: [
      'Field order is protocol. A new field means a new version, never an append.',
      'The version sits right after the type so an older reader fails loudly instead of mis-parsing.',
      'The node list is sorted and the encoder asserts it.',
      'Balance constants live in the contract because a client has to be able to see, before staking, whether the rank curve is flat.',
    ],
  };
}

/* -------------------------------------------------------------- checkpoint */
{
  const first = {
    roundId: b32(7), entryId: b32(9), tick: 600,
    stateHash: b32(0x5a), inputChainHash: b32(0x1c), previousHash: NO_PREVIOUS,
  };
  const second = { ...first, tick: 660, stateHash: b32(0x5b), previousHash: checkpointId(first) };
  const forged = { ...first, stateHash: b32(0x5b) };
  out.checkpoint = {
    what: 'A checkpoint: the state hash at an agreed tick, chained to the one before it.',
    protocolVersion: PROTOCOL_VERSION,
    fields: ['type u8', 'version u16', 'roundId 32', 'entryId 32', 'tick u32',
             'stateHash 32', 'inputChainHash 32', 'previousHash 32'],
    bytesOnTheWire: encodeCheckpoint(first).length,
    first: { hex: toHex(encodeCheckpoint(first)), checkpointId: toHex(checkpointId(first)) },
    second: { hex: toHex(encodeCheckpoint(second)), checkpointId: toHex(checkpointId(second)) },
    equivocation: {
      what: 'The same round, entry and tick with a different state hash. A different object, and that is the point.',
      hex: toHex(encodeCheckpoint(forged)),
      checkpointId: toHex(checkpointId(forged)),
    },
    rules: [
      'Nothing here is variable-length, so every checkpoint is the same size on the wire.',
      'The first checkpoint of a round chains to thirty-two zero bytes, as an input batch does.',
      'The entry id names the player: it is the hash of the contract that carries the key.',
      'There is no signature in this version. It proves storage and equivocation, not that the player committed at that time.',
    ],
  };
}

for (const [name, body] of Object.entries(out))
  writeFileSync(DIR + name + '.json', JSON.stringify(body, null, 1) + '\n');

writeFileSync(DIR + 'index.json', JSON.stringify({
  package: '@blwp/protocol',
  protocolVersion: PROTOCOL_VERSION,
  produced: 'packages/protocol/tools/make-vectors.js',
  claim: 'A second implementation is correct if and only if it reproduces every value here.',
  vectors: Object.keys(out),
}, null, 1) + '\n');

console.log('wrote ' + Object.keys(out).length + ' vector files to test-vectors/protocol/');
for (const k of Object.keys(out)) console.log('  ' + k);
