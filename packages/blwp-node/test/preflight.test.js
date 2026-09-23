// CAN A LIGHTNING NODE HOLD A ROUND'S STAKES - decided from its own JSON.
//
// The shape the operator's testnet4 lnd answered on 2026-09-10 is the first
// fixture: synced, one active channel of 400000 sat, 396530 on our side and 0
// on the other. A hold invoice is received money, so that node cannot take one
// stake, and until this file nothing said so before a player's payment failed.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { lightningPreflight, askLnd, askLndRegtest, MIN_PLAYERS_PER_ROUND } from '../src/preflight.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { BLOCK_TICKS as RUN_TICKS } from '../../core/src/rules/gate.js';   // `Round.open` refuses another

// TWO GATEWAYS THAT CAN RECEIVE (§23.6) AND A CHAIN WITH REAL BLOCKS. Both rules landed after this file was
// written, and both are refusals when unanswered: a paying round needs two independent gateways, and a hold
// must outlive the round it secures. Neither is what these tests are about, so both are given.
const GATEWAYS = [
  { identityPubkey: '02'.padEnd(66, '1'), rpc: '127.0.0.1:1', syncedToChain: true, channels: [{ active: true, remoteBalanceSat: 1000000n }] },
  { identityPubkey: '03'.padEnd(66, '2'), rpc: '127.0.0.1:2', syncedToChain: true, channels: [{ active: true, remoteBalanceSat: 1000000n }] },
];
const ROUND = { blockTicks: 10800, objectionWindowMs: 600000n, stakeExpiryBlocks: 144 };
const CHAIN = { round: ROUND, secondsPerBlock: 600 };
const able = (o) => ({ gateways: GATEWAYS, ...CHAIN, ...o });


const STAKE = 100000n;
const signerNode = (donationMsat = 0n, stakeMsat = STAKE) =>
  ({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat });
const info = (network = 'testnet4', synced = true) =>
  ({ synced_to_chain: synced, block_height: 151773, chains: [{ chain: 'bitcoin', network }] });
const channel = (local, remote, reserve = 4000) => ({
  active: true, capacity: String(local + remote), local_balance: String(local),
  remote_balance: String(remote), remote_constraints: { chan_reserve_sat: String(reserve) },
});

test('the testnet4 node as measured cannot hold one stake, and says how short it is', slice2(), () => {
  const said = lightningPreflight(able({
    info: info(), channels: [channel(396530, 0)], holdInvoices: true, players: 2, entry: signerNode(),
  }));
  assert.equal(said.ready, false);
  assert.equal(said.facts.heldPerSignerNodeMsat, 98000n, 'the hold is not the net of the 2% fee');
  assert.equal(said.facts.inboundMsat, 0n);
  assert.match(said.why, /2 holds of 98000 msat need 196000 msat of inbound, and the channels offer 0/);
  console.log(`  as measured: ${said.why}`);
});

test('a node with enough inbound, synced, offering holds, is ready - and the reserve is not inbound', slice2(), () => {
  const ok = lightningPreflight(able({
    info: info(), channels: [channel(200000, 200000)], holdInvoices: true, players: 2, entry: signerNode(),
  }));
  assert.equal(ok.ready, true, ok.why);
  assert.equal(ok.facts.inboundMsat, (200000n - 4000n) * 1000n, 'the peer\'s reserve was counted as spendable');

  // one msat short of two holds, once the reserve is taken off
  const short = lightningPreflight(able({
    info: info(), channels: [channel(0, 4000 + 195)], holdInvoices: true, players: 2, entry: signerNode(),
  }));
  assert.equal(short.ready, false);
  assert.match(short.why, /need 196000 msat of inbound, and the channels offer 195000/);
});

test('mainnet is refused by name before anything is computed', slice2(), () => {
  const said = lightningPreflight(able({
    info: info('mainnet'), channels: [channel(0, 10000000)], holdInvoices: true, players: 2, entry: signerNode(),
  }));
  assert.equal(said.ready, false);
  assert.deepEqual(said.facts, {}, 'a mainnet node was measured as if it might be used');
  assert.match(said.why || said.missing[0], /MAINNET/);
  const other = lightningPreflight(able({
    info: info('signet'), channels: [channel(0, 400000)], holdInvoices: true, players: 1, entry: signerNode(),
  }));
  assert.equal(other.ready, false);
  assert.match(other.why, /on signet, and rounds hold stakes only on testnet4 or regtest/);
});

test('an unsynced node, a node with no channel and a node without holds are each named', slice2(), () => {
  const said = lightningPreflight(able({ info: info('testnet4', false), channels: [], holdInvoices: false, players: 1, entry: signerNode() }));
  assert.equal(said.ready, false);
  assert.match(said.why, /not synced/);
  assert.match(said.why, /no active channel/);
  assert.match(said.why, /does not offer addholdinvoice/);
  // an inactive channel is no channel
  const idle = lightningPreflight(able({
    info: info(), channels: [{ ...channel(0, 400000), active: false }], holdInvoices: true, players: 1, entry: signerNode(),
  }));
  assert.match(idle.why, /no active channel/);
});

test('a round that asks no stake is ready with no channel at all (M3.3-19)', slice2(), () => {
  const said = lightningPreflight(able({ info: info(), channels: [], holdInvoices: false, players: 2, entry: signerNode(0n, 0n) }));
  assert.equal(said.ready, true, said.why);
  assert.match(said.why, /needs no inbound and no channel/);
});

test('the inbound a round needs is the NET hold, so a donating signer node needs less', slice2(), () => {
  const plain = lightningPreflight(able({ info: info(), channels: [channel(0, 400000)], holdInvoices: true, players: 3, entry: signerNode() }));
  const giving = lightningPreflight(able({ info: info(), channels: [channel(0, 400000)], holdInvoices: true, players: 3, entry: signerNode(5000n) }));
  assert.equal(plain.facts.neededMsat, 3n * 98000n);
  assert.equal(giving.facts.neededMsat, 3n * 93000n);
  // and a signer node whose fee and donation exceed its stake is refused, not measured
  assert.throws(() => lightningPreflight(able({ info: info(), players: 1, entry: signerNode(200000n) })), /cannot come to more than it/);
});

/* ---------------------------------------------------------------- the gate */

// A round is opened on POST /round. A node that HOLDS stakes - it was given a
// Lightning port - opens a round that asks one only when its preflight says
// the node can hold it; a round that asks nothing never asks the preflight.
const NOW = 1788700000000;
const b32g = (n) => new Uint8Array(32).fill(n);
const contractFor = (nodes, stakeMsat) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS, entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32g(2), stakeMsat, bondMinSats: 50000n, blockTicks: RUN_TICKS,
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
const asMeasured = async ({ contract }) => lightningPreflight(able({
  info: info(), channels: [channel(396530, 0)], holdInvoices: true, players: MIN_PLAYERS_PER_ROUND,
  entry: { stakeMsat: contract.stakeMsat, feeMsat: entryFeeMsat(contract.stakeMsat), donationMsat: 0n },
}));

test('a node that cannot hold a stake refuses to open a round that asks one, and says how short it is', slice2(), async () => {
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

test('a READY node opens the paying round', slice2(), async () => {
  const o = await opener({ lightning: deadPort, preflight: async () => ({ ready: true, why: 'enough inbound' }) });
  try { assert.equal((await o.open(STAKE)).status, 201); } finally { await o.close(); }
});

test('a node that holds stakes and was given no preflight opens no paying round - it fails closed', slice2(), async () => {
  const o = await opener({ lightning: deadPort });
  try {
    const paid = await o.open(STAKE);
    assert.equal(paid.status, 503);
    assert.match(paid.why, /no preflight/);
    assert.equal((await o.open(0n)).status, 201, 'the free round was refused too');
  } finally { await o.close(); }
});

test('a preflight that throws is a refusal, named', slice2(), async () => {
  const o = await opener({ lightning: deadPort, preflight: async () => { throw new Error('lncli getinfo refused'); } });
  try {
    const paid = await o.open(STAKE);
    assert.equal(paid.status, 503);
    assert.match(paid.why, /lncli getinfo refused/);
  } finally { await o.close(); }
});

test('a node with no Lightning at all opens a paying round as before - it holds nothing', slice2(), async () => {
  const o = await opener({});
  try { assert.equal((await o.open(STAKE)).status, 201); } finally { await o.close(); }
});

test('askLnd refuses a node that is not testnet4 by its own lnd.conf, before any call, and never asks with a spending key', slice2(), () => {
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

test('a regtest lnd is asked with its read-only key and the port\'s own flags, and refused if it answers as another network', slice2(), () => {
  // Before: a regtest daemon given Lightning had no preflight at all, and a
  // node with a port and no preflight opens no paying round (measured 503).
  const asked = [];
  const answering = (network) => (bin, argv) => {
    asked.push(argv);
    if (argv.includes('--help')) return '';
    if (argv[argv.length - 1] === 'getinfo')
      return JSON.stringify({ synced_to_chain: true, chains: [{ network }] });
    return JSON.stringify({ channels: [{ active: true, remote_balance: '500000', local_balance: '0' }] });
  };
  const got = askLndRegtest({ lncli: 'lncli', lnddir: '/x/bob', rpc: '127.0.0.1:1', run: answering('regtest') });
  assert.equal(got.info.chains[0].network, 'regtest');
  assert.equal(got.channels.length, 1);
  assert.equal(got.holdInvoices, true);
  for (const argv of asked.filter((a) => !a.includes('--help'))) {
    assert.ok(argv.includes('--macaroonpath=/x/bob/data/chain/bitcoin/regtest/readonly.macaroon'),
      `asked without the read-only key: ${argv.join(' ')}`);
    assert.ok(argv.includes('--rpcserver=127.0.0.1:1') && argv.includes('--network=regtest'));
  }
  assert.throws(() => askLndRegtest({ lncli: 'lncli', lnddir: '/x/bob', rpc: '127.0.0.1:1', run: answering('testnet4') }),
    /answers as testnet4, not regtest/);
});

/** Why this test does not run in Step 1 of the THRESHOLD_LN disposal (see TASKBOOK). */
function slice2() { return { skip: "slice 2: the subject is the hold path (hold invoices on a Lightning port). It still runs at HEAD on a FEDERATION round given a Lightning port, so it is skipped, not moved to FEDERATION (RULED 2026-09-23); slice 2 deletes this test with the code" }; }
