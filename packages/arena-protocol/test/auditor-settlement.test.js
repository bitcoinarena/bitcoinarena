// THE AUDITORS' LINE IN A ROUND'S PAYOUT (spec §13A.1, kanban #725, protocol 22): 10 % of the nodes' part, after the website's line,
// equally to the auditors whose AUDIT the seats hold - off the nodes' part only: the winner's line and the donation are untouched; a round
// before protocol 22, or one with no AUDIT held, pays exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockSettlement } from '../src/lock-settlement.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { entryFeeMsat } from '../src/fee.js';
import { toHex } from '../src/hash.js';
import { AUDITOR_VERSION } from '../src/constants.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const N = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
const STAKE = 10000000n;
// the entries and their locks at a fee: 5 % before protocol 11, the nodes' 4 % from it (§0A.8, §27A.9)
const roundOf = (fee) => {
  const e = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: fee, donationMsat: 0n, outcome, score });
  const W = e(1, DELIVERED, 5), L = e(2, FAILED, 0);
  return { entries: [W, L],
    locks: new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x40 + i), outIdx: BigInt(i) }, amountMsat: STAKE - fee, refundPk: refund(i + 1) }])),
    feeLocks: new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x80 + i), outIdx: BigInt(i) }, amountMsat: fee, preimage: b32(0xf0 + i) }])) };
};
const nodes = [N(1), N(2)];
const contractOf = (protocolVersion) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
  ...(protocolVersion === undefined ? {} : { protocolVersion }),
});
const fees = { ppm: 0n, baseMsat: 1000n };
const AUD = [toHex(N(7)), toHex(N(8))];
const plan = (contract, auditors) => {
  const r = roundOf(Number(contract.protocolVersion) >= 11 ? (STAKE * 4n) / 100n : entryFeeMsat(STAKE));
  return lockSettlement({ roundId: b32(0x5f), entries: r.entries, minScore: 1, locks: r.locks, feeLocks: r.feeLocks, fees, contract,
    signerNodes: { gameVerify: nodes, settlement: nodes, ...(auditors ? { auditors } : {}) } });
};
const of = (p, kind) => p.payouts.filter((x) => x.kind === kind);
const sum = (xs) => xs.reduce((t, x) => t + x.msat + x.feeMsat, 0n);

test('from protocol 22: each auditor holding an AUDIT a line off the nodes\' part; the winner untouched', () => {
  const contract = contractOf(undefined);
  const before = plan(contract, null);
  assert.equal(before.ok, true, before.why);
  // the same round as protocol 22: the version only names the rule; a contract field the settlement reads otherwise is the same
  const v22 = { ...contract, protocolVersion: AUDITOR_VERSION };
  const none = plan(v22, null), withAud = plan(v22, AUD);
  assert.equal(none.ok, true, none.why);
  assert.equal(withAud.ok, true, withAud.why);
  const lines = of(withAud, 'auditor');
  assert.deepEqual(lines.map((x) => toHex(x.payoutPk).slice(0, 4)), ['02a7', '02a8'], 'one line each, to the key\'s even-y form');
  assert.equal(lines[0].msat, lines[1].msat, 'equal shares');
  const nodesPart = sum(of(none, 'signer node'));
  assert.ok(lines[0].owedMsat * 20n >= nodesPart - 4000n && lines[0].owedMsat * 20n <= nodesPart + 4000n,
    `each about 5 % of the nodes' part: ${lines[0].owedMsat} of ${nodesPart}`);
  assert.equal(sum(of(none, 'signer node')) - sum(of(withAud, 'signer node')), sum(lines), 'the seats give up exactly the auditors\' lines');
  assert.deepEqual(of(withAud, 'qualifier').map((x) => x.msat), of(none, 'qualifier').map((x) => x.msat), 'the winner untouched');
  assert.deepEqual(plan(v22, []).payouts, none.payouts, 'no AUDIT held: as before');
});

test('before protocol 22 an auditor list changes nothing', () => {
  const contract = contractOf(undefined);
  assert.deepEqual(plan(contract, AUD).payouts, plan(contract, null).payouts);
});
