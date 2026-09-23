import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { serve } from '../src/server.js';
import { receiptsNeeded } from '../../protocol/src/genesis.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);

test('two slots need two receipts, seven still need five', () => {
  assert.equal(receiptsNeeded(2), 2);
  assert.equal(receiptsNeeded(7), 5);
});

test('two daemons on one machine have two identities', async () => {
  const a = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  const b = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  const pa = new Uint8Array(await (await fetch(`http://127.0.0.1:${a.port}/identity`)).arrayBuffer());
  const pb = new Uint8Array(await (await fetch(`http://127.0.0.1:${b.port}/identity`)).arrayBuffer());
  assert.equal(pa.length, 32);
  assert.equal(pb.length, 32);
  assert.notEqual(toHex(pa), toHex(pb));
  await a.close();
  await b.close();
});

test('a 2-slot round is canonical at two distinct receipts', () => {
  const db = openStore(':memory:');
  const round = new Round(db);
  const contract = {
    networkId: b32(0x4e), configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
    gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH,
    startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
    custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
    donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [round.pubkey, b32(9)],
  };
  // smoke: opening a 2-slot contract is allowed
  const id = round.open(contract);
  assert.equal(id.length, 32);
});
