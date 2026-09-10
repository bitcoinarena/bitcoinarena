// CAN A LIGHTNING NODE HOLD A ROUND'S STAKES - decided from its own JSON.
//
// The shape the operator's testnet4 lnd answered on 2026-09-10 is the first
// fixture: synced, one active channel of 400000 sat, 396530 on our side and 0
// on the other. A hold invoice is received money, so that node cannot take one
// stake, and until this file nothing said so before a player's payment failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightningPreflight } from '../src/preflight.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const STAKE = 100000n;
const seat = (donationMsat = 0n, stakeMsat = STAKE) =>
  ({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat });
const info = (network = 'testnet4', synced = true) =>
  ({ synced_to_chain: synced, block_height: 151773, chains: [{ chain: 'bitcoin', network }] });
const channel = (local, remote, reserve = 4000) => ({
  active: true, capacity: String(local + remote), local_balance: String(local),
  remote_balance: String(remote), remote_constraints: { chan_reserve_sat: String(reserve) },
});

test('the testnet4 node as measured cannot hold one stake, and says how short it is', () => {
  const said = lightningPreflight({
    info: info(), channels: [channel(396530, 0)], holdInvoices: true, players: 2, entry: seat(),
  });
  assert.equal(said.ready, false);
  assert.equal(said.facts.heldPerSeatMsat, 98000n, 'the hold is not the net of the 2% fee');
  assert.equal(said.facts.inboundMsat, 0n);
  assert.match(said.why, /2 holds of 98000 msat need 196000 msat of inbound, and the channels offer 0/);
  console.log(`  as measured: ${said.why}`);
});

test('a node with enough inbound, synced, offering holds, is ready - and the reserve is not inbound', () => {
  const ok = lightningPreflight({
    info: info(), channels: [channel(200000, 200000)], holdInvoices: true, players: 2, entry: seat(),
  });
  assert.equal(ok.ready, true, ok.why);
  assert.equal(ok.facts.inboundMsat, (200000n - 4000n) * 1000n, 'the peer\'s reserve was counted as spendable');

  // one msat short of two holds, once the reserve is taken off
  const short = lightningPreflight({
    info: info(), channels: [channel(0, 4000 + 195)], holdInvoices: true, players: 2, entry: seat(),
  });
  assert.equal(short.ready, false);
  assert.match(short.why, /need 196000 msat of inbound, and the channels offer 195000/);
});

test('mainnet is refused by name before anything is computed', () => {
  const said = lightningPreflight({
    info: info('mainnet'), channels: [channel(0, 10000000)], holdInvoices: true, players: 2, entry: seat(),
  });
  assert.equal(said.ready, false);
  assert.deepEqual(said.facts, {}, 'a mainnet node was measured as if it might be used');
  assert.match(said.why || said.missing[0], /MAINNET/);
  const other = lightningPreflight({
    info: info('signet'), channels: [channel(0, 400000)], holdInvoices: true, players: 1, entry: seat(),
  });
  assert.equal(other.ready, false);
  assert.match(other.why, /on signet, and rounds hold stakes only on testnet4 or regtest/);
});

test('an unsynced node, a node with no channel and a node without holds are each named', () => {
  const said = lightningPreflight({ info: info('testnet4', false), channels: [], holdInvoices: false, players: 1, entry: seat() });
  assert.equal(said.ready, false);
  assert.match(said.why, /not synced/);
  assert.match(said.why, /no active channel/);
  assert.match(said.why, /does not offer addholdinvoice/);
  // an inactive channel is no channel
  const idle = lightningPreflight({
    info: info(), channels: [{ ...channel(0, 400000), active: false }], holdInvoices: true, players: 1, entry: seat(),
  });
  assert.match(idle.why, /no active channel/);
});

test('a round that asks no stake is ready with no channel at all (M3.3-19)', () => {
  const said = lightningPreflight({ info: info(), channels: [], holdInvoices: false, players: 2, entry: seat(0n, 0n) });
  assert.equal(said.ready, true, said.why);
  assert.match(said.why, /needs no inbound and no channel/);
});

test('the inbound a round needs is the NET hold, so a donating seat needs less', () => {
  const plain = lightningPreflight({ info: info(), channels: [channel(0, 400000)], holdInvoices: true, players: 3, entry: seat() });
  const giving = lightningPreflight({ info: info(), channels: [channel(0, 400000)], holdInvoices: true, players: 3, entry: seat(5000n) });
  assert.equal(plain.facts.neededMsat, 3n * 98000n);
  assert.equal(giving.facts.neededMsat, 3n * 93000n);
  // and a seat whose fee and donation exceed its stake is refused, not measured
  assert.throws(() => lightningPreflight({ info: info(), players: 1, entry: seat(200000n) }), /cannot come to more than it/);
});
