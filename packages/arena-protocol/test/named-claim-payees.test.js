// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LEVEL 2 OF PROOF (a), "WHO IS PAID" (kanban #1044 B1, rulings #1138 2, #1139 A, #1140): the accepted transaction's outputs against the closed payee list,
// and the node row against the fee locks it claims. The gate (#1139): the planners' own honest settlements, turned into the outputs the stake-lock tool
// writes, read here - none may be found false; a hit is a missing payee, reported, never a looser check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimPayees, unpayableClaims, entryPayeeKeys } from '../src/named-claim-payees.js';
import { lockSettlement, bookLockSettlement, attestedLockSettlement, lateLockSettlement } from '../src/lock-settlement.js';
import { DELIVERED, FAILED, FORFEIT } from '../src/payout.js';
import { refundKeyOf } from '../src/stake-lock.js';
import { entryFeeMsat } from '../src/fee.js';
import { toHex } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const RID = b32(0x5f);
const AGG = 'ab'.repeat(32);
const SEATS = [pk(0x71), pk(0x72), pk(0x73)];
const NO_FEES = { ppm: 0n, baseMsat: 0n };
const STAKE = 100000n, FEE = entryFeeMsat(STAKE), NET = STAKE - FEE;
const entry = (n, outcome, score, extra = {}) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score, ...extra });
const lockFor = (e, n, amountMsat = e.stakeMsat - e.feeMsat) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + n), outIdx: 0n }, amountMsat, refundPk: refundKeyOf(e.pubkey) }];
const feeLockFor = (e, n) => [toHex(e.pubkey), { outpoint: { txid: b32(0x60 + n), outIdx: 0n }, amountMsat: e.feeMsat, preimage: b32(0x80 + n), refundPk: refundKeyOf(e.pubkey) }];
// the Entry Contract's fields the payee list reads
const contractOf = (e) => ({ roundId: RID, playerPubkey: e.pubkey, ...(e.frontendPk ? { frontendPk: e.frontendPk } : {}) });

/** A plan as the stake-lock tool writes it and arena-claim-read reads it back: one spend per claimed lock, the plan's payouts as outputs. */
function readOf(plan, txid = 'cc'.repeat(32), named = ['02' + '11'.repeat(32)]) {
  const outputs = plan.payouts.map((p, i) => (p.sent
    ? { out_idx: i, kind: 'outgoing', claim_pk: p.sent.gatewayPk, refund_pk: '02' + AGG, amount_msat: Number(p.msat) }
    : { out_idx: i, kind: 'outgoing', claim_pk: p.kind === 'held' ? '02' + AGG : toHex(p.payoutPk), refund_pk: p.kind === 'held' ? '02' + AGG : toHex(p.payoutPk), amount_msat: Number(p.msat) }));
  return plan.claims.map((c) => ({ kind: 'claim', txid, session: 3, outpoint: `${toHex(c.outpoint.txid)}:0`, named_keys: named, agg_key: AGG, outputs,
    lock: { round_id: toHex(RID), amount_msat: Number(c.amountMsat), refund_pk: toHex(refundKeyOf(c.pubkey)), payment_image: c.kind === 'fee' ? { hash: '00' } : { point: '02' } } }));
}
// a keyed donation set (FEDERATION.md "Donations in the federation"): the Round Contract's, and a market game's own
const NET_KEY = Uint8Array.from([0x02, ...b32(0x4d)]), GAME_KEY = Uint8Array.from([0x02, ...b32(0x6e)]);
const KEYED_SET = { recipients: [{ recipientPk: NET_KEY, shareBps: 10000, label: 'devs' }] };
const ROUND = { networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 3, settlementSlots: 3, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: SEATS, protocolVersion: 27 };
const seatKeys = (extra = []) => new Set([...SEATS, ...extra].map((k) => toHex(refundKeyOf(k))));
const donationKeys = new Set([toHex(NET_KEY)]);

test('an honest played round: the winner, the seats, the website and an auditor are all on the list, the node row within the fee locks', () => {
  const site = Uint8Array.from([0x03, ...b32(0x33)]);
  const W = entry(1, DELIVERED, 3, { frontendPk: site }), L = entry(2, FAILED, 0);
  const auditor = pk(0x90);
  const plan = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, feeBps: 500, contract: ROUND,
    signerNodes: { gameVerify: SEATS, settlement: SEATS, auditors: [toHex(auditor)] }, locks: new Map([lockFor(W, 1), lockFor(L, 2)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  assert.equal(plan.ok, true, plan.why);
  assert.ok(plan.payouts.some((p) => p.kind === 'auditor') && plan.payouts.some((p) => p.kind === 'frontend'));
  const spends = readOf(plan);
  const payees = { nodeKeys: seatKeys([auditor]), donationKeys, reserveKeys: new Set() };
  const r = claimPayees({ spends, entryKeys: entryPayeeKeys([contractOf(W), contractOf(L)]), payees });
  assert.equal(r.false, false, r.why);
  assert.deepEqual(r.unread, []);
  assert.deepEqual(unpayableClaims({ spends, roundId: toHex(RID), entries: [contractOf(W), contractOf(L)], payees }), []);
});

test('a claim paying a key on no list is false, its named signers the offenders; with a payee set unread it is unread instead', () => {
  const W = entry(1, DELIVERED, 3), L = entry(2, FAILED, 0);
  const plan = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, feeBps: 500, contract: ROUND,
    signerNodes: { gameVerify: SEATS, settlement: SEATS }, locks: new Map([lockFor(W, 1), lockFor(L, 2)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  const thief = Uint8Array.from([0x02, ...b32(0xee)]);
  const off = { ...plan, payouts: plan.payouts.map((p) => (p.kind === 'qualifier' ? { ...p, payoutPk: thief } : p)) };
  const named = ['02' + '21'.repeat(32), '02' + '22'.repeat(32)];
  const spends = readOf(off, 'dd'.repeat(32), named);
  const entries = [contractOf(W), contractOf(L)];
  const payees = { nodeKeys: seatKeys(), donationKeys, reserveKeys: new Set() };
  const found = unpayableClaims({ spends, roundId: toHex(RID), entries, payees });
  assert.equal(found.length, 1);
  assert.equal(found[0].txid, 'dd'.repeat(32));
  assert.match(found[0].why, /a key the round may not pay/);
  assert.deepEqual(found[0].offenders, named.sort());
  // the donation set unread: that output could be a recipient's, so nothing is held
  const r = claimPayees({ spends, entryKeys: entryPayeeKeys(entries), payees: { ...payees, donationKeys: null } });
  assert.equal(r.false, false);
  assert.match(r.unread[0], /no payee read here names/);
  // a round of another id is not read at all
  assert.deepEqual(unpayableClaims({ spends, roundId: 'ff'.repeat(32), entries, payees }), []);
});

test('the node row above the fee locks the transaction claims is false, though every key is a seat\'s', () => {
  const W = entry(1, DELIVERED, 3), L = entry(2, FAILED, 0);
  const plan = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, feeBps: 500, contract: ROUND,
    signerNodes: { gameVerify: SEATS, settlement: SEATS }, locks: new Map([lockFor(W, 1), lockFor(L, 2)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  // the winner's payout moved to a seat: every key listed, the node row now holds the loser's stake
  const moved = { ...plan, payouts: plan.payouts.map((p) => (p.kind === 'qualifier' ? { ...p, payoutPk: refundKeyOf(SEATS[0]) } : p)) };
  const r = claimPayees({ spends: readOf(moved), entryKeys: entryPayeeKeys([contractOf(W), contractOf(L)]), payees: { nodeKeys: seatKeys(), donationKeys, reserveKeys: new Set() } });
  assert.equal(r.false, true);
  assert.match(r.why, /node row is paid \d+ msat and the fee locks the transaction claims hold 10000/);
});

test('an output no settlement makes, and a send refunding anywhere but the signer set, are false', () => {
  const base = { kind: 'claim', txid: 'aa'.repeat(32), session: 1, named_keys: [], agg_key: AGG, lock: { round_id: toHex(RID), amount_msat: 1000, refund_pk: '02' + '01'.repeat(32), payment_image: { hash: '00' } } };
  const payees = { nodeKeys: new Set(), donationKeys: new Set(), reserveKeys: new Set() };
  assert.match(claimPayees({ spends: [{ ...base, outputs: [{ out_idx: 0, module: 'mint' }] }], entryKeys: new Set(), payees }).why, /output of module mint/);
  assert.match(claimPayees({ spends: [{ ...base, outputs: [{ out_idx: 0, kind: 'arena-lock' }] }], entryKeys: new Set(), payees }).why, /arena-lock output/);
  const send = { out_idx: 0, kind: 'outgoing', claim_pk: '02' + '05'.repeat(32), refund_pk: '02' + '06'.repeat(32), amount_msat: 500 };
  assert.match(claimPayees({ spends: [{ ...base, outputs: [send] }], entryKeys: new Set(), payees }).why, /send refunding to/);
  assert.equal(claimPayees({ spends: [{ ...base, outputs: [{ ...send, refund_pk: '03' + AGG }] }], entryKeys: new Set(), payees }).false, false, 'a send refunding to KeyAgg(S)');
  // the claimed lock's own refund key is a qualifier's
  const own = { out_idx: 0, kind: 'outgoing', claim_pk: '02' + '01'.repeat(32), refund_pk: '02' + '01'.repeat(32), amount_msat: 900 };
  assert.equal(claimPayees({ spends: [{ ...base, outputs: [own] }], entryKeys: new Set(), payees }).false, false);
});

// ---- THE GATE (#1139, #1140): honest settlements the planners build, read at level 2

test('gate: a walk-away\'s remainder (75 % of its stake to the sitting seats, 25 % to the donation set\'s keys)', () => {
  const walker = entry(5, FORFEIT, 0, { atTheDoor: true }), loser = entry(6, FAILED, 0);
  const plan = lockSettlement({ roundId: RID, entries: [walker, loser], minScore: 1, locks: new Map([lockFor(walker, 5), lockFor(loser, 6)]), fees: NO_FEES,
    contract: ROUND, donationSet: KEYED_SET });
  assert.equal(plan.ok, true, plan.why);
  const payees = { nodeKeys: seatKeys(), donationKeys, reserveKeys: new Set(), fees: NO_FEES };
  const keys = entryPayeeKeys([contractOf(walker), contractOf(loser)]);
  // the remainder room (#1143 1): no qualifier paid, so the seats may take 75 % of the claimed stake, the donation set the other 25 %
  const r = claimPayees({ spends: readOf(plan), entryKeys: keys, payees });
  assert.equal(r.false, false, r.why);
  // a seat paid a msat more than the 75 %: false
  const more = { ...plan, payouts: [...plan.payouts, { kind: 'remainder node', payoutPk: refundKeyOf(SEATS[2]), msat: plan.remainder.nodesMsat - plan.payouts.filter((x) => x.kind === 'remainder node').reduce((t, x) => t + x.msat, 0n) + 1n }] };
  assert.match(claimPayees({ spends: readOf(more), entryKeys: keys, payees }).why, new RegExp(`the remainder room ${plan.remainder.nodesMsat}`));
  // the donation set paid above its 25 %
  const rich = { ...plan, payouts: plan.payouts.map((p) => (p.kind === 'donation key' ? { ...p, msat: p.msat + 1n } : p)) };
  assert.match(claimPayees({ spends: readOf(rich), entryKeys: keys, payees }).why, new RegExp(`a walk-away's remainder gives it at most ${plan.remainder.donationMsat}`));
});

test('#1143 1: where a qualifier is paid there is no remainder room - seats paid out of a stake lock beside a winner are false', () => {
  const W = entry(1, DELIVERED, 3), L = entry(2, FAILED, 0);
  const plan = lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, feeBps: 500, contract: ROUND,
    signerNodes: { gameVerify: SEATS, settlement: SEATS }, locks: new Map([lockFor(W, 1), lockFor(L, 2)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  // half the winner's payout moved to a seat: within 75 % of the stake, but a qualifier is paid
  const half = plan.payouts.find((p) => p.kind === 'qualifier').msat / 2n;
  const split = { ...plan, payouts: [...plan.payouts.map((p) => (p.kind === 'qualifier' ? { ...p, msat: p.msat - half } : p)), { kind: 'signer node', payoutPk: refundKeyOf(SEATS[1]), msat: half }] };
  const r = claimPayees({ spends: readOf(split), entryKeys: entryPayeeKeys([contractOf(W), contractOf(L)]), payees: { nodeKeys: seatKeys(), donationKeys, reserveKeys: new Set(), fees: NO_FEES } });
  assert.equal(r.false, true);
  assert.match(r.why, /it pays a qualifier: no remainder room/);
});

test('gate: a market\'s book settlement - orders, seats, the donation target, the reserve', () => {
  const A = entry(11, DELIVERED, 0), B = entry(12, DELIVERED, 0);
  const eid = (e) => toHex(e.pubkey);
  const table = { claimed: [
    { entry: eid(A), stakeMsat: NET, feeMsat: FEE, outMsat: 2n * NET - 2000n },
    { entry: eid(B), stakeMsat: NET, feeMsat: FEE, outMsat: 0n }], feesDueMsat: 2000n + 2n * FEE };
  const reserveKey = Uint8Array.from([0x02, ...b32(0x5e)]);
  const gameKey = GAME_KEY;
  const plan = bookLockSettlement({ roundId: RID, table, entries: [A, B].map((e) => ({ ...e, entryId: eid(e) })), locks: new Map([lockFor(A, 11), lockFor(B, 12)]),
    feeLocks: new Map([feeLockFor(A, 11), feeLockFor(B, 12)]), fees: NO_FEES, contract: ROUND, nodeBps: 200, donationBps: 200, reserveBps: 50, reserveKey,
    donation: { recipients: { network: KEYED_SET.recipients, game: [{ recipientPk: gameKey, shareBps: 10000, label: 'game' }] } } });
  if (!plan.ok) { assert.fail(`the book plan did not build: ${plan.why}`); }
  const spends = readOf(plan);
  const keys = entryPayeeKeys([contractOf(A), contractOf(B)]);
  const base = { nodeKeys: seatKeys(), donationKeys, reserveKeys: new Set([toHex(reserveKey)]) };
  assert.ok(plan.payouts.some((p) => toHex(p.payoutPk) === toHex(gameKey)), 'the book pays its game\'s own set');
  // without the game's set read it is a key the round may not pay; with it (#1143 2) honest, both sets within the donation share
  assert.match(claimPayees({ spends, entryKeys: keys, payees: base }).why, /a key the round may not pay/);
  const market = { nodeBps: 200, donationBps: 200 };
  const r = claimPayees({ spends, entryKeys: keys, payees: { ...base, gameDonationKeys: new Set([toHex(gameKey)]), market } });
  assert.equal(r.false, false, r.why);
  // the game's set paid above the share: false
  const claimed = plan.claims.reduce((t, c) => t + c.amountMsat, 0n);
  const greedy = { ...plan, payouts: plan.payouts.map((p) => (toHex(p.payoutPk) === toHex(gameKey) ? { ...p, msat: claimed } : p)) };
  assert.match(claimPayees({ spends: readOf(greedy), entryKeys: keys, payees: { ...base, gameDonationKeys: new Set([toHex(gameKey)]), market } }).why, /the market's donation share of what the transaction claims is/);
});

// ---- THE ZERO-FALSE GATE (#1139, #1143): every honest settlement the planners build here, read at level 2 with the payees a seat reads - none may be false
test('gate: every honest settlement the planners build reads clean at level 2', () => {
  const FEES = [NO_FEES, { ppm: 1000n, baseMsat: 0n }, { ppm: 0n, baseMsat: 1000n }];
  const auditor = pk(0x90), guardian = pk(0x91), guardianPk = Uint8Array.from([0x03, ...b32(0x92)]), site = Uint8Array.from([0x03, ...b32(0x33)]);
  const reserveKey = Uint8Array.from([0x02, ...b32(0x5e)]);
  const payeesOf = (fees, extra = {}) => ({ nodeKeys: new Set([...seatKeys([auditor, guardian]), toHex(guardianPk)]), donationKeys, reserveKeys: new Set([toHex(reserveKey)]), fees, ...extra });
  const plans = [];
  for (const fees of FEES) {
    // played rounds: 2..5 players, 1..n-1 winners, a website on the first, auditors and a guardian paid at its advert key
    for (let n = 2; n <= 5; n++) for (let w = 1; w < n; w++) {
      const es = Array.from({ length: n }, (_, i) => entry(i + 1, i < w ? DELIVERED : FAILED, i < w ? 3 : 0, i === 0 ? { frontendPk: site } : {}));
      plans.push({ what: `played ${n}/${w}`, fees, entries: es, plan: lockSettlement({ roundId: RID, entries: es, minScore: 1, fees, feeBps: 500, contract: ROUND,
        signerNodes: { gameVerify: SEATS, settlement: SEATS, auditors: [toHex(auditor)], guardian: [guardian], guardianPayout: new Map([[toHex(guardian), guardianPk]]) },
        locks: new Map(es.map((e, i) => lockFor(e, i + 1))), feeLocks: new Map(es.map((e, i) => feeLockFor(e, i + 1))) }) });
    }
    // walk-aways: the walker alone or beside losers, with and without the fee locks
    for (const losers of [0, 1, 3]) for (const withFee of [false, true]) {
      const es = [entry(5, FORFEIT, 0, { atTheDoor: true }), ...Array.from({ length: losers }, (_, i) => entry(6 + i, FAILED, 0))];
      plans.push({ what: `walk-away +${losers}${withFee ? ' fee' : ''}`, fees, entries: es, plan: lockSettlement({ roundId: RID, entries: es, minScore: 1, fees, feeBps: 500, contract: ROUND,
        donationSet: KEYED_SET, signerNodes: { gameVerify: SEATS, settlement: SEATS }, locks: new Map(es.map((e, i) => lockFor(e, 20 + i))),
        ...(withFee ? { feeLocks: new Map(es.map((e, i) => feeLockFor(e, 20 + i))) } : {}) }) });
    }
    // attested (pari-mutuel): one winner, one or two losers
    for (const losers of [1, 2]) {
      const es = Array.from({ length: losers + 1 }, (_, i) => ({ ...entry(30 + i, DELIVERED, 0), entryId: toHex(b32(0x30 + i)) }));
      const rows = es.map((e, i) => ({ entryId: e.entryId, won: i === 0, netMsat: NET, payoutMsat: i === 0 ? NET * BigInt(losers + 1) : 0n }));
      plans.push({ what: `attested 1/${losers}`, fees, entries: es, plan: attestedLockSettlement({ roundId: RID, table: { rows }, entries: es, locks: new Map(es.map((e, i) => lockFor(e, 30 + i))),
        feeLocks: new Map(es.map((e, i) => feeLockFor(e, 30 + i))), fees, feeBps: 500, contract: ROUND, signerNodes: { gameVerify: SEATS, settlement: SEATS } }) });
    }
    // a late loser's lock to the winners
    { const late = entry(40, FAILED, 0), win = entry(41, DELIVERED, 3);
      plans.push({ what: 'late', fees, entries: [late, win], plan: lateLockSettlement({ roundId: RID, entryId: b32(0x40), entry: late, lock: lockFor(late, 40)[1], shares: [{ pubkey: win.pubkey, msat: 1n }],
        winnerLocks: new Map([lockFor(win, 41)]), fees, feeBps: 500, contract: ROUND, signerNodes: { gameVerify: SEATS, settlement: SEATS }, feeLock: feeLockFor(late, 40)[1] }) }); }
    // a market's book: with and without the reserve
    for (const reserveBps of [0, 50]) {
      const A = entry(11, DELIVERED, 0), B = entry(12, DELIVERED, 0);
      const eid = (e) => toHex(e.pubkey);
      const table = { claimed: [{ entry: eid(A), stakeMsat: NET, feeMsat: FEE, outMsat: 2n * NET - 2000n }, { entry: eid(B), stakeMsat: NET, feeMsat: FEE, outMsat: 0n }], feesDueMsat: 2000n + 2n * FEE };
      plans.push({ what: `book reserve ${reserveBps}`, fees, entries: [A, B], market: { nodeBps: 200, donationBps: 200 }, plan: bookLockSettlement({ roundId: RID, table, entries: [A, B].map((e) => ({ ...e, entryId: eid(e) })),
        locks: new Map([lockFor(A, 11), lockFor(B, 12)]), feeLocks: new Map([feeLockFor(A, 11), feeLockFor(B, 12)]), fees, contract: ROUND, nodeBps: 200, donationBps: 200, reserveBps, reserveKey,
        donation: { recipients: { network: KEYED_SET.recipients, game: [{ recipientPk: GAME_KEY, shareBps: 10000, label: 'game' }] } } }) });
    }
  }
  const built = plans.filter((x) => x.plan.ok && !x.plan.nothing && x.plan.claims.length);
  const falseOnes = [];
  for (const x of built) {
    const r = claimPayees({ spends: readOf(x.plan), entryKeys: entryPayeeKeys(x.entries.map(contractOf)),
      payees: payeesOf(x.fees, x.market ? { market: x.market, gameDonationKeys: new Set([toHex(GAME_KEY)]) } : {}) });
    if (r.false || r.unread.length) falseOnes.push(`${x.what} ${x.fees.ppm}/${x.fees.baseMsat}: ${r.why || r.unread.join('; ')}`);
  }
  console.log(`#1044 gate: ${built.length} honest settlements read of ${plans.length} plans, ${falseOnes.length} false`);
  assert.ok(built.length >= 60, `${built.length} built: ${plans.filter((x) => !x.plan.ok).map((x) => `${x.what}: ${x.plan.why}`).slice(0, 3).join(' | ')}`);
  assert.deepEqual(falseOnes, []);
});

// KANBAN #1331 (1), §13A.1 RULED 2026-11-07 (#1306): "The unpaid remainder of the auditors' 10 % goes to the protocol reserves, never back into
// the nodes' pools." With the round's reserve key handed in (signerNodes.auditReserveKey): no AUDIT -> the whole 10 % to the reserves; one AUDIT
// paid -> the rest of the 10 % to the reserves. Without a key the old rule stands.
test('#1331 the auditors\' unpaid remainder goes to the reserves, not back to the seats', () => {
  const W = entry(1, DELIVERED, 3), L = entry(2, FAILED, 0);
  const RK = Uint8Array.from([0x02, ...b32(0x5a)]);
  const run = (signerNodes) => lockSettlement({ roundId: RID, entries: [W, L], minScore: 1, fees: NO_FEES, feeBps: 500, contract: ROUND, signerNodes,
    locks: new Map([lockFor(W, 1), lockFor(L, 2)]), feeLocks: new Map([feeLockFor(W, 1), feeLockFor(L, 2)]) });
  const sum = (plan, kind) => plan.payouts.filter((p) => p.kind === kind).reduce((a, p) => a + p.msat, 0n);
  const old = run({ gameVerify: SEATS, settlement: SEATS, auditors: [] });
  const none = run({ gameVerify: SEATS, settlement: SEATS, auditors: [], auditReserveKey: RK });
  const one = run({ gameVerify: SEATS, settlement: SEATS, auditors: [toHex(pk(0x90))], auditReserveKey: RK });
  const seatsOld = sum(old, 'signer node'), seatsNone = sum(none, 'signer node');
  const toReserve = (plan) => plan.payouts.filter((p) => p.auditRemainder).reduce((a, p) => a + p.msat, 0n);
  console.log('  MEASURED #1331 (1):', JSON.stringify({ seatsWithoutKey: String(seatsOld), seatsNoAudit: String(seatsNone), reserveNoAudit: String(toReserve(none)),
    auditorOne: String(sum(one, 'auditor')), reserveOneAudit: String(toReserve(one)) }));
  assert.equal(old.ok && none.ok && one.ok, true);
  assert.equal(toReserve(old), 0n, 'without a reserve key the old rule stands');
  assert.ok(toReserve(none) > 0n, 'with no AUDIT the auditors\' 10 % stayed with the seats');
  assert.ok(seatsNone < seatsOld, 'the seats kept the auditors\' share');
  assert.ok(sum(one, 'auditor') > 0n);
  assert.ok(toReserve(one) < toReserve(none), 'a paid auditor\'s share also went to the reserves');
  assert.ok(none.payouts.find((p) => p.auditRemainder).payoutPk === RK);
});
