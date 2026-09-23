// The protocol has to agree across engines too - it computes round_ids that
// pin money, and a browser client derives them independently of the node.
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { taggedHash, toHex } from '../src/hash.js';
import { encodeRoundContract, roundId } from '../src/contracts.js';
import { computePayoutTable, DELIVERED, FAILED } from '../src/payout.js';
const say = (m) => { if (typeof print === 'function') print(m); else console.log(m); };
const b32 = (n) => new Uint8Array(32).fill(n);
const c = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: new Uint8Array(32).fill(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000,
  exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792,
  timeFloor: 16384, timeCeil: 98304, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4), b32(7), b32(9)],
};
say('round_id ' + toHex(roundId(c)));
const entries = [];
for (let i = 0; i < 50; i++) entries.push({ pubkey: b32(i), stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n, outcome: DELIVERED, score: 50 });
for (let i = 0; i < 25; i++) entries.push({ pubkey: b32(100 + i), stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n, outcome: DELIVERED, score: 900 });
for (let i = 0; i < 25; i++) entries.push({ pubkey: b32(200 + i), stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n, outcome: FAILED, score: 0 });
const r = computePayoutTable({ roundId: b32(9), entries, minScore: 1 });
say('payout ' + r.pool + ' ' + r.payingRanks + ' ' + r.table.reduce((s,t)=>s+t.amountMsat,0n));
