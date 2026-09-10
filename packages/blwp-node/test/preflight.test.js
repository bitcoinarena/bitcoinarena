// CAN A LIGHTNING NODE HOLD A ROUND'S STAKES - decided from its own JSON.
//
// The shape the operator's testnet4 lnd answered on 2026-09-10 is the first
// fixture: synced, one active channel of 400000 sat, 396530 on our side and 0
// on the other. A hold invoice is received money, so that node cannot take one
// stake, and until this file nothing said so before a player's payment failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightningPreflight, askLnd, MIN_PLAYERS_PER_ROUND } from '../src/preflight.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';

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

/* ---------------------------------------------------------------- the gate */

// A round is opened on POST /round. A node that HOLDS stakes - it was given a
// Lightning port - opens a round that asks one only when its preflight says
// the node can hold it; a round that asks nothing never asks the preflight.
const NOW = 1788700000000;
const b32g = (n) => new Uint8Array(32).fill(n);
const contractFor = (nodes, stakeMsat) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32g(0x43), censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32g(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS, entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32g(0xd0), censusHeight: 900000,
  censusRoot: b32g(2), stakeMsat, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
// A port that can only fail: a gate that let a round through could still hold nothing.
const deadPort = { createHeld: async () => { throw new Error('held'); }, look: async () => ({}),
  settle: async () => { throw new Error('settled'); }, cancel: async () => { throw new Error('cancelled'); } };

async function opener(opts) {
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true, now: () => NOW, ...opts });
  const open = async (stake) => {
    const r = await fetch(`http://127.0.0.1:${node.port}/round`,
      { method: 'POST', body: encodeRoundContract(contractFor([node.round.pubkey], stake)) });
    return { status: r.status, why: r.status === 201 ? '' : (await r.text()).trim() };
  };
  return { open, close: () => node.close() };
}

// The node as measured, fed to the same preflight the daemon runs.
const asMeasured = async ({ contract }) => lightningPreflight({
  info: info(), channels: [channel(396530, 0)], holdInvoices: true, players: MIN_PLAYERS_PER_ROUND,
  entry: { stakeMsat: contract.stakeMsat, feeMsat: entryFeeMsat(contract.stakeMsat), donationMsat: 0n },
});

test('a node that cannot hold a stake refuses to open a round that asks one, and says how short it is', async () => {
  const asked = [];
  const o = await opener({ lightning: deadPort, preflight: async (x) => { asked.push(x); return asMeasured(x); } });
  try {
    const paid = await o.open(STAKE);
    assert.equal(paid.status, 503, 'a paying round was opened on a node with no inbound');
    assert.match(paid.why, /2 holds of 98000 msat need 196000 msat of inbound, and the channels offer 0/);
    assert.equal(asked.length, 1);
    // A ROUND THAT ASKS NOTHING NEVER ASKS THE PREFLIGHT (M3.3-19)
    const free = await o.open(0n);
    assert.equal(free.status, 201, free.why);
    assert.equal(asked.length, 1, 'a free round was made to wait on Lightning');
    console.log(`  refused: ${paid.why}`);
  } finally { await o.close(); }
});

test('a READY node opens the paying round', async () => {
  const o = await opener({ lightning: deadPort, preflight: async () => ({ ready: true, why: 'enough inbound' }) });
  try { assert.equal((await o.open(STAKE)).status, 201); } finally { await o.close(); }
});

test('a node that holds stakes and was given no preflight opens no paying round - it fails closed', async () => {
  const o = await opener({ lightning: deadPort });
  try {
    const paid = await o.open(STAKE);
    assert.equal(paid.status, 503);
    assert.match(paid.why, /no preflight/);
    assert.equal((await o.open(0n)).status, 201, 'the free round was refused too');
  } finally { await o.close(); }
});

test('a preflight that throws is a refusal, named', async () => {
  const o = await opener({ lightning: deadPort, preflight: async () => { throw new Error('lncli getinfo refused'); } });
  try {
    const paid = await o.open(STAKE);
    assert.equal(paid.status, 503);
    assert.match(paid.why, /lncli getinfo refused/);
  } finally { await o.close(); }
});

test('a node with no Lightning at all opens a paying round as before - it holds nothing', async () => {
  const o = await opener({});
  try { assert.equal((await o.open(STAKE)).status, 201); } finally { await o.close(); }
});

test('askLnd refuses a node that is not testnet4 by its own lnd.conf, before any call, and never asks with a spending key', () => {
  const calls = [];
  const run = (bin, argv) => { calls.push(argv); return argv.includes('listchannels') ? '{"channels":[]}' : '{"chains":[{"network":"testnet4"}]}'; };
  assert.throws(() => askLnd({ lncli: 'lncli', lnddir: '/x/lnd-mainnet', run, read: () => 'bitcoin.testnet4=true\n' }), /not a testnet4 lnd/);
  assert.throws(() => askLnd({ lncli: 'lncli', lnddir: '/x/lnd', run, read: () => 'bitcoin.mainnet=true\n' }), /not a testnet4 lnd/);
  assert.equal(calls.length, 0, 'a non-testnet4 node was asked anything');
  askLnd({ lncli: 'lncli', lnddir: '/x/lnd-t4', run, read: () => 'bitcoin.testnet4=true\nrpclisten=127.0.0.1:11009\n' });
  const asks = calls.filter((a) => !a.includes('--help'));
  assert.ok(asks.length >= 2);
  for (const a of asks) {
    assert.ok(a.includes('--macaroonpath=/x/lnd-t4/data/chain/bitcoin/testnet4/readonly.macaroon'),
      `a call carried another key: ${a.join(' ')}`);
    assert.ok(a.includes('--network=testnet4') && a.includes('--rpcserver=127.0.0.1:11009'));
  }
});
