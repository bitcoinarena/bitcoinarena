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
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { commitCensus, leafHash, encodeEntry } from '../src/census.js';
import { selectCommittee, ticketFor, weightOf } from '../src/sortition.js';
import { computePayoutTable, rankWeights, DELIVERED, FAILED, FORFEIT, VOID } from '../src/payout.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../src/contracts.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, CHECKPOINT_BYTES, SIGNED_CHECKPOINT_BYTES } from '../src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, RECEIPT_BYTES, SIGNED_RECEIPT_BYTES } from '../src/receipt.js';
import { encodeAdvert, advertId, ADVERT_SIGNATURE_BYTES } from '../src/advert.js';
import { chainOf as minedChain } from './chainview.js';

/**
 * A view spanning the census height: from it to `tip`. A view that begins
 * after `census_height` carries no block the census is about and is refused,
 * so a fixture cannot start at the tip and call itself a chain.
 */
const spanning = (from, tip) =>
  minedChain(Array.from({ length: tip - from + 1 }, () => ({ transactions: [] })), from);


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
    txid: b32(n), vout: n % 3, pubkey: b32(200 - n), advertId: b32(n + 60),
    bondSats: BigInt(bond), height, roles: ['game', 'verify'], spent: false,
  });
  const entries = [mk(7, 100000, 800007), mk(3, 500000, 800003),
                   mk(11, 100000, 800011), mk(5, 2000000, 800005)];
  const c = commitCensus(entries, { contract: { censusHeight: 900000, censusConfirmations: 6 }, view: spanning(900000, 900100) });
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
    // The seed is the lottery's input, not a contract field: 5A.5 derives it
    // from the beacon and section 6's contract carries none.
    selected: selectCommittee({ entries, role: 'game', committeeSeed: seed,
      contract: { networkId: NETWORK_ID_REGTEST, gameVerifySlots: 3, bondMinSats: 100000n } })
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
  // 6e: an entry as the door takes it - 100 sat committed, the 2% fee OUT of
  // it, no donation - so every amount below is a net stake of 98 sat.
  const money = { stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n };
  const entries = [];
  for (let i = 0; i < 50; i++) entries.push({ pubkey: pk(i), ...money, outcome: DELIVERED, score: 50 });
  for (let i = 0; i < 25; i++) entries.push({ pubkey: pk(100 + i), ...money, outcome: DELIVERED, score: 900 });
  for (let i = 0; i < 25; i++) entries.push({ pubkey: pk(200 + i), ...money, outcome: FAILED, score: 0 });
  const r = computePayoutTable({ roundId: b32(9), entries, minScore: 1 });

  out.payout = {
    what: 'The worked example from specification 18A.6: 100 players at 100 sat, fifty on the quiet route and all arriving, fifty in the corridor with half of them lost. Collected inclusively (22A): each commits 100 sat, 2 of it the node fee, 98 staked.',
    roundId: toHex(b32(9)),
    minScore: 1,
    input: { delivered_low_score: 50, delivered_high_score: 25, failed: 25, stakeMsat: '100000', feeMsat: '2000', donationMsat: '0' },
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
      'Every amount is a NET stake: stakeMsat less the feeMsat and donationMsat that come out of it (22A, inclusive). The hold invoice is for the net, and the pool is the net stakes of FAILED and FORFEIT entries.',
      'sum(payouts) must equal sum(activated net stakes). A node that cannot satisfy this refuses to sign.',
      'Qualifiers who staked different nets are refused while there is a pool: 22A weights a share by net stake and, as written, that does not spend the pool.',
    ],
  };
}

/* --------------------------------------------------------------- contracts */
{
  const c = {
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: new Uint8Array(32).fill(0xd0),
    censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000,
    exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792,
    timeFloor: 16384, timeCeil: 98304, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [b32(4), b32(7), b32(9)],
  };
  const e = {
    roundId: roundId(c), playerPubkey: b32(21), sessionPubkey: b32(22),
    stakeCommitment: b32(23), stakeMsat: 100000n, feeMsat: 2000n,
    donationMsat: 1000n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
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
    bytesSigned: SIGNED_CHECKPOINT_BYTES,
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
      'The signature sits BESIDE the object, as a 64-byte suffix, so the id is the same whether or not the mark is signed and previousHash never has to move.',
      'What is signed is the checkpointId - the tagged hash - and not the raw encoding, so a signature cannot be replayed over another object with the same bytes.',
      'The player signs with the session key; the verifier is sessionPubkey on the Entry Contract. The curve is ed25519 and the verifying lives in the node, not here.',
    ],
  };
}

/* ----------------------------------------------------------------- receipt */
{
  const marked = {
    roundId: b32(7), entryId: b32(9), tick: 600,
    stateHash: b32(0x5a), inputChainHash: b32(0x1c), previousHash: NO_PREVIOUS,
  };
  const one = {
    checkpointId: checkpointId(marked),
    receivedAtMs: 1788600000000n,
    nodePubkey: b32(0x2b),
  };
  const otherNode = { ...one, nodePubkey: b32(0x2c) };
  out.receipt = {
    what: 'A checkpoint receipt: a node saying it held this mark at this time.',
    protocolVersion: PROTOCOL_VERSION,
    fields: ['type u8', 'version u16', 'checkpointId 32', 'receivedAtMs u64', 'nodePubkey 32'],
    bytesOnTheWire: RECEIPT_BYTES,
    bytesSigned: SIGNED_RECEIPT_BYTES,
    receipt: { hex: toHex(encodeCheckpointReceipt(one)), receiptId: toHex(receiptId(one)) },
    fromAnotherNode: {
      what: 'The same mark, the same instant, a different signer. Five receipts for one checkpoint are five objects.',
      hex: toHex(encodeCheckpointReceipt(otherNode)),
      receiptId: toHex(receiptId(otherNode)),
    },
    rules: [
      'checkpointId alone names the mark: it is the tagged hash of an object that already carries the round and the entry.',
      'nodePubkey is carried although IMPLEMENTATION.md\'s wire line omits it, because a receipt travels inside the round record where there is no connection to ask who signed. EntryReceipt carries it for the same reason.',
      'The signature sits BESIDE the object, a 64-byte suffix, so the id does not move when it is signed.',
      'receivedAtMs is the node\'s clock: evidence of what it saw and when, never a source of truth about the round.',
      'Nothing issues one yet. A node signs with its own key and the daemon has none - that waits on the bond advertisement (M2.1 step 5b).',
    ],
  };
}

/* --------------------------------------------------------------- advertisement */
{
  const one = {
    nodePubkey: b32(0x11), operatorId: 'example operator', protocolVersions: [1],
    roles: ['game', 'verify'], endpoint: 'wss://node.example:443', region: 'eu-west',
    capacityClass: 2, softwareHash: b32(0x33), settlementCapabilities: 0,
    lightningCapabilities: 0, bondTxid: b32(0x44), bondVout: 0,
    bondScriptTemplateVersion: 1, payoutPubkey: b32(0x55), timestamp: 1788700000000n,
  };
  const moved = { ...one, endpoint: 'wss://somewhere-else.example:443' };
  out.advert = {
    what: 'A node advertisement: who a node is, and where to reach it. The bond output commits to its hash.',
    protocolVersion: PROTOCOL_VERSION,
    fields: [
      'type u8', 'version u16', 'nodePubkey 32', 'operatorId str',
      'protocolVersions vec<u16>', 'roles vec<u8>', 'endpoint str', 'region str',
      'capacityClass u8', 'softwareHash 32', 'settlementCapabilities u32',
      'lightningCapabilities u32', 'bondTxid 32', 'bondVout u32',
      'bondScriptTemplateVersion u16', 'payoutPubkey 32', 'timestamp u64',
    ],
    signatureBytes: ADVERT_SIGNATURE_BYTES,
    advert: { hex: toHex(encodeAdvert(one)), advertId: toHex(advertId(one)) },
    withTheEndpointSwapped: {
      what: 'The same node, one field changed. A different id, which is the whole point: the bond output commits to the body.',
      hex: toHex(encodeAdvert(moved)),
      advertId: toHex(advertId(moved)),
    },
    rules: [
      'The advertisement is NOT what makes a node eligible (5A.1). The bond output is; this is the body it commits to.',
      'bondOutpoint is mandatory, so chain data alone identifies both the node and its terms.',
      'The signature sits BESIDE the object, as for a checkpoint and a receipt: inside, the id would move the moment it was signed, and the bond output commits to a body fixed when the funding transaction is built.',
      'The endpoint is fixed for the life of the bond. A server move means a new funding transaction and new confirmations (25.1).',
      'operatorId is self-declared (5A.13) and is never treated as proof of identity.',
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
