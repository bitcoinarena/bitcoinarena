// THE PAGE MAKES THE PLAYER'S STAKE LOCK (W1b; v4.6.2 §23.1 steps 3-5).
//
// `lockStake` decides what the injected lock client (lock-client/, the stock
// fedimint 0.12.0 crates built to wasm) is asked, and `handLock` hands the
// lock it made to the signer nodes. The lock client here is a stand-in that records
// what it was asked; the real one is driven from the built page on a regtest
// federation by tools/page-lock.mjs. The signer nodes in `handLock`'s test are real
// daemons verifying against a port that holds locks by outpoint (W2).
//
// MEASURED BEFORE (TASKBOOK, W1b): the page built every entry with a zero
// stake_lock_outpoint, loaded no lock client and posted no /lock.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../blwp-node/src/cores.js';
import { test } from 'node:test';
// The run length is the core's; a literal 9000 is refused by the node as a contract
// disagreeing with the network it names (WAR_TACTICS moved a run to 10800).
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { bech32Encode, convertBits } from '../../protocol/src/bech32.js';
import { decodeBolt11 } from '../../protocol/src/bolt11.js';

import { lockStake, fundPlayerWallet, walletSecretFor, withdrawPlayerWallet, handLock, lockSecretFor, lockAmountMsat, lockLine, saveLock, savedLock, markLockCommitted,
  refundStake, redeemStake, redeemPayout, payoutLine, returnStake, stakeBackLine, saveCollect, savedCollects, markCollectDone, keptLockUse, withdrawCollected, collectIntoPlayerWallet, invoiceAmountMsat, withdrawLine, refundKept, refundLine, lookOwed, owedToLine as owedLine, collectAndWithdraw, tabLockWallet, findOwedRounds, feeSecretFor, ledgerRows, ledgerReadSavedStakes, playerWallet, depositChoices, depositOffer, withdrawChoices, playerWithdrawable, pendingDeposits, resumeDeposits, restOfFeesMsat, shortOnlyByFees, restInvoiceMsat, ceilNote, NOTE_MSAT, roundsDepositMsat, locksForRound, settingsDepositOffer, DEPOSIT_INSUFFICIENT } from '../src/page-lock.js';
import { replayLinkFor } from '../src/replay-link.js';
import { lockFieldsFromJson } from '../../protocol/src/stake-lock.js';
import { sha256 } from '../../protocol/src/hash.js';
import { entryFor, joinQuery, stakeFor, playerFor } from '../src/join.js';
import { lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { pageCurve } from '../src/page-curve.js';
import { playerSecretFor } from '../../protocol/src/player-key.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { roundId, encodeRoundContract } from '../../protocol/src/contracts.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { CORE_HASH } from '../../blwp-node/tools/core-hash.mjs';
import { joinedWithLock, CLAIM } from '../../blwp-node/test/lock-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
// The shape of a real invite (bech32m, prefix `fed1`, separator `1`): the first
// rehearsal's page threw on its own invite because this constant had no separator.
const INVITE = 'fed11qgqpw9thwvaz7te3xgmjuvpwxqhrzw' + 'q'.repeat(20);
const POINT = Uint8Array.from([0x03, ...b32(0x5e)]);
const now = BigInt(Date.now());
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(0x31), b32(0x32)],
};
const rid = roundId(round);
const seed = b32(0x51);
const player = b32(0x61);
const claimKey = { ok: true, claimPk: CLAIM, ref: b32(0x9a) };

/**
 * A stand-in lock client: fees as W1a measured them (16064 msat on the way in,
 * 2528 on the lock, or `lockFee`), and a quote that fails on funds it does not
 * hold, as the stock dry run does. The allowance is the stock
 * TRANSACTION_FEE_DEFAULT's arithmetic (2 sat + 3000 ppm).
 */
function lockClient({ idsMatch = true, lockedMsat, lockFee = 2528n, feeRule = null, both = false, badFee = false, donations = false, badDonation = null, submit = false, acceptAs = 'same' } = {}) {
  const log = [];
  // Its wallet is kept in the store it is handed, as the real one's database
  // is: one key, the balance, written when a deposit is claimed.
  class Fake {
    static async join(invite, federationId, secret, store) {
      const kept = store ? JSON.parse(store.entries()) : [];
      log.push({ join: { invite, federationId, secret, kept: kept.length } });
      const f = new Fake(store);
      const bal = kept.find(([k]) => k === 'ba');
      if (bal) f.balance = BigInt(`0x${bal[1]}`);
      return f;
    }
    static lockAllowanceMsat(msat) { return String(2000n + BigInt(msat) * 3000n / 1000000n); }
    constructor(store) { this.store = store; this.balance = 0n; this.coming = 0n; }
    async lockCostMsat(msat) {
      const cost = BigInt(msat) + lockFee;
      if (this.balance < cost) throw new Error('Insufficient funds');
      return String(cost);
    }
    async balanceMsat() { return String(this.balance); }
    async depositFor(msat) { return JSON.stringify({ invoice_msat: String(BigInt(msat) + 16064n), credited_msat: msat, gateway: 'http://gw' }); }
    // A RECEIVE THAT SMALL IS REFUSED, as the federation's gateway refuses it (measured in a real
    // browser: a 556 msat top-up, "Amount is too small to cover fees").
    async receive(msat, gateway) {
      log.push({ receive: { msat, gateway } });
      if (BigInt(msat) - 16064n < 1000n) throw new Error('Amount is too small to cover fees');
      this.coming = BigInt(msat) - 16064n; return JSON.stringify({ invoice: 'lnbcrt1page', operation: 'op' });
    }
    async awaitReceive() {
      this.balance += this.coming;
      if (this.store) this.store.put('ba', this.balance.toString(16).padStart(2, '0'));
      return 'Claimed';
    }
    async lock(point, amount, claim, refund, delta) {
      log.push({ lock: { point, amount, claim, refund, delta } });
      this.balance -= BigInt(amount) + lockFee;
      if (this.store) this.store.put('ba', this.balance.toString(16).padStart(2, '0'));   // kept, as the real database keeps it
      const expiration = 1000 + delta;
      return JSON.stringify({ txid: 'ab'.repeat(32), out_idx: 0, computed_contract_id: 'c1', stored_contract_id: idsMatch ? 'c1' : 'c2',
        ids_match: idsMatch, computed_expiration: expiration, stored_expiration: expiration, amount_msat: Number(lockedMsat ?? amount) });
    }
    // THE FEDERATION'S FEE RULE (Pick b's gate reads it), when this stand-in has one.
    async feeRule() {
      if (!feeRule) throw new Error('this stand-in names no fee rule');
      return JSON.stringify({ fee_ppm: Number(feeRule.ppm), fee_base_msat: Number(feeRule.baseMsat) });
    }
    // THE WITHDRAW (§24A.1): the whole balance less the stand-in's send fee, to the invoice it is handed.
    async withdrawableMsat() { if (this.balance <= 3000n) throw new Error('Balance is too low to send any amount after fees'); return String(this.balance - 3000n); }
    async withdraw(invoice) {
      log.push({ withdraw: { invoice } });
      const before = this.balance; this.balance = 0n;
      if (this.store) this.store.put('ba', '00');
      return JSON.stringify({ state: 'Success', invoice_msat: Number(before - 3000n), gateway: 'http://gw-b', balance_before: Number(before), balance_after: 0 });
    }
    async lockHash(hash, amount, claim, refund, delta) {
      log.push({ lockHash: { hash, amount, claim, refund, delta } });
      this.balance -= BigInt(amount) + lockFee;
      if (this.store) this.store.put('ba', this.balance.toString(16).padStart(2, '0'));
      const expiration = 1000 + delta;
      return JSON.stringify({ txid: 'cd'.repeat(32), out_idx: 1, computed_contract_id: 'f1', stored_contract_id: 'f1',
        ids_match: true, computed_expiration: expiration, stored_expiration: expiration, amount_msat: Number(amount) });
    }
  }
  // THE ONE-TRANSACTION LOCK (`lockBoth`), when this stand-in has it: both contracts in one transaction, outputs 0 and 1,
  // each answered in `lock`'s own shape; `badFee` stores another contract at the fee's outpoint than the one built
  if (both) Fake.prototype.lockBoth = async function (point, stakeMsat, hash, feeMsat, claim, refund, delta) {
    log.push({ lockBoth: { point, stakeMsat, hash, feeMsat, claim, refund, delta } });
    this.balance -= BigInt(stakeMsat) + BigInt(feeMsat) + lockFee;
    if (this.store) this.store.put('ba', this.balance.toString(16).padStart(2, '0'));
    const expiration = 1000 + delta;
    const one = (out_idx, id, stored, amount) => ({ txid: 'ef'.repeat(32), out_idx, computed_contract_id: id, stored_contract_id: stored,
      ids_match: id === stored, computed_expiration: expiration, stored_expiration: expiration, amount_msat: Number(amount) });
    return JSON.stringify({ stake: one(0, 's1', 's1', stakeMsat), fee: one(1, 'f1', badFee ? 'f2' : 'f1', feeMsat) });
  };
  // THE DONATION IN THE SAME TRANSACTION (the owner 2026-10-03): stake, fee when a hash is given, then one output per donation;
  // `badDonation` 'key' or 'amount' answers an output that is not the share it was asked for
  if (donations) Fake.prototype.lockWithDonations = async function (point, stakeMsat, hash, feeMsat, claim, refund, delta, given) {
    const ds = JSON.parse(given);
    log.push({ lockWithDonations: { point, stakeMsat, hash, feeMsat, claim, refund, delta, donations: ds } });
    this.balance -= BigInt(stakeMsat) + BigInt(hash ? feeMsat : 0) + ds.reduce((t, d) => t + BigInt(d.msat), 0n) + lockFee;
    if (this.store) this.store.put('ba', this.balance.toString(16).padStart(2, '0'));
    const expiration = 1000 + delta;
    const one = (out_idx, id, amount) => ({ txid: '9a'.repeat(32), out_idx, computed_contract_id: id, stored_contract_id: id,
      ids_match: true, computed_expiration: expiration, stored_expiration: expiration, amount_msat: Number(amount) });
    const first = hash ? 2 : 1;
    return JSON.stringify({ stake: one(0, 's1', stakeMsat), fee: hash ? one(1, 'f1', feeMsat) : null,
      donations: ds.map((d, i) => ({ txid: '9a'.repeat(32), out_idx: first + i, ids_match: true, stored_contract_id: `d${i}`,
        recipient_pk: badDonation === 'key' && i === 1 ? '03' + 'ee'.repeat(32) : d.pk,
        amount_msat: Number(BigInt(d.msat) + (badDonation === 'amount' && i === 0 ? 1n : 0n)) })) });
  };
  // THE LOCK ANSWERED ON SUBMISSION (OPEN-LIST-2140 item 3): lockSubmit answers the outputs as built, lockAccepted later
  // what the guardians store - `acceptAs` 'moved' holds the stake at another output, 'refused' throws
  if (submit) {
    Fake.prototype.lockSubmit = async function (point, stakeMsat, hash, feeMsat, claim, refund, delta, given) {
      const ds = JSON.parse(given);
      log.push({ lockSubmit: { stakeMsat, hash, feeMsat, donations: ds } });
      this.balance -= BigInt(stakeMsat) + BigInt(hash ? feeMsat : 0) + ds.reduce((t, d) => t + BigInt(d.msat), 0n) + lockFee;
      const exp = 1000 + delta;
      const outputs = [{ out_idx: 0, role: 'stake', computed_contract_id: 's1', computed_expiration: exp, amount_msat: Number(stakeMsat), recipient_pk: null }];
      if (hash) outputs.push({ out_idx: 1, role: 'fee', computed_contract_id: 'f1', computed_expiration: exp, amount_msat: Number(feeMsat), recipient_pk: null });
      ds.forEach((d, i) => outputs.push({ out_idx: outputs.length, role: 'donation', computed_contract_id: `d${i}`, computed_expiration: 0, amount_msat: Number(d.msat), recipient_pk: d.pk }));
      this.submitted = { operation: 'op1', txid: '5a'.repeat(32), block_count_at_lock: 1000, expiry_delta: delta, with_fee: !!hash, outputs };
      return JSON.stringify(this.submitted);
    };
    Fake.prototype.lockAccepted = async function (sub) {
      const s = JSON.parse(sub);
      log.push({ lockAccepted: s.operation });
      await new Promise((r) => setTimeout(r, 20));
      if (acceptAs === 'refused') throw new Error('the guardians did not accept the lock transaction: spent inputs');
      const one = (o) => ({ txid: s.txid, out_idx: acceptAs === 'moved' && o.role === 'stake' ? 7 : o.out_idx, computed_contract_id: o.computed_contract_id,
        stored_contract_id: o.computed_contract_id, ids_match: true, computed_expiration: o.computed_expiration, stored_expiration: o.computed_expiration,
        amount_msat: o.amount_msat, recipient_pk: o.recipient_pk });
      return JSON.stringify({ stake: one(s.outputs[0]), fee: s.with_fee ? one(s.outputs[1]) : null, donations: s.outputs.filter((o) => o.role === 'donation').map(one) });
    };
  }
  return { LockClient: Fake, log };
}

const ask = (extra = {}) => lockStake({ round, roundId: rid, invite: INVITE, seed, stake: { stakePoint: POINT },
  claimKey, playerPubkey: player, ...extra });

// THE PLAYER WALLET (§24A.1, RULED the owner 2026-09-25): the stake is spent from one wallet per seed and FEDERATION. The
// top-up is its own act (`fundPlayerWallet`); the stake asks for no deposit. Measured before (rehearsal item 8,
// 27e1fbb9): lockStake joined a wallet keyed by seed and ROUND and paid a Lightning invoice inside the stake.
test('the page tops up the player wallet - under the seed\'s secret for this FEDERATION, not this round - then spends the stake from it with no deposit, to the attested key and the player\'s refund key', async () => {
  const { LockClient, log } = lockClient();
  const tab = tabStorage();
  const deposits = [];
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab, onDeposit: (d) => deposits.push(d) });
  const receivesBefore = log.filter((l) => l.receive).length;
  const got = await ask({ LockClient, storage: tab });
  const joins = log.filter((l) => l.join).map((l) => l.join);
  const locked = log.find((l) => l.lock).lock;
  const facts = {
    federation: joins[0].federationId, invite: joins[0].invite,
    secretIsTheSeedsForThisFederation: joins.every((j) => j.secret === toHex(walletSecretFor(seed, TEST_FEDERATION_ID))),
    secretIsNotTheRounds: joins.every((j) => j.secret !== toHex(lockSecretFor(seed, rid))),
    secretIsNotThePlayerKey: joins.every((j) => j.secret !== toHex(playerSecretFor(seed, rid))),
    deposits: deposits.map((d) => [d.invoice, String(d.amountMsat)]),
    depositsAskedByTheStake: log.filter((l) => l.receive).length - receivesBefore,
    lock: locked, outpoint: `${toHex(got.outpoint.txid)}:${got.outpoint.outIdx}`,
    leftTheWallet: String(got.walletBeforeMsat - got.walletAfterMsat),
  };
  console.log('  FACTS (the page\'s lock):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    federation: toHex(TEST_FEDERATION_ID), invite: INVITE, secretIsTheSeedsForThisFederation: true, secretIsNotTheRounds: true,
    secretIsNotThePlayerKey: true,
    // THE NET STAKE AND THE STOCK ALLOWANCE (2000 + 980000 x 3000 ppm = 4940), grossed up by the gateway's fee: the
    // empty wallet cannot be quoted. Into the player wallet, before the stake.
    deposits: [['lnbcrt1page', String(lockAmountMsat(round) + 4940n + 16064n)]],
    depositsAskedByTheStake: 0,
    lock: { point: toHex(POINT), amount: String(lockAmountMsat(round)), claim: toHex(CLAIM),
      refund: toHex(refundKeyOf(player)), delta: 144 },
    outpoint: `${'ab'.repeat(32)}:0`,
    leftTheWallet: String(lockAmountMsat(round) + 2528n),
  });
  assert.equal(lockAmountMsat(round), 980000n, 'the net stake of 1000000 msat less the 2% fee');
});

test('the Withdraw spends the player wallet - the same wallet the stakes left, its whole withdrawable balance to the player\'s invoice - and a wallet with nothing in it spends nothing', async () => {
  const { LockClient, log } = lockClient({ lockFee: 0n });   // so the stake leaves the allowance behind to withdraw
  const tab = tabStorage();
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab });
  const staked = await ask({ LockClient, storage: tab });
  const invoices = [];
  const invoiceFor = async (msat) => { invoices.push(msat); return { ok: true, invoice: `lnbcrt${msat}n1player` }; };
  const out = await withdrawPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab, invoiceFor });
  const joins = log.filter((l) => l.join).map((l) => l.join.secret);
  console.log(`  withdraw from the player wallet: ${out.state} ${out.invoiceMsat} msat through ${out.gateway}; balance ${out.balance_before} -> ${out.balance_after}`);
  assert.equal(out.ok, true);
  assert.equal(out.from, 'the player wallet');
  assert.ok(joins.every((j) => j === toHex(walletSecretFor(seed, TEST_FEDERATION_ID))), 'the withdraw opened another wallet than the stakes left');
  assert.equal(BigInt(out.balance_before), staked.walletAfterMsat, 'the withdraw did not start from what the stakes left');
  assert.equal(out.balance_after, 0);
  assert.deepEqual(invoices, [staked.walletAfterMsat - 3000n]);
  assert.equal(log.filter((l) => l.withdraw).length, 1);
  // AND AN EMPTY WALLET: nothing to spend, no invoice asked, said by name.
  const empty = await withdrawPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab, invoiceFor });
  assert.equal(empty.ok, false);
  assert.match(empty.why, /nothing in the player wallet to withdraw after the send's fees/);
  assert.equal(log.filter((l) => l.withdraw).length, 1, 'an empty wallet was spent');
  assert.equal(invoices.length, 1);
});

test('a player wallet short of the round\'s locks is refused by name, and the stake asks for no deposit', async () => {
  const { LockClient, log } = lockClient();
  await assert.rejects(() => ask({ LockClient, storage: tabStorage() }),
    /no stake is locked to this round: the player wallet holds 0 msat and this round's locks need at least \d+ msat - top the player wallet up first; the stake itself asks for no deposit/);
  assert.equal(log.filter((l) => l.receive).length, 0, 'the stake asked for a deposit');
  assert.equal(log.filter((l) => l.lock || l.lockHash).length, 0, 'something was locked from a wallet that could not pay for it');
});

test('one player wallet per seed and federation: two rounds of one federation open the same wallet; another federation, or another seed, opens another', async () => {
  const other = { ...round, slashMinimumServed: 21 };
  assert.notEqual(toHex(roundId(other)), toHex(rid));
  const fed2 = { ...round, federationId: b32(0x77) };
  const { LockClient, log } = lockClient();
  const tab = tabStorage();
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab });
  // THE SAME WALLET IS THE SAME OPEN CLIENT NOW (INSTANT-1527): a second round of the federation asks no second join.
  const joined = async (r, s = seed) => { const n = log.length; await fundPlayerWallet({ round: r, invite: INVITE, seed: s, LockClient, storage: tab }).catch(() => {}); const j = log.slice(n).find((l) => l.join); return j ? j.join : { reused: true }; };
  const same = await joined(other);
  const fedOther = await joined(fed2);
  const seedOther = await joined(round, b32(0x52));
  console.log(`  wallets: another round of the federation kept ${same.kept}; another federation kept ${fedOther.kept}; another seed kept ${seedOther.kept}`);
  assert.ok(same.reused || (same.secret === toHex(walletSecretFor(seed, TEST_FEDERATION_ID)) && same.kept > 0),
    'another round of the same federation neither reused nor reopened the player wallet');
  assert.notEqual(fedOther.secret, same.secret);
  assert.equal(fedOther.kept, 0, 'another federation opened this federation\'s wallet');
  assert.equal(seedOther.kept, 0, 'another seed opened this seed\'s wallet');
  assert.throws(() => walletSecretFor(seed, new Uint8Array(32)), /per federation, and no federation id was given/);
});

// PICK (b), THE GATE ON THE PAGE (the owner 2026-09-14), UNDER THE RULED FEE (07:44: "Fedimint base fee is
// 0 - run the federation with disable_base_fees"). The stand-in answers the ruled rule; the old one - 1000
// msat on every input and output, what the regtest guardians answered before 07:44 - is now a federation
// the page refuses. Until then this file's 100 sat test measured "no fee lock: the base fee would eat it".
const RULE = { ppm: 0n, baseMsat: 0n };
const BASE_FEE_RULE = { ppm: 0n, baseMsat: 1000n };

test('a federation that still charges a base fee gets no stake: the page refuses before it deposits or locks anything', async () => {
  const round100 = { ...round, stakeMsat: 100000n };
  const { LockClient, log } = lockClient({ feeRule: BASE_FEE_RULE });
  const deposits = [];
  const why = /its federation charges a base fee of 1000 msat on every input and output - a federation for BLWP runs with disable_base_fees/;
  await assert.rejects(() => fundPlayerWallet({ round: round100, invite: INVITE, seed, LockClient, onDeposit: (d) => deposits.push(d) }), why);
  await assert.rejects(() => lockStake({ round: round100, roundId: roundId(round100), invite: INVITE, seed, stake: { stakePoint: POINT }, claimKey,
    playerPubkey: player, LockClient }), why);
  const locks = log.filter((l) => l.lock || l.lockHash).length;
  console.log(`  base fee 1000: refused; deposits ${deposits.length}, locks ${locks}`);
  assert.equal(deposits.length, 0, 'the player was asked to deposit into a federation the page refuses');
  assert.equal(locks, 0, 'something was locked into a federation that charges a base fee');
});

test('a 100 sat round under the ruled fee: its 2000 msat fee lock pays the signer nodes, so the page mints it and names it in the entry', async () => {
  const round100 = { ...round, stakeMsat: 100000n };
  const rid100 = roundId(round100);
  const { LockClient, log } = lockClient({ feeRule: RULE });
  const deposits = [];
  const tab = tabStorage();
  await fundPlayerWallet({ round: round100, invite: INVITE, seed, LockClient, storage: tab, onDeposit: (d) => deposits.push(d) });
  const got = await lockStake({ round: round100, roundId: rid100, invite: INVITE, seed, stake: { stakePoint: POINT }, claimKey, playerPubkey: player,
    LockClient, storage: tab });
  const minted = log.filter((l) => l.lockHash).map((l) => l.lockHash);
  console.log(`  100 sat: fee locks minted ${minted.length} (${minted.map((m) => `${m.amount} msat`).join(', ')}); deposits ${deposits.map((d) => String(d.amountMsat)).join(', ')} msat; gate: ${got.feeGate.why}`);
  assert.equal(got.feeGate.pays, true, got.feeGate.why);
  assert.equal(minted.length, 1);
  assert.equal(minted[0].amount, '2000');
  const entry = entryFor(round100, { seed, curve: pageCurve, random: (n) => new Uint8Array(n).fill(7), claimKey,
    stake: { stakeCommitment: b32(0x71), vssSharesRef: new Uint8Array(32), stakePoint: POINT }, stakeLock: { outpoint: got.outpoint, fields: got.fields, feeLock: got.feeLock } });
  assert.equal(toHex(entry.feePreimage), toHex(feeSecretFor(seed, rid100)));
  assert.notEqual(toHex(entry.feeLockOutpoint.txid), '00'.repeat(32));
});

test('the stake and the fee lock in one transaction when the lock client has lockBoth: one call, each half checked as a lone lock, and a fee outpoint holding another contract refused', async () => {
  const round100 = { ...round, stakeMsat: 100000n };
  const rid100 = roundId(round100);
  for (const badFee of [false, true]) {
    const { LockClient, log } = lockClient({ feeRule: RULE, both: true, badFee });
    const tab = tabStorage();
    await fundPlayerWallet({ round: round100, invite: INVITE, seed, LockClient, storage: tab });
    const go = lockStake({ round: round100, roundId: rid100, invite: INVITE, seed, stake: { stakePoint: POINT }, claimKey, playerPubkey: player,
      LockClient, storage: tab });
    if (badFee) { await assert.rejects(go, /another contract/); continue; }
    const got = await go;
    const calls = log.filter((l) => l.lock || l.lockHash || l.lockBoth);
    console.log(`  lockBoth: ${calls.length} call(s): ${calls.map((c) => Object.keys(c)[0]).join(', ')}; stake at out ${got.outpoint.outIdx}, fee at out ${got.feeLock.outpoint.outIdx}`);
    assert.deepEqual(calls.map((c) => Object.keys(c)[0]), ['lockBoth'], 'the two locks were not one transaction');
    assert.equal(calls[0].lockBoth.feeMsat, '2000');
    assert.equal(calls[0].lockBoth.hash, toHex(sha256(feeSecretFor(seed, rid100))));
    assert.equal(got.outpoint.outIdx, 0n);
    assert.equal(got.feeLock.outpoint.outIdx, 1n);
    assert.equal(toHex(got.outpoint.txid), toHex(got.feeLock.outpoint.txid));
    assert.equal(toHex(got.feeLock.preimage), toHex(feeSecretFor(seed, rid100)));
  }
});

test('a 1000 sat round: the page mints one 20000 msat fee lock to H(F), names F and its outpoint in the entry, and hands it to each signer node\'s /fee-lock', async () => {
  const { LockClient, log } = lockClient({ feeRule: RULE });
  const deposits = [];
  const walletTab = tabStorage();
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: walletTab, onDeposit: (d) => deposits.push(d) });
  const got = await ask({ LockClient, storage: walletTab });
  const minted = log.filter((l) => l.lockHash).map((l) => l.lockHash);
  const F = feeSecretFor(seed, rid);
  console.log(`  1000 sat: fee locks minted ${minted.length} (${minted.map((m) => `${m.amount} msat to ${m.hash.slice(0, 12)}`).join(', ')}); deposits ${deposits.map((d) => String(d.amountMsat)).join(', ')} msat; `
    + `gate: stake ${got.feeGate.stakeMsat}, lock ${got.feeGate.lockMsat}, input fees ${got.feeGate.inputFeesMsat}, output fees ${got.feeGate.outputFeesMsat}, per-signer node net [${got.feeGate.perSignerNodeNetMsat.join(', ')}]`);
  assert.equal(minted.length, 1);
  assert.deepEqual(minted[0], { hash: toHex(sha256(F)), amount: '20000', claim: toHex(CLAIM), refund: toHex(refundKeyOf(player)), delta: 144 });
  assert.equal(got.feeGate.pays, true);
  assert.equal(toHex(got.feeLock.preimage), toHex(F));
  assert.equal(got.feeLock.fields.paymentImage.kind, 'hash');
  const entry = entryFor(round, { seed, curve: pageCurve, random: (n) => new Uint8Array(n).fill(7), claimKey,
    stake: { stakeCommitment: b32(0x71), vssSharesRef: new Uint8Array(32), stakePoint: POINT }, stakeLock: { outpoint: got.outpoint, fields: got.fields, feeLock: got.feeLock } });
  assert.equal(toHex(entry.feePreimage), toHex(F));
  assert.equal(`${toHex(entry.feeLockOutpoint.txid)}:${entry.feeLockOutpoint.outIdx}`, `${'cd'.repeat(32)}:1`);
  assert.equal(entry.feeMsat, 20000n);
  const asked = [];
  const handed = await handLock({ entryId: b32(0x0e), fields: got.feeLock.fields, nodes: ['http://a', 'http://b'], needed: 2, door: 'fee-lock',
    fetcher: async (url) => { asked.push(url); return { status: 201, text: async () => 'fee lock verified' }; } });
  assert.deepEqual(asked, [`http://a/fee-lock?entry=${'0e'.repeat(32)}`, `http://b/fee-lock?entry=${'0e'.repeat(32)}`]);
  assert.equal(handed.ok, true);
  // AND A RELOAD KEEPS IT
  const tab = new Map(); const storage = { getItem: (k) => tab.get(k) ?? null, setItem: (k, v) => tab.set(k, v) };
  saveLock(storage, { roundId: rid, playerPubkey: player, stake: { preimage: b32(0x44), body: new Uint8Array(0) }, lock: got });
  assert.equal(JSON.parse([...tab.values()][0]).feeLock.preimage, toHex(F));
});

// 6d (W4): THE WINNER COLLECTS ITS PAYOUT; A LOSER FINDS NONE.
test('the winner\'s page collects its own payout contract from the signer nodes\' settlement - by Refund under its key - and a loser\'s asks the wallet nothing', async () => {
  const winner = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const loserSeed = b32(0x52);
  const winnerPk = toHex(refundKeyOf(winner.pubkey));
  const settled = { state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { txid: 'ef'.repeat(32), payouts: [
    { kind: 'signer node', pk: '02' + 'aa'.repeat(32), msat: '18000', feeMsat: '1000' },
    { kind: 'qualifier', pk: winnerPk, msat: '978000', feeMsat: '1000' },
  ] } };
  const signerNodes = async (url) => ({ ok: true, status: 200, json: async () => settled, text: async () => '' });
  const asked = [];
  class Wallet {
    static async join(invite, federationId, secret) { asked.push({ join: { invite, federationId, secret } }); return new Wallet(); }
    async refund(txid, outIdx, fields, secret) {
      asked.push({ refund: { txid, outIdx, fields: JSON.parse(fields), secret } });
      return JSON.stringify({ accepted: true, balance_before: 0, balance_after: 977000, amount_msat: 978000 });
    }
  }
  const won = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, nodes: ['http://a'], fetcher: signerNodes });
  console.log(`  winner: collected ${won.ok}, output ${won.outIdx}, ${won.amountMsat} msat, balance ${won.balance_before} -> ${won.balance_after}`);
  assert.equal(won.ok, true, won.why);
  assert.deepEqual(asked.find((a) => a.refund).refund, { txid: 'ef'.repeat(32), outIdx: 1, secret: toHex(winner.secret),
    fields: { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: '978000', claimPk: winnerPk, refundPk: winnerPk, expiration: 0 } });
  asked.length = 0;
  const lost = await redeemPayout({ round, roundId: rid, invite: INVITE, seed: loserSeed, curve: pageCurve, LockClient: Wallet, nodes: ['http://a'], fetcher: signerNodes });
  console.log(`  loser: collected ${lost.ok} - ${lost.why}; lock client asked ${asked.length} time(s)`);
  assert.equal(lost.ok, false);
  assert.equal(lost.final, true);
  assert.match(lost.why, /pays this seed's key nothing/);
  assert.equal(asked.length, 0, 'a loser\'s page asked the lock client for a payout');
  // ON SCREEN (the wallet panel's settled line): collected, none, or waiting.
  assert.match(payoutLine(won), /^Payout collected: 978000 msat .* \(balance 0 → 977000 msat\)$/);
  assert.match(payoutLine(lost), /^No payout: /);
  console.log(`  screen: "${payoutLine(won)}" / "${payoutLine(lost)}"`);
  // A RELOADED TAB THAT ALREADY COLLECTED: answered from the tab's note, the lock
  // client asked nothing - the contract is spent, and asking again could only fail.
  const tab = new Map();
  const storage = { getItem: (k) => (tab.has(k) ? tab.get(k) : null), setItem: (k, v) => tab.set(k, String(v)), removeItem: (k) => tab.delete(k),
    key: (i) => [...tab.keys()][i] ?? null, get length() { return tab.size; } };
  const first = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, storage, nodes: ['http://a'], fetcher: signerNodes });
  assert.equal(first.ok, true);
  asked.length = 0;
  const again = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, storage, nodes: ['http://a'],
    fetcher: async () => { throw new Error('a kept payout asked the signer nodes'); } });
  assert.equal(again.ok, true);
  assert.equal(again.final, true);
  assert.equal(again.kept, true);
  assert.equal(again.amountMsat, 978000n);
  assert.equal(asked.length, 0, 'a reloaded tab asked the lock client for a payout it already collected');
  assert.equal(payoutLine(again), payoutLine(first));
  asked.length = 0;
  // A PAYOUT ALREADY SPENT (a reload mid-collect, another tab): the federation holds no contract
  // there any more - final, said so, not "waiting ... undefined" for ever.
  class SpentWallet {
    static async join() { return new SpentWallet(); }
    async refund() { return JSON.stringify({ accepted: false, error: 'input already spent', stored_before: null, stored_after: null, balance_before: 0, balance_after: 0 }); }
  }
  const spentOne = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: SpentWallet, nodes: ['http://a'], fetcher: signerNodes });
  assert.equal(spentOne.ok, false);
  assert.equal(spentOne.final, true, 'a payout already spent was asked again for ever');
  assert.equal(spentOne.spent, true);
  assert.match(payoutLine(spentOne), /^Payout already collected: 978000 msat - the payout contract is already spent/);
  // AND ONE THE FEDERATION STILL HOLDS BUT REFUSED: not final, with the federation's reason.
  class RefusedWallet {
    static async join() { return new RefusedWallet(); }
    async refund() { return JSON.stringify({ accepted: false, error: 'guardians busy', stored_before: { contract_id: 'c', blocks_left: 0 }, balance_before: 0, balance_after: 0 }); }
  }
  const refused = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: RefusedWallet, nodes: ['http://a'], fetcher: signerNodes });
  assert.equal(refused.final, false);
  assert.match(payoutLine(refused), /guardians busy/);
  const unsettled = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, nodes: ['http://a'],
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ state: 'NONE' }), text: async () => '' }) });
  assert.equal(unsettled.ok, false);
  assert.equal(unsettled.final, false, 'a page gave up on a payout before the signer nodes settled');
  assert.match(payoutLine(unsettled), /^Payout: waiting for the signer nodes' settlement/);
  assert.match(unsettled.why, /no signer node holds an accepted settlement/);
  assert.equal(asked.length, 0);
});

// 6d: AND THE WINNER'S OWN STAKE BACK BY THE SIGNER NODES' FORFEIT, AFTER THE WINDOW.
test('after the settlement the winner\'s page redeems its own stake by the signer nodes\' forfeit into the same wallet; a loser\'s is final with the lock client asked nothing; inside the window or unsettled it asks again', async () => {
  const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const refund = toHex(refundKeyOf(player.pubkey));
  const fields = { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
  const SIG = 'ab'.repeat(64);
  const asked = [];
  const signerNodes = ({ settled = true, forfeit = 200 } = {}) => async (url) => {
    asked.push(url);
    if (url.includes('/lock-settlement'))
      return new Response(JSON.stringify(settled ? { state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [] } } : { state: 'NONE' }), { status: 200 });
    if (url.includes('/stake-lock'))
      return new Response(JSON.stringify(url.includes(`refund=${refund}`) ? [{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: 'c1' }] : []), { status: 200 });
    if (url.includes('/forfeit'))
      return forfeit === 200 ? new Response(JSON.stringify({ signature: SIG, contractId: 'c1', claimPk: toHex(CLAIM) }), { status: 200 })
        : new Response(forfeit === 'window' ? 'no forfeit before the result is final with its objection window closed: PROVISIONALLY_FINAL'
          : 'that run is FAILED with score 0 and this round\'s minimum is 1: not a qualifier', { status: 409 });
    return new Response('no', { status: 404 });
  };
  let joins = 0;
  const redeemed = [];
  class Wallet {
    static async join() { joins++; return new Wallet(); }
    async redeem(txid, outIdx, f, sig, key) {
      redeemed.push({ txid, outIdx, sig, key });
      return JSON.stringify({ forfeit_verifies: true, accepted: true, amount_msat: 980000, balance_before: 973312, balance_after: 1950624, stored_after: null });
    }
  }
  const tab = new Map();
  const storage = { getItem: (k) => (tab.has(k) ? tab.get(k) : null), setItem: (k, v) => tab.set(k, String(v)), removeItem: (k) => tab.delete(k),
    key: (i) => [...tab.keys()][i] ?? null, get length() { return tab.size; } };
  const ask = { round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, nodes: ['http://a.test'] };

  // THE WINNER, handed the wallet its payout went into: no second join.
  const given = new Wallet();
  const back = await returnStake({ ...ask, storage, client: given, fetcher: signerNodes() });
  console.log(`  winner: "${stakeBackLine(back)}"; joins ${joins}`);
  assert.equal(back.ok, true, back.why);
  assert.equal(back.final, true);
  assert.equal(back.amountMsat, 980000n);
  assert.equal(joins, 0, 'the page opened a second wallet beside the one its payout is in');
  assert.deepEqual(redeemed, [{ txid: 'cd'.repeat(32), outIdx: 0, sig: SIG, key: toHex(player.secret) }]);
  assert.equal(stakeBackLine(back), 'Stake returned: 980000 msat back to this tab\'s federation wallet by the signer nodes\' forfeit (balance 973312 → 1950624 msat)');
  // A RELOAD: answered from the tab's note - signer nodes and wallet asked nothing.
  redeemed.length = 0; asked.length = 0;
  const again = await returnStake({ ...ask, storage, fetcher: signerNodes() });
  assert.equal(again.kept, true);
  assert.equal(again.amountMsat, 980000n);
  assert.equal(asked.length + redeemed.length + joins, 0);

  // A LOSER: every signer node refuses the forfeit as not a qualifier - final, nothing asked of the wallet.
  const lost = await returnStake({ ...ask, fetcher: signerNodes({ forfeit: 409 }) });
  console.log(`  loser: "${stakeBackLine(lost)}"; joins ${joins}, redeems ${redeemed.length}`);
  assert.equal(lost.ok, false);
  assert.equal(lost.final, true);
  assert.match(stakeBackLine(lost), /^No stake back: .*went into the round's pool/);
  assert.equal(joins + redeemed.length, 0, 'a loser\'s page asked the lock client');

  // A STAKE LOCK ALREADY BACK (another tab took it): refused, and the guardians hold no contract
  // there - final, "Stake already back"; measured before: "not back yet - No contract found", for ever.
  class SpentStake {
    static async join() { return new SpentStake(); }
    async redeem() { return JSON.stringify({ forfeit_verifies: true, accepted: false, error: 'The transaction had an invalid input: 0-No contract found for given ContractId',
      amount_msat: 980000, stored_before: null, stored_after: null, balance_before: 0, balance_after: 0 }); }
  }
  const already = await returnStake({ ...ask, LockClient: SpentStake, fetcher: signerNodes() });
  assert.equal(already.ok, false);
  assert.equal(already.final, true, 'a stake already back was asked for again for ever');
  assert.equal(already.spent, true);
  assert.equal(already.amountMsat, 980000n);
  assert.match(stakeBackLine(already), /^Stake already back: 980000 msat - the stake lock is already spent/);
  // AND ONE STILL HELD BUT REFUSED: not final, with the federation's own reason.
  class BusyStake {
    static async join() { return new BusyStake(); }
    async redeem() { return JSON.stringify({ forfeit_verifies: true, accepted: false, error: 'guardians busy', amount_msat: 980000,
      stored_before: { contract_id: 'c1', blocks_left: 140 }, balance_before: 0, balance_after: 0 }); }
  }
  const busy = await returnStake({ ...ask, LockClient: BusyStake, fetcher: signerNodes() });
  assert.equal(busy.final, false);
  assert.match(stakeBackLine(busy), /^Stake: not back yet - guardians busy/);

  // INSIDE THE WINDOW, and UNSETTLED: not final, asked again later, the wallet untouched.
  const early = await returnStake({ ...ask, fetcher: signerNodes({ forfeit: 'window' }) });
  assert.equal(early.final, false);
  assert.match(stakeBackLine(early), /^Stake: not back yet - .*objection window/);
  asked.length = 0;
  const unsettled = await returnStake({ ...ask, fetcher: signerNodes({ settled: false }) });
  assert.equal(unsettled.final, false);
  assert.equal(asked.filter((u) => u.includes('/forfeit') || u.includes('/stake-lock')).length, 0, 'a forfeit was asked for before the signer nodes settled');
  assert.equal(joins + redeemed.length, 0);
});

// W4 / 6d: NOTHING SPENT BEFORE THE PLAYER WITHDRAWS - the page only looks at what is owed.
test('the page looks at what a seed is owed and spends nothing: a winner\'s payout and stake, a loser\'s none, a refused lock waiting then owed after expiry; collect and withdraw happen in one action', async () => {
  const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const mine = toHex(refundKeyOf(player.pubkey));
  const fields = { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
  const signerNodes = ({ settled = true, payout = true, forfeit = 200, known = true } = {}) => async (url) => {
    if (url.includes('/lock-settlement')) return new Response(JSON.stringify(settled ? { state: 'ACCEPTED', txid: 'ef'.repeat(32),
      moved: { payouts: payout ? [{ kind: 'qualifier', pk: mine, msat: '978000' }] : [] } } : { state: 'NONE' }), { status: 200 });
    if (url.includes('/stake-lock')) return new Response(JSON.stringify(known ? [{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: 'c1' }] : []), { status: 200 });
    if (url.includes('/forfeit')) return forfeit === 200 ? new Response(JSON.stringify({ signature: 'ab'.repeat(64), contractId: 'c1', claimPk: toHex(CLAIM) }), { status: 200 })
      : new Response('that run is FAILED with score 0 and this round\'s minimum is 1: not a qualifier', { status: 409 });
    return new Response('no', { status: 404 });
  };
  const spent = [];
  const wallet = (blocksLeft) => ({
    async lockStatus() { return JSON.stringify({ block_count: 464 - blocksLeft, stored: { contract_id: 'c', blocks_left: blocksLeft } }); },
    async refund() { spent.push('refund'); return JSON.stringify({ accepted: true, amount_msat: 978000, balance_before: 0, balance_after: 973312, stored_before: { contract_id: 'p', blocks_left: 0 } }); },
    async redeem() { spent.push('redeem'); return JSON.stringify({ forfeit_verifies: true, accepted: true, amount_msat: 980000, balance_before: 973312, balance_after: 1951232 }); },
    async withdrawableMsat() { return '1930649'; },
    async withdraw() { spent.push('withdraw'); return JSON.stringify({ state: 'Success', invoice_msat: 1930649, gateway: 'gw', balance_before: 1951232, balance_after: 0 }); },
  });
  const ask = { round, roundId: rid, seed, curve: pageCurve, nodes: ['http://a.test'] };
  const kept = { lock: { outpoint: { txid: b32(0xd8), outIdx: 0n }, fields } };

  const won = await lookOwed({ ...ask, fetcher: signerNodes(), client: wallet(0), kept });
  console.log(`  winner, before withdrawing: "${owedLine(won)}"`);
  assert.equal(won.payoutMsat, 978000n);
  assert.equal(won.stakeMsat, 980000n);
  assert.equal(won.owedMsat, 1958000n);
  assert.deepEqual(spent, [], 'looking at what is owed spent something');
  assert.match(owedLine(won), /^978000 msat payout and your 980000 msat stake - yours in the round's federation until you withdraw it/);

  const lost = await lookOwed({ ...ask, fetcher: signerNodes({ payout: false, forfeit: 409 }), client: wallet(0), kept });
  assert.equal(lost.owedMsat, 0n);
  assert.equal(lost.stakeLost, true);
  assert.equal(lost.final, true);
  assert.match(owedLine(lost), /^No payout · No stake back/);

  const early = await lookOwed({ ...ask, fetcher: signerNodes({ payout: false, known: false }), client: wallet(150), kept });
  assert.equal(early.owedMsat, 0n);
  assert.equal(early.final, false);
  assert.match(owedLine(early), /from federation block 464 \(now 314\)/);
  const late = await lookOwed({ ...ask, fetcher: signerNodes({ payout: false, known: false }), client: wallet(0), kept });
  assert.equal(late.refundMsat, 980000n);
  assert.deepEqual(spent, [], 'a lock owed after its expiry was refunded by looking at it');
  // AND ONCE IT IS BACK BY THE PLAYER'S KEY (live, run B1: after its own Withdraw the refused
  // player's tab read "No stake back: no lock of yours is left" for a stake that came back).
  const refunded = { ...wallet(0), async lockStatus() { return JSON.stringify({ block_count: 470, stored: null }); } };
  const back = await lookOwed({ ...ask, fetcher: signerNodes({ payout: false, known: false }), client: refunded, kept });
  assert.equal(back.stake.state, 'gone');
  assert.match(owedLine(back), /Stake 980000 msat: no longer in the federation - back to your key after its expiry/);
  assert.doesNotMatch(owedLine(back), /No stake back/, 'a stake back by the player\'s key read as no stake back');

  const invoiceFor = async (msat) => ({ ok: true, invoice: `lnbcrt${msat}n1p` });
  const done = await collectAndWithdraw({ ...ask, invite: INVITE, LockClient: { join: async () => { throw new Error('a second wallet was opened'); } },
    fetcher: signerNodes(), client: wallet(0), invoiceFor });
  console.log(`  collect and withdraw: ${spent.join(' -> ')}; "${withdrawLine(done.withdraw)}"`);
  assert.deepEqual(spent, ['refund', 'redeem', 'withdraw'], 'the payout, the stake and the withdraw were not one action');
  assert.equal(done.withdraw.ok, true);

  // WINNINGS-AUTO (RULED the owner 2026-10-01): the same owed money, collected BY ITSELF into the player's federation
  // wallet - opened for this federation, the payout redeemed and the stake back - and nothing withdrawn; the history
  // row is what the wallet's balance grew by.
  spent.length = 0;
  let bal = 0n;
  const pw = { ...wallet(0),
    async balanceMsat() { return String(bal); },
    async refund() { spent.push('refund'); bal += 973312n; return JSON.stringify({ accepted: true, amount_msat: 978000, balance_before: 0, balance_after: 973312, stored_before: { contract_id: 'p', blocks_left: 0 } }); },
    async redeem() { spent.push('redeem'); bal += 977920n; return JSON.stringify({ forfeit_verifies: true, accepted: true, amount_msat: 980000, balance_before: 973312, balance_after: 1951232 }); },
    async withdraw() { spent.push('withdraw'); throw new Error('the automatic collect withdrew'); } };
  const joined = [];
  const store = tabStorage();
  const look = await lookOwed({ ...ask, fetcher: signerNodes(), client: wallet(0), kept });
  const auto = await collectIntoPlayerWallet({ ...ask, look, invite: INVITE, storage: store, fetcher: signerNodes(),
    LockClient: { join: async (invite, fed) => { joined.push(fed); return pw; }, lockAllowanceMsat: () => '0' } });
  console.log(`  collected by itself: ${spent.join(' -> ')}; credited ${auto.creditedMsat}`);
  assert.equal(auto.collected, true);
  assert.deepEqual(spent, ['refund', 'redeem'], 'the automatic collect did not redeem both, or withdrew');
  assert.deepEqual(joined, [toHex(round.federationId)], 'not the player wallet of this federation');
  assert.equal(auto.creditedMsat, 973312n + 977920n);
  const rows = ledgerRows(store, round.federationId);
  assert.deepEqual(rows.map((r) => [r.kind, r.msat]), [['winnings', String(973312n + 977920n)]], 'the history has no winnings row of what arrived');
  // AND NOTHING OWED: nothing opened, nothing moved
  const none = await collectIntoPlayerWallet({ ...ask, look: { payoutMsat: 0n, stakeMsat: 0n, refundMsat: 0n }, invite: INVITE, storage: tabStorage(),
    LockClient: { join: async () => { throw new Error('a wallet was opened with nothing owed'); } } });
  assert.equal(none.collected, false);
});

// W4 / 6d: A CLOSED TAB LOSES NOTHING THE FEDERATION HELD - measured on a federation that keeps
// its contracts and each tab's e-cash, the old timer's collect against the look.
test('a winner\'s tab closed before withdrawing: the old timer\'s collect strands the money in the closed tab; the look leaves the federation holding the payout and the stake, and a fresh tab\'s withdraw collects and pays both out', async () => {
  const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const mine = toHex(refundKeyOf(player.pubkey));
  const PAYOUT = `${'ef'.repeat(32)}:0`;
  const STAKE = `${'cd'.repeat(32)}:0`;
  const fields = { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
  const signerNodes = async (url) => {
    if (url.includes('/lock-settlement')) return new Response(JSON.stringify({ state: 'ACCEPTED', txid: 'ef'.repeat(32),
      moved: { payouts: [{ kind: 'qualifier', pk: mine, msat: '978000' }] } }), { status: 200 });
    if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: STAKE, fields: lockFieldsToJson(fields), contractId: 'c1' }]), { status: 200 });
    if (url.includes('/forfeit')) return new Response(JSON.stringify({ signature: 'ab'.repeat(64), contractId: 'c1', claimPk: toHex(CLAIM) }), { status: 200 });
    return new Response('no', { status: 404 });
  };
  // THE FEDERATION: what it holds at each outpoint, each tab's e-cash, what went out over Lightning.
  const federation = () => {
    const held = new Map([[PAYOUT, 978000n], [STAKE, 980000n]]);
    const tabs = []; const paid = [];
    const tab = () => {
      const t = { balance: 0n, calls: [] }; tabs.push(t);
      const take = (txid, i) => {
        const k = `${txid}:${i}`; const m = held.get(k);
        if (m === undefined) return JSON.stringify({ accepted: false, stored_before: null, error: 'No contract found for given ContractId' });
        held.delete(k); const before = t.balance; t.balance += m;
        return JSON.stringify({ accepted: true, forfeit_verifies: true, amount_msat: Number(m), balance_before: Number(before), balance_after: Number(t.balance), stored_before: { contract_id: 'c', blocks_left: 0 } });
      };
      return {
        async lockStatus(txid, i) { t.calls.push('lockStatus'); return JSON.stringify({ block_count: 500, stored: held.has(`${txid}:${i}`) ? { contract_id: 'c', blocks_left: 0 } : null }); },
        async refund(txid, i) { t.calls.push('refund'); return take(txid, i); },
        async redeem(txid, i) { t.calls.push('redeem'); return take(txid, i); },
        async withdrawableMsat() { t.calls.push('withdrawableMsat'); if (t.balance === 0n) throw new Error('Balance is too low to send any amount after fees'); return String(t.balance - 1000n); },
        async withdraw(invoice) {
          t.calls.push('withdraw');
          // A REAL INVOICE IS PAID FOR ITS OWN AMOUNT, and fails when the balance after the fee is short of it.
          let asks = null; try { asks = decodeBolt11(invoice).amountMsat; } catch { asks = null; }
          if (asks !== null && asks > t.balance - 1000n)
            return JSON.stringify({ state: 'Failure', invoice_msat: Number(asks), gateway: 'gw', balance_before: Number(t.balance), balance_after: Number(t.balance) });
          const amt = asks !== null ? asks : t.balance - 1000n; const before = t.balance; paid.push({ invoice, msat: amt }); t.balance -= amt + 1000n;
          return JSON.stringify({ state: 'Success', invoice_msat: Number(amt), gateway: 'gw', balance_before: Number(before), balance_after: 0 });
        },
      };
    };
    return { held, tabs, paid, tab };
  };
  const noJoin = { join: async () => { throw new Error('a second wallet was opened'); } };
  const ask = (storage) => ({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: noJoin, storage, nodes: ['http://a.test'], fetcher: signerNodes });

  // BEFORE: the old 5 s timer - redeemPayout and returnStake into the tab - then the tab closes.
  const was = federation();
  const oldTab = was.tab();
  const oldStorage = tabStorage();
  await redeemPayout({ ...ask(oldStorage), client: oldTab });
  await returnStake({ ...ask(oldStorage), client: oldTab });
  const oldFresh = await lookOwed({ ...ask(tabStorage()), client: was.tab() });
  console.log(`  before (the timer collected, the tab closed): federation holds ${was.held.size} contracts, the closed tab ${was.tabs[0].balance} msat; a fresh tab: "${owedLine(oldFresh)}"`);
  assert.equal(was.held.size, 0);
  assert.equal(was.tabs[0].balance, 1958000n, 'the old path did not strand the money in the closed tab');
  assert.equal(oldFresh.owedMsat, 0n);

  // NOW: the tab only looks - three times, as the 5 s loop does - then closes without a withdraw.
  const fed = federation();
  const closed = fed.tab();
  const closedStorage = tabStorage();
  for (let i = 0; i < 3; i++) {
    const l = await lookOwed({ ...ask(closedStorage), client: closed });
    assert.equal(l.owedMsat, 1958000n);
  }
  assert.deepEqual([...fed.held], [[PAYOUT, 978000n], [STAKE, 980000n]], 'looking changed what the federation holds');
  assert.equal(fed.tabs[0].balance, 0n, 'looking moved money into the tab');
  assert.deepEqual([...new Set(fed.tabs[0].calls)].sort(), ['lockStatus', 'withdrawableMsat'], 'looking asked the wallet to spend');
  assert.equal(closedStorage.m.size, 0, 'looking wrote to the tab');

  // A FRESH TAB after the closed one: everything still owed, in the federation.
  const fresh = fed.tab();
  const freshStorage = tabStorage();
  const seen = await lookOwed({ ...ask(freshStorage), client: fresh });
  console.log(`  after (the tab only looked, then closed): federation holds ${fed.held.size} contracts; a fresh tab: "${owedLine(seen)}"`);
  assert.equal(seen.payoutMsat, 978000n);
  assert.equal(seen.stakeMsat, 980000n);
  assert.equal(seen.final, false);

  // WITHDRAW WITH NO INVOICE TO PAY: nothing collected, it stays in the federation.
  const refused = await collectAndWithdraw({ ...ask(freshStorage), client: fresh, invoiceFor: async () => ({ ok: false }), canInvoice: false });
  assert.equal(refused.withdraw.ok, false);
  assert.equal(fed.held.size, 2, 'a withdraw with no invoice collected into the tab');
  assert.equal(fed.tabs[1].balance, 0n);

  // WITHDRAW: collected and paid out in the one action, through the one wallet.
  const done = await collectAndWithdraw({ ...ask(freshStorage), client: fresh, invoiceFor: async (msat) => ({ ok: true, invoice: `lnbcrt${msat}` }) });
  console.log(`  withdraw: ${fed.tabs[1].calls.filter((c) => !['lockStatus', 'withdrawableMsat'].includes(c)).join(' -> ')}; "${withdrawLine(done.withdraw)}"`);
  assert.equal(done.withdraw.ok, true);
  assert.equal(fed.held.size, 0);
  assert.deepEqual(fed.paid, [{ invoice: 'lnbcrt1957000', msat: 1957000n }]);
  assert.equal(fed.tabs[1].balance, 0n);
  const after = await lookOwed({ ...ask(freshStorage), client: fresh });
  assert.equal(after.final, true);
  assert.equal(after.inTabMsat, 0n);
  assert.equal(owedLine(after), 'Payout 978000 msat collected · Stake 980000 msat back');
  const other = await lookOwed({ ...ask(tabStorage()), client: fed.tab() });
  assert.equal(other.final, true);
  assert.equal(other.owedMsat, 0n);
  assert.match(owedLine(other), /^Payout 978000 msat: no longer in the federation - your key collected it before .* · Stake 980000 msat: no longer in the federation - back to your key before$/);

  // A PASTED INVOICE FOR THE OWED SUM. Before the rule: collected, then the withdraw fails - the
  // money in the tab (the same hole as run 15, by another door).
  const invoice = (msat) => bolt11For(msat);
  const was2 = federation();
  const t2 = was2.tab();
  const before2 = await collectAndWithdraw({ ...ask(tabStorage()), client: t2, invoiceFor: async () => ({ ok: true, invoice: invoice(1958000n) }) });
  console.log(`  pasted for the owed sum, no rule: federation ${was2.held.size} contracts, tab ${was2.tabs[0].balance} msat, "${withdrawLine(before2.withdraw)}"`);
  assert.equal(before2.withdraw.ok, false);
  assert.equal(was2.tabs[0].balance, 1958000n, 'the unruled paste did not strand the money in the tab');
  // NOW: a pasted fixed invoice collects nothing while the federation holds the money.
  const fed2 = federation();
  const t3 = fed2.tab();
  const s3 = tabStorage();
  const refusedPaste = await collectAndWithdraw({ ...ask(s3), client: t3, pasted: invoice(1958000n), invoiceFor: async () => ({ ok: true, invoice: invoice(1958000n) }) });
  console.log(`  pasted for the owed sum, ruled: federation ${fed2.held.size} contracts, tab ${fed2.tabs[0].balance} msat, "${withdrawLine(refusedPaste.withdraw)}"`);
  assert.equal(refusedPaste.withdraw.ok, false);
  assert.match(refusedPaste.withdraw.why, /nothing was collected, it stays in the federation$/);
  assert.equal(fed2.held.size, 2, 'a pasted invoice collected from the federation');
  assert.equal(fed2.tabs[0].balance, 0n);
  assert.deepEqual([...new Set(fed2.tabs[0].calls)].sort(), ['lockStatus', 'withdrawableMsat']);
  const notAnInvoice = await collectAndWithdraw({ ...ask(s3), client: t3, pasted: 'lnbcrt-nothing', invoiceFor: async () => ({ ok: false }) });
  assert.match(notAnInvoice.withdraw.why, /^that is not an invoice/);
  assert.equal(fed2.held.size, 2);
  // MONEY ALREADY IN THE TAB (an earlier build's timer): a paste pays it when it fits, and is refused unmoved when it does not.
  const inTab = federation();
  const t4 = inTab.tab();
  const s4 = tabStorage();
  await redeemPayout({ ...ask(s4), client: t4 });
  await returnStake({ ...ask(s4), client: t4 });
  const tooBig = await collectAndWithdraw({ ...ask(s4), client: t4, pasted: invoice(1958000n), invoiceFor: async () => ({ ok: true, invoice: invoice(1958000n) }) });
  assert.match(tooBig.withdraw.why, /^the invoice asks 1958000 msat and this tab's wallet can pay 1957000 msat/);
  assert.equal(inTab.tabs[0].balance, 1958000n);
  assert.equal(inTab.paid.length, 0);
  const fits = await collectAndWithdraw({ ...ask(s4), client: t4, pasted: invoice(1957000n), invoiceFor: async () => ({ ok: true, invoice: invoice(1957000n) }) });
  console.log(`  already in the tab, pasted for 1957000: "${withdrawLine(fits.withdraw)}"`);
  assert.equal(fits.withdraw.ok, true);
  assert.equal(inTab.tabs[0].balance, 0n);
  assert.deepEqual(inTab.paid.map((x) => x.msat), [1957000n]);
});

// A WITHDRAW SURVIVES THE TAB (the owner 2026-09-14, spec §24). Live, run A3: the page's Withdraw
// collected both into the round's wallet, the tab was closed before it paid out, and >= 973312 msat
// went with the tab's sessionStorage. The page now keeps the round's record and its wallet in the
// browser's storage; this drives the page's own functions over one such storage.
test('a Withdraw cut off after its collect: the next start finds the kept round, reopens the same wallet under the same key and pays it out; with the wallet kept in the tab the next tab reaches nothing', async () => {
  const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const mine = toHex(refundKeyOf(player.pubkey));
  const PAYOUT = `${'ef'.repeat(32)}:0`;
  const STAKE = `${'cd'.repeat(32)}:0`;
  const fields = { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
  const nodes = ['http://a.test'];
  const signerNodes = async (url) => {
    if (url.includes('/lock-settlement')) return new Response(JSON.stringify({ state: 'ACCEPTED', txid: 'ef'.repeat(32),
      moved: { payouts: [{ kind: 'qualifier', pk: mine, msat: '978000' }] } }), { status: 200 });
    if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: STAKE, fields: lockFieldsToJson(fields), contractId: 'c1' }]), { status: 200 });
    if (url.includes('/forfeit')) return new Response(JSON.stringify({ signature: 'ab'.repeat(64), contractId: 'c1', claimPk: toHex(CLAIM) }), { status: 200 });
    return new Response('no', { status: 404 });
  };
  // THE FEDERATION, AND THE STOCK WALLET'S SHAPE: its notes in the store it is handed, read back by the next join.
  const federation = () => {
    const held = new Map([[PAYOUT, 978000n], [STAKE, 980000n]]);
    const paid = [];
    class Wallet {
      static async join(invite, federationId, secret, store) {
        const w = new Wallet(store);
        const kept = JSON.parse(store.entries()).find(([k]) => k === 'notes');
        if (kept) w.balance = BigInt(kept[1]);
        return w;
      }
      constructor(store) { this.store = store; this.balance = 0n; }
      keep() { this.store.put('notes', String(this.balance)); }
      take(txid, i) {
        const k = `${txid}:${i}`; const m = held.get(k);
        if (m === undefined) return JSON.stringify({ accepted: false, stored_before: null, error: 'No contract found for given ContractId' });
        held.delete(k); const before = this.balance; this.balance += m; this.keep();
        return JSON.stringify({ accepted: true, forfeit_verifies: true, amount_msat: Number(m), balance_before: Number(before), balance_after: Number(this.balance), stored_before: { contract_id: 'c', blocks_left: 0 } });
      }
      async lockStatus(txid, i) { return JSON.stringify({ block_count: 500, stored: held.has(`${txid}:${i}`) ? { contract_id: 'c', blocks_left: 0 } : null }); }
      async refund(txid, i) { return this.take(txid, i); }
      async redeem(txid, i) { return this.take(txid, i); }
      async balanceMsat() { return String(this.balance); }
      async withdrawableMsat() { if (this.balance === 0n) throw new Error('Balance is too low to send any amount after fees'); return String(this.balance - 1000n); }
      async withdraw(invoice) {
        const amt = this.balance - 1000n; const before = this.balance; paid.push({ invoice, msat: amt }); this.balance = 0n; this.keep();
        return JSON.stringify({ state: 'Success', invoice_msat: Number(amt), gateway: 'gw', balance_before: Number(before), balance_after: 0 });
      }
    }
    return { held, paid, Wallet };
  };
  const ask = (storage, Wallet) => ({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, storage, nodes, fetcher: signerNodes });
  // THE FIRST START'S WITHDRAW, CUT OFF: the invoice is asked only after the collect, and the tab closes there.
  const cutAfterCollect = async (storage, Wallet) => {
    saveCollect(storage, { roundIdHex: toHex(rid), round, invite: INVITE, nodes, seed });
    const w = await tabLockWallet(ask(storage, Wallet));
    let cut; const reached = new Promise((r) => { cut = r; });
    collectAndWithdraw({ ...ask(storage, Wallet), client: w, invoiceFor: async () => { cut(); return new Promise(() => {}); } });
    await reached;
    return w;
  };

  // BEFORE: the round's record and wallet in the tab's storage.
  const was = federation();
  const oldTab = tabStorage();
  const cutOld = await cutAfterCollect(oldTab, was.Wallet);
  const nextTab = tabStorage();
  const oldKept = savedCollects(nextTab);
  const oldNext = await tabLockWallet(ask(nextTab, was.Wallet));
  console.log(`  before (wallet in the tab): the cut-off tab holds ${cutOld.balance} msat, the federation ${was.held.size} contracts; the next tab keeps ${oldKept.length} rounds and opens ${oldNext.balance} msat`);
  assert.equal(was.held.size, 0);
  assert.equal(cutOld.balance, 1958000n);
  assert.equal(oldKept.length, 0);
  assert.equal(oldNext.balance, 0n, 'a tab-kept wallet was reached from another tab');

  // NOW: the browser's storage, shared by every start.
  const fed = federation();
  const browser = tabStorage();
  const cut = await cutAfterCollect(browser, fed.Wallet);
  assert.equal(fed.held.size, 0, 'the collect did not take both out of the federation');
  assert.equal(cut.balance, 1958000n);
  // THE NEXT START (a reload, another tab, a restarted browser): the kept round, the same key, the same wallet.
  const kept = savedCollects(browser);
  assert.equal(kept.length, 1, 'the next start found no kept round');
  assert.equal(toHex(kept[0].seed), toHex(seed), 'the next start has another key');
  const next = await tabLockWallet({ ...ask(browser, fed.Wallet), seed: kept[0].seed });
  assert.equal(next.balance, 1958000n, 'the next start did not reopen the wallet the Withdraw collected into');
  const seen = await lookOwed({ ...ask(browser, fed.Wallet), client: next });
  assert.equal(seen.inTabMsat, 1957000n);
  assert.equal(seen.owedMsat, 0n);
  // CLAIMED LATER: its Withdraw pays it out.
  const done = await collectAndWithdraw({ ...ask(browser, fed.Wallet), client: next, invoiceFor: async (msat) => ({ ok: true, invoice: `lnbcrt${msat}` }) });
  console.log(`  now (wallet in the browser): the next start keeps ${kept.length} round, opens ${1958000} msat, looks "${owedLine(seen)}", withdraws "${withdrawLine(done.withdraw)}"`);
  assert.equal(done.withdraw.ok, true);
  assert.deepEqual(fed.paid, [{ invoice: 'lnbcrt1957000', msat: 1957000n }]);
  const after = await tabLockWallet({ ...ask(browser, fed.Wallet), seed: kept[0].seed });
  assert.equal(after.balance, 0n);
});

// A WITHDRAWAL CLAIMED ON ANOTHER DEVICE (spec §24, the owner 2026-09-14: alice on her desktop, then her
// iPhone two hours later, holding only her seed). The signer nodes list what they settled; the device derives
// its own key per round and asks for exactly that key.
test('a device holding only the seed matches its own key against the keys each settled round pays and its locks\' refund keys, asks nothing per round, fetches only a matched round and checks it against its id', async () => {
  const mineIn = (r) => toHex(refundKeyOf(playerFor({ ...r, id: roundId(r) }, { seed, curve: pageCurve }).pubkey));
  const other = { ...round, stakeMsat: 100000n };
  const refused = { ...round, stakeMsat: 200000n };
  const stranger = toHex(refundKeyOf(b32(0x62)));
  let asked = [];
  const listing = [
    { id: toHex(rid), state: 'ACCEPTED', payouts: [mineIn(round)], refunds: [mineIn(round), stranger] },
    { id: toHex(roundId(other)), state: 'ACCEPTED', payouts: [stranger], refunds: [stranger] },
    { id: toHex(roundId(refused)), state: 'ACCEPTED', payouts: [], refunds: [mineIn(refused)] },
  ];
  const contracts = new Map([[toHex(rid), encodeRoundContract(round)], [toHex(roundId(refused)), encodeRoundContract(other)]]);
  const signerNodes = async (url) => {
    asked.push(url.replace('http://a.test', ''));
    if (url.includes('/settled?since=')) return new Response(JSON.stringify({ rounds: listing }), { status: 200 });
    const m = url.match(/\/round\?id=([0-9a-f]{64})/);
    if (m && contracts.has(m[1])) return new Response(contracts.get(m[1]), { status: 200 });
    return new Response('no', { status: 404 });
  };
  const ask = { seed, curve: pageCurve, nodes: ['http://a.test'], fetcher: signerNodes, sinceMs: 1000 };
  const found = await findOwedRounds(ask);
  console.log(`  found ${found.length} of ${listing.length} listed: ${found.map((f) => `${f.roundIdHex.slice(0, 12)} payout=${f.payout} lock=${f.lock}`).join(', ')}; asked ${asked.join(' ')}`);
  assert.deepEqual(found.map((f) => f.roundIdHex), [toHex(rid)], 'not exactly the round that pays this seed');
  assert.equal(found[0].payout, true);
  assert.equal(found[0].lock, true);
  assert.deepEqual(asked, ['/settled?since=1000', `/round?id=${toHex(rid)}`, `/round?id=${toHex(roundId(refused))}`],
    'the signer nodes were asked more than the list and the matched rounds - or a round this seed has no key in');
  // a matched round whose contract is not its id (above: the refused round's served as another) is dropped
  asked = [];
  assert.deepEqual(await findOwedRounds({ ...ask, known: [toHex(rid)] }), [], 'a kept round was found again');
  assert.equal(asked.some((u) => u.includes(toHex(rid)) && u.startsWith('/round')), false, 'a kept round was fetched again');
  assert.deepEqual(await findOwedRounds({ ...ask, seed: b32(0x52) }), [], 'another seed was paid this round');
});

/** A BOLT11 invoice for tests: the real encoding, an all-zero signature (as donation-pay.test.js). */
function bolt11For(amountMsat) {
  const amount = amountMsat % 100n === 0n ? `${amountMsat / 100n}n` : `${amountMsat * 10n}p`;
  const ts = 1788700000;
  const words = [];
  for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / 32 ** i) % 32);
  const field = (type, bytes) => { const w = convertBits([...bytes], 8, 5, true); words.push(type, w.length >> 5, w.length & 31, ...w); };
  field(1, b32(0x77));
  field(23, b32(0x78));
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32Encode(`lnbcrt${amount}`, words);
}

// W4 / 6d: THE PAGE'S TIMERS ONLY LOOK. The page's own code: nothing registered on an interval
// collects, redeems, refunds or withdraws; the collect is reached from the Withdraw button only.
test('the page withdraws nothing on a timer: its interval functions look, the payout look collects into the player wallet by itself (WINNINGS-AUTO), and collect-and-withdraw is called from the Withdraw action alone', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url), 'utf8');
  const spends = /redeemPayout|returnStake|refundKept|withdrawCollected|withdrawPlayerWallet|collectOwed|collectAndWithdraw|\.refund\(|\.redeem\(|\.withdraw\(/;
  const timed = [...page.matchAll(/setInterval\((\w+), \d+\)/g)].map((m) => m[1]);
  assert.ok(timed.includes('lookThePayout'), `the look is not on a timer (${timed.join(', ')})`);
  // WINNINGS-AUTO (RULED the owner 2026-10-01): the timed look collects what is owed into the player wallet by itself - and
  // that one call is the only money it moves: it redeems, never withdraws (the spends below stay off every timer)
  const look = page.slice(page.search(/function lookThePayout\(/), page.indexOf('\n    }\n', page.search(/function lookThePayout\(/)));
  assert.match(look, /BLWPCLIENT\.collectIntoPlayerWallet\(/, 'the look does not collect into the player wallet by itself');
  for (const name of timed) {
    const at = page.search(new RegExp(`function ${name}\\(`));
    if (at < 0) continue;
    const body = page.slice(at, page.indexOf('\n    }\n', at));
    assert.doesNotMatch(body, spends, `${name}, on a timer, spends`);
  }
  for (const f of ['redeemPayout', 'returnStake', 'refundKept', 'withdrawCollected', 'collectOwed'])
    assert.ok(!page.includes(`BLWPCLIENT.${f}(`), `the page calls ${f} itself`);
  const calls = [...page.matchAll(/BLWPCLIENT\.collectAndWithdraw\(/g)].map((m) => m.index);
  const withdrawAt = page.indexOf('window.BLWP_WITHDRAW = async function');
  assert.equal(calls.length, 1);
  assert.ok(calls[0] > withdrawAt && calls[0] < page.indexOf('\n    };\n', withdrawAt), 'collect-and-withdraw is called outside the Withdraw action');
  // AND THE PLAYER WALLET'S WITHDRAW (§24A.1) is called only inside a Withdraw press: the lobby's Withdraw action, and
  // Settings' Withdraw button with its round tabs (GROSS-INVOICE-2053) - never on a timer (above).
  const fromWallet = [...page.matchAll(/BLWPCLIENT\.withdrawPlayerWallet\(/g)].map((m) => m.index);
  const settingsAt = page.indexOf("document.getElementById('blwp-wd-go').onclick = async () => {");
  const inside = (i, at, end) => at >= 0 && i > at && i < page.indexOf(end, at);
  assert.equal(fromWallet.length, 2);
  for (const i of fromWallet)
    assert.ok(inside(i, withdrawAt, '\n    };\n') || inside(i, settingsAt, '\n      };\n'), 'the player wallet is withdrawn outside a Withdraw press');
});

// W4 / 6d: A LOCK NO SIGNER NODE WILL SETTLE COMES BACK BY THE PLAYER'S OWN KEY AFTER ITS EXPIRY.
test('a lock no signer node will settle comes back from the tab\'s own record by the player\'s key: before its expiry it waits and says when, after it both locks are refunded, and a lock already gone asks for nothing', async () => {
  const lockRound = { ...round, custody: 'FEDERATION', federationId: TEST_FEDERATION_ID };
  const lr = roundId(lockRound);
  const player = playerFor({ ...lockRound, id: lr }, { seed, curve: pageCurve });
  const kept = { lock: {
    outpoint: { txid: b32(0xd8), outIdx: 0n }, fields: { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 },
    feeLock: { outpoint: { txid: b32(0xd9), outIdx: 0n }, fields: { paymentImage: { kind: 'hash', bytes: b32(0x44) }, amountMsat: 20000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 } },
  } };
  const refunded = [];
  const wallet = (status) => ({
    async lockStatus(txid) { return JSON.stringify(status(txid)); },
    async refund(txid, outIdx, fields, key) {
      refunded.push({ txid, key, amount: JSON.parse(fields).amountMsat });
      return JSON.stringify({ accepted: true, error: null, balance_before: refunded.length === 1 ? 0 : 976000, balance_after: refunded.length === 1 ? 976000 : 993000 });
    },
  });
  const ask = { round: lockRound, roundId: lr, seed, curve: pageCurve, kept };
  const early = await refundKept({ ...ask, client: wallet(() => ({ block_count: 320, stored: { contract_id: 'c', blocks_left: 144 } })) });
  console.log(`  before expiry: "${refundLine(early)}"`);
  assert.equal(early.final, false);
  assert.equal(refunded.length, 0, 'a lock was refunded before its expiry');
  assert.match(refundLine(early), /come back to your key from federation block 464 \(now 320\)/);

  const late = await refundKept({ ...ask, client: wallet(() => ({ block_count: 464, stored: { contract_id: 'c', blocks_left: 0 } })) });
  console.log(`  after expiry: "${refundLine(late)}"`);
  assert.equal(late.ok, true);
  assert.equal(late.final, true);
  assert.equal(late.refundedMsat, 1000000n);
  assert.deepEqual(refunded.map((r) => [r.txid, r.key]), [[toHex(b32(0xd8)), toHex(player.secret)], [toHex(b32(0xd9)), toHex(player.secret)]]);
  assert.match(refundLine(late), /^Back by your own key after expiry: 1000000 msat to this tab's wallet \(stake \+ fee locks; balance 0 → 993000 msat\)/);

  refunded.length = 0;
  const gone = await refundKept({ ...ask, client: wallet(() => ({ block_count: 470, stored: null })) });
  assert.equal(gone.final, true);
  assert.equal(gone.ok, false);
  assert.equal(refunded.length, 0, 'a lock already gone was refunded');
  assert.equal(refundLine(gone), 'No lock of yours is left in the federation for this round');
});

// 6d'S DESTINATION (24A.2): THE TAB'S WALLET WITHDRAWN OVER LIGHTNING TO THE PLAYER'S OWN.
test('the collected payout and stake leave the tab: the whole withdrawable balance to an invoice from the player\'s own wallet; a refunded withdraw stays in the tab and says so; an empty wallet asks for no invoice', async () => {
  const asked = [];
  const wallet = (state, withdrawable = 1937000n) => ({
    async withdrawableMsat() { return String(withdrawable); },
    async withdraw(invoice) {
      asked.push(invoice);
      return JSON.stringify({ state, preimage: state === 'Success' ? 'ab'.repeat(32) : null, invoice_msat: Number(withdrawable), gateway: 'gw1',
        balance_before: 1951232, balance_after: state === 'Success' ? 0 : 1951232 });
    },
  });
  const invoices = [];
  const invoiceFor = async (msat) => { invoices.push(msat); return { ok: true, invoice: `lnbcrt${msat}n1player` }; };
  const out = await withdrawCollected({ client: wallet('Success'), invoiceFor });
  console.log(`  withdrawn: "${withdrawLine(out)}"`);
  assert.equal(out.ok, true);
  assert.equal(out.final, true);
  assert.deepEqual(invoices, [1937000n], 'the invoice was not for the whole withdrawable balance');
  assert.deepEqual(asked, ['lnbcrt1937000n1player']);
  assert.equal(withdrawLine(out), 'Withdrawn: 1937000 msat to your own wallet over Lightning (this tab\'s wallet 1951232 → 0 msat)');

  const back = await withdrawCollected({ client: wallet('Refunded'), invoiceFor });
  assert.equal(back.ok, false);
  assert.equal(back.final, false, 'a refunded withdraw was taken as done');
  assert.match(withdrawLine(back), /^Withdraw: the withdraw ended Refunded - the money is back in this tab's wallet/);

  invoices.length = 0; asked.length = 0;
  const empty = await withdrawCollected({ client: wallet('Success', 0n), invoiceFor });
  assert.equal(empty.ok, false);
  assert.equal(empty.final, true);
  assert.equal(invoices.length + asked.length, 0, 'an empty wallet asked the player for an invoice');

  const noInvoice = await withdrawCollected({ client: wallet('Success'), invoiceFor: async () => ({ ok: false, why: 'paste an invoice from your wallet' }) });
  assert.equal(noInvoice.final, false);
  assert.match(withdrawLine(noInvoice), /paste an invoice from your wallet/);
  assert.equal(withdrawLine(null, 1937000n), '1937000 msat is in this tab\'s wallet - withdraw it to your own wallet before you close the tab');
  assert.equal(withdrawLine(null, 0n), '');
});

// 6d, W4 HOLE 1: A RELOAD ONTO THE ROUND LINK MUST NOT ASK A SECOND DEPOSIT.
test('a reloaded tab with no kept lock joins anew; with a kept lock no signer node committed it reuses it; with one a signer node committed it stops and never stakes again', () => {
  assert.deepEqual(keptLockUse(null), { use: 'new' });
  const kept = { stake: { preimage: b32(1) }, lock: { outpoint: { txid: b32(0xd8), outIdx: 0n } }, committedTo: null };
  const reuse = keptLockUse(kept);
  assert.equal(reuse.use, 'reuse');
  assert.equal(reuse.kept, kept);
  const staked = keptLockUse({ ...kept, committedTo: 'ee'.repeat(32) });
  assert.equal(staked.use, 'staked');
  assert.match(staked.why, /already locked and committed to entry eeeeeeeeeeeeeeee…: no second deposit/);
  assert.match(staked.why, /payout and stake are collected after the window/);
});

// 6d: A RELOAD MUST NOT LOSE THE COLLECT - measured, it left 978000 + 980000 msat in the federation.
test('what the tab still has to collect is kept per round across a reload: the round, invite, signer nodes, seed and lock come back whole; a done round keeps its lines; an unreadable record is skipped', () => {
  const tab = new Map();
  const storage = { getItem: (k) => (tab.has(k) ? tab.get(k) : null), setItem: (k, v) => tab.set(k, String(v)), removeItem: (k) => tab.delete(k),
    key: (i) => [...tab.keys()][i] ?? null, get length() { return tab.size; } };
  const lockRound = { ...round, custody: 'FEDERATION', federationId: TEST_FEDERATION_ID };
  const lr = toHex(roundId(lockRound));
  const stakeLock = { outpoint: { txid: b32(0xd8), outIdx: 1n },
    fields: { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(playerFor({ ...lockRound, id: roundId(lockRound) }, { seed, curve: pageCurve }).pubkey), expiration: 464 } };
  assert.equal(saveCollect(storage, { roundIdHex: lr, round: lockRound, invite: INVITE, nodes: ['http://a.test', 'http://b.test'], seed, stakeLock }), true);
  tab.set('blwp.collect.' + 'ff'.repeat(32), 'not json');
  const kept = savedCollects(storage);
  assert.equal(kept.length, 1, 'an unreadable record was returned, or the kept one lost');
  const k = kept[0];
  assert.equal(k.roundIdHex, lr);
  assert.equal(toHex(roundId(k.round)), lr, 'the round came back as another contract');
  assert.equal(k.invite, INVITE);
  assert.deepEqual(k.nodes, ['http://a.test', 'http://b.test']);
  assert.equal(toHex(k.seed), toHex(seed));
  assert.equal(toHex(k.stakeLock.outpoint.txid), toHex(b32(0xd8)));
  assert.equal(k.stakeLock.outpoint.outIdx, 1n);
  assert.deepEqual(lockFieldsToJson(k.stakeLock.fields), lockFieldsToJson(stakeLock.fields));
  assert.equal(k.done, null);
  // DONE: both answers final - kept with their lines, and a later save (a rejoin) does not undo it.
  assert.equal(markCollectDone(storage, lr, { payout: 'Payout collected: 978000 msat', stake: 'Stake returned: 980000 msat' }), true);
  saveCollect(storage, { roundIdHex: lr, round: lockRound, invite: INVITE, nodes: ['http://a.test'], seed, stakeLock });
  assert.deepEqual(savedCollects(storage)[0].done, { payout: 'Payout collected: 978000 msat', stake: 'Stake returned: 980000 msat' });
  assert.equal(markCollectDone(storage, 'ee'.repeat(32), {}), false, 'a round never kept was marked done');
  // A LOCK THAT DOES NOT ENCODE (amount and expiry only) STILL LEAVES THE RECORD - without the
  // lock; measured on 0.0.1236 it threw the record away and the collect never ran.
  const other = { ...lockRound, stakeMsat: 2000000n };
  const or = toHex(roundId(other));
  assert.equal(saveCollect(storage, { roundIdHex: or, round: other, invite: INVITE, nodes: ['http://a.test'], seed,
    stakeLock: { outpoint: { txid: b32(0xd9), outIdx: 0n }, fields: { amountMsat: 1960000n, expiration: 464 } } }), true);
  const half = savedCollects(storage).find((r) => r.roundIdHex === or);
  assert.ok(half, 'a record whose lock did not encode was not kept');
  assert.equal(half.stakeLock, null);
  assert.equal(toHex(half.seed), toHex(seed));
  // NO STORAGE: nothing kept, nothing thrown.
  assert.deepEqual(savedCollects(null), []);
});

test('a player wallet whose lock fee the allowance does not cover is topped up after the quote, and one that never funds is refused', async () => {
  const { LockClient, log } = lockClient({ lockFee: 6000n });
  const deposits = [];
  const tab = tabStorage();
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab, onDeposit: (d) => deposits.push(String(d.creditsMsat)) });
  // 984940 credited; the lock costs 986000, so the quote still fails on the funds held (a dry run names no
  // shortfall) and the allowance goes in again - into the player wallet, before the stake.
  assert.deepEqual(deposits, [String(lockAmountMsat(round) + 4940n), '4940']);
  await ask({ LockClient, storage: tab });
  assert.equal(log.filter((l) => l.lock).length, 1);
  await assert.rejects(() => fundPlayerWallet({ round, invite: INVITE, seed, LockClient: lockClient({ lockFee: 10n ** 12n }).LockClient }),
    /after 3 deposits the player wallet/);
});

/** The tab's storage, as the page has it (sessionStorage's shape). */
function tabStorage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}

test('a tab reloaded between the top-up and the stake reopens the player wallet that holds it, and is not asked to pay again', async () => {
  const tab = tabStorage();
  // THE FIRST LOAD: tops the player wallet up, and the tab goes away before the stake is locked.
  const first = lockClient();
  const deposits = [];
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient: first.LockClient, storage: tab, onDeposit: (d) => deposits.push(d) });
  await assert.rejects(() => ask({ LockClient: first.LockClient, storage: tab,
    onStep: (s) => { if (s === 'locking the stake') throw new Error('the tab closed'); } }), /the tab closed/);
  assert.equal(deposits.length, 1);
  assert.ok([...tab.m.keys()].some((k) => k.startsWith('blwp.walletdb.')), 'the player wallet was kept nowhere');
  assert.ok(![...tab.m.keys()].some((k) => k.startsWith('blwp.lockdb.')), 'a per-round wallet was kept for the stake');
  assert.ok(![...tab.m.keys()].some((k) => k.includes(toHex(walletSecretFor(seed, TEST_FEDERATION_ID)))), 'the wallet\'s secret is in the tab\'s keys');
  // THE RELOAD: the same seed's player wallet for this federation is reopened, top-up and all.
  const again = lockClient();
  const steps = [];
  const got = await ask({ LockClient: again.LockClient, storage: tab, onStep: (s) => steps.push(s) });
  const joined = again.log.find((l) => l.join).join;
  assert.ok(joined.kept > 0, 'the reloaded page joined an empty wallet');
  assert.equal(again.log.filter((l) => l.receive).length, 0, 'the reloaded page asked the player to pay again');
  assert.ok(steps.includes('reopening the player wallet this tab keeps for this federation'));
  assert.ok(steps.some((x) => x.startsWith(`the player wallet holds ${lockAmountMsat(round) + 4940n} msat; locking`)));
  assert.equal(`${toHex(got.outpoint.txid)}:${got.outpoint.outIdx}`, `${'ab'.repeat(32)}:0`);
  // AND ANOTHER SEED IN THE SAME TAB DOES NOT OPEN THAT WALLET.
  const other = lockClient();
  await assert.rejects(() => ask({ LockClient: other.LockClient, storage: tab, seed: b32(0x52) }), /the player wallet holds 0 msat/);
  assert.equal(other.log.find((l) => l.join).join.kept, 0, 'another seed opened this seed\'s wallet');
});

test('a lock the tab made is kept with its stake until a signer node commits it: rebuilt exactly, and marked once committed', async () => {
  const signerNodes = [0x21, 0x22].map((n) => pageCurve.pointX(b32(n)));
  const player2 = pageCurve.pointX(b32(0x62));
  const stake = await stakeFor({ ...round, id: rid }, { signerNodes, curve: pageCurve, random: (n) => new Uint8Array(n).fill(9), playerPubkey: player2, needed: 2 });
  const lock = { outpoint: { txid: b32(0xd8), outIdx: 1n },
    fields: { paymentImage: { kind: 'point', bytes: stake.stakePoint }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player2), expiration: 464 } };
  const tab = tabStorage();
  const who = { roundId: rid, playerPubkey: player2 };
  assert.equal(savedLock(tab, who), null);
  saveLock(tab, { ...who, stake, lock });
  const back = savedLock(tab, who);
  for (const k of ['preimage', 'stakeCommitment', 'vssSharesRef', 'stakePoint', 'body'])
    assert.equal(toHex(back.stake[k]), toHex(stake[k]), `the kept stake's ${k} is not the dealt one`);
  assert.equal(`${toHex(back.lock.outpoint.txid)}:${back.lock.outpoint.outIdx}`, `${toHex(b32(0xd8))}:1`);
  assert.deepEqual({ ...back.lock.fields, paymentImage: toHex(back.lock.fields.paymentImage.bytes), claimPk: toHex(back.lock.fields.claimPk), refundPk: toHex(back.lock.fields.refundPk) },
    { ...lock.fields, paymentImage: toHex(stake.stakePoint), claimPk: toHex(CLAIM), refundPk: toHex(refundKeyOf(player2)) });
  assert.equal(back.committedTo, null);
  markLockCommitted(tab, { ...who, entryId: b32(0xee) });
  assert.equal(savedLock(tab, who).committedTo, toHex(b32(0xee)));
  assert.equal(savedLock(tab, { roundId: rid, playerPubkey: b32(0x63) }), null, 'another player got this player\'s kept lock');
});

test('the lock is shown as what it is: the amount, where, and the block it comes back to the player\'s key from', () => {
  const line = lockLine({ outpoint: { txid: b32(0xd8), outIdx: 0n }, fields: { amountMsat: 980000n, expiration: 465 } });
  assert.equal(line, `stake locked in the round's federation: 980000 msat at ${'d8'.repeat(8)}…:0 · back to your key from federation block 465 if nobody settles it`);
  assert.equal(lockLine(null), '');
});

// M3 W7: THE CLIENT PUTS NO STAKE INTO A ROUND WHOSE CUSTODY FIELDS FAIL. Before: lockStake checked only
// that the round named a non-zero federation; the 144-block expiry and the relays were not its business.
test('no lock is made for a named FEDERATION round whose custody fields fail - the expiry is not 144 blocks, or it names no relay - and the lock client is not even joined', async () => {
  for (const [what, bad, why] of [
    ['expiry 12', { ...round, stakeExpiryBlocks: 12 }, /stake_expiry_blocks 12 where §23\.1 rules 144/],
    ['no relay', { ...round, publicationRelays: [] }, /takes a stake and names no publication relay/],
  ]) {
    const { LockClient, log } = lockClient();
    await assert.rejects(ask({ round: bad, invite: INVITE, LockClient }), (e) => {
      assert.match(e.message, /^no stake is locked to this round: /);
      assert.match(e.message, why);
      return true;
    }, what);
    assert.equal(log.filter((x) => x.join).length, 0, `${what}: the lock client was joined for a round the page refused`);
  }
});

test('no lock is made for a link naming no federation, a key without its attestation, a round naming no federation, or a stake with no point', async () => {
  const { LockClient, log } = lockClient();
  const cases = [
    [{ invite: '' }, /the link names no federation/],
    [{ claimKey: { ok: false, claimPk: CLAIM } }, /must refuse to lock to a key without them|without it/],
    [{ round: { ...round, federationId: new Uint8Array(32) } }, /names no federation, so its stake is not a lock/],
    [{ stake: { stakePoint: new Uint8Array(33) } }, /this stake names none/],
    [{ LockClient: null }, /no lock client was loaded|none was loaded/],
  ];
  for (const [extra, why] of cases) await assert.rejects(() => ask({ LockClient, ...extra }), why);
  assert.equal(log.length, 0, 'the lock client was asked for a lock the page should have refused');
});

test('an answer that is not the lock asked for is refused: another contract at the outpoint, or another amount', async () => {
  // EACH FROM A TOPPED-UP PLAYER WALLET: the stake is spent from it, and a wallet that cannot pay is refused before any lock.
  const funded = async (c) => { const tab = tabStorage(); await fundPlayerWallet({ round, invite: INVITE, seed, LockClient: c, storage: tab }); return ask({ LockClient: c, storage: tab }); };
  await assert.rejects(() => funded(lockClient({ idsMatch: false }).LockClient), /another contract at that outpoint/);
  await assert.rejects(() => funded(lockClient({ lockedMsat: 979999 }).LockClient), /locked 979999 msat, and this entry's net stake is 980000/);
});

test('the lock handed to a signer node that verifies it is committed; an entry naming no lock is refused, and the hand-over says so', async () => {
  const good = await joinedWithLock({ claimKeyFor: () => CLAIM });
  const none = await joinedWithLock({ claimKeyFor: () => CLAIM }, { outpoint: { txid: new Uint8Array(32), outIdx: 0n } });
  try {
    const a = await handLock({ entryId: good.eid, fields: good.fields, nodes: [`http://127.0.0.1:${good.d.port}`], needed: 1 });
    const b = await handLock({ entryId: none.eid, fields: none.fields, nodes: [`http://127.0.0.1:${none.d.port}`], needed: 1 });
    console.log(`  handed to a signer node: ${a.said.map((s) => s.status)} (committed ${a.committed}); no lock named: ${b.said.map((s) => `${s.status} ${s.why}`)}`);
    assert.deepEqual([a.ok, a.committed, String(good.d.round.stakeSeen(good.eid).paidMsat)], [true, 1, String(good.fields.amountMsat)]);
    assert.deepEqual([b.ok, b.committed, b.said[0].status], [false, 0, 409]);
    assert.match(b.said[0].why, /that entry names no stake lock outpoint/);
    assert.equal(none.d.round.stakeSeen(none.eid), null);
  } finally { await good.close(); await none.close(); }
});

test('a lock round\'s entry names its lock\'s outpoint and is not built without one; a round naming no federation, or the withdrawn custody, is handed none', () => {
  const opts = { seed, curve: pageCurve, random: (n) => new Uint8Array(n).fill(7), claimKey };
  const outpoint = { txid: b32(0xab), outIdx: 3n };
  const entry = entryFor(round, { ...opts, stakeLock: { outpoint } });
  assert.equal(`${toHex(entry.stakeLockOutpoint.txid)}:${entry.stakeLockOutpoint.outIdx}`, `${toHex(b32(0xab))}:3`);
  assert.throws(() => entryFor(round, opts), /no lock was made: an entry naming no stake lock outpoint/);
  assert.throws(() => entryFor(round, { ...opts, stakeLock: { outpoint: { txid: new Uint8Array(32), outIdx: 0n } } }), /no lock was made/);
  // A ROUND NAMING NO FEDERATION IS NO CONTRACT (M3 W7): a paying FEDERATION round with a zero id is refused,
  // and the withdrawn THRESHOLD_LN (RULED 2026-09-22 22:59) is no round at all - no entry is built for it.
  assert.throws(() => entryFor({ ...round, federationId: new Uint8Array(32) }, opts), /takes a stake into a FEDERATION and names no federation_id/);
  const withdrawn = { ...round, custody: 'THRESHOLD_LN', federationId: new Uint8Array(32) };
  assert.throws(() => entryFor(withdrawn, { ...opts, stakeLock: { outpoint } }), /THRESHOLD_LN is not a custody this network has/);
  assert.throws(() => entryFor(withdrawn, opts), /THRESHOLD_LN is not a custody this network has/);
});

test('the refund from the seed alone: the signer nodes are asked by the seed\'s refund key, and the lock client refunds that lock with the player\'s key', async () => {
  const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const refund = toHex(refundKeyOf(player.pubkey));
  const fields = { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    const hit = url.includes(`refund=${refund}`);
    return new Response(JSON.stringify(hit ? [{ entryId: 'ee'.repeat(32), outpoint: `${'ab'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: 'c1' }] : []), { status: 200 });
  };
  const refunded = [];
  class Fake {
    static async join(invite, federationId, secret) { refunded.push({ join: { federationId, secret } }); return new Fake(); }
    async refund(txid, outIdx, f, key) { refunded.push({ refund: { txid, outIdx, f: JSON.parse(f), key } }); return JSON.stringify({ accepted: true, balance_after: 978000 }); }
  }
  const got = await refundStake({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Fake,
    nodes: ['http://a.test', 'http://b.test'], fetcher });
  assert.equal(asked.length, 2, 'not every signer node was asked');
  assert.ok(asked.every((u) => u.includes(`round=${toHex(rid)}`) && u.includes(`refund=${refund}`)));
  const r = refunded.find((x) => x.refund).refund;
  assert.deepEqual([r.txid, r.outIdx, r.key], ['ab'.repeat(32), 0, toHex(player.secret)]);
  assert.deepEqual(r.f, lockFieldsToJson(fields));
  assert.equal(refunded.find((x) => x.join).join.secret, toHex(lockSecretFor(seed, rid)));
  assert.deepEqual(got.refunds.map((x) => x.accepted), [true]);
  // AND ANOTHER SEED FINDS NOTHING TO REFUND.
  await assert.rejects(() => refundStake({ round, roundId: rid, invite: INVITE, seed: b32(0x53), curve: pageCurve, LockClient: Fake,
    nodes: ['http://a.test'], fetcher }), /no signer node knows a stake lock that refunds to this seed's key/);
});

test('the redeem from the seed alone: the signer nodes\' forfeit and the player\'s key go to the lock client; a lock no signer node forfeits is not redeemed', async () => {
  const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const refund = toHex(refundKeyOf(player.pubkey));
  const fields = { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
  const SIG = 'ab'.repeat(64);
  const signerNodesSay = (forfeitStatus) => async (url) => {
    if (url.includes('/stake-lock'))
      return new Response(JSON.stringify(url.includes(`refund=${refund}`) ? [{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: 'c1' }] : []), { status: 200 });
    if (url.includes('/forfeit'))
      return forfeitStatus === 200
        ? new Response(JSON.stringify({ signature: SIG, contractId: 'c1', claimPk: toHex(CLAIM) }), { status: 200 })
        : new Response('that run is FAILED with score 128 and this round\'s minimum is 1: not a qualifier', { status: 409 });
    return new Response('no', { status: 404 });
  };
  const calls = [];
  class Fake {
    static async join() { return new Fake(); }
    async redeem(txid, outIdx, f, sig, key) { calls.push({ txid, outIdx, sig, key, f: JSON.parse(f) }); return JSON.stringify({ forfeit_verifies: true, accepted: true }); }
  }
  const got = await redeemStake({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Fake,
    nodes: ['http://a.test', 'http://b.test'], fetcher: signerNodesSay(200) });
  assert.deepEqual(calls.map((c) => [c.txid, c.outIdx, c.sig, c.key]), [['cd'.repeat(32), 0, SIG, toHex(player.secret)]]);
  assert.deepEqual(calls[0].f, lockFieldsToJson(fields));
  assert.deepEqual(got.redeems.map((r) => [r.accepted, r.forfeitFrom]), [[true, 'http://a.test']]);
  // A LOSER'S: every signer node refuses the forfeit, and nothing reaches the lock client.
  calls.length = 0;
  await assert.rejects(() => redeemStake({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Fake,
    nodes: ['http://a.test', 'http://b.test'], fetcher: signerNodesSay(409) }), /no signer node gave a forfeit of this lock: .*not a qualifier/);
  assert.equal(calls.length, 0, 'a lock no signer node forfeited was sent to the federation');
});

test('the join link carries the federation\'s invite, and refuses one that is not an invite code', () => {
  const base = `?round=${'aa'.repeat(32)}&node=http://a.test,http://b.test&bond=http://c.test&advert=${'ab'.repeat(64)}`;
  assert.equal(joinQuery(base).federation, null);
  assert.equal(joinQuery(`${base}&federation=${INVITE}`).federation, INVITE);
  assert.throws(() => joinQuery(`${base}&federation=http://evil.test`), /not a federation invite code/);
});

// A DEPOSIT ONLY THROUGH A GATEWAY THAT HOLDS E-CASH (the owner 2026-09-30 14:30: "Do not pick a gateway at random"). The
// lock client's plan named 'http://gw' (its own pick); the operator lists the funded gateway, and the receive names that.
test('a deposit goes through the listed funded gateway, not the lock client\'s pick', async () => {
  const { LockClient, log } = lockClient();
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tabStorage(), gateways: ['https://funded.example/'] });
  const asked = log.filter((l) => l.receive).map((l) => l.receive.gateway);
  assert.ok(asked.length > 0, 'no deposit was asked');
  assert.deepEqual([...new Set(asked)], ['https://funded.example/']);
  const { LockClient: L2, log: log2 } = lockClient();
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient: L2, storage: tabStorage() });
  assert.deepEqual([...new Set(log2.filter((l) => l.receive).map((l) => l.receive.gateway))], ['http://gw'], 'with no list the plan stands');
});

// THE INVOICE AT ONCE (INSTANT-1527): measured, depositFor took 256.8 s in a page on testnet4. With estimateDeposit the
// invoice is sized here - depositFor is never asked - and it carries the margin, so the wallet is credited what it needs.
test('an estimated deposit asks no depositFor, and its invoice carries the margin', async () => {
  const { LockClient, log } = lockClient();
  let quoted = 0;
  const orig = LockClient.prototype.depositFor;
  LockClient.prototype.depositFor = function (...a) { quoted++; return orig.apply(this, a); };
  const deposits = [];
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tabStorage(), estimateDeposit: true,
    gateways: ['https://funded.example/'], onDeposit: (d) => deposits.push(d) });
  assert.equal(quoted, 0, 'depositFor was asked');
  assert.ok(deposits.length >= 1);
  const first = log.find((l) => l.receive).receive;
  assert.equal(first.gateway, 'https://funded.example/');
  assert.ok(BigInt(first.msat) > deposits[0].creditsMsat, 'the invoice is not above what it credits');
});


// THE WALLET'S HISTORY (the owner 2026-09-30 16:15; accepted sequence): one list per federation in the tab's vault - a
// deposit once its receive is claimed, a stake when saveLock keeps the lock (its entry added on commit), a withdrawal
// when it succeeds; and a stake row names its round and entry, from which the replay link is built.
test('the wallet history: a deposit, then a stake, then a withdrawal are three rows; the stake row names its round and entry, and a replay link is built from it', async () => {
  const { LockClient } = lockClient();
  const tab = tabStorage();
  await fundPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab });
  const got = await ask({ LockClient, storage: tab });
  saveLock(tab, { roundId: rid, playerPubkey: player, stake: { preimage: b32(0x44), body: new Uint8Array(0) }, lock: got, federationId: round.federationId });
  markLockCommitted(tab, { roundId: rid, playerPubkey: player, entryId: b32(0x0e) });
  // WHAT A SETTLED ROUND RETURNED TO THE WALLET, for the withdraw to take (the stand-in's balance, on the open wallet)
  (await playerWallet({ round, invite: INVITE, seed, LockClient, storage: tab })).balance += 50000n;
  const w = await withdrawPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab, invoiceFor: async () => ({ ok: true, invoice: 'lnbcrt1out' }) });
  assert.equal(w.ok, true);
  const rows = ledgerRows(tab, round.federationId);
  console.log('  FACTS (history):', JSON.stringify(rows.map(({ atMs, ...r }) => r)));
  assert.deepEqual(rows.map((r) => r.kind), ['deposit', 'stake', 'withdrawal']);
  assert.ok('invoiceHash' in rows[0] && BigInt(rows[0].msat) > 0n);
  const stakeRow = rows[1];
  assert.equal(stakeRow.round, toHex(rid));
  assert.equal(stakeRow.entry, '0e'.repeat(32));
  assert.equal(stakeRow.msat, String(got.fields.amountMsat + (got.feeLock ? got.feeLock.fields.amountMsat : 0n)));
  assert.equal(rows[2].state, 'Success');
  const link = replayLinkFor({ endpoints: ['wss://test-host.example/guardian-1'], roundHex: stakeRow.round, entryHex: stakeRow.entry });
  assert.equal(link.ok, true, link.why);
  assert.ok(link.url.includes(`round=${stakeRow.round}`) && link.url.includes(`entry=${stakeRow.entry}`), link.url);
  assert.equal(ledgerReadSavedStakes(tab, round.federationId), 0, 'the stake the history already holds was added again');
  assert.equal(ledgerRows(tab, b32(0x77)).length, 0, 'another federation shows this one\'s rows');
});

test('stakes kept before the history existed are read into it once', () => {
  const tab = tabStorage();
  const lock = { outpoint: { txid: b32(0xab), outIdx: 0n }, fields: { ...lockFieldsFromJson({ amountMsat: '9800000', paymentImage: { kind: 'hash', bytes: 'aa'.repeat(32) },
    claimPk: '02' + 'bb'.repeat(32), refundPk: '02' + 'cc'.repeat(32), expiration: '154698' }) }, feeLock: null };
  saveLock(tab, { roundId: rid, playerPubkey: player, stake: { preimage: b32(0x44), body: new Uint8Array(0) }, lock });
  assert.equal(ledgerRows(tab, round.federationId).length, 0, 'a lock saved with no federation named was written to a history');
  assert.equal(ledgerReadSavedStakes(tab, round.federationId), 1);
  const [row] = ledgerRows(tab, round.federationId);
  assert.equal(row.kind, 'stake'); assert.equal(row.round, toHex(rid)); assert.equal(row.msat, '9800000'); assert.equal(row.atMs, null);
  assert.equal(ledgerReadSavedStakes(tab, round.federationId), 0, 'read twice');
});


// GROSS-INVOICE-2053 (the owner 2026-09-30 20:53): the deposit is the gross round amount, chosen in round tabs.
test('the deposit tabs are this round\'s stake times 1, 2, 5 and 10, then Custom - 100 sat is 100, 200, 500, 1000', () => {
  const c100 = depositChoices(100000n);
  assert.deepEqual(c100.map((c) => c.label), ['1 round', '2 rounds', '5 rounds', '10 rounds', 'Custom']);
  assert.deepEqual(c100.slice(0, 4).map((c) => String(c.msat / 1000n)), ['100', '200', '500', '1000']);
  assert.equal(c100[4].msat, null);
  assert.deepEqual(depositChoices(10000000n).slice(0, 4).map((c) => String(c.msat / 1000n)), ['10000', '20000', '50000', '100000']);
  assert.equal(DEPOSIT_INSUFFICIENT, 'insufficient funds to play this round. Do you want to do a lightning deposit?');
});

/** A stand-in wallet as measured on 337ae01a (2026-10-01): e-cash in whole 512 msat notes - a deposit credits its whole
 * notes (100000 -> 99840), a lock costs its amount in whole notes (98000 -> 98304), the fee rule is 0/0. */
function noteClient() {
  const log = [];
  class Note {
    static async join(invite, federationId, secret, store) {
      const f = new Note(store);
      const kept = store ? JSON.parse(store.entries()) : [];
      const bal = kept.find(([k]) => k === 'ba'); if (bal) f.balance = BigInt(`0x${bal[1]}`);
      return f;
    }
    static lockAllowanceMsat(msat) { return String(2000n + BigInt(msat) * 3000n / 1000000n); }
    constructor(store) { this.store = store; this.balance = 0n; this.coming = 0n; }
    keep() { if (this.store) this.store.put('ba', this.balance.toString(16).padStart(2, '0')); }
    async balanceMsat() { return String(this.balance); }
    async feeRule() { return JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }); }
    async lockCostMsat(msat) { const c = ceilNote(msat); if (this.balance < c) throw new Error('Insufficient funds'); return String(c); }
    async receive(msat, gateway) { log.push({ receive: { msat, gateway } }); this.coming = BigInt(msat) / NOTE_MSAT * NOTE_MSAT; return JSON.stringify({ invoice: 'lnbcrt1n', operation: 'op' + log.length }); }
    async awaitReceive() { this.balance += this.coming; this.coming = 0n; this.keep(); return 'Claimed'; }
    async spend(msat) { const c = ceilNote(msat); if (this.balance < c) throw new Error('Insufficient funds'); this.balance -= c; this.keep(); }
  }
  return { LockClient: Note, log };
}

test('N rounds play N rounds (the owner 2026-10-01): the "N rounds" tab, a whole number of sats, funds N rounds\' locks - 1, 2, 5 and 10', async () => {
  for (const [i, N] of [[0, 1], [1, 2], [2, 5], [3, 10]]) {
    const { LockClient, log } = noteClient();
    const tab = tabStorage(); const sd = b32(0x80 + N);
    let asked = 0;
    await fundPlayerWallet({ round, invite: INVITE, seed: sd, LockClient, storage: tab, askDeposit: (offer) => {
      asked++;
      assert.deepEqual(offer.choices.map((c) => c.label), ['1 round', '2 rounds', '5 rounds', '10 rounds', 'Custom']);
      assert.equal(offer.choices[i].msat % 1000n, 0n, 'not a whole sat');
      offer.invoice(offer.choices[i].msat);
    } });
    assert.equal(asked, 1);
    const client = await playerWallet({ round, invite: INVITE, seed: sd, LockClient, storage: tab });
    const locks = await locksForRound(round, client, 0n);
    assert.equal(BigInt(log[0].receive.msat), roundsDepositMsat(N, locks, LockClient));
    assert.equal(roundsDepositMsat(N, locks, LockClient), BigInt(N) * roundsDepositMsat(1, locks, LockClient), 'N rounds is not N x 1 round');
    for (let k = 1; k <= N; k++) {
      // round k: the wallet holds its locks without another deposit, then they are spent
      await fundPlayerWallet({ round, invite: INVITE, seed: sd, LockClient, storage: tab, askDeposit: () => assert.fail(`round ${k} of ${N} asked for a deposit`) });
      await client.spend(locks.amount); if (locks.feeMsat > 0n) await client.spend(locks.feeMsat);
    }
  }
});

test('the Settings tabs are sized as the join sizes them - with the donation - so "1 round" there is the 1 round PLAY asks', async () => {
  const { LockClient } = noteClient();
  const at = (donationMsat) => settingsDepositOffer({ round, invite: INVITE, seed: b32(0x91), LockClient, storage: tabStorage(), donationMsat });
  const two = BigInt(round.stakeMsat) * 200n / 10000n;   // 2%, the Settings default
  const withDonation = (await at(two)).choices[0].msat; const without = (await at(0n)).choices[0].msat;
  const client = await playerWallet({ round, invite: INVITE, seed: b32(0x91), LockClient, storage: tabStorage() });
  const locks = await locksForRound(round, client, two);
  assert.equal(withDonation, roundsDepositMsat(1, locks, LockClient));
  // the donation is paid from the player wallet too: one round is its stake lock, its fee lock and the donation, each in whole notes
  assert.equal(locks.donationCostMsat, ceilNote(two));
});

test('the donation is paid by the player (the owner 2026-10-01): an N rounds deposit pays each round\'s stake lock, fee lock and every donation share from the player wallet - never asked again, N = 1 and 10', async () => {
  const { TEST_DONATION_SET_REGTEST } = await import('../../protocol/src/test-donation-sets.js');
  const { splitDonation } = await import('../../protocol/src/donation.js');
  const recipients = TEST_DONATION_SET_REGTEST.recipients;
  for (const N of [1, 10]) {
    const { LockClient } = noteClient();
    const tab = tabStorage(); const sd = b32(0xa0 + N);
    const donationMsat = BigInt(round.stakeMsat) * 200n / 10000n;   // 2%, the Settings default
    let asked = 0;
    await fundPlayerWallet({ round, invite: INVITE, seed: sd, LockClient, storage: tab, donationMsat, donationRecipients: recipients,
      askDeposit: (offer) => { asked++; offer.invoice(offer.choices.find((c) => c.rounds === N).msat); } });
    assert.equal(asked, 1);
    const client = await playerWallet({ round, invite: INVITE, seed: sd, LockClient, storage: tab });
    const locks = await locksForRound(round, client, donationMsat, recipients);
    const shares = splitDonation({ donationMsat, recipients }).shares.map((x) => x.amountMsat).filter((m) => m > 0n);
    assert.ok(shares.length >= 2, 'the test set should split the donation');
    for (let k = 1; k <= N; k++) {
      await fundPlayerWallet({ round, invite: INVITE, seed: sd, LockClient, storage: tab, donationMsat, donationRecipients: recipients,
        askDeposit: () => assert.fail(`round ${k} of ${N} asked for a deposit`) });
      await client.spend(locks.amount); if (locks.feeMsat > 0n) await client.spend(locks.feeMsat);
      for (const m of shares) await client.spend(m);                  // each share its own payment, from the same wallet
    }
    assert.ok(BigInt(await client.balanceMsat()) >= 0n);
  }
});

test('a close refuses the deposit', async () => {
  const { LockClient } = noteClient();
  await assert.rejects(() => fundPlayerWallet({ round, invite: INVITE, seed: b32(0x53), LockClient, storage: tabStorage(),
    askDeposit: (offer) => offer.close() }), /the deposit was closed/);
});
test('the deposit status: each invoice names its gateway, and a watcher hears how it ended - claimed, expired or a failed wait', async () => {
  const heard = [];
  const client = { receive: async () => JSON.stringify({ invoice: 'lntb1x', operation: 'op1' }),
    awaitReceive: async (op) => (op === 'op1' ? 'Expired' : 'Claimed') };
  const offer = depositOffer({ client, stakeMsat: 100000n, gateways: ['https://gw-b.example/'] });
  offer.watch((d, final) => heard.push([d.gateway, final]));
  const d = await offer.invoice(100000n);
  assert.equal(d.gateway, 'https://gw-b.example/');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(heard, [['https://gw-b.example/', 'Expired']]);
  client.receive = async () => JSON.stringify({ invoice: 'lntb1y', operation: 'op2' });
  await offer.invoice(200000n);
  assert.equal((await offer.claimed).invoice, 'lntb1y', 'the claimed one settles the offer');
  assert.deepEqual(heard[1], ['https://gw-b.example/', 'Claimed']);
  client.receive = async () => JSON.stringify({ invoice: 'lntb1z', operation: 'op3' });
  client.awaitReceive = async () => { throw new Error('the federation did not answer'); };
  await offer.invoice(100000n); await new Promise((r) => setTimeout(r, 0));
  assert.match(heard[2][1], /^Failure: the federation did not answer/);
});

test('the withdrawal tabs are 25%, 50% and 100% of what the wallet can send, in whole sat, then Custom', async () => {
  const c = withdrawChoices(20513999n);
  assert.deepEqual(c.map((x) => x.label), ['25%', '50%', '100%', 'Custom']);
  assert.deepEqual(c.slice(0, 3).map((x) => x.msat), [5128000n, 10256000n, 20513000n]);
  assert.equal(c[3].msat, null);
  assert.deepEqual(withdrawChoices(0n).slice(0, 3).map((x) => x.msat), [0n, 0n, 0n]);
  const { LockClient } = lockClient();
  assert.equal(await playerWithdrawable({ round, invite: INVITE, seed: b32(0x61), LockClient, storage: tabStorage() }), 0n,
    'an empty wallet can send nothing, and says so without an error');
});

test('a deposit paid just before a reload: the next page\'s wallet finds it, writes its history row once, and forgets it', async () => {
  const tab = tabStorage();
  const inv = bolt11For(100000n);
  // the page that made the invoice is reloaded away before the claim: its wait never ends
  const gone = { receive: async () => JSON.stringify({ invoice: inv, operation: 'op-a' }), awaitReceive: () => new Promise(() => {}) };
  const offer = depositOffer({ client: gone, stakeMsat: 100000n, storage: tab, federationId: TEST_FEDERATION_ID });
  await offer.invoice(100000n);
  assert.equal(pendingDeposits(tab, TEST_FEDERATION_ID).length, 1, 'the invoice is kept until it ends');
  assert.equal(ledgerRows(tab, TEST_FEDERATION_ID).length, 0);
  // the reloaded page reopens the wallet; the same operation ends Claimed
  const heard = [];
  const reopened = { awaitReceive: async (op) => (op === 'op-a' ? 'Claimed' : 'Failure') };
  assert.deepEqual(await resumeDeposits({ client: reopened, storage: tab, federationId: TEST_FEDERATION_ID, onClaimed: (d) => heard.push(d.amountMsat) }), ['Claimed']);
  const rows = ledgerRows(tab, TEST_FEDERATION_ID);
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'deposit'); assert.equal(rows[0].msat, '100000');
  assert.deepEqual(heard, [100000n]);
  assert.equal(pendingDeposits(tab, TEST_FEDERATION_ID).length, 0, 'an ended deposit leaves the list');
  // a second page seeing the same invoice claimed writes no second row
  const again = { receive: async () => JSON.stringify({ invoice: inv, operation: 'op-a' }), awaitReceive: async () => 'Claimed' };
  const o2 = depositOffer({ client: again, stakeMsat: 100000n, storage: tab, federationId: TEST_FEDERATION_ID });
  await o2.invoice(100000n); await o2.claimed;
  assert.equal(ledgerRows(tab, TEST_FEDERATION_ID).length, 1, 'one paid invoice, one row');
  // an expired one leaves the list with no row
  const exp = { receive: async () => JSON.stringify({ invoice: bolt11For(200000n), operation: 'op-b' }), awaitReceive: () => new Promise(() => {}) };
  await depositOffer({ client: exp, stakeMsat: 100000n, storage: tab, federationId: TEST_FEDERATION_ID }).invoice(200000n);
  await resumeDeposits({ client: { awaitReceive: async () => 'Expired' }, storage: tab, federationId: TEST_FEDERATION_ID });
  assert.equal(pendingDeposits(tab, TEST_FEDERATION_ID).length, 0);
  assert.equal(ledgerRows(tab, TEST_FEDERATION_ID).length, 1);
});

test('option 2: a paid gross deposit that falls short is not asked again with the tabs - its outcome hands one exact invoice for the rest; paid, it is funded', async () => {
  const { LockClient, log } = lockClient();
  // the first (gross) deposit credits 97% of itself, as the measured round fell short; the rest is credited whole
  const realReceive = LockClient.prototype.receive; let first = true;
  // (the stand-in's small-receive refusal models the old 2 sat gateway fee; the gateways' fees are 0 since FEES-0)
  LockClient.prototype.receive = async function (msat, gw) {
    if (first) { await realReceive.call(this, msat, gw); this.coming = BigInt(msat) * 97n / 100n; first = false; }
    else { log.push({ receive: { msat, gateway: gw } }); this.coming = BigInt(msat); }
    return JSON.stringify({ invoice: 'lnbcrt1page', operation: 'op' });
  };
  const tab = tabStorage();
  const asks = []; const outcomes = [];
  const done = await fundPlayerWallet({ round, invite: INVITE, seed: b32(0x71), LockClient, storage: tab, askDeposit: (offer) => {
    asks.push(offer.choices.map((c) => c.label));
    (async () => {
      await offer.invoice(offer.choices[0].msat);            // "1 round": the gross stake; the stand-in credits it less 16064 msat
      let o = await offer.outcome; outcomes.push(o.funded);
      while (!o.funded) {
        assert.deepEqual(o.rest.choices.map((c) => c.key), ['rest'], 'the rest is one amount, not the tabs');
        await o.rest.invoice(o.rest.choices[0].msat);
        o = await o.rest.outcome; outcomes.push(o.funded);
      }
    })();
  } });
  assert.equal(asks.length, 1, 'the modal was asked for twice - it must not start over');
  assert.deepEqual(asks[0], ['1 round', '2 rounds', '5 rounds', '10 rounds', 'Custom']);
  assert.deepEqual(outcomes, [false, true]);
  const asked = log.filter((l) => l.receive).map((l) => BigInt(l.receive.msat));
  assert.equal(asked[0] % 1000n, 0n, 'the first invoice is the "1 round" tab, a whole sat');
  assert.equal(asked.length, 2);
  assert.equal(asked[1] % 1000n, 0n, 'the rest is a whole sat');
  assert.ok(asked[1] < BigInt(round.stakeMsat) / 10n, 'the rest is the fees, not another round');
  assert.ok(done.heldMsat > 0n);
});

test('the rest of the fees: the smallest whole sat whose notes cover the shortfall; asked at once only when the wallet is short by no more than a tenth of the stake', () => {
  assert.equal(restOfFeesMsat(1n), 1000n);
  assert.equal(restOfFeesMsat(1000n), 1000n, '1 sat credits 1 sat');
  assert.equal(restOfFeesMsat(2464n), 3000n, 'the rest is the next whole sat');
  assert.equal(shortOnlyByFees(99840n, 2464n, 100000n), true, 'the measured 99840 msat wallet is asked only the rest');
  assert.equal(shortOnlyByFees(0n, 100000n, 100000n), false, 'an empty wallet gets the tabs');
  assert.equal(shortOnlyByFees(50000n, 50000n, 100000n), false, 'half a round short gets the tabs');
});
test('a rest under the federation\'s 5 sat floor is invoiced at 5 sat; more is invoiced as it is', async () => {
  assert.equal(restInvoiceMsat(2000n), 5000n);
  assert.equal(restInvoiceMsat(4000n), 5000n);
  assert.equal(restInvoiceMsat(5000n), 5000n);
  assert.equal(restInvoiceMsat(7000n), 7000n);
  const client = { receive: async (msat) => JSON.stringify({ invoice: 'lntb50n1x', operation: 'op' + msat }), awaitReceive: () => new Promise(() => {}) };
  const o = depositOffer({ client, stakeMsat: 100000n, restMsat: 2000n });
  assert.equal(o.restMsat, 2000n, 'the rest the round needs');
  assert.equal(o.restPayMsat, 5000n, 'the invoice asks the floor');
  assert.deepEqual(o.choices.map((c) => [c.key, c.msat]), [['rest', 5000n]]);
});

test('1 sat = 1 sat (the owner 2026-10-01): a 100 sat round - stake lock 96, fee lock 2, donation 2 - is 100 sat, and N rounds N x 100', async () => {
  assert.equal(NOTE_MSAT, 1n, 'the lock client issues notes from 1 msat');
  const { LockClient } = noteClient();
  const locks = { amount: 96000n, feeMsat: 2000n, zeroFees: true, donationCostMsat: 1334n + 666n };
  assert.deepEqual([1, 2, 5, 10].map((n) => roundsDepositMsat(n, locks, LockClient)), [100000n, 200000n, 500000n, 1000000n]);
});
test('a withdrawal names the funded gateway to the lock client (the owner 2026-10-01 08:34: the stock pick sent an LND-a invoice to gateway A and it was refunded)', async () => {
  const seen = [];
  const client = { withdrawableMsat: async () => '50000',
    withdraw: async (invoice, gw) => { seen.push(gw); return JSON.stringify({ state: 'Success', preimage: 'ab'.repeat(32), invoice_msat: 5000, gateway: gw }); } };
  const out = await withdrawCollected({ client, amountMsat: 5000n, gateways: ['https://gw-b.example/'],
    invoiceFor: async () => ({ ok: true, invoice: bolt11For(5000n) }) });
  assert.equal(out.ok, true, out.why);
  assert.deepEqual(seen, ['https://gw-b.example/']);
});

test('the invoice defines the withdrawal (the owner 2026-10-01): its amount is read off it; no amount and not an invoice are said so', () => {
  assert.deepEqual(invoiceAmountMsat(bolt11For(99000n)), { ok: true, msat: 99000n });
  assert.equal(invoiceAmountMsat('hello').why, 'That is not a Lightning invoice.');
  assert.equal(invoiceAmountMsat('').ok, false);
});

test('a withdrawal of a chosen amount pays only an invoice of exactly that amount', async () => {
  const { LockClient } = lockClient();
  const tab = tabStorage();
  (await playerWallet({ round, invite: INVITE, seed, LockClient, storage: tab })).balance += 900000n;
  const inv = bolt11For(200000n);
  const bad = await withdrawPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab, amountMsat: 300000n, invoiceFor: async () => ({ ok: true, invoice: inv }) });
  assert.equal(bad.ok, false); assert.match(bad.why, /nothing was sent/);
  const good = await withdrawPlayerWallet({ round, invite: INVITE, seed, LockClient, storage: tab, amountMsat: 200000n, invoiceFor: async () => ({ ok: true, invoice: inv }) });
  assert.equal(good.ok, true, good.why);
});

// THE OBJECTION WINDOW IS EXACTLY 600 000 ms (§13A, WINDOW-10-SPEC, RULED the owner 2026-10-01): "a node refuses to open it,
// list it or take an entry for it" - and the page, which reads every round through fetchRound (the lobby's rows and a
// join alike), lists and joins none, whatever a node answers.
test('WINDOW-10-SPEC: the page lists and joins only a round whose objection window is 600000 ms - 0, 599999 and 600001 refused by name', async () => {
  const { fetchRound } = await import('../src/join.js');
  const answering = (c) => async () => ({ ok: true, status: 200, arrayBuffer: async () => encodeRoundContract(c).buffer.slice(0) });
  for (const w of [0n, 599999n, 600001n]) {
    const c = { ...round, objectionWindowMs: w };
    await assert.rejects(fetchRound(toHex(roundId(c)), ['http://127.0.0.1:9'], { fetcher: answering(c) }),
      new RegExp(`names an objection window of ${w} ms, not 600000: that contract is invalid and the page does not join it`));
  }
  const got = await fetchRound(toHex(rid), ['http://127.0.0.1:9'], { fetcher: answering(round) });
  assert.equal(got.contract.objectionWindowMs, 600000n);
});

// TWO PLAYERS IN ONE BROWSER (ORDER-2116, measured 2026-10-02 05:5xZ): keyed by round alone, the loser's record replaced the
// winner's, the winner's tab found nothing owed and marked the round done - its 96000 msat payout left in the federation.
test('two players of one round in one browser keep a collect each, and each tab reads and marks only its own', () => {
  const tab = new Map();
  const storage = { getItem: (k) => (tab.has(k) ? tab.get(k) : null), setItem: (k, v) => tab.set(k, String(v)), removeItem: (k) => tab.delete(k),
    key: (i) => [...tab.keys()][i] ?? null, get length() { return tab.size; } };
  const lockRound = { ...round, custody: 'FEDERATION', federationId: TEST_FEDERATION_ID };
  const lr = toHex(roundId(lockRound));
  const winner = b32(0x5a), loser = b32(0x5b);
  for (const s of [winner, loser]) assert.equal(saveCollect(storage, { roundIdHex: lr, round: lockRound, invite: INVITE, nodes: ['http://a.test'], seed: s }), true);
  const w = savedCollects(storage, { seed: winner }), l = savedCollects(storage, { seed: loser });
  assert.equal(savedCollects(storage).length, 2, 'one record replaced the other');
  assert.deepEqual([w.length, l.length, toHex(w[0].seed), toHex(l[0].seed)], [1, 1, toHex(winner), toHex(loser)]);
  assert.equal(markCollectDone(storage, lr, { payout: 'No payout' }, loser), true);
  assert.equal(savedCollects(storage, { seed: winner })[0].done, null, 'the loser\'s answer marked the winner\'s round done');
  assert.deepEqual(savedCollects(storage, { seed: loser })[0].done, { payout: 'No payout' });
  // A RECORD FROM BEFORE THE SEED KEY, the loser's and marked done, is not carried into the winner's new record
  const t2 = new Map();
  const s2 = { getItem: (k) => (t2.has(k) ? t2.get(k) : null), setItem: (k, v) => t2.set(k, String(v)), removeItem: (k) => t2.delete(k),
    key: (i) => [...t2.keys()][i] ?? null, get length() { return t2.size; } };
  t2.set('blwp.collect.' + lr, JSON.stringify({ roundIdHex: lr, round: toHex(encodeRoundContract(lockRound)), invite: INVITE, nodes: [], seed: toHex(loser), stakeLock: null, done: { payout: 'No payout' }, savedMs: 1 }));
  saveCollect(s2, { roundIdHex: lr, round: lockRound, invite: INVITE, nodes: ['http://a.test'], seed: winner });
  assert.equal(savedCollects(s2, { seed: winner })[0].done, null, 'the loser\'s old record marked the winner\'s new one done');
  assert.ok(t2.has('blwp.collect.' + lr), 'another seed\'s old record was removed');
});

// THE LOCK GOES TO EVERY SIGNER NODE AT ONCE (JOIN-TIME-1359, the owner 2026-10-02: "PLAY to a committed entry is the clock"):
// handed one after another, seven nodes that each verify in the federation (~1.8 s) made the stake lock ~13 s of the paid
// join. Seven nodes that each take 300 ms are all answered in about 300 ms, and the answers keep the nodes' order.
test('handLock asks every signer node at once and keeps their order', async () => {
  const nodes = [1, 2, 3, 4, 5, 6, 7].map((i) => `http://n${i}`);
  const fetcher = (u) => new Promise((r) => setTimeout(() => r({ status: u.includes('n3') ? 409 : 201, text: async () => (u.includes('n3') ? 'no' : 'kept') }), 300));
  const t0 = Date.now();
  const got = await handLock({ entryId: b32(0x0e), fields: { paymentImage: { kind: 'hash', bytes: b32(0x21) }, amountMsat: 96000n, claimPk: CLAIM, refundPk: CLAIM, expiration: 1000 }, nodes, needed: 5, fetcher });
  const ms = Date.now() - t0;
  console.log('  FACTS:', JSON.stringify({ ms, committed: got.committed, order: got.said.map((x) => x.node.slice(-2)) }));
  assert.ok(ms < 1000, `seven 300 ms nodes took ${ms} ms - asked one after another`);
  assert.deepEqual(got.said.map((x) => x.node), nodes);
  assert.equal(got.committed, 6);
  assert.equal(got.ok, true);
});

// THE LOBBY'S WALLET OPEN THAT NEVER SETTLES DOES NOT HOLD PLAY FOR GOOD (JOIN-TIME-1359, measured 2026-10-02 on testnet4:
// 2 of 12 paid joins sat at "the player wallet is open" - the lobby's federation join never answered). A lock client whose
// first join hangs and whose second answers: the lobby opens (and hangs), PLAY waits openWaitMs, says so, joins again and
// gets the second client; and a join that never answers at all is refused by name after joinWaitMs.
test('a wallet the lobby could not open is joined again at PLAY, and a join that never answers is refused by name', async () => {
  let joins = 0;
  const good = { tag: 'second' };
  const LockClient = { join: () => (++joins === 1 ? new Promise(() => {}) : Promise.resolve(good)) };
  const tab = tabStorage(); const steps = [];
  const args = { round, invite: INVITE, seed: b32(0x93), LockClient, storage: tab, openWaitMs: 100, joinWaitMs: 400 };
  playerWallet(args).catch(() => {});                                     // the lobby: never answers, cut at 400 ms
  const t0 = Date.now();
  const got = await playerWallet({ ...args, onStep: (s) => steps.push(s) });   // PLAY
  console.log('  FACTS:', JSON.stringify({ ms: Date.now() - t0, joins, steps }));
  assert.equal(got, good);
  assert.equal(joins, 2);
  assert.ok(steps.some((s) => /did not open in 0 s|did not open in/.test(s)), 'PLAY did not say the lobby wallet failed to open');
  const never = { join: () => new Promise(() => {}) };
  await assert.rejects(playerWallet({ round, invite: INVITE, seed: b32(0x94), LockClient: never, storage: tabStorage(), joinWaitMs: 100 }),
    /did not open the player wallet in 0 s - press PLAY again/);
});

// MEASURED 2026-10-03 13:58:51Z ON 0.0.2490: A RELOAD BEFORE THE ROUND'S START, HOLDING THE ENTRY ITS LOCK WAS COMMITTED TO, PLAYS IT.
test('a committed lock is reused before the start, and resumed until the close, when the tab kept the very entry it was committed to; another entry or a closed round stops', async () => {
  const { entryId } = await import('../../protocol/src/contracts.js');
  const { entryFor } = await import('../src/join.js');
  const { feldmanGroup } = await import('../../blwp-node/src/curve.js');
  const { TEST_FEDERATION_ID } = await import('../../protocol/src/test-federation.js');
  const { coreHashHex } = await import('../../core/tools/hash-core.js');
  const { randomBytes } = await import('node:crypto');
  const round = { id: b32(0x21), stakeMsat: 100000n, settlementSlots: 7, simCoreHash: fromHex(coreHashHex()), federationId: TEST_FEDERATION_ID };
  const entry = Object.assign(entryFor(round, { seed: b32(0x5e), curve: feldmanGroup, random: (n) => new Uint8Array(randomBytes(n)),
    claimKey: { ok: true, ref: new Uint8Array(32).fill(0x9a) },
    stakeLock: { outpoint: { txid: b32(0xd8), outIdx: 0 }, fields: { paymentImage: { kind: 'point', bytes: Uint8Array.of(2, ...b32(0x6c)) } } } }),
    { roundId: round.id, sessionPubkey: b32(0x55) });   // as the bridge sends it (blwp.jslib net.open)
  const kept = { stake: { preimage: b32(1) }, lock: { outpoint: { txid: b32(0xd8), outIdx: 0n } }, committedTo: toHex(entryId(entry)) };
  const r = keptLockUse(kept, { entry, beforeStart: true });
  assert.equal(r.use, 'reuse'); assert.equal(r.resumed, true); assert.equal(r.kept, kept);
  assert.equal(keptLockUse(kept, { entry, beforeStart: false }).use, 'staked', 'a closed round: the run is not resumed');
  // AFTER THE START, BEFORE THE CLOSE (the owner 2026-10-03, "That run must not be lost"): resumed from the seats' record
  const running = keptLockUse(kept, { entry, beforeStart: false, beforeClose: true });
  assert.equal(running.use, 'reuse'); assert.equal(running.resumed, 'running'); assert.equal(running.kept, kept);
  assert.equal(keptLockUse(kept, { entry: null, beforeStart: false, beforeClose: true }).use, 'staked', 'running, no kept entry');
  assert.equal(keptLockUse({ ...kept, committedTo: 'ee'.repeat(32) }, { entry, beforeStart: false, beforeClose: true }).use, 'staked', 'running, another entry');
  assert.equal(keptLockUse(kept, { entry: null, beforeStart: true }).use, 'staked', 'no kept entry');
  assert.equal(keptLockUse({ ...kept, committedTo: 'ee'.repeat(32) }, { entry, beforeStart: true }).use, 'staked', 'another entry');
});

// DONATIONS IN THE FEDERATION (the owner 2026-10-03): a round whose set pays keys locks the stake, the fee and one payout
// contract per share in ONE transaction; each output is checked against its share; the outpoints are kept across a reload.
test('a set of keys: one lockWithDonations call, the shares in the set\'s order, each output checked, kept for a reload', async () => {
  const DEVS = [{ recipientPk: Uint8Array.of(2, ...b32(0xa1)), shareBps: 6667, label: 'dev a' }, { recipientPk: Uint8Array.of(3, ...b32(0xb2)), shareBps: 3333, label: 'dev b' }];
  const round100 = { ...round, stakeMsat: 100000n };
  const rid100 = roundId(round100);
  for (const [feeRule, badDonation] of [[RULE, null], [null, null], [RULE, 'key'], [RULE, 'amount']]) {
    const { LockClient, log } = lockClient({ feeRule, both: true, donations: true, badDonation });
    const tab = tabStorage();
    await fundPlayerWallet({ round: round100, invite: INVITE, seed, LockClient, storage: tab, donationMsat: 2000n, donationRecipients: DEVS });
    const go = lockStake({ round: round100, roundId: rid100, invite: INVITE, seed, stake: { stakePoint: POINT }, claimKey, playerPubkey: player,
      LockClient, storage: tab, donationMsat: 2000n, donationRecipients: DEVS });
    if (badDonation === 'key') { await assert.rejects(go, /pays another key than the set's/); continue; }
    if (badDonation === 'amount') { await assert.rejects(go, /holds 1335 msat, and its share is 1334/); continue; }
    const got = await go;
    const calls = log.filter((l) => l.lock || l.lockHash || l.lockBoth || l.lockWithDonations);
    assert.deepEqual(calls.map((c) => Object.keys(c)[0]), ['lockWithDonations'], 'stake, fee and donation were not one transaction');
    assert.deepEqual(calls[0].lockWithDonations.donations, [{ pk: '02' + 'a1'.repeat(32), msat: '1334' }, { pk: '03' + 'b2'.repeat(32), msat: '666' }]);
    assert.equal(calls[0].lockWithDonations.hash === '', !feeRule, 'a fee hash only when the fee lock is due');
    assert.equal(!!got.feeLock, !!feeRule);
    assert.deepEqual(got.donations.map((d) => [d.outIdx, d.amountMsat]), feeRule ? [[2n, 1334n], [3n, 666n]] : [[1n, 1334n], [2n, 666n]]);
    // kept across a reload, with the donation row in the history
    const player2 = pageCurve.pointX(b32(0x62));
    const kept = await stakeFor({ ...round100, id: rid100 }, { signerNodes: [0x21, 0x22].map((n) => pageCurve.pointX(b32(n))), curve: pageCurve,
      random: (n) => new Uint8Array(n).fill(9), playerPubkey: player2, needed: 2 });
    saveLock(tab, { roundId: rid100, playerPubkey: player2, stake: kept, lock: got, federationId: round100.federationId });
    const back = savedLock(tab, { roundId: rid100, playerPubkey: player2 });
    assert.deepEqual(back.lock.donations.map((d) => [toHex(d.txid).slice(0, 4), d.outIdx, toHex(d.recipientPk).slice(0, 4), d.amountMsat]),
      got.donations.map((d) => [toHex(d.txid).slice(0, 4), d.outIdx, toHex(d.recipientPk).slice(0, 4), d.amountMsat]));
    assert.ok(ledgerRows(tab, round100.federationId).some((r) => r.kind === 'donation' && r.msat === '2000'));
  }
});

// THE LOCK ANSWERED ON SUBMISSION (the owner 2026-10-03, OPEN-LIST-2140 item 3): the entry's outpoints come back before the
// guardians accept the lock; acceptance is checked after, and a lock held elsewhere or refused rejects `accepted`.
test('a submitted lock answers its outpoints before acceptance; acceptance is checked after, and a moved or refused lock rejects', async () => {
  const DEVS = [{ recipientPk: Uint8Array.of(2, ...b32(0xa1)), shareBps: 6667, label: 'dev a' }, { recipientPk: Uint8Array.of(3, ...b32(0xb2)), shareBps: 3333, label: 'dev b' }];
  const round100 = { ...round, stakeMsat: 100000n };
  const rid100 = roundId(round100);
  for (const acceptAs of ['same', 'moved', 'refused']) {
    const { LockClient, log } = lockClient({ feeRule: RULE, both: true, donations: true, submit: true, acceptAs });
    const tab = tabStorage();
    await fundPlayerWallet({ round: round100, invite: INVITE, seed, LockClient, storage: tab, donationMsat: 2000n, donationRecipients: DEVS });
    const got = await lockStake({ round: round100, roundId: rid100, invite: INVITE, seed, stake: { stakePoint: POINT }, claimKey, playerPubkey: player,
      LockClient, storage: tab, donationMsat: 2000n, donationRecipients: DEVS });
    // answered at submission: nothing awaited the guardians yet
    assert.deepEqual(log.filter((l) => l.lockSubmit || l.lockAccepted || l.lockBoth || l.lockWithDonations || l.lock).map((l) => Object.keys(l)[0]), ['lockSubmit', 'lockAccepted']);
    assert.equal(toHex(got.outpoint.txid), '5a'.repeat(32));
    assert.deepEqual([got.outpoint.outIdx, got.feeLock.outpoint.outIdx, ...got.donations.map((d) => d.outIdx)], [0n, 1n, 2n, 3n]);
    assert.deepEqual(got.donations.map((d) => d.amountMsat), [1334n, 666n]);
    if (acceptAs === 'same') { const a = await got.accepted; assert.equal(a.ok, true); }
    else if (acceptAs === 'moved') await assert.rejects(got.accepted, /another output than the entry names/);
    else await assert.rejects(got.accepted, /did not accept the lock transaction/);
  }
});
