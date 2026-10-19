// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LEADERBOARD PAYOUT, END TO END (2026-10-17/18): the pass rule - YES >= 25 % of the voting weight over the 2-week
// vote, no signal, a larger NO does not block it; the winners - the top N of the season by P&L, identities only (rows without one are
// skipped and the next moves up), a tie at the cut sharing the places it spans; the 10 % cap; and the payout - seven guardian seats on
// one fake federation pay the winners in the federation from the reserves, and a winner's page collects its payout as a zap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { createReservePayouts, PAYOUT } from '../src/reserve-payout.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { encodeLeaderboardPayout, leaderboardPayoutId, leaderboardPasses, leaderboardVotePeriod, LB_SCOPE } from '../../arena-protocol/src/leaderboard-payout.js';
import { leaderboardWinners, leaderboardCap } from '../../arena-protocol/src/leaderboard-winners.js';
import { fundingTally, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../../arena-protocol/src/ballot.js';
import { identitySecretFor } from '../../arena-protocol/src/player-key.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { collectZaps } from '../../arena-client/src/identity.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 7; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hx = (n) => n.toString(16).padStart(2, '0').repeat(32);
const FED = 'b1'.repeat(32);
const P = (over = {}) => ({ networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 100, scope: LB_SCOPE.GAME, gameName: 'btc-updown-15m', top: 3,
  amountSats: 3000n, federationId: fromHex(FED), splitBps: [], periodDays: 7, paymentHeight: 600, purpose: 'the best three of the week', ...over });

// ---- 1. THE PASS RULE: YES >= 25 % of the voting weight, nothing else ----
test('the pass edge: YES at 24.99 % of the voting weight fails, at 25 % passes - also when NO outweighs YES; ABSTAIN is not YES', () => {
  const id = leaderboardPayoutId(P());
  const census = (yes, no, abstain = 0) => [[21, yes], [22, no], [23, abstain]].filter(([, w]) => w > 0)
    .map(([n, w]) => ({ pubkey: pk(n), outpoint: `${hx(n)}:0`, bondSats: BigInt(w), weight: BigInt(w) }));
  const vote = (n, choice) => ({ payload: encodeVote({ proposalId: id, choice, signature: schnorr.sign(voteMessage(id, choice), sk(n)) }), height: 105, txid: 'aa'.repeat(32) });
  const count = (yes, no, abstain = 0) => leaderboardPasses(fundingTally({ proposalId: id, census: census(yes, no, abstain),
    votes: [vote(21, CHOICE.YES), vote(22, CHOICE.NO), ...(abstain ? [vote(23, CHOICE.ABSTAIN)] : [])], from: 100, until: 2116, verify }));
  const under = count(2499, 7501), at = count(2500, 7500);
  assert.deepEqual([under.yesOfAllPct, under.passed], [24.99, false]);
  assert.deepEqual([at.yesOfAllPct, at.passed, at.approvalPct], [25, true, 25], '25 % YES passes though NO is 75 % of the votes');
  assert.equal(count(2000, 2000, 6000).passed, false, 'ABSTAIN is not YES: 20 % YES of the weight fails');
  assert.equal(at.rule, 'YES >= 25 % of the voting weight');
  // no signal: the vote starts at publication and runs 2016 blocks
  assert.deepEqual(leaderboardVotePeriod({ proposal: P() }), { from: 100, until: 2116, last: 2115, decidableAt: 2120 });
});

test('a seat keeps it, opens its vote at publication with no signal, and decides it by the 25 % rule alone', async () => {
  const S = FUNDING_SCHEDULES.short;
  const chain = { tip: 100, blocks: new Map(), bonds: [] };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${hx(n)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
  chain.bonds = [bond(21, 2500), bond(22, 7500)];
  const book = createFundingBook({ db: openStore(':memory:'), verify, schedule: S, tip: async () => chain.tip, isBonded: () => true,
    activeAt: async () => ({ ok: false, why: 'no signal is asked' }),
    voteChain: { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null), votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })),
      censusAt: async () => chain.bonds.map((b) => ({ ...b })) } });
  const p = P({ paymentHeight: 100 + S.vote + S.decideDepth + 5 });
  const id = leaderboardPayoutId(p);
  const kept = await book.add('leaderboard', toHex(Uint8Array.from([...encodeLeaderboardPayout(p), ...schnorr.sign(id, sk(1))])));
  assert.equal(kept.ok, true, kept.why);
  assert.deepEqual(await book.decide(), [], 'no signal is decided for it');
  at(100).votes.push({ payload: encodeVote({ proposalId: id, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(id, CHOICE.YES), sk(21)) }), txid: 'aa'.repeat(32) });
  at(101).votes.push({ payload: encodeVote({ proposalId: id, choice: CHOICE.NO, signature: schnorr.sign(voteMessage(id, CHOICE.NO), sk(22)) }), txid: 'bb'.repeat(32) });
  chain.tip = 100 + S.vote - 1 + S.decideDepth - 1;
  const [v] = await book.voteRound();
  assert.deepEqual([v.passed, v.yesSats, v.noSats, v.yesOfAllPct], [true, '2500', '7500', 25], 'decided passed at 25 % YES, NO at 75 %');
  assert.deepEqual(book.leaderboardsPassed().map((x) => x.id), [toHex(id)]);
  assert.equal(book.leaderboardList(chain.tip)[0].vote.state, 'passed');
  // a payment height before the vote can be decided: refused
  const early = P({ paymentHeight: 101 });
  assert.match((await book.add('leaderboard', toHex(Uint8Array.from([...encodeLeaderboardPayout(early), ...schnorr.sign(leaderboardPayoutId(early), sk(1))])))).why, /comes before its vote is decided/);
});

// ---- 2. THE WINNERS ----
// identities: a seed's identity key for the winner whose page collects; a row's player is an identity when its entries name a round key
// that is not the player
const SEED = new Uint8Array(32).fill(0x5e);
const A = toHex(schnorr.getPublicKey(identitySecretFor(SEED)));
const B = hx(0x0b), C = hx(0x0c), D = hx(0x0d), E = hx(0x0e), F = hx(0x0f);
const GAME = hx(0x9a);
const T0 = Date.UTC(2026, 9, 10);
const S0 = 100000n;
const en = (player, payoutMsat, roundKey) => ({ player, outcome: payoutMsat > 0n ? DELIVERED : FAILED, score: null, payoutMsat, stakeMsat: S0, name: null, roundKey });
const ROUNDS = [
  { roundId: hx(0x11), gameId: GAME, startMs: T0 + 3600000, entries: [en(A, 400000n, hx(0xa1)), en(B, 1000000n, B), en(F, 900000n, null)] },
  { roundId: hx(0x12), gameId: GAME, startMs: T0 + 7200000, entries: [en(C, 300000n, hx(0xc1)), en(D, 200000n, hx(0xd1)), en(E, 200000n, hx(0xe1))] },
];
const WIN = { rounds: ROUNDS, games: [GAME], fromMs: T0, toMs: T0 + 7 * 86400000, top: 3, amountMsat: 3000000n };

test('the winners: rows without an identity skipped, the next moving up; a tie at the cut shares its place', () => {
  const w = leaderboardWinners(WIN);
  assert.equal(w.ok, true, w.why);
  assert.deepEqual(w.skipped, [B, F], 'B joined under its own key, F named none: no identity, skipped');
  // by P&L: A 300000, C 200000, then D and E 100000 each - tied for place 3
  assert.deepEqual(w.winners.map((x) => [x.player.slice(0, 4), x.msat, x.places]),
    [[A.slice(0, 4), 1000000n, '1'], [C.slice(0, 4), 1000000n, '2'], [D.slice(0, 4), 500000n, '3-3 shared by 2'], [E.slice(0, 4), 500000n, '3-3 shared by 2']]);
  assert.equal(w.totalMsat, 3000000n);
  assert.equal(w.winners[0].payoutPk, toHex(refundKeyOf(fromHex(A))), 'paid to the identity\'s refund key');
  // a split by place: 50 / 30 / 20 - the tie at place 3 shares its 20 %
  const s = leaderboardWinners({ ...WIN, splitBps: [5000, 3000, 2000] });
  assert.deepEqual(s.winners.map((x) => x.msat), [1500000n, 900000n, 300000n, 300000n]);
});

test('the 10 % cap: at most 10 % of the paying federation\'s reserves', () => {
  assert.equal(leaderboardCap({ amountSats: 3000n, reservesSats: 30000n }).ok, true);
  assert.match(leaderboardCap({ amountSats: 3001n, reservesSats: 30000n }).why, /more than 10 % of the 30000 sat reserves/);
});

// ---- 3. THE PAYOUT: seven guardian seats, one fake federation ----
const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));
const G = evenGroupSecret(0x7654321n, curve);
const DEAL = trustedDealerSplit({ secret: G.secret, max: 7, min: 5, coefficients: [3n, 5n, 7n, 11n], curve });
const KEY = DEAL.groupPublicKey;
const NODE_KEYS = Array.from({ length: 7 }, (_, i) => toHex(schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i + 1 : 8))))).sort();
const FEES = { ppm: 100n, baseMsat: 1000n };
const LB = 'cc'.repeat(32);

function world({ reserves = [20000000n, 20000000n] } = {}) {
  const fed = { contracts: new Map(), submits: [] };
  const reserveRows = reserves.map((m, i) => ({ outpoint: `${String(i + 1).padStart(2, '0').repeat(32)}:0`, amountMsat: String(m), verifiedMs: i + 1 }));
  for (const r of reserveRows) fed.contracts.set(r.outpoint, { key: toHex(KEY), msat: BigInt(r.amountMsat), spent: false });
  const msgOf = (o) => sha256(new TextEncoder().encode(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v))));
  const port = {
    fees: async () => FEES,
    settle: async ({ claimPk, refunds, payouts, nonce, signature = null }) => {
      const message = msgOf({ k: claimPk, r: refunds.map((x) => [toHex(x.outpoint.txid), String(x.outpoint.outIdx), x.amountMsat]), p: payouts, n: nonce });
      if (!signature) return { message: toHex(message) };
      if (!schnorr.verify(signature, message, claimPk.subarray(1))) return { accepted: false, error: 'the signature does not verify' };
      for (const x of refunds) { const c = fed.contracts.get(`${toHex(x.outpoint.txid)}:${x.outpoint.outIdx}`); if (!c || c.spent || c.key !== toHex(claimPk)) return { accepted: false, error: 'an input is not spendable' }; }
      for (const x of refunds) fed.contracts.get(`${toHex(x.outpoint.txid)}:${x.outpoint.outIdx}`).spent = true;
      const txid = toHex(message);
      payouts.forEach((p, i) => fed.contracts.set(`${txid}:${i}`, { key: toHex(p.payoutPk), msat: p.msat, spent: false }));
      fed.submits.push({ txid, payouts: payouts.map((p) => [toHex(p.payoutPk), p.msat]) });
      return { txid, accepted: true };
    },
  };
  const state = { kept: [] };
  const due = [{ id: LB, federation: FED, amountSats: 3000n, paymentHeight: 600, decidableAt: 520 }];
  const seats = [];
  for (let i = 0; i < 7; i++) {
    const s = { inbox: [] };
    s.api = createReservePayouts({ db: openStore(':memory:'), me: NODE_KEYS[i], curve, random: rand, network: 'testnet4', passed: () => [],
      leaderboards: () => due, winnersOf: async () => leaderboardWinners(WIN),
      reserveRows: () => [...reserveRows, ...state.kept.filter((k) => k.seat === i && k.row.recipientPk === toHex(KEY)).map((k) => ({ outpoint: k.row.outpoint, amountMsat: k.row.amountMsat, verifiedMs: 99 }))],
      portOf: async () => port, payRequest: async () => ({ ok: false }), invoiceFor: async () => ({ ok: false }),
      keepRow: (row) => { const o = `${toHex(row.outpoint.txid)}:${row.outpoint.outIdx}`; if (!state.kept.some((k) => k.seat === i && k.row.outpoint === o))
        state.kept.push({ seat: i, row: { outpoint: o, amountMsat: String(row.amountMsat), recipientPk: toHex(row.recipientPk), federationId: toHex(row.federationId), senderOnContract: !!row.senderOnContract, item: row.item } }); },
      broadcast: (rec) => { for (const o of seats) if (o !== s) o.inbox.push(rec); },
      guardians: () => new Map([[FED, { members: NODE_KEYS, key: KEY, needed: 5, signer: { id: i + 1, share: DEAL.shares[i].share },
        peers: seats.filter((o) => o !== s).map((o) => ({ commit: (b) => o.api.commit(b), share: (b) => o.api.share(b) })) }]]) });
    seats.push(s);
  }
  const deliver = async () => { for (const s of seats) { while (s.inbox.length) await s.api.learn(s.inbox.shift()); } };
  return { fed, seats, state, deliver, due };
}

test('the payout: from the payment height, once, the four winners paid in the federation from the reserves; every seat records it; the winner collects it as a zap', async () => {
  const w = world();
  const coord = w.seats.findIndex((s, i) => NODE_KEYS.indexOf(NODE_KEYS[i]) === 0);
  assert.deepEqual(await w.seats[coord].api.round({ height: 599 }), [], 'not before the payment height');
  const out = await w.seats[coord].api.round({ height: 600 });
  const r = out.find((x) => x.id === LB);
  assert.deepEqual([r.ok, r.state], [true, PAYOUT.PAID], r.why);
  assert.equal(w.fed.submits.length, 1);
  const paid = w.fed.submits[0].payouts;
  assert.deepEqual(paid.slice(0, 4), [[toHex(refundKeyOf(fromHex(A))), 1000000n], [toHex(refundKeyOf(fromHex(C))), 1000000n], [toHex(refundKeyOf(fromHex(D))), 500000n], [toHex(refundKeyOf(fromHex(E))), 500000n]]);
  assert.equal(paid[4][0], toHex(KEY), 'the change back to the reserve key');
  await w.deliver();
  for (const s of w.seats) assert.equal(s.api.stateOf(LB).state, PAYOUT.PAID);
  // again, later, on every seat: nothing more is paid
  for (const s of w.seats) await s.api.round({ height: 900 });
  assert.equal(w.fed.submits.length, 1, 'paid once');

  // THE WINNER COLLECTS: its page asks the seats what was paid to its identity's refund key and spends it into its wallet
  const mine = toHex(refundKeyOf(fromHex(A)));
  const rows = w.state.kept.filter((k) => k.row.recipientPk === mine && k.row.item === 'leaderboard payout');
  assert.equal(new Set(rows.map((k) => k.seat)).size, 7, 'every seat keeps the winner\'s output under its key');
  const fetcher = async (u) => { const key = /key=([0-9a-f]+)/.exec(u)[1];
    return new Response(JSON.stringify({ donations: rows.filter((k) => k.row.recipientPk === key).map((k) => ({ outpoint: k.row.outpoint, federationId: k.row.federationId, amountMsat: k.row.amountMsat, senderOnContract: false })) })); };
  const wallet = { got: 0n, refund: async (txid, outIdx, fields, secretHex) => {
    const f = JSON.parse(fields), c = w.fed.contracts.get(`${txid}:${outIdx}`);
    if (!c || c.spent) return JSON.stringify({ accepted: false, stored_before: null });
    if (c.key !== f.claimPk || BigInt(f.amountMsat) !== c.msat || toHex(refundKeyOf(schnorr.getPublicKey(fromHex(secretHex)))) !== c.key) return JSON.stringify({ accepted: false, stored_before: {}, error: 'not this key' });
    c.spent = true; wallet.got += c.msat; return JSON.stringify({ accepted: true, txid: 'f1'.repeat(32) }); } };
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const storage = mem(); storage.setItem('arena.player.seed', toHex(SEED));
  const curveC = { pointX: (s) => schnorr.getPublicKey(s) };
  const got = await collectZaps({ storage, keep: mem(), curve: curveC, clients: new Map([[FED, wallet]]), seats: ['https://s1.example', 'https://s2.example'], fetcher });
  assert.deepEqual([got.collected.length, got.totalMsat, wallet.got], [1, '1000000', 1000000n], 'the winner\'s 1,000 sat in its wallet');
});

test('over the 10 % cap the payout is SHORT for good: nothing is signed or paid', async () => {
  const w = world({ reserves: [10000000n, 10000000n] });     // 20,000 sat of reserves: 3,000 sat is over 10 %
  const out = await w.seats[0].api.round({ height: 600 });
  const r = out.find((x) => x.id === LB) || {};
  assert.equal(r.state, PAYOUT.SHORT);
  assert.match(r.why, /more than 10 % of the 20000 sat reserves/);
  assert.equal(w.fed.submits.length, 0);
});
