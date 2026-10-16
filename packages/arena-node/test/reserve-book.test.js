// THE PROTOCOL RESERVES' BOOK (§27A.9.2, kanban #397 slice 4): GET /reserves' figures come from the seat's own rows under a
// federation's reserve key - the held total, the entries and the last payments in, newest first - and a row another seat
// listed is kept only once this seat's own federation port holds that payout contract to the reserve key for that amount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveFigures, verifyPeerReserveRow, RESERVES_LAST } from '../src/reserve-book.js';
import { donationContractFields } from '../src/stake-lock-signer-node.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { b32 } from './window-fixture.js';
import { joinedWithLock, CLAIM } from './lock-fixture.js';

const key = (prefix, fill) => Uint8Array.of(prefix, ...new Uint8Array(32).fill(fill));
const RESERVE_KEY = key(0x02, 0xc3);
const FED = toHex(b32(0xfe)), OTHER = toHex(b32(0xfd));
const at = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const idOf = (f) => [f.paymentImage.kind, toHex(f.paymentImage.bytes), f.amountMsat, toHex(f.claimPk), toHex(f.refundPk), f.expiration].join('|');
const federation = (held) => ({ held: new Map(Object.entries(held)),
  async status(o) { const id = this.held.get(at(o)); return { blockCount: 156800, stored: id ? { contractId: id, blocksLeft: 0 } : null }; },
  async contractId(f) { return idOf(f); } });
const row = (i, more = {}) => ({ outpoint: `${toHex(b32(0x10 + i))}:4`, roundId: toHex(b32(0x01)), entryId: toHex(b32(0x20 + i)), federationId: FED,
  amountMsat: '2000', verifiedMs: Date.UTC(2026, 9, 17, 1, i), senderOnContract: false, playerKey: null, ...more });

test('figures: the held total, the entries and the last payments in, newest first; another federation\'s rows not counted', () => {
  const rows = [row(0), row(1, { amountMsat: '3000' }), row(2, { federationId: OTHER })];
  const f = reserveFigures(rows, { federationId: FED, gameOf: (r) => (r === toHex(b32(0x01)) ? 'Rock Paper Scissors' : null) });
  assert.equal(f.heldMsat, '5000'); assert.equal(f.entries, 2);
  assert.deepEqual(f.paidIn.map((p) => [p.entryId.slice(0, 4), p.amountMsat, p.game]), [['2121', '3000', 'Rock Paper Scissors'], ['2020', '2000', 'Rock Paper Scissors']]);
  assert.equal(f.paidIn[0].at, '2026-10-17T01:01:00.000Z');
  const many = Array.from({ length: RESERVES_LAST + 5 }, (_, i) => row(i % 40, { verifiedMs: i }));
  assert.equal(reserveFigures(many, { federationId: FED }).paidIn.length, RESERVES_LAST);
  assert.equal(reserveFigures(many, { federationId: FED }).heldMsat, String(2000 * (RESERVES_LAST + 5)), 'the total counts every row, not only the listed');
  assert.equal(reserveFigures(many, { federationId: FED, last: Infinity }).paidIn.length, RESERVES_LAST + 5);
});

test('a peer\'s row is kept once the federation holds that contract to the reserve key; with the player key as image too', async () => {
  const r0 = row(0), r1 = row(1, { image: toHex(b32(0x77)) });
  const port = federation({ [r0.outpoint]: idOf(donationContractFields({ recipientPk: RESERVE_KEY, amountMsat: 2000n })),
    [r1.outpoint]: idOf(donationContractFields({ recipientPk: RESERVE_KEY, amountMsat: 2000n, image: b32(0x77) })) });
  const a = await verifyPeerReserveRow({ row: r0, port, reserveKey: RESERVE_KEY, federationId: b32(0xfe) });
  assert.equal(a.ok, true, a.why);
  assert.deepEqual([at(a.row.outpoint), a.row.amountMsat, toHex(a.row.recipientPk), a.row.senderOnContract], [r0.outpoint, 2000n, toHex(RESERVE_KEY), false]);
  const b = await verifyPeerReserveRow({ row: r1, port, reserveKey: RESERVE_KEY, federationId: b32(0xfe) });
  assert.equal(b.ok, true, b.why); assert.equal(b.row.senderOnContract, true); assert.equal(b.row.image, toHex(b32(0x77)));
});

test('a peer\'s row is not kept: nothing held, another amount, another key, no port, no key, no outpoint', async () => {
  const r = row(0);
  const held = (amountMsat, k = RESERVE_KEY) => federation({ [r.outpoint]: idOf(donationContractFields({ recipientPk: k, amountMsat })) });
  const cases = [
    ['nothing held', { port: federation({}) }, /holds nothing/],
    ['1,999 msat held, 2,000 listed', { port: held(1999n) }, /is not 2000 msat to the reserve key/],
    ['a listed amount above what is held', { port: held(2000n), row: { ...r, amountMsat: '20000' } }, /is not 20000 msat/],
    ['another key holds it', { port: held(2000n, key(0x03, 0xd4)) }, /is not 2000 msat to the reserve key/],
    ['no port', { port: null }, /no port/],
    ['no reserve key', { port: held(2000n), reserveKey: null }, /no reserve key/],
    ['no outpoint', { port: held(2000n), row: { ...r, outpoint: 'xyz' } }, /is no outpoint/],
    ['zero msat', { port: held(2000n), row: { ...r, amountMsat: '0' } }, /at least 1 msat/],
  ];
  for (const [name, more, why] of cases) {
    const v = await verifyPeerReserveRow({ row: r, reserveKey: RESERVE_KEY, federationId: b32(0xfe), ...more });
    assert.equal(v.ok, false, name); assert.match(v.why, why, `${name}: ${v.why}`);
  }
});

test('a row taken from a peer keeps its image: the seat holds no entry to read the player key from', async () => {
  const s = await joinedWithLock({ claimKeyFor: () => CLAIM });
  try {
    const port = federation({ [row(3).outpoint]: idOf(donationContractFields({ recipientPk: RESERVE_KEY, amountMsat: 2000n, image: b32(0x77) })) });
    const v = await verifyPeerReserveRow({ row: row(3, { image: toHex(b32(0x77)) }), port, reserveKey: RESERVE_KEY, federationId: b32(0xfe) });
    assert.equal(v.ok, true, v.why);
    s.d.round.putDonationOutputs([v.row]);
    const kept = s.d.round.donationsFor(toHex(RESERVE_KEY));
    assert.deepEqual(kept.map((x) => [x.outpoint, x.amountMsat, x.playerKey, x.senderOnContract]), [[row(3).outpoint, '2000', toHex(b32(0x77)), true]]);
    assert.equal(reserveFigures(kept, { federationId: FED }).paidIn[0].image, toHex(b32(0x77)), 'listed on with its image, so the next seat can check it too');
  } finally { await s.close(); }
});
