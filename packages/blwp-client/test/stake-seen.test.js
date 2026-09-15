// HOW MANY SETTLEMENT NODES HAVE SEEN THIS STAKE HELD - M3.3-21, §23.1 step 5.
//
// "STAKE_COMMITTED is recorded once >=5 settlement nodes have seen the held
// HTLC." Each node already refuses play until ITS Lightning shows the stake held
// and answers `GET /stake`; the page asked only the node it joined, and printed
// the node's join-time `x-hold` word - which says HELD for an invoice nobody has
// paid, because lnd's OPEN and ACCEPTED both read as held.
//
// So the page counts: every settlement signer node is asked, and the line is
// "stake seen by N of M nodes (T needed)". M is the round's settlement signer nodes
// (keys, from `fetchSettlementSignerNodes`), found at the node addresses the page
// holds through each node's own `GET /identity`. T is 2 on a two-slot round and
// 5 otherwise - the shape `receiptsForLive` already has. A signer node with no address
// that answers is counted as not seen, and the line says how many did not
// answer. COMMITTED is a label, true only at N >= T. It does not gate driving:
// the late-payer path stays, and each node still refuses its own receipt.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../blwp-node/src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { HELD } from '../../blwp-node/src/custody.js';
import { assumeAssigned } from '../../blwp-node/test/assignment.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { toHex } from '../../protocol/src/hash.js';
import { Client } from '../src/client.js';
import { stakeLine } from '../src/ghost-field.js';
import * as join from '../src/join.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };
const READY = { preflight: async () => ({ ready: true, why: 'test port' }) };
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const STAKE = 100000n;

/** A Lightning node whose one invoice is paid when the test says so. */
function payablePort() {
  const port = {
    paid: false,
    async createHeld({ paymentHash, amountMsat }) { port.amount = amountMsat; return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look() { return { state: HELD, amountMsat: port.amount, paidMsat: port.paid ? port.amount : 0n }; },
    async settle() {}, async cancel() {},
  };
  return port;
}

/** `n` daemons, each with its own Lightning port, one round, one joined entry. */
async function committee(n) {
  const ports = Array.from({ length: n }, payablePort);
  const nodes = [];
  for (const port of ports) nodes.push(await serve(openStore(':memory:'), { port: 0, ...FUNDED, ...READY, lightning: port }));
  const keys = nodes.map((d) => d.round.pubkey);
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
    gameVerifySlots: n, settlementSlots: n, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
    entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN',
    slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
    censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
    randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
    blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: keys,
  };
  const rid = roundId(contract);
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  for (const d of nodes) {
    const base = `http://127.0.0.1:${d.port}`;
    await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(contract) });
    assumeAssigned(d.round, rid, keys);
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
  }
  const bases = nodes.map((d) => `http://127.0.0.1:${d.port}`);
  return {
    nodes, ports, keys, contract, rid, entry, eid: entryId(entry), bases,
    pay: (k) => { for (let i = 0; i < k; i++) ports[i].paid = true; },
    close: async () => { for (const d of nodes) { try { await d.close(); } catch { /* gone */ } } },
  };
}

test('at join time the page printed "held" for a stake nobody has paid; now it says it is not yet counted', async () => {
  const c = await committee(2);
  const client = new Client({ base: c.bases[0], core, sign, verify });
  try {
    await client.join(c.entry);
    // THE NODE'S JOIN-TIME WORD, measured: lnd's OPEN reads as held.
    assert.equal(client.joinHold.state, HELD, `the node answered x-hold ${client.joinHold.state}`);
    const line = stakeLine({ dealt: true, hold: client.joinHold });
    assert.ok(!/held/.test(line), `the page tells a player an unpaid stake is held: "${line}"`);
    assert.equal(line, ' · stake dealt, not yet counted');
  } finally { await c.close(); }
});

test('seven settlement signer nodes: seen by 4 of 7 is not committed, 5 of 7 is, and a signer node that does not answer is named', async () => {
  const c = await committee(7);
  // THE SEVENTH SIGNER NODE'S ADDRESS IS DOWN: its key is a signer node, its node is gone.
  await c.nodes[6].close();
  try {
    assert.equal(typeof join.stakeSeenBy, 'function', 'there is no count of the nodes that have seen a stake');
    assert.equal(join.stakeSeenNeeded(c.contract), 5);

    c.pay(4);
    const four = await join.stakeSeenBy({ entryId: c.eid, signerNodes: c.keys, nodes: c.bases, contract: c.contract });
    assert.deepEqual([four.seen, four.of, four.needed, four.unanswered, four.committed], [4, 7, 5, 1, false]);
    assert.equal(stakeLine({ dealt: true, seen: four }),
      ' · stake seen by 4 of 7 nodes (5 needed), 1 did not answer');

    c.pay(5);
    const five = await join.stakeSeenBy({ entryId: c.eid, signerNodes: c.keys, nodes: c.bases, contract: c.contract });
    assert.deepEqual([five.seen, five.of, five.needed, five.unanswered, five.committed], [5, 7, 5, 1, true]);
    assert.equal(stakeLine({ dealt: true, seen: five }),
      ' · stake seen by 5 of 7 nodes (5 needed), 1 did not answer · committed');
    console.log(`  7 signer nodes: 4 paid -> ${four.seen}/${four.of} (${four.needed} needed) committed=${four.committed}; `
      + `5 paid -> ${five.seen}/${five.of} committed=${five.committed}; unanswered ${five.unanswered}`);
  } finally { await c.close(); }
});

test('two settlement signer nodes: T is 2, not a hard 5 - 1 of 2 is not committed, 2 of 2 is', async () => {
  const c = await committee(2);
  try {
    assert.equal(join.stakeSeenNeeded(c.contract), 2, 'a 2-of-2 round would wait for 5 nodes it does not have');
    const none = await join.stakeSeenBy({ entryId: c.eid, signerNodes: c.keys, nodes: c.bases, contract: c.contract });
    assert.deepEqual([none.seen, none.of, none.needed, none.committed], [0, 2, 2, false]);
    c.pay(1);
    const one = await join.stakeSeenBy({ entryId: c.eid, signerNodes: c.keys, nodes: c.bases, contract: c.contract });
    assert.deepEqual([one.seen, one.of, one.needed, one.committed], [1, 2, 2, false]);
    c.pay(2);
    const two = await join.stakeSeenBy({ entryId: c.eid, signerNodes: c.keys, nodes: c.bases, contract: c.contract });
    assert.deepEqual([two.seen, two.of, two.needed, two.committed], [2, 2, 2, true]);
    assert.equal(stakeLine({ dealt: true, seen: two }), ' · stake seen by 2 of 2 nodes (2 needed) · committed');
  } finally { await c.close(); }
});

test('counted from the signer node: a watch started before anybody paid reaches committed when the stake lands, and a second start is the same watch', async () => {
  // A WALLET CAN ANSWER AFTER payStake HAS GIVEN UP (wallet-nwc.test.js: "did
  // not answer in 400 ms") and still pay. A count started only on payStake's ok
  // would never start, and the line would say "not yet counted" while the
  // committee held the stake. So the count runs from the signer node.
  const c = await committee(2);
  const client = new Client({ base: c.bases[0], core, sign, verify });
  try {
    await client.join(c.entry);
    const args = { signerNodes: c.keys, nodes: c.bases, contract: c.contract, everyMs: 50 };
    const first = client.watchStake(args);
    const again = client.watchStake(args);
    assert.equal(again, first, 'a second start is a second watch, polling twice');
    await wait(150);
    assert.deepEqual([client.stakeCount.seen, client.stakeCommitted], [0, false]);
    c.pay(2);                                   // the wallet answered late
    const done = await first;
    assert.deepEqual([done.seen, done.of, done.committed], [2, 2, true]);
  } finally { client.close(); await c.close(); }
});

test('a signer node the node issued no hold for keeps the node\'s reason while nobody has seen it', () => {
  // The count starts from the signer node whatever the node answered. A node with no
  // Lightning answers `x-hold: none` and says why - letter 15 put that reason on
  // the chip so a stake that can never be held does not read like one waiting.
  // A count of "0 of 2" in its place would hide it.
  const none = { state: 'none', why: 'this node reaches no Lightning, so it holds no stakes' };
  const zero = { seen: 0, of: 2, needed: 2, unanswered: 0, committed: false };
  assert.equal(stakeLine({ dealt: true, hold: none, seen: zero }),
    ' · stake dealt, unpaid (this node reaches no Lightning, so it holds no stakes)',
    'the node\'s reason there is no hold was replaced by a count of nothing');
  // ONCE A SIGNER NODE HAS SEEN IT, the count is the truth (a hold issued later).
  assert.equal(stakeLine({ dealt: true, hold: none, seen: { ...zero, seen: 1 } }),
    ' · stake seen by 1 of 2 nodes (2 needed)');
  // AND A HELD SIGNER NODE'S ZERO IS A COUNT, not a reason.
  assert.equal(stakeLine({ dealt: true, hold: { state: HELD }, seen: zero }),
    ' · stake seen by 0 of 2 nodes (2 needed)');
});

test('a count that is over is not started again: committed, ended or closed, watchStake asks nobody', async () => {
  // The chip paints every 500 ms and starts the count from the signer node. What
  // stops it restarting a finished count is a rule, and a rule in index.html is
  // one node --test cannot run - so it lives here, where the suite does.
  const c = await committee(2);
  const client = new Client({ base: c.bases[0], core, sign, verify });
  let asked = 0;
  const counting = (u, o) => { asked++; return fetch(u, o); };
  try {
    await client.join(c.entry);
    c.pay(2);
    const args = { signerNodes: c.keys, nodes: c.bases, contract: c.contract, everyMs: 20, fetcher: counting };
    const done = await client.watchStake(args);
    assert.equal(done.committed, true);
    const polls = client.stakePolls;
    const before = asked;
    const again = await client.watchStake(args);
    assert.equal(client.stakePolls, polls, 'a committed count was started again');
    assert.equal(asked, before, `a committed count asked the nodes ${asked - before} more times`);
    assert.equal(again.committed, true, 'the last count was not handed back');

    const other = new Client({ base: c.bases[0], core, sign, verify });
    await other.join(c.entry);
    other.close();
    const closedAsk = asked;
    await other.watchStake(args);
    assert.equal(asked, closedAsk, 'a closed client counted the stake');
  } finally { client.close(); await c.close(); }
});

test('the page counts from the signer node, whatever payStake answered, and hands the count to the chip', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
  assert.ok(!/said\.ok && client\.watchStake/.test(page), 'the count still starts only when payStake said ok');
  assert.match(page, /net\.client\.watchStake\(\{/, 'the chip never starts the count from the signer node');
});

test('the page counts after paying and hands the count to the chip', async () => {
  // `index.html` is the one file node --test cannot load, so what is pinned is
  // that it calls the counted rule rather than printing a word of its own.
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
  assert.match(page, /client\.watchStake\(\{/, 'the page never asks the settlement signer nodes');
  assert.match(page, /signerNodeKeys: signerNodes\.signerNodes, nodes: named\.nodes/, 'the page does not keep who to count');
  assert.match(page, /seen: \(net && net\.client && net\.client\.stakeCount\)/, 'the chip is not handed the count');
});

test('the client polls until the stake is committed and then stops; driving is not gated below T', async () => {
  const c = await committee(2);
  const client = new Client({ base: c.bases[0], core, sign, verify });
  try {
    await client.join(c.entry);
    await client.connect();
    client.setRound({ roundId: c.rid, entryId: c.eid, blockTicks: c.contract.blockTicks });
    // THE NODE THE PAGE JOINED HAS SEEN IT; THE OTHER HAS NOT. 1 of 2.
    c.ports[0].paid = true;
    assert.equal(typeof client.watchStake, 'function', 'the client cannot watch a stake being seen');
    const watching = client.watchStake({ signerNodes: c.keys, nodes: c.bases, contract: c.contract, everyMs: 50 });
    await wait(200);
    assert.equal(client.stakeCommitted, false, 'committed below T');
    assert.equal(client.stakeCount.seen, 1);

    // DRIVING IS NOT GATED: the node the player joined takes the ticks at 1 of 2.
    for (let i = 0; i < 20; i++) client.record([45875, 22000, 0, 0, 0]);
    for (let i = 0; i < 20 && client.hold.length; i++) { const p = client.drain(); if (p) { try { await p; } catch { /* measured below */ } } await wait(2); }
    assert.equal(client.ended, false);
    assert.equal(client.nextTick, 20, `driving below T published ${client.nextTick} of 20`);

    c.ports[1].paid = true;
    const final = await watching;
    assert.equal(client.stakeCommitted, true);
    assert.deepEqual([final.seen, final.of, final.needed, final.committed], [2, 2, 2, true]);
    const polls = client.stakePolls;
    await wait(200);
    assert.equal(client.stakePolls, polls, 'the client kept polling after the stake was committed');
  } finally { client.endRun && client.endRun('test over'); client.close(); await c.close(); }
});
