// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LEADERBOARD PAYOUT ON SIGNED ACCOUNTS (kanban #1153, critical). Seven guardian seats pay the top 3 of a season from the federation's
// reserves. THE SCENARIO: three colluding bonded seats hand every guardian byte-identical accounts of an invented round in which their
// identity X wins 90,000 sat. Before, three identical unsigned accounts counted (SEASON_NETWORK_AGREE) and X was paid first. Now a round
// counts only when the threshold of its own draw signed its account, the winners are frozen once per payout and persisted at every
// co-signer before it commits, and every co-signer persists the same list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.js';
import { createReservePayouts, PAYOUT } from '../src/reserve-payout.js';
import { createWinnersBook, winnersStep, WINNERS, WINNERS_EVENT, FREEZE_GRACE_MS } from '../src/leaderboard-freeze.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { mergeSeasonAccounts, SEASON_NETWORK_AGREE } from '../../arena-protocol/src/season.js';
import { leaderboardWinners } from '../../arena-protocol/src/leaderboard-winners.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { contractRound, seatAnswer, drawOf } from './signed-season-fixture.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const h = (n) => n.toString(16).padStart(2, '0').repeat(32);
const GAME = h(0x9a);
const T0 = Date.UTC(2026, 9, 10);
const S = 100000n;
const en = (player, payoutMsat, roundKey) => ({ player, roundKey, name: null, stakeMsat: S, payoutMsat, outcome: payoutMsat > S ? DELIVERED : FAILED, score: 1 });
const [A, B, C, D, X] = [0x0a, 0x0b, 0x0c, 0x0d, 0x0e].map(h);
const R1 = contractRound({ gameId: GAME, startMs: T0 + 3600000, n: 1, entries: [en(A, 3n * S, h(0xa1)), en(B, 0n, h(0xb1)), en(C, 0n, h(0xc1))] });
const R2 = contractRound({ gameId: GAME, startMs: T0 + 7200000, n: 2, entries: [en(C, 2n * S, h(0xc2)), en(D, 0n, h(0xd2))] });
const R3 = contractRound({ gameId: GAME, startMs: T0 + 8000000, n: 4, entries: [en(D, 9n * S, h(0xd4)), en(B, 0n, h(0xb4))] });
const FAKE = contractRound({ gameId: GAME, startMs: T0 + 9000000, n: 3, entries: [en(X, 900n * S, h(0xe1)), en(D, 0n, h(0xd3))] });
const SEASON = { games: [GAME], fromMs: T0, toMs: T0 + 7 * 86400000, top: 3, amountMsat: 3000000n, splitBps: [] };
const DUE_MS = SEASON.toMs + FREEZE_GRACE_MS;
// THE DRAWS EVERY GUARDIAN COMPUTES: honest rounds on seats 1-9; the invented one on the colluders 11-13 and six others
const DRAW = drawOf(new Map([[FAKE.roundId, [11, 12, 13, 1, 2, 3, 4, 5, 6]]]), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
const COLLUDERS = (rounds) => [11, 12, 13].map((n) => [`colluder-${n}`, seatAnswer(n, [...rounds, FAKE])]);
const HONEST = (rounds, seats = [1, 2, 3, 4, 5]) => seats.map((n) => [`seat-${n}`, seatAnswer(n, rounds)]);

const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));
const G = evenGroupSecret(0x7654321n, curve);
const DEAL = trustedDealerSplit({ secret: G.secret, max: 7, min: 5, coefficients: [3n, 5n, 7n, 11n], curve });
const KEY = DEAL.groupPublicKey;
const NODE_KEYS = Array.from({ length: 7 }, (_, i) => toHex(schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i + 1 : 8))))).sort();
// each seat's node key signs the payout records it hands on (kanban #1156)
const SECRET_OF = new Map(Array.from({ length: 7 }, (_, i) => { const sk = Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i + 1 : 8)); return [toHex(schnorr.getPublicKey(sk)), sk]; }));
const FEES = { ppm: 100n, baseMsat: 1000n };
const FED = 'b1'.repeat(32);
const LB = 'cc'.repeat(32);

/** Seven guardian seats; `views(i)` what seat i's collect gets from the network (a Map of answers). */
function world(views, { clock = { now: DUE_MS } } = {}) {
  const fed = { contracts: new Map(), submits: [], atSubmit: [] };
  const reserveRows = [20000000n, 20000000n].map((m, i) => ({ outpoint: `${String(i + 1).padStart(2, '0').repeat(32)}:0`, amountMsat: String(m), verifiedMs: i + 1 }));
  for (const r of reserveRows) fed.contracts.set(r.outpoint, { key: toHex(KEY), msat: BigInt(r.amountMsat), spent: false });
  const msgOf = (o) => sha256(new TextEncoder().encode(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v))));
  const seats = [];
  const chain = { tip: null };
  const port = {
    fees: async () => FEES,
    status: async (at) => { const c = fed.contracts.get(`${toHex(at.txid)}:${at.outIdx}`); return { blockCount: 0, stored: c && !c.spent ? { contractId: 'c', blocksLeft: 0 } : null }; },
    settle: async ({ claimPk, refunds, payouts, nonce, signature = null }) => {
      const message = msgOf({ k: claimPk, r: refunds.map((x) => [toHex(x.outpoint.txid), String(x.outpoint.outIdx), x.amountMsat]), p: payouts, n: nonce });
      if (!signature) return { message: toHex(message) };
      if (!schnorr.verify(signature, message, claimPk.subarray(1))) return { accepted: false, error: 'the signature does not verify' };
      // THE IRREVERSIBLE STEP: what every seat holds persisted at this moment
      fed.atSubmit.push(seats.map((s) => ({ winners: s.book.stateOf(LB), payout: (s.api.stateOf(LB) || {}).state || null, list: s.book.recordOf(LB).winnersId || null })));
      for (const x of refunds) { const c = fed.contracts.get(`${toHex(x.outpoint.txid)}:${x.outpoint.outIdx}`); if (!c || c.spent) return { accepted: false, error: 'an input is not spendable' }; }
      for (const x of refunds) fed.contracts.get(`${toHex(x.outpoint.txid)}:${x.outpoint.outIdx}`).spent = true;
      const txid = toHex(message);
      fed.submits.push({ txid, payouts: payouts.map((p) => [toHex(p.payoutPk), p.msat]) });
      return { txid, accepted: true };
    },
  };
  const due = [{ id: LB, federation: FED, amountSats: 3000n, paymentHeight: 600, decidableAt: 520 }];
  for (let i = 0; i < 7; i++) {
    const s = { inbox: [], collects: 0 };
    const db = openStore(':memory:');
    s.book = createWinnersBook({ db, paramsOf: async () => ({ ok: true, ...SEASON }), collect: async () => { s.collects++; return new Map(views(i)); },
      seatsOf: DRAW, verify, now: () => clock.now });
    s.api = createReservePayouts({ db, me: NODE_KEYS[i], heightNow: () => chain.tip, curve, random: rand, network: 'testnet4', passed: () => [], leaderboards: () => due, winners: s.book, sign: (d) => schnorr.sign(d, SECRET_OF.get(NODE_KEYS[i])),
      reserveRows: () => reserveRows, portOf: async () => port, payRequest: async () => ({ ok: false }), invoiceFor: async () => ({ ok: false }),
      broadcast: (rec) => { for (const o of seats) if (o !== s) o.inbox.push(rec); },
      guardians: () => new Map([[FED, { members: NODE_KEYS, key: KEY, needed: 5, signer: { id: i + 1, share: DEAL.shares[i].share },
        peers: seats.filter((o) => o !== s).map((o) => ({ commit: (b) => o.api.commit(b), share: (b) => o.api.share(b), winners: async (id) => o.book.recordOf(id) })) }]]) });
    // ONE CHAIN (kanban #1159): every seat reads the height the last pass ran at, as a seat reads its tip
    { const pass = s.api.round; s.api.round = (o = {}) => { chain.tip = o.height; return pass(o); }; }
    seats.push(s);
  }
  const deliver = async () => { for (const s of seats) { while (s.inbox.length) await s.api.learn(s.inbox.shift()); } };
  return { fed, seats, deliver, clock };
}
const paidTo = (w) => w.fed.submits[0].payouts.slice(0, -1).map(([k, msat]) => [k, String(msat)]);
const keyOf = (p) => toHex(refundKeyOf(fromHex(p)));

test('the scenario, old rule: three colluding seats\' identical invented rounds put X first in the payout', () => {
  // EXACTLY WHAT server.js leaderboardWinnersOf DID: every seat's accounts merged by SEASON_NETWORK_AGREE identical, then the top 3
  const unsigned = (rounds) => rounds.map(({ contract, sigs, ...r }) => r);
  const bySeat = new Map([['me', unsigned(seatAnswer(1, [R1, R2]))], ...COLLUDERS([R1, R2]).map(([k, v]) => [k, unsigned(v)])]);
  const m = mergeSeasonAccounts(bySeat, { agree: SEASON_NETWORK_AGREE, keys: true });
  const w = leaderboardWinners({ ...SEASON, rounds: m.rounds });
  assert.deepEqual(w.winners.map((x) => x.player), [X, A, C], 'X, who played no round, takes place 1');
});

test('the scenario, new rule: the colluders\' invented round is not counted, X is paid nothing, the honest top 3 are paid', async () => {
  const w = world(() => [...HONEST([R1, R2]), ...COLLUDERS([R1, R2])]);
  const out = await w.seats[0].api.round({ height: 600 });
  const r = out.find((x) => x.id === LB);
  assert.deepEqual([r.ok, r.state], [true, PAYOUT.PAID], r.why);
  assert.equal(w.fed.submits.length, 1);
  // A +2S, C 0, B and D -S sharing place 3
  assert.deepEqual(paidTo(w), [[keyOf(A), '1000000'], [keyOf(C), '1000000'], [keyOf(B), '500000'], [keyOf(D), '500000']]);
  assert.ok(!paidTo(w).some(([k]) => k === keyOf(X)), 'X is paid nothing');
  const own = w.seats[0].book.recordOf(LB);
  assert.equal(own.pairs.length, 2, 'two signed rounds, the invented one not among them');
});

test('nothing irreversible before its state is persisted: at the transaction every signer holds the same winners list PLANNED', async () => {
  const w = world(() => [...HONEST([R1, R2]), ...COLLUDERS([R1, R2])]);
  await w.seats[0].api.round({ height: 600 });
  assert.equal(w.fed.atSubmit.length, 1);
  const at = w.fed.atSubmit[0];
  const planned = at.filter((x) => x.winners === WINNERS.PLANNED);
  assert.ok(planned.length >= 5, `${planned.length} seats held the list PLANNED when the transaction went in`);
  // the co-signers hold the payout PLANNED; the coordinator SUBMITTING - its signed transaction kept before it went in (kanban #1159)
  assert.equal(at[0].payout, PAYOUT.SUBMITTING, 'the coordinator kept the signed transaction first');
  assert.ok(planned.every((x) => x.payout === PAYOUT.PLANNED || x.payout === PAYOUT.SUBMITTING), 'and the payout PLANNED');
  assert.equal(new Set(planned.map((x) => x.list)).size, 1, 'the same list at every co-signer');
});

test('frozen once: a round signed after the freeze changes no list; the seats are not asked again', async () => {
  let rounds = [R1, R2];
  const w = world(() => HONEST(rounds));
  for (const s of w.seats) assert.equal((await s.book.freeze(LB)).ok, true);
  rounds = [R1, R2, R3];                         // D's big win of R3, signed by five of its seats, arrives after every seat froze
  await w.seats[0].api.round({ height: 600 });
  assert.deepEqual(paidTo(w).map(([k]) => k), [keyOf(A), keyOf(C), keyOf(B), keyOf(D)], 'R3 is not on the list');
  assert.ok(w.seats.every((s) => s.collects === 1), 'each seat read the season once');
  // before the window has closed FREEZE_GRACE_MS ago, nothing is read at all
  const early = world(() => HONEST([R1, R2]), { clock: { now: DUE_MS - 1 } });
  const f = await early.seats[0].book.freeze(LB);
  assert.equal(f.ok, false);
  assert.match(f.why, /read 135 min after/);
  assert.equal(early.seats[0].collects, 0);
});

test('the same list at every co-signer: a seat that missed a round takes it from the plan\'s evidence; a plan that leaves out a round is refused', async () => {
  // seat 3 (NODE_KEYS[3]) heard only three of R2's seats: R2 does not stand in its own read
  const view = (i) => (i === 3 ? [...HONEST([R1, R2], [1, 2, 3]), ...HONEST([R1], [4, 5])] : HONEST([R1, R2]));
  const w = world(view);
  await w.seats[3].book.freeze(LB);
  assert.equal(w.seats[3].book.recordOf(LB).pairs.length, 1, 'R2 is not in seat 3\'s frozen read');
  await w.seats[0].api.round({ height: 600 });
  await w.deliver();
  assert.equal(w.fed.submits.length, 1);
  const lists = w.seats.map((s) => s.book.recordOf(LB));
  assert.ok(lists.every((x) => x.state === WINNERS.PLANNED), lists.map((x) => x.state).join());
  assert.equal(new Set(lists.map((x) => x.winnersId)).size, 1, 'all seven hold the same list');
  assert.equal(lists[3].pairs.length, 2, 'seat 3 took R2 on the evidence it checked');

  // A COORDINATOR THAT LEAVES R2 OUT (to move B and D up): a seat whose own read counts R2 refuses it
  const v = world(() => HONEST([R1, R2]));
  const plan = (await v.seats[1].book.freeze(LB)).record;
  assert.equal(plan.state, WINNERS.FROZEN);
  const onlyR1 = await createWinnersBook({ db: openStore(':memory:'), paramsOf: async () => ({ ok: true, ...SEASON }), collect: async () => new Map(HONEST([R1])),
    seatsOf: DRAW, verify, now: () => DUE_MS }).union(LB, []);
  const st = await v.seats[1].book.check(LB, { winners: onlyR1.winners, rounds: onlyR1.pairs, winnersId: onlyR1.winnersId });
  assert.equal(st.ok, false);
  assert.match(st.why, /leaves out round .* which this seat counts/);
  // AND ONE THAT ADDS A ROUND IT CANNOT PROVE: refused
  const withFake = { winners: [{ player: X, payoutPk: keyOf(X), msat: '3000000' }], rounds: [...plan.own.pairs, [FAKE.roundId, '00'.repeat(32)]] };
  const st2 = await v.seats[1].book.check(LB, { ...withFake, winnersId: (await import('../src/leaderboard-freeze.js')).winnersIdOf(LB, withFake.winners, withFake.rounds) });
  assert.match(st2.why, /does not stand on evidence this seat checked/);
});

test('one enum, one transition function: OPEN -> FROZEN -> PLANNED, nothing else', () => {
  assert.deepEqual(winnersStep(WINNERS.OPEN, WINNERS_EVENT.FREEZE), { ok: true, to: WINNERS.FROZEN });
  assert.deepEqual(winnersStep(WINNERS.FROZEN, WINNERS_EVENT.PLAN), { ok: true, to: WINNERS.PLANNED });
  assert.deepEqual(winnersStep(WINNERS.PLANNED, WINNERS_EVENT.PLAN, { same: true }), { ok: true, to: WINNERS.PLANNED });
  assert.match(winnersStep(WINNERS.FROZEN, WINNERS_EVENT.FREEZE).why, /read once/);
  assert.match(winnersStep(WINNERS.PLANNED, WINNERS_EVENT.FREEZE).why, /read once/);
  assert.match(winnersStep(WINNERS.OPEN, WINNERS_EVENT.PLAN).why, /not read the season yet/);
  assert.match(winnersStep(WINNERS.PLANNED, WINNERS_EVENT.PLAN).why, /one list per payout/);
  assert.equal(winnersStep('PAID', WINNERS_EVENT.PLAN).ok, false);
});
