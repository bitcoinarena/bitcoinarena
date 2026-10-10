// THE DEV CLIENT IN THE OWNER AREA (kanban #276 step 3): what a seat verified for the protocol developers' set and for each
// hosted game's developer set - in msat, per round and per UTC day - through GET /owner/donations, read from the seat's own
// donation index (the rows settlements put there).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { donationTotals, donationReport } from '../src/owner-donations.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DAY1 = Date.parse('2026-10-09T23:59:00Z'), DAY2 = Date.parse('2026-10-10T00:01:00Z');

test('a recipient\'s rows add up to the msat: in all, per round, per UTC day', () => {
  const rows = [
    { roundId: 'aa', amountMsat: 1334, verifiedMs: DAY1 }, { roundId: 'aa', amountMsat: 400, verifiedMs: DAY1 + 1000 },
    { roundId: 'bb', amountMsat: 666, verifiedMs: DAY2 },
  ];
  const t = donationTotals(rows);
  assert.equal(t.totalMsat, '2400');
  assert.equal(t.donations, 3);
  assert.deepEqual(t.byRound.map((r) => [r.roundId, r.msat, r.donations]), [['bb', '666', 1], ['aa', '1734', 2]], 'newest round first');
  assert.deepEqual(t.byDay.map((d) => [d.day, d.msat]), [['2026-10-10', '666'], ['2026-10-09', '1734']], 'by UTC day, newest first');
  assert.equal(donationTotals([]).totalMsat, '0');
});

test('the report names the protocol set and every hosted game\'s set, each recipient with its own totals', () => {
  const keyA = '02' + 'a1'.repeat(32), keyB = '03' + 'b2'.repeat(32), keyG = '02' + 'c3'.repeat(32);
  const protocol = { networkId: b32(4), serial: 3, recipients: [{ recipientPk: Buffer.from(keyA, 'hex'), shareBps: 5000, label: 'dev a' }, { recipientPk: Buffer.from(keyB, 'hex'), shareBps: 5000, label: 'dev b' }] };
  const game = { name: 'rock-paper-scissors', title: 'Rock Paper Scissors', gameId: b32(7), donationSet: [{ recipientPk: Buffer.from(keyG, 'hex'), shareBps: 10000, label: 'rps dev' }] };
  const rows = { [keyA]: [{ roundId: 'aa', amountMsat: 500, verifiedMs: DAY2 }], [keyG]: [{ roundId: 'aa', amountMsat: 500, verifiedMs: DAY2 }, { roundId: 'bb', amountMsat: 250, verifiedMs: DAY2 }] };
  const r = donationReport({ protocolSets: [protocol], games: [game], rowsFor: (k) => rows[k] || [] });
  assert.equal(r.totalMsat, '1250');
  assert.deepEqual(r.sets.map((s) => [s.kind, s.title, s.recipients.map((x) => [x.label, x.totalMsat])]),
    [['protocol', 'Protocol developers', [['dev a', '500'], ['dev b', '0']]], ['game', 'Rock Paper Scissors', [['rps dev', '750']]]]);
});

test('GET /owner/donations on a running seat: the rows its settlements verified, per hosted game\'s developer', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, owner: { store: { read: () => null, write: () => {}, writeCode: () => {} } } });
  try {
    const game = [...HOSTED].find((g) => Array.isArray(g.donationSet) && g.donationSet.length);
    assert.ok(game, 'a hosted test game with a developer set');
    const pk = game.donationSet[0].recipientPk;
    node.round.putDonationOutputs([
      { outpoint: { txid: b32(8), outIdx: 1n }, entryId: b32(1), roundId: b32(2), federationId: b32(0xfe), recipientPk: Buffer.from(pk), amountMsat: 1334n, contractId: 'c0', verifiedMs: DAY2, senderOnContract: false },
      { outpoint: { txid: b32(8), outIdx: 2n }, entryId: b32(1), roundId: b32(2), federationId: b32(0xfe), recipientPk: Buffer.from(pk), amountMsat: 400n, contractId: 'c1', verifiedMs: DAY2, senderOnContract: false },
    ]);
    const r = await (await fetch(`http://127.0.0.1:${node.port}/owner/donations`)).json();
    const set = r.sets.find((s) => s.kind === 'game' && s.gameId === toHex(game.gameId));
    assert.ok(set, 'the hosted game\'s set is listed');
    const mine = set.recipients.find((x) => x.key === toHex(pk));
    assert.equal(mine.totalMsat, '1734');
    assert.deepEqual(mine.byRound.map((x) => [x.roundId, x.msat]), [[toHex(b32(2)), '1734']]);
    // the seat stamps a row with the time it verified it (round.js putDonationOutputs): the day is today's, in UTC
    assert.deepEqual(mine.byDay.map((x) => [x.day, x.msat]), [[new Date().toISOString().slice(0, 10), '1734']]);
  } finally { await node.close(); }
});
