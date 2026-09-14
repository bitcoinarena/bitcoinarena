// THE PAGE MAKES THE PLAYER'S STAKE LOCK (W1b; v4.6.2 §23.1 steps 3-5).
//
// `lockStake` decides what the injected lock client (lock-client/, the stock
// fedimint 0.12.0 crates built to wasm) is asked, and `handLock` hands the
// lock it made to the seats. The lock client here is a stand-in that records
// what it was asked; the real one is driven from the built page on a regtest
// federation by tools/page-lock.mjs. The seats in `handLock`'s test are real
// daemons verifying against a port that holds locks by outpoint (W2).
//
// MEASURED BEFORE (TASKBOOK, W1b): the page built every entry with a zero
// stake_lock_outpoint, loaded no lock client and posted no /lock.
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';

import { lockStake, handLock, lockSecretFor, lockAmountMsat, lockLine, saveLock, savedLock, markLockCommitted,
  refundStake, redeemStake, redeemPayout, payoutLine, returnStake, stakeBackLine, saveCollect, savedCollects, markCollectDone, keptLockUse, LOCK_EXPIRY_MARGIN_BLOCKS, feeSecretFor } from '../src/page-lock.js';
import { sha256 } from '../../protocol/src/hash.js';
import { entryFor, joinQuery, stakeFor, playerFor } from '../src/join.js';
import { lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { pageCurve } from '../src/page-curve.js';
import { playerSecretFor } from '../../protocol/src/player-key.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { roundId } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';
import { CORE_HASH } from '../../blwp-node/tools/core-hash.mjs';
import { seatedWithLock, CLAIM } from '../../blwp-node/test/lock-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
// The shape of a real invite (bech32m, prefix `fed1`, separator `1`): the first
// rehearsal's page threw on its own invite because this constant had no separator.
const INVITE = 'fed11qgqpw9thwvaz7te3xgmjuvpwxqhrzw' + 'q'.repeat(20);
const POINT = Uint8Array.from([0x03, ...b32(0x5e)]);
const now = BigInt(Date.now());
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
  objectionWindowMs: 3000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: b32(0xfe),
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n,
  bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
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
function lockClient({ idsMatch = true, lockedMsat, lockFee = 2528n, feeRule = null } = {}) {
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
      const expiration = 1000 + delta;
      return JSON.stringify({ txid: 'ab'.repeat(32), out_idx: 0, computed_contract_id: 'c1', stored_contract_id: idsMatch ? 'c1' : 'c2',
        ids_match: idsMatch, computed_expiration: expiration, stored_expiration: expiration, amount_msat: Number(lockedMsat ?? amount) });
    }
    // THE FEDERATION'S FEE RULE (Pick b's gate reads it), when this stand-in has one.
    async feeRule() {
      if (!feeRule) throw new Error('this stand-in names no fee rule');
      return JSON.stringify({ fee_ppm: Number(feeRule.ppm), fee_base_msat: Number(feeRule.baseMsat) });
    }
    async lockHash(hash, amount, claim, refund, delta) {
      log.push({ lockHash: { hash, amount, claim, refund, delta } });
      this.balance -= BigInt(amount) + lockFee;
      const expiration = 1000 + delta;
      return JSON.stringify({ txid: 'cd'.repeat(32), out_idx: 1, computed_contract_id: 'f1', stored_contract_id: 'f1',
        ids_match: true, computed_expiration: expiration, stored_expiration: expiration, amount_msat: Number(amount) });
    }
  }
  return { LockClient: Fake, log };
}

const ask = (extra = {}) => lockStake({ round, roundId: rid, invite: INVITE, seed, stake: { stakePoint: POINT },
  claimKey, playerPubkey: player, ...extra });

test('the page asks the lock client for the round\'s own federation, under the seed\'s secret for this round, for the net stake, to the attested key and the player\'s refund key', async () => {
  const { LockClient, log } = lockClient();
  const deposits = [];
  const got = await ask({ LockClient, onDeposit: (d) => deposits.push(d) });
  const joined = log.find((l) => l.join).join;
  const locked = log.find((l) => l.lock).lock;
  const facts = {
    federation: joined.federationId, invite: joined.invite,
    secretIsTheSeedsForThisRound: joined.secret === toHex(lockSecretFor(seed, rid)),
    secretIsNotThePlayerKey: joined.secret !== toHex(playerSecretFor(seed, rid)),
    deposits: deposits.map((d) => [d.invoice, String(d.amountMsat)]),
    lock: locked, outpoint: `${toHex(got.outpoint.txid)}:${got.outpoint.outIdx}`,
  };
  console.log('  FACTS (the page\'s lock):', JSON.stringify(facts));
  assert.deepEqual(facts, {
    federation: toHex(b32(0xfe)), invite: INVITE, secretIsTheSeedsForThisRound: true, secretIsNotThePlayerKey: true,
    // THE NET STAKE AND THE STOCK ALLOWANCE (2000 + 980000 x 3000 ppm = 4940),
    // grossed up by the gateway's fee: the empty client cannot be quoted.
    deposits: [['lnbcrt1page', String(lockAmountMsat(round) + 4940n + 16064n)]],
    lock: { point: toHex(POINT), amount: String(lockAmountMsat(round)), claim: toHex(CLAIM),
      refund: toHex(refundKeyOf(player)), delta: 144 + LOCK_EXPIRY_MARGIN_BLOCKS },
    outpoint: `${'ab'.repeat(32)}:0`,
  });
  assert.equal(lockAmountMsat(round), 980000n, 'the net stake of 1000000 msat less the 2% fee');
});

// PICK (b), THE GATE ON THE PAGE (the owner 2026-09-14): "Do not mint a fee lock when
// claiming it cannot pay a sitting seat after this federation's 1000 msat input fee
// and 1000 msat output fee." The stand-in answers the federation's real rule.
const REAL_RULE = { ppm: 0n, baseMsat: 1000n };

test('a 100 sat round with two players: the page mints no fee lock - the player deposits for the 98000 msat stake only, and the entry names no fee lock', async () => {
  const round100 = { ...round, stakeMsat: 100000n };
  const rid100 = roundId(round100);
  const { LockClient, log } = lockClient({ feeRule: REAL_RULE });
  const deposits = [];
  const got = await lockStake({ round: round100, roundId: rid100, invite: INVITE, seed, stake: { stakePoint: POINT }, claimKey, playerPubkey: player,
    LockClient, onDeposit: (d) => deposits.push(d) });
  const hashLocks = log.filter((l) => l.lockHash).length;
  console.log(`  100 sat: fee locks minted ${hashLocks}; deposits ${deposits.map((d) => String(d.amountMsat)).join(', ')} msat; stake lock ${got.fields.amountMsat}; gate: ${got.feeGate.why}`);
  assert.equal(hashLocks, 0, 'a fee lock was minted that cannot pay a seat');
  assert.equal(got.feeLock, null);
  assert.equal(got.feeGate.pays, false);
  // NOT CHARGED A LOCK IT CANNOT USE: the deposits are exactly those of the same page
  // with no fee rule at all - the flow before the gate existed, stake lock only (its
  // own fee top-up included: at 98000 msat the stock allowance, 2294, is below this
  // stand-in's 2528 msat lock fee, with or without the gate).
  const without = lockClient({});
  const before = [];
  await lockStake({ round: round100, roundId: rid100, invite: INVITE, seed, stake: { stakePoint: POINT }, claimKey, playerPubkey: player,
    LockClient: without.LockClient, onDeposit: (d) => before.push(d) });
  console.log(`  100 sat: deposits with the gate ${deposits.map((d) => String(d.amountMsat)).join(', ')}; without any fee rule ${before.map((d) => String(d.amountMsat)).join(', ')}`);
  assert.deepEqual(deposits.map((d) => String(d.amountMsat)), before.map((d) => String(d.amountMsat)),
    'the player was asked for more than the stake lock alone');
  const entry = entryFor(round100, { seed, curve: pageCurve, random: (n) => new Uint8Array(n).fill(7), claimKey,
    stake: { stakeCommitment: b32(0x71), vssSharesRef: new Uint8Array(32), stakePoint: POINT }, stakeLock: { outpoint: got.outpoint, fields: got.fields, feeLock: got.feeLock } });
  assert.equal(toHex(entry.feePreimage), '00'.repeat(32));
  assert.equal(toHex(entry.feeLockOutpoint.txid), '00'.repeat(32));
});

test('a 1000 sat round: the page mints one 20000 msat fee lock to H(F), names F and its outpoint in the entry, and hands it to each seat\'s /fee-lock', async () => {
  const { LockClient, log } = lockClient({ feeRule: REAL_RULE });
  const deposits = [];
  const got = await ask({ LockClient, onDeposit: (d) => deposits.push(d) });
  const minted = log.filter((l) => l.lockHash).map((l) => l.lockHash);
  const F = feeSecretFor(seed, rid);
  console.log(`  1000 sat: fee locks minted ${minted.length} (${minted.map((m) => `${m.amount} msat to ${m.hash.slice(0, 12)}`).join(', ')}); deposits ${deposits.map((d) => String(d.amountMsat)).join(', ')} msat; `
    + `gate: stake ${got.feeGate.stakeMsat}, lock ${got.feeGate.lockMsat}, input fees ${got.feeGate.inputFeesMsat}, output fees ${got.feeGate.outputFeesMsat}, per-seat net [${got.feeGate.perSeatNetMsat.join(', ')}]`);
  assert.equal(minted.length, 1);
  assert.deepEqual(minted[0], { hash: toHex(sha256(F)), amount: '20000', claim: toHex(CLAIM), refund: toHex(refundKeyOf(player)), delta: 144 + LOCK_EXPIRY_MARGIN_BLOCKS });
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
test('the winner\'s page collects its own payout contract from the seats\' settlement - by Refund under its key - and a loser\'s asks the wallet nothing', async () => {
  const winner = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const loserSeed = b32(0x52);
  const winnerPk = toHex(refundKeyOf(winner.pubkey));
  const settled = { state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { txid: 'ef'.repeat(32), payouts: [
    { kind: 'seat', pk: '02' + 'aa'.repeat(32), msat: '18000', feeMsat: '1000' },
    { kind: 'qualifier', pk: winnerPk, msat: '978000', feeMsat: '1000' },
  ] } };
  const seats = async (url) => ({ ok: true, status: 200, json: async () => settled, text: async () => '' });
  const asked = [];
  class Wallet {
    static async join(invite, federationId, secret) { asked.push({ join: { invite, federationId, secret } }); return new Wallet(); }
    async refund(txid, outIdx, fields, secret) {
      asked.push({ refund: { txid, outIdx, fields: JSON.parse(fields), secret } });
      return JSON.stringify({ accepted: true, balance_before: 0, balance_after: 977000, amount_msat: 978000 });
    }
  }
  const won = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, nodes: ['http://a'], fetcher: seats });
  console.log(`  winner: collected ${won.ok}, output ${won.outIdx}, ${won.amountMsat} msat, balance ${won.balance_before} -> ${won.balance_after}`);
  assert.equal(won.ok, true, won.why);
  assert.deepEqual(asked.find((a) => a.refund).refund, { txid: 'ef'.repeat(32), outIdx: 1, secret: toHex(winner.secret),
    fields: { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: '978000', claimPk: winnerPk, refundPk: winnerPk, expiration: 0 } });
  asked.length = 0;
  const lost = await redeemPayout({ round, roundId: rid, invite: INVITE, seed: loserSeed, curve: pageCurve, LockClient: Wallet, nodes: ['http://a'], fetcher: seats });
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
  const first = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, storage, nodes: ['http://a'], fetcher: seats });
  assert.equal(first.ok, true);
  asked.length = 0;
  const again = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, storage, nodes: ['http://a'],
    fetcher: async () => { throw new Error('a kept payout asked the seats'); } });
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
  const spentOne = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: SpentWallet, nodes: ['http://a'], fetcher: seats });
  assert.equal(spentOne.ok, false);
  assert.equal(spentOne.final, true, 'a payout already spent was asked again for ever');
  assert.equal(spentOne.spent, true);
  assert.match(payoutLine(spentOne), /^Payout already collected: 978000 msat - the payout contract is already spent/);
  // AND ONE THE FEDERATION STILL HOLDS BUT REFUSED: not final, with the federation's reason.
  class RefusedWallet {
    static async join() { return new RefusedWallet(); }
    async refund() { return JSON.stringify({ accepted: false, error: 'guardians busy', stored_before: { contract_id: 'c', blocks_left: 0 }, balance_before: 0, balance_after: 0 }); }
  }
  const refused = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: RefusedWallet, nodes: ['http://a'], fetcher: seats });
  assert.equal(refused.final, false);
  assert.match(payoutLine(refused), /guardians busy/);
  const unsettled = await redeemPayout({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Wallet, nodes: ['http://a'],
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ state: 'NONE' }), text: async () => '' }) });
  assert.equal(unsettled.ok, false);
  assert.equal(unsettled.final, false, 'a page gave up on a payout before the seats settled');
  assert.match(payoutLine(unsettled), /^Payout: waiting for the seats' settlement/);
  assert.match(unsettled.why, /no seat holds an accepted settlement/);
  assert.equal(asked.length, 0);
});

// 6d: AND THE WINNER'S OWN STAKE BACK BY THE SEATS' FORFEIT, AFTER THE WINDOW.
test('after the settlement the winner\'s page redeems its own stake by the seats\' forfeit into the same wallet; a loser\'s is final with the lock client asked nothing; inside the window or unsettled it asks again', async () => {
  const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const refund = toHex(refundKeyOf(player.pubkey));
  const fields = { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
  const SIG = 'ab'.repeat(64);
  const asked = [];
  const seats = ({ settled = true, forfeit = 200 } = {}) => async (url) => {
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
  const back = await returnStake({ ...ask, storage, client: given, fetcher: seats() });
  console.log(`  winner: "${stakeBackLine(back)}"; joins ${joins}`);
  assert.equal(back.ok, true, back.why);
  assert.equal(back.final, true);
  assert.equal(back.amountMsat, 980000n);
  assert.equal(joins, 0, 'the page opened a second wallet beside the one its payout is in');
  assert.deepEqual(redeemed, [{ txid: 'cd'.repeat(32), outIdx: 0, sig: SIG, key: toHex(player.secret) }]);
  assert.equal(stakeBackLine(back), 'Stake returned: 980000 msat back to this tab\'s federation wallet by the seats\' forfeit (balance 973312 → 1950624 msat)');
  // A RELOAD: answered from the tab's note - seats and wallet asked nothing.
  redeemed.length = 0; asked.length = 0;
  const again = await returnStake({ ...ask, storage, fetcher: seats() });
  assert.equal(again.kept, true);
  assert.equal(again.amountMsat, 980000n);
  assert.equal(asked.length + redeemed.length + joins, 0);

  // A LOSER: every seat refuses the forfeit as not a qualifier - final, nothing asked of the wallet.
  const lost = await returnStake({ ...ask, fetcher: seats({ forfeit: 409 }) });
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
  const already = await returnStake({ ...ask, LockClient: SpentStake, fetcher: seats() });
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
  const busy = await returnStake({ ...ask, LockClient: BusyStake, fetcher: seats() });
  assert.equal(busy.final, false);
  assert.match(stakeBackLine(busy), /^Stake: not back yet - guardians busy/);

  // INSIDE THE WINDOW, and UNSETTLED: not final, asked again later, the wallet untouched.
  const early = await returnStake({ ...ask, fetcher: seats({ forfeit: 'window' }) });
  assert.equal(early.final, false);
  assert.match(stakeBackLine(early), /^Stake: not back yet - .*objection window/);
  asked.length = 0;
  const unsettled = await returnStake({ ...ask, fetcher: seats({ settled: false }) });
  assert.equal(unsettled.final, false);
  assert.equal(asked.filter((u) => u.includes('/forfeit') || u.includes('/stake-lock')).length, 0, 'a forfeit was asked for before the seats settled');
  assert.equal(joins + redeemed.length, 0);
});

// 6d, W4 HOLE 1: A RELOAD ONTO THE ROUND LINK MUST NOT ASK A SECOND DEPOSIT.
test('a reloaded tab with no kept lock joins anew; with a kept lock no seat committed it reuses it; with one a seat committed it stops and never stakes again', () => {
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
test('what the tab still has to collect is kept per round across a reload: the round, invite, seats, seed and lock come back whole; a done round keeps its lines; an unreadable record is skipped', () => {
  const tab = new Map();
  const storage = { getItem: (k) => (tab.has(k) ? tab.get(k) : null), setItem: (k, v) => tab.set(k, String(v)), removeItem: (k) => tab.delete(k),
    key: (i) => [...tab.keys()][i] ?? null, get length() { return tab.size; } };
  const lockRound = { ...round, custody: 'FEDERATION', federationId: b32(0xfe) };
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

test('a lock whose fee the allowance does not cover is topped up after the quote, and one that never funds is refused', async () => {
  const { LockClient, log } = lockClient({ lockFee: 6000n });
  const deposits = [];
  await ask({ LockClient, onDeposit: (d) => deposits.push(String(d.creditsMsat)) });
  // 984940 credited; the lock costs 986000, so the quote still fails on the
  // funds held (a dry run names no shortfall) and the allowance goes in again.
  assert.deepEqual(deposits, [String(lockAmountMsat(round) + 4940n), '4940']);
  assert.equal(log.filter((l) => l.lock).length, 1);
  await assert.rejects(() => ask({ LockClient: lockClient({ lockFee: 10n ** 12n }).LockClient }), /after 3 deposits the lock client/);
});

/** The tab's storage, as the page has it (sessionStorage's shape). */
function tabStorage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}

test('a tab reloaded between the deposit and the lock reopens the wallet that holds the deposit, and is not asked to pay again', async () => {
  const tab = tabStorage();
  // THE FIRST LOAD: pays the deposit, and the tab goes away before the lock.
  const first = lockClient();
  const deposits = [];
  await assert.rejects(() => ask({ LockClient: first.LockClient, storage: tab, onDeposit: (d) => deposits.push(d),
    onStep: (s) => { if (s === 'locking the stake') throw new Error('the tab closed'); } }), /the tab closed/);
  assert.equal(deposits.length, 1);
  assert.ok([...tab.m.keys()].some((k) => k.startsWith('blwp.lockdb.')), 'the wallet was kept nowhere');
  assert.ok(![...tab.m.keys()].some((k) => k.includes(toHex(lockSecretFor(seed, rid)))), 'the lock client\'s secret is in the tab\'s keys');
  // THE RELOAD: the same seed's wallet for this round is reopened, deposit and all.
  const again = lockClient();
  const more = [];
  const steps = [];
  const got = await ask({ LockClient: again.LockClient, storage: tab, onDeposit: (d) => more.push(d), onStep: (s) => steps.push(s) });
  const joined = again.log.find((l) => l.join).join;
  assert.ok(joined.kept > 0, 'the reloaded page joined an empty wallet');
  assert.equal(more.length, 0, 'the reloaded page asked the player to pay again');
  assert.ok(steps.includes('reopening the wallet this tab kept for this round'));
  assert.ok(steps.includes(`holding ${lockAmountMsat(round) + 4940n} msat`));
  assert.equal(`${toHex(got.outpoint.txid)}:${got.outpoint.outIdx}`, `${'ab'.repeat(32)}:0`);
  // AND ANOTHER SEED IN THE SAME TAB DOES NOT OPEN THAT WALLET.
  const other = lockClient();
  await ask({ LockClient: other.LockClient, storage: tab, seed: b32(0x52) });
  assert.equal(other.log.find((l) => l.join).join.kept, 0, 'another seed opened this seed\'s wallet');
});

test('a lock the tab made is kept with its stake until a seat commits it: rebuilt exactly, and marked once committed', async () => {
  const seats = [0x21, 0x22].map((n) => pageCurve.pointX(b32(n)));
  const player2 = pageCurve.pointX(b32(0x62));
  const stake = await stakeFor({ ...round, id: rid }, { seats, curve: pageCurve, random: (n) => new Uint8Array(n).fill(9), playerPubkey: player2, needed: 2 });
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
  await assert.rejects(() => ask({ LockClient: lockClient({ idsMatch: false }).LockClient }), /another contract at that outpoint/);
  await assert.rejects(() => ask({ LockClient: lockClient({ lockedMsat: 979999 }).LockClient }), /locked 979999 msat, and this entry's net stake is 980000/);
});

test('the lock handed to a seat that verifies it is committed; an entry naming no lock is refused, and the hand-over says so', async () => {
  const good = await seatedWithLock({ claimKeyFor: () => CLAIM });
  const none = await seatedWithLock({ claimKeyFor: () => CLAIM }, { outpoint: { txid: new Uint8Array(32), outIdx: 0n } });
  try {
    const a = await handLock({ entryId: good.eid, fields: good.fields, nodes: [`http://127.0.0.1:${good.d.port}`], needed: 1 });
    const b = await handLock({ entryId: none.eid, fields: none.fields, nodes: [`http://127.0.0.1:${none.d.port}`], needed: 1 });
    console.log(`  handed to a seat: ${a.said.map((s) => s.status)} (committed ${a.committed}); no lock named: ${b.said.map((s) => `${s.status} ${s.why}`)}`);
    assert.deepEqual([a.ok, a.committed, String(good.d.round.stakeSeen(good.eid).paidMsat)], [true, 1, String(good.fields.amountMsat)]);
    assert.deepEqual([b.ok, b.committed, b.said[0].status], [false, 0, 409]);
    assert.match(b.said[0].why, /that entry names no stake lock outpoint/);
    assert.equal(none.d.round.stakeSeen(none.eid), null);
  } finally { await good.close(); await none.close(); }
});

test('a lock round\'s entry names its lock\'s outpoint and is not built without one; a round naming no federation is handed none', () => {
  const opts = { seed, curve: pageCurve, random: (n) => new Uint8Array(n).fill(7), claimKey };
  const outpoint = { txid: b32(0xab), outIdx: 3n };
  const entry = entryFor(round, { ...opts, stakeLock: { outpoint } });
  assert.equal(`${toHex(entry.stakeLockOutpoint.txid)}:${entry.stakeLockOutpoint.outIdx}`, `${toHex(b32(0xab))}:3`);
  assert.throws(() => entryFor(round, opts), /no lock was made: an entry naming no stake lock outpoint/);
  assert.throws(() => entryFor(round, { ...opts, stakeLock: { outpoint: { txid: new Uint8Array(32), outIdx: 0n } } }), /no lock was made/);
  const hold = { ...round, federationId: new Uint8Array(32) };
  assert.throws(() => entryFor(hold, { ...opts, stakeLock: { outpoint } }), /names no federation, so there is no lock/);
  assert.equal(entryFor(hold, opts).stakeLockOutpoint.txid.every((b) => b === 0), true);
});

test('the refund from the seed alone: the seats are asked by the seed\'s refund key, and the lock client refunds that lock with the player\'s key', async () => {
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
  assert.equal(asked.length, 2, 'not every seat was asked');
  assert.ok(asked.every((u) => u.includes(`round=${toHex(rid)}`) && u.includes(`refund=${refund}`)));
  const r = refunded.find((x) => x.refund).refund;
  assert.deepEqual([r.txid, r.outIdx, r.key], ['ab'.repeat(32), 0, toHex(player.secret)]);
  assert.deepEqual(r.f, lockFieldsToJson(fields));
  assert.equal(refunded.find((x) => x.join).join.secret, toHex(lockSecretFor(seed, rid)));
  assert.deepEqual(got.refunds.map((x) => x.accepted), [true]);
  // AND ANOTHER SEED FINDS NOTHING TO REFUND.
  await assert.rejects(() => refundStake({ round, roundId: rid, invite: INVITE, seed: b32(0x53), curve: pageCurve, LockClient: Fake,
    nodes: ['http://a.test'], fetcher }), /no seat knows a stake lock that refunds to this seed's key/);
});

test('the redeem from the seed alone: the seats\' forfeit and the player\'s key go to the lock client; a lock no seat forfeits is not redeemed', async () => {
  const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const refund = toHex(refundKeyOf(player.pubkey));
  const fields = { paymentImage: { kind: 'point', bytes: POINT }, amountMsat: 980000n, claimPk: CLAIM, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
  const SIG = 'ab'.repeat(64);
  const seatsSay = (forfeitStatus) => async (url) => {
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
    nodes: ['http://a.test', 'http://b.test'], fetcher: seatsSay(200) });
  assert.deepEqual(calls.map((c) => [c.txid, c.outIdx, c.sig, c.key]), [['cd'.repeat(32), 0, SIG, toHex(player.secret)]]);
  assert.deepEqual(calls[0].f, lockFieldsToJson(fields));
  assert.deepEqual(got.redeems.map((r) => [r.accepted, r.forfeitFrom]), [[true, 'http://a.test']]);
  // A LOSER'S: every seat refuses the forfeit, and nothing reaches the lock client.
  calls.length = 0;
  await assert.rejects(() => redeemStake({ round, roundId: rid, invite: INVITE, seed, curve: pageCurve, LockClient: Fake,
    nodes: ['http://a.test', 'http://b.test'], fetcher: seatsSay(409) }), /no seat gave a forfeit of this lock: .*not a qualifier/);
  assert.equal(calls.length, 0, 'a lock no seat forfeited was sent to the federation');
});

test('the join link carries the federation\'s invite, and refuses one that is not an invite code', () => {
  const base = `?round=${'aa'.repeat(32)}&node=http://a.test,http://b.test&bond=http://c.test&advert=${'ab'.repeat(64)}`;
  assert.equal(joinQuery(base).federation, null);
  assert.equal(joinQuery(`${base}&federation=${INVITE}`).federation, INVITE);
  assert.throws(() => joinQuery(`${base}&federation=http://evil.test`), /not a federation invite code/);
});
