// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEV'S DONATION CLIENT, ITS DECISIONS (2026-10-03): the key, where the funds are, what is redeemed, when it
// withdraws - with the seats, the federation and the LND faked; the live pass is measured on testnet4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';

import { newKey, keyFromSecret, walletSecretFor, gatherDonations, donationFields, splitOutpoint, redeemAll, withdrawToLnd } from '../src/donor.js';
import { donationContractFields, lockFieldsToJson } from '../../arena-node/src/stake-lock-signer-node.js';

const PK = '02' + 'a1'.repeat(32);
const op = (n) => `${'08'.repeat(32)}:${n}`;
const row = (n, fed, msat, ms) => ({ outpoint: op(n), federationId: fed, amountMsat: String(msat), roundId: 'r', entryId: 'e', verifiedMs: ms });
const seatsAnswering = (bySeat) => async (url) => {
  const seat = url.split('/donations')[0];
  if (!(seat in bySeat)) throw new Error('connection refused');
  return { ok: true, json: async () => ({ donations: bySeat[seat] }) };
};

test('a new key is a secp256k1 key whose compressed point is the recipient key', () => {
  const k = newKey();
  assert.equal(k.recipientPkHex, Buffer.from(secp256k1.getPublicKey(Buffer.from(k.secretHex, 'hex'), true)).toString('hex'));
  assert.equal(keyFromSecret(Buffer.from(k.secretHex, 'hex')).recipientPkHex, k.recipientPkHex);
  assert.notEqual(walletSecretFor(k.secretHex, 'aa'.repeat(32)), walletSecretFor(k.secretHex, 'bb'.repeat(32)), 'one wallet per federation');
});

test('every seat is asked; one donation listed by several seats is one; the funds are grouped by federation; a silent seat is named', async () => {
  const fa = 'aa'.repeat(32), fb = 'bb'.repeat(32);
  const got = await gatherDonations({ recipientPkHex: PK, seats: ['http://s1', 'http://s2', 'http://s3'], fetcher: seatsAnswering({
    'http://s1': [row(2, fa, 1334, 10), row(5, fb, 666, 30)],
    'http://s2': [row(2, fa, 1334, 10), row(3, fa, 1334, 20)],
  }) });
  assert.equal(got.total, 3);
  assert.deepEqual([...got.byFederation.keys()], [fa, fb]);
  assert.deepEqual(got.byFederation.get(fa).map((d) => [d.outpoint.slice(-2), d.seats]), [[':2', 2], [':3', 1]]);
  assert.deepEqual(got.unanswered, ['http://s3: connection refused']);
});

test('the contract the client redeems is the one the seats verified: the same fields', () => {
  const seat = lockFieldsToJson(donationContractFields({ recipientPk: Buffer.from(PK, 'hex'), amountMsat: 1334n }));
  assert.deepEqual(JSON.parse(donationFields(PK, 1334n)), JSON.parse(JSON.stringify(seat)));
  assert.deepEqual(splitOutpoint(op(7)), { txid: '08'.repeat(32), outIdx: 7 });
  assert.throws(() => splitOutpoint('nope'));
});

test('redeem: accepted is redeemed, a contract no longer held was spent (final), anything else is asked again; done is skipped', async () => {
  const asked = [];
  const client = { async refund(txid, idx, fields, secret) {
    asked.push(idx);
    if (idx === 2) return JSON.stringify({ accepted: true, txid: 'f'.repeat(64), stored_before: { contract_id: 'c' } });
    if (idx === 3) return JSON.stringify({ accepted: false, stored_before: null, error: 'no contract' });
    if (idx === 4) return JSON.stringify({ accepted: false, stored_before: { contract_id: 'c' }, error: 'not accepted yet' });
    throw new Error('guardians unreachable');
  } };
  const r = await redeemAll({ client, donations: [row(2), row(3), row(4), row(5), row(6)], recipientPkHex: PK, secretHex: '11'.repeat(32), done: new Set([op(6)]) });
  assert.deepEqual(asked, [2, 3, 4, 5]);
  assert.deepEqual(r.redeemed.map((d) => d.outpoint.slice(-1)), ['2']);
  assert.deepEqual(r.spent.map((d) => d.outpoint.slice(-1)), ['3']);
  assert.deepEqual(r.failed.map((d) => [d.outpoint.slice(-1), d.why]), [['4', 'not accepted yet'], ['5', 'guardians unreachable']]);
});

test('withdraw: below the minimum nothing is asked of the LND; above it, the largest payable invoice is made and paid', async () => {
  const made = [];
  const lnd = { invoice: async (msat) => { made.push(msat); return 'lntb1...'; } };
  const low = await withdrawToLnd({ client: { withdrawableMsat: async () => '9999' }, lnd, minMsat: 10000n });
  assert.equal(low.withdrawn, false); assert.deepEqual(made, []);
  const high = await withdrawToLnd({ client: { withdrawableMsat: async () => '25000', withdraw: async (inv) => JSON.stringify({ state: 'Success', preimage: 'ab' }) }, lnd, minMsat: 10000n });
  assert.equal(high.withdrawn, true); assert.deepEqual(made, [25000n]);
});

// ONE WALLET CLIENT PER FEDERATION FOR THE PROCESS (2026-10-07 11:50): every pass joined the federation
// again and never closed the client - after 29 h each donor held ~720 sockets, 680 MB and 54-57% CPU between its 300 s passes,
// and every client wrote the same wallet file. walletClients joins once per federation and hands that client back.
test('walletClients: one join per federation across passes; a failed join is tried again next pass', async () => {
  const { walletClients } = await import('../src/donor.js');
  let joins = 0, fail = true;
  const clientFor = walletClients(async (invite, fed) => { joins++; if (fed === 'bad' && fail) throw new Error('no answer'); return { fed, n: joins }; });
  const a1 = await clientFor('inv', 'fedA', 's', null);
  const a2 = await clientFor('inv', 'fedA', 's', null);
  const [a3, a4] = await Promise.all([clientFor('inv', 'fedA', 's', null), clientFor('inv', 'fedA', 's', null)]);
  assert.equal(joins, 1, `${joins} joins for one federation over four asks`);
  assert.ok(a1 === a2 && a2 === a3 && a3 === a4, 'the same client every pass');
  await clientFor('inv', 'fedB', 's', null);
  assert.equal(joins, 2, 'a second federation has its own client');
  await assert.rejects(clientFor('inv', 'bad', 's', null), /no answer/);
  fail = false;
  const b = await clientFor('inv', 'bad', 's', null);
  assert.equal(b.fed, 'bad', 'a failed join is not kept: the next pass joins again');
});

test('a withdrawal tries the gateways the network names first, and the next after a refund', async () => {
  const lnd = { invoice: async () => 'lnbc1' };
  const asked = [];
  let held = 19937n;
  const client = { withdrawableMsat: async () => String(held),
    withdraw: async (inv, gw) => { asked.push(gw || 'pick'); if (gw === 'https://live/') { held = 0n; return JSON.stringify({ state: 'Success', preimage: 'cd' }); } return JSON.stringify({ state: 'Refunded' }); } };
  const w = await withdrawToLnd({ client, lnd, minMsat: 10000n, gateways: ['https://stale/', 'https://live/'] });
  assert.deepEqual([w.withdrawn, w.state, asked], [true, 'Success', ['https://stale/', 'https://live/']]);
  held = 19937n; asked.length = 0;
  const none = await withdrawToLnd({ client: { ...client, withdraw: async (inv, gw) => { asked.push(gw || 'pick'); return JSON.stringify({ state: 'Refunded' }); } }, lnd, minMsat: 10000n, gateways: ['https://stale/'] });
  assert.deepEqual([none.withdrawn, asked], [false, ['https://stale/', 'pick']], 'every named one, then the client\'s own pick');
});

test('an empty wallet is nothing to withdraw, not a failed pass (2026-10-14 15:02Z)', async () => {
  const lnd = { invoice: async () => { throw new Error('no invoice is made for nothing'); } };
  const w = await withdrawToLnd({ client: { withdrawableMsat: async () => { throw new Error('Balance is too low to send any amount after fees'); } }, lnd, minMsat: 10000n });
  assert.deepEqual([w.withdrawn, w.withdrawableMsat], [false, 0n]);
  await assert.rejects(withdrawToLnd({ client: { withdrawableMsat: async () => { throw new Error('socket closed'); } }, lnd }), /socket closed/, 'any other error still stops the pass');
});

// UNCLAIMED E-CASH RECOVERED ON ITS OWN (plan agreed by 2026-10-14)
test('unclaimed e-cash: noted on the pass that first sees it, recovered only if the same outputs are still unclaimed a pass later', async () => {
  const { claimUnclaimed } = await import('../src/donor.js');
  const state = {};
  let pending = [{ nonce: 'n1', amount_msat: 4096 }, { nonce: 'n2', amount_msat: 904 }];
  const calls = [];
  const io = { balanceMsat: async () => 0, backup: async () => { calls.push('backup'); return 'b'; }, recover: async () => calls.push('recover'),
    reopen: async () => ({ balanceMsat: 5000n, pendingMsat: 0n }), swap: async () => calls.push('swap'), keepFailed: async () => calls.push('keep'), sleep: async () => {} };
  const first = await claimUnclaimed({ federation: 'A', state, pendingOutputs: async () => JSON.stringify(pending), ...io });
  assert.deepEqual([first.step, String(first.unclaimedMsat), calls], ['noted', '5000', []], 'the first pass only notes it');
  assert.deepEqual(state.unclaimed.A.nonces, ['n1', 'n2']);
  // the live client claimed n1 meanwhile and a new n3 appeared: not every noted one persisted - noted again, nothing recovered
  pending = [{ nonce: 'n2', amount_msat: 904 }, { nonce: 'n3', amount_msat: 8 }];
  const second = await claimUnclaimed({ federation: 'A', state, pendingOutputs: async () => JSON.stringify(pending), ...io });
  assert.deepEqual([second.step, calls], ['noted', []]);
  // claimed meanwhile: nothing remembered
  const none = await claimUnclaimed({ federation: 'A', state, pendingOutputs: async () => '[]', ...io });
  assert.deepEqual([none.step, state.unclaimed.A], ['none', undefined]);
});

test('unclaimed e-cash still there a pass later: backup, recovery, reopened past the first 0 until the balance is old + unclaimed, then swapped', async () => {
  const { claimUnclaimed } = await import('../src/donor.js');
  const pending = JSON.stringify([{ nonce: 'n1', amount_msat: 4096 }, { nonce: 'n2', amount_msat: 904 }]);
  const state = { unclaimed: { A: { nonces: ['n1', 'n2'], msat: '5000', since: 't0' } } };
  const calls = []; const opens = [{ balanceMsat: 0n, pendingMsat: 0n }, { balanceMsat: 6000n, pendingMsat: 0n }];
  const r = await claimUnclaimed({ federation: 'A', state, pendingOutputs: async () => pending, balanceMsat: async () => 1000, nowIso: () => '2026-10-14T16:00:00.000Z',
    backup: async (at) => { calls.push('backup'); return `wallet-A.pre-recover-${at}.json`; }, recover: async () => calls.push('recover'),
    reopen: async () => { calls.push('reopen'); return opens.shift(); }, swap: async () => calls.push('swap'), keepFailed: async () => calls.push('keep'), sleep: async () => {} });
  assert.deepEqual(calls, ['backup', 'recover', 'reopen', 'reopen', 'swap'], 'never swapped on the first open\'s 0');
  assert.deepEqual([r.step, r.ok, r.unclaimedMsat, r.recoveredMsat, r.backup], ['recovered', true, '5000', '6000', 'wallet-A.pre-recover-2026-10-14T16:00:00.000Z.json']);
  assert.equal(state.unclaimed.A, undefined); assert.equal(state.recoveries.length, 1);
});

test('a recovered store that never reaches old + unclaimed, or keeps outputs pending, is not swapped: the old wallet stays, the store is kept', async () => {
  const { claimUnclaimed } = await import('../src/donor.js');
  const pending = JSON.stringify([{ nonce: 'n1', amount_msat: 5000 }]);
  for (const open of [{ balanceMsat: 4000n, pendingMsat: 0n }, { balanceMsat: 9000n, pendingMsat: 32n }]) {
    const state = { unclaimed: { A: { nonces: ['n1'], msat: '5000' } } };
    const calls = [];
    const r = await claimUnclaimed({ federation: 'A', state, pendingOutputs: async () => pending, balanceMsat: async () => 1000, tries: 3,
      backup: async () => 'b', recover: async () => calls.push('recover'), reopen: async () => { calls.push('reopen'); return open; },
      swap: async () => calls.push('swap'), keepFailed: async () => calls.push('keep'), sleep: async () => {} });
    assert.deepEqual(calls, ['recover', 'reopen', 'reopen', 'reopen', 'keep']);
    assert.deepEqual([r.step, r.ok], ['recovery failed', false]); assert.match(r.why, /the old wallet stays/);
    assert.deepEqual(state.unclaimed.A.nonces, ['n1'], 'still noted: the next pass tries again');
  }
});

test('every federation the seats hold a record of gives its invite; a closed one none; the first seats that answer (kanban #578)', async () => {
  const { invitesFromSeats } = await import('../src/donor.js');
  const asked = [];
  const answers = {
    'http://a': null,
    'http://b': { federations: [{ federation: 'AA'.repeat(32), status: 'OPEN', record: 'r1' }, { federation: 'bb'.repeat(32), status: 'CLOSED', record: 'r2' }] },
    'http://c': { federations: [{ federation: 'cc'.repeat(32), status: 'DRAINING', record: 'r3' }, { federation: 'dd'.repeat(32), status: 'OPEN', record: 'bad' }] },
    'http://d': { federations: [{ federation: 'ee'.repeat(32), status: 'OPEN', record: 'r5' }] },
  };
  const fetcher = async (url) => { const s = url.replace('/federations', ''); asked.push(s); if (!answers[s]) throw new Error('down'); return { json: async () => answers[s] }; };
  const decode = (h) => { if (h === 'bad') throw new Error('no'); return { invite: `fed11${h}` }; };
  const got = await invitesFromSeats({ seats: Object.keys(answers), fetcher, decode, want: 2 });
  assert.deepEqual(got, { ['aa'.repeat(32)]: 'fed11r1', ['cc'.repeat(32)]: 'fed11r3' });
  assert.deepEqual(asked, ['http://a', 'http://b', 'http://c'], 'stops once two seats answered');
});

test('the seats\' records also tell each federation\'s status and successor: a draining one names where its money goes (kanban #578)', async () => {
  const { invitesFromSeats } = await import('../src/donor.js');
  const succ = new Uint8Array(32).fill(0x4d), none = new Uint8Array(32);
  const answers = { 'http://s': { federations: [{ federation: 'B1'.repeat(32), status: 'DRAINING', record: 'b' }, { federation: '4d'.repeat(32), status: 'OPEN', record: 'n' }] } };
  const fetcher = async (url) => ({ json: async () => answers[url.replace('/federations', '')] });
  const decode = (h) => ({ invite: `fed11${h}`, successorId: h === 'b' ? succ : none });
  const states = {};
  await invitesFromSeats({ seats: ['http://s'], fetcher, decode, states });
  assert.deepEqual(states, { ['b1'.repeat(32)]: { status: 'DRAINING', successor: '4d'.repeat(32) }, ['4d'.repeat(32)]: { status: 'OPEN', successor: null } });
});
