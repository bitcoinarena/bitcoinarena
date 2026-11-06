// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE PAYOUT, PAID ONCE (kanban #1174, keyed-payout.js): the record's states and its one transition function, against a tool that pays under a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyedPay, payoutStep, payoutOf, PAYOUT, runPayouts } from '../src/keyed-payout.js';

/** A tool with keyed pays: `lose` answers lost after paying; `reject` keys the guardians refused (nothing paid); `old` no key, no pay-sent. */
function tool({ lose = 0, reject = [], old = false } = {}) {
  const made = [], byKey = new Map();
  let lost = lose;
  return {
    made,
    pay: async (list, key) => {
      if (!old && byKey.has(key)) { const k = byKey.get(key); if (k.rejected) throw new Error(`the keyed payout ${key} was refused by the guardians`); return { txid: k.txid, payouts: [], again: true }; }
      if (!old && reject.includes(key)) { byKey.set(key, { rejected: true }); throw new Error('the guardians did not accept the payout transaction'); }
      const txid = `t${made.length + 1}`;
      made.push({ key: old ? null : key, list });
      if (!old) byKey.set(key, { txid });
      if (lost > 0) { lost--; throw new Error('no answer in 300 s'); }
      return { txid, payouts: [] };
    },
    paidBack: async (list, key) => {
      if (old) throw new Error('no mode pay-sent');
      const k = byKey.get(key);
      return !k ? { found: false } : k.rejected ? { found: false, rejected: true, why: 'refused' } : { found: true, txid: k.txid, payouts: [] };
    },
  };
}
const LIST = [{ key: '02' + 'aa'.repeat(32), msat: 1000n }, { key: '02' + 'bb'.repeat(32), msat: 2000n }];

test('kanban #1174: the payout record moves only NONE -> ASKED -> PAID; ASKED is saved before the tool is called; PAID goes nowhere', async () => {
  const rec = {};
  assert.equal(payoutOf(rec), PAYOUT.NONE);
  assert.equal(payoutStep(rec, PAYOUT.PAID), false, 'never PAID without ASKED');
  const t = tool();
  let savedAt = null;
  const r = await keyedPay({ rec, save: () => { savedAt = t.made.length; }, list: LIST, key: 'k1', pay: t.pay, paidBack: t.paidBack });
  assert.equal(savedAt, 0, 'ASKED was saved before the tool paid');
  assert.deepEqual([r.ok, rec.step, rec.txid, t.made.length], [true, 'PAID', 't1', 1]);
  assert.equal(payoutStep(rec, PAYOUT.ASKED), false, 'PAID is final');
  const again = await keyedPay({ rec, save: () => {}, list: LIST, key: 'k1', pay: t.pay, paidBack: t.paidBack });
  assert.deepEqual([again.ok, again.again, t.made.length], [true, true, 1]);
});

test('kanban #1174: a lost answer is read back by its key; a refused one is paid under the next key; an old tool holds; the recorded list is the one paid', async () => {
  const facts = {};
  { const t = tool({ lose: 1 }); const rec = {};
    const a = await keyedPay({ rec, save: () => {}, list: LIST, key: 'k', pay: t.pay, paidBack: t.paidBack });
    // a later pass works out another list (what is owed moved): the recorded one is what was asked, and it is read back
    const b = await keyedPay({ rec, save: () => {}, list: [{ key: LIST[0].key, msat: 9n }], key: 'k', pay: t.pay, paidBack: t.paidBack });
    facts.lost = { first: a.ok, second: b.ok, readBack: !!rec.readBack, made: t.made.length, list: rec.list.map((x) => x.msat) }; }
  { const t = tool({ reject: ['k'] }); const rec = {};
    const a = await keyedPay({ rec, save: () => {}, list: LIST, key: 'k', pay: t.pay, paidBack: t.paidBack });
    const b = await keyedPay({ rec, save: () => {}, list: LIST, key: 'k', pay: t.pay, paidBack: t.paidBack });
    facts.refused = { first: a.ok, second: b.ok, key: rec.key, made: t.made.map((x) => x.key) }; }
  { const t = tool({ lose: 1, old: true }); const rec = {};
    const a = await keyedPay({ rec, save: () => {}, list: LIST, key: 'k', pay: t.pay, paidBack: t.paidBack });
    const b = await keyedPay({ rec, save: () => {}, list: LIST, key: 'k', pay: t.pay, paidBack: t.paidBack });
    facts.oldTool = { first: a.ok, second: b.ok, held: !!b.held, step: rec.step, made: t.made.length }; }
  console.log('  MEASURED #1174 keyedPay:', JSON.stringify(facts));
  assert.deepEqual(facts.lost, { first: false, second: true, readBack: true, made: 1, list: ['1000', '2000'] });
  assert.deepEqual(facts.refused, { first: false, second: true, key: 'k#1', made: ['k#1'] });
  assert.deepEqual(facts.oldTool, { first: false, second: false, held: true, step: 'ASKED', made: 1 });
});

test('kanban #1174: runPayouts speaks the tool: pay with --key, pay-sent read back, and a tool without pay-sent throws', async () => {
  const seen = [];
  const run = async (args) => { seen.push(args.join(' '));
    if (args[1] === 'pay') return { txid: 'x', payouts: [{ refund_pk: LIST[0].key, out_idx: 0 }] };
    if (args[1] === 'pay-sent') return { mode: 'pay-sent', key: args.at(-1), found: true, txid: 'x', payouts: [] };
    return {}; };
  const p = runPayouts(run);
  assert.equal((await p.pay(LIST, 'kk')).txid, 'x');
  assert.deepEqual(await p.paidBack(LIST, 'kk'), { found: true, rejected: false, txid: 'x', payouts: [], why: null });
  assert.deepEqual(seen, [`--mode pay --payouts ${LIST[0].key}:1000,${LIST[1].key}:2000 --key kk`, `--mode pay-sent --payouts ${LIST[0].key}:1000,${LIST[1].key}:2000 --key kk`]);
  await assert.rejects(runPayouts(async () => ({ error: 'no mode pay-sent: lock, ...' })).paidBack(LIST, 'kk'), /no mode pay-sent/);
});
