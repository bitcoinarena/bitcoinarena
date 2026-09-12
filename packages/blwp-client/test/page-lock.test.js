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
import assert from 'node:assert/strict';

import { lockStake, handLock, lockSecretFor, lockAmountMsat, lockLine, saveLock, savedLock, markLockCommitted,
  refundStake, LOCK_EXPIRY_MARGIN_BLOCKS } from '../src/page-lock.js';
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
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: b32(0xd0), censusHeight: 900000,
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
function lockClient({ idsMatch = true, lockedMsat, lockFee = 2528n } = {}) {
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
    async receive(msat, gateway) { log.push({ receive: { msat, gateway } }); this.coming = BigInt(msat) - 16064n; return JSON.stringify({ invoice: 'lnbcrt1page', operation: 'op' }); }
    async awaitReceive() {
      this.balance += this.coming;
      if (this.store) this.store.put('ba', this.balance.toString(16).padStart(2, '0'));
      return 'Claimed';
    }
    async lock(point, amount, claim, refund, delta) {
      log.push({ lock: { point, amount, claim, refund, delta } });
      const expiration = 1000 + delta;
      return JSON.stringify({ txid: 'ab'.repeat(32), out_idx: 0, computed_contract_id: 'c1', stored_contract_id: idsMatch ? 'c1' : 'c2',
        ids_match: idsMatch, computed_expiration: expiration, stored_expiration: expiration, amount_msat: Number(lockedMsat ?? amount) });
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

test('the join link carries the federation\'s invite, and refuses one that is not an invite code', () => {
  const base = `?round=${'aa'.repeat(32)}&node=http://a.test,http://b.test&bond=http://c.test&advert=${'ab'.repeat(64)}`;
  assert.equal(joinQuery(base).federation, null);
  assert.equal(joinQuery(`${base}&federation=${INVITE}`).federation, INVITE);
  assert.throws(() => joinQuery(`${base}&federation=http://evil.test`), /not a federation invite code/);
});
