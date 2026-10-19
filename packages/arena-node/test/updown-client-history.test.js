// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// UP/DOWN'S ORDER HISTORY, AS ITS CLIENT SHOWS IT (the tests of - 2026-10-17: "also show closed orders with
// the history with how much you won or lost, and also show there if it's still pending (10 minute delay)"; "Don't forget past orders
// ... round (human readable name eg 18:45-19:00), result, stake, p/l"). The client's own <history> block, cut out of
// btc-updown/client/index.html as it ships and run here with no page: every state an order can be in, the 10-minute window
// counted down and then final, and the past orders kept in the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CLIENT = readFileSync(new URL('../../btc-updown/client/index.html', import.meta.url), 'utf8');
const from = CLIENT.indexOf('// <history>'), to = CLIENT.indexOf('// </history>');
assert.ok(from > 0 && to > from, 'the client has its <history> block');
const HISTORY = new Function(`${CLIENT.slice(from, to)}\nreturn HISTORY;`)();

const OUT = ['Up', 'Down'];
const CLOSE = Date.UTC(2026, 9, 17, 19, 0);                 // the 18:45–19:00 window
const FINAL_AT = CLOSE + 15000 + 600000;                    // attested 15 s after the close, final 10 min later
const order = (over = {}) => ({ round: 'r1', entry: 'e1', pick: 0, limitPrice: 60000, stakeMsat: 61000, entryCloseMs: CLOSE, ...over });
const line = (state, more = {}) => ({ kind: 'market', round: 'r1', entry: 'e1', pick: 0, state, text: state, ...more });
const view = (o, l, now) => {
  const r = HISTORY.resultOf(o, l, now);
  return { closed: HISTORY.isClosed(o, l), chip: r[1], amount: r[2], pnlMsat: r[4] };
};
const past = (o, l, now, kept = []) => HISTORY.merge(kept, HISTORY.isClosed(o, l) ? [{ o, l }] : [], now);
const row = (p, now) => ({ round: HISTORY.roundOf(p.closeMs), stake: Math.floor(p.stakeMsat / 1000), result: HISTORY.resultLine(p, OUT),
  pl: HISTORY.plLine(p), status: HISTORY.statusLine(p, now) });

test('the round reads as its window: 18:45–19:00 UTC', () => {
  assert.equal(HISTORY.roundOf(CLOSE), '18:45–19:00 UTC');
});

test('open: before the close, with the time left - not in the history', () => {
  const now = CLOSE - 125000;
  assert.deepEqual(view(order(), line('open'), now), { closed: false, chip: 'closes in 2:05', amount: '', pnlMsat: 0 });
  assert.deepEqual(past(order(), line('open'), now), []);
});

test('waiting: closed and no result yet, or a pick the seats\' table does not name yet (unknown) - it stays waiting, not in the history', () => {
  const now = CLOSE + 5000;
  for (const l of [undefined, line('waiting'), line('unknown')]) {
    assert.deepEqual(view(order(), l, now), { closed: false, chip: 'waiting for the result', amount: '', pnlMsat: 0 }, l ? l.state : 'no line');
    assert.deepEqual(past(order(), l, now), []);
  }
  assert.equal(view(order(), line('unverified'), now).chip, 'result unverified');
});

test('refunded ±0, and void the same; disputed refunded at expiry', () => {
  const now = CLOSE + 20000;
  for (const st of ['refunded', 'void']) {
    const l = line(st, { backMsat: '61000', final: false, finalAtMs: FINAL_AT });
    assert.deepEqual(view(order(), l, now), { closed: true, chip: 'refunded', amount: '±0', pnlMsat: 0 });
    assert.deepEqual(row(past(order(), l, now)[0], now), { round: '18:45–19:00 UTC', stake: 61, result: 'refunded', pl: '±0', status: 'pending · final in 9:55' });
  }
  assert.equal(view(order(), line('disputed'), now).chip, 'refunded at expiry');
});

test('cancelled: closed at once, ±0, and final at once', () => {
  const now = CLOSE - 300000;
  const o = order({ cancelled: true });
  assert.deepEqual(view(o, line('open'), now), { closed: true, chip: 'cancelled', amount: '', pnlMsat: 0 });
  assert.deepEqual(row(past(o, line('open'), now)[0], now), { round: '18:45–19:00 UTC', stake: 61, result: 'cancelled', pl: '±0', status: 'final' });
});

test('won while pending: +amount, the 10-minute window counted down, then final at the final time', () => {
  const l = line('won', { gainMsat: '60390', payoutMsat: '120780', final: false, finalAtMs: FINAL_AT });
  const at = (now) => row(past(order(), l, now)[0], now);
  assert.deepEqual(view(order(), l, CLOSE + 15000), { closed: true, chip: 'won', amount: '+60 sats', pnlMsat: 60390 });
  assert.deepEqual(at(CLOSE + 15000), { round: '18:45–19:00 UTC', stake: 61, result: 'Up won', pl: '+60 sats', status: 'pending · final in 10:00' });
  assert.equal(at(FINAL_AT - 61000).status, 'pending · final in 1:01');
  assert.equal(at(FINAL_AT - 1).status, 'pending · final in 0:01');
  assert.equal(at(FINAL_AT).status, 'final', 'final at the final time, by the clock');
  assert.equal(row(past(order(), { ...l, final: true }, CLOSE + 20000)[0], CLOSE + 20000).status, 'final', 'or when the seats say so');
});

test('lost while pending: −amount, the window counted down, then final; the result names the side that won', () => {
  const o = order({ entry: 'e2', pick: 1 });
  const l = line('lost', { entry: 'e2', pick: 1, lostMsat: '60390', final: false, finalAtMs: FINAL_AT });
  assert.deepEqual(view(o, l, CLOSE + 15000), { closed: true, chip: 'lost', amount: '−60 sats', pnlMsat: -60390 });
  assert.deepEqual(row(past(o, l, CLOSE + 15000)[0], CLOSE + 15000), { round: '18:45–19:00 UTC', stake: 61, result: 'Up won', pl: '−60 sats', status: 'pending · final in 10:00' });
  assert.equal(row(past(o, l, FINAL_AT + 5000)[0], FINAL_AT + 5000).status, 'final');
  assert.equal(HISTORY.plCls(past(o, l, FINAL_AT)[0]), 'lost');
});

test('a past order kept from before a reload: no live line any more, final once its time has passed', () => {
  const kept = [{ entry: 'e9', closeMs: CLOSE - 900000, side: 0, stakeMsat: 100000, limit: 60, state: 'won', pnlMsat: 39000, final: false, finalAtMs: FINAL_AT - 900000 }];
  const before = HISTORY.merge(kept, [], FINAL_AT - 900000 - 30000);
  assert.deepEqual(row(before[0], FINAL_AT - 900000 - 30000), { round: '18:30–18:45 UTC', stake: 100, result: 'Up won', pl: '+39 sats', status: 'pending · final in 0:30' });
  const after = HISTORY.merge(kept, [], FINAL_AT);
  assert.equal(row(after[0], FINAL_AT).status, 'final');
  assert.equal(HISTORY.isFinal(after[0], FINAL_AT), true);
});

test('a live line overrides the kept summary of the same order', () => {
  const kept = [{ entry: 'e1', closeMs: CLOSE, side: 0, stakeMsat: 61000, limit: 60, state: 'refunded', pnlMsat: 0, final: false, finalAtMs: FINAL_AT }];
  const l = line('won', { gainMsat: '60390', final: true, finalAtMs: FINAL_AT });
  const got = HISTORY.merge(kept, [{ o: order(), l }], FINAL_AT + 1);
  assert.equal(got.length, 1);
  assert.deepEqual(row(got[0], FINAL_AT + 1), { round: '18:45–19:00 UTC', stake: 61, result: 'Up won', pl: '+60 sats', status: 'final' });
});

test('newest round first, at most 200 kept', () => {
  const kept = Array.from({ length: 230 }, (_, i) => ({ entry: 'k' + String(i).padStart(3, '0'), closeMs: CLOSE - i * 900000, side: i % 2, stakeMsat: 1000, limit: 50,
    state: i % 2 ? 'lost' : 'won', pnlMsat: i % 2 ? -1000 : 1000, final: true }));
  const got = HISTORY.merge(kept.slice().reverse(), [], CLOSE);
  assert.equal(HISTORY.MAX, 200);
  assert.equal(got.length, 200);
  assert.equal(got[0].entry, 'k000');
  assert.equal(got[199].entry, 'k199');
  assert.ok(got.every((p, i) => !i || got[i - 1].closeMs >= p.closeMs));
  // and junk in the browser's store is dropped, not shown
  assert.deepEqual(HISTORY.merge([null, 7, { closeMs: 1 }], [], CLOSE), []);
  assert.deepEqual(HISTORY.merge('not a list', [], CLOSE), []);
});
