// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BOND AS AN OFFER AND THE CAPACITY PLEA IN REACT (kanban #564; the cases were the page's owner-standing-page, kanban #553 / #543):
// "Earn up to N× more", the sat to send worked out from the wallet and the fees, its address and QR, one button with the plan shown before
// it is posted; nothing to earn: no offer; a bond below what rounds ask: red with the amount; the plea's words, nothing while calm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BondAnswer, CapacityPlea, bondAnswerOf, daysHours } from '../dist/test/bond-offer.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));
const enough = { ownBondSats: '50000', commonBondMinSats: '50000', warnings: [] };
const m = { federation: '337ae01ad1e9bb35' + '0'.repeat(48), band: 'FULL', load: 4.333, guardians: 7, bondSats: '50000', targetBondSats: '433334', addSats: '383334', now: 1 / 7, ifRaised: 0.926 };
const bond = { bond: { sats: '50000' }, wallet: { spendableSats: '16004', confirmingSats: '0', addOverheadSats: '4830' } };
function answer(props) {
  const calls = { needs: [], planned: [], added: [] };
  const a = new BondAnswer({ qr: () => '<svg data-qr=""/>', address: async () => ({ address: 'tb1ptopup' }),
    plan: async (s) => { calls.planned.push(s); return { bondSats: '50000', totalSats: '433334', addSats: String(s), fees: { total: 900 }, maturity: 158000, lock: { estimatedMs: Date.now() + 26 * 3600000 } }; },
    add: async (s) => { calls.added.push(s); return { bond: { txid: 'ab'.repeat(32) } }; }, onNeed: (...x) => calls.needs.push(x), ...props });
  a.setState = (u) => Object.assign(a.state, typeof u === 'function' ? u(a.state) : u);
  return { a, calls, html: () => renderToStaticMarkup(React.createElement(React.Fragment, null, a.render())) };
}

test('the offer: "Earn up to 6.5× more", the sat to send, its address and QR, one button; an offer, never red', async () => {
  const o = answer({ standing: enough, capacity: { ok: true, plea: null, mine: [m] }, bond });
  o.a.componentDidMount(); await tick(); await tick();
  const h = o.html();
  assert.match(h, /<h3 class="offer">💰 Earn up to 6\.5× more<\/h3><p>Federation 337ae01a is 433 % full and pays guardians with bigger bonds more\. Optional\.<\/p>/);
  assert.match(h, /<li><b>Send 372,160 sat<\/b> to your bond wallet/, '383,334 + 4,830 - 16,004');
  assert.match(h, /<code>tb1ptopup<\/code>.*<svg data-qr=""\/>.*Your bond wallet has 16,004 sat\. This adds the rest and about 4,830 sat for fees\./);
  assert.match(h, /<button type="button" class="primary" id="ab-go" disabled="">Add 383,334 sat to my bond<\/button><span class="sub"> - once the coins have arrived<\/span>/);
  assert.match(h, /<p class="ok">✓ Your bond is enough: this node is drawn for rounds\.<\/p>$/);
  assert.deepEqual(o.calls.needs, [['earn', 'warn', 'Earn up to 6.5× more from Federation 337ae01a: add 383,334 sat to your bond.']]);
});

test('a wallet with enough: no send step, the button on, the plan shown, then posted', async () => {
  const o = answer({ standing: enough, capacity: { mine: [m] }, bond: { ...bond, wallet: { ...bond.wallet, spendableSats: '400000' } } });
  o.a.componentDidMount();
  assert.match(o.html(), /<li class="ok">✓ Your bond wallet has enough\.<\/li><li><button type="button" class="primary" id="ab-go">Add 383,334 sat/);
  await o.a.plan(383334);
  assert.match(o.html(), /<div class="warn">Bond 50,000 → <b>433,334 sat<\/b> · fees 900 sat · locked until block 158000 \(about 1 day 2 h\) · counts in about an hour<\/div><button type="button" class="primary" id="ab-post">Confirm<\/button>/);
  await o.a.confirm(383334);
  assert.deepEqual([o.calls.planned, o.calls.added], [[383334], [383334]]);
  assert.match(o.html(), /<p class="ok"><b>Done ✓<\/b> 383,334 sat added \(<code>abababababababab…<\/code>\)\. It counts in about an hour\.<\/p>/);
  assert.match(o.html(), /id="ab-go" disabled="">/);
});

test('nothing to earn: no offer; a bond below what rounds ask: red with the amount and on the Overview', () => {
  const calm = answer({ standing: enough, capacity: { mine: [{ ...m, band: 'CALM', load: 0.4 }] }, bond });
  assert.match(calm.html(), /^<h3>Your bond<\/h3><p class="ok">✓ Your bond is enough.*No federation you guard pays extra/);
  const low = answer({ standing: { ownBondSats: '20000', commonBondMinSats: '50000', warnings: [{ kind: 'losing brackets' }] }, capacity: null, bond: null });
  low.a.componentDidMount();
  assert.match(low.html(), /<p class="err">⚠ Your bond is below what most rounds ask \(50,000 sat\): add 30,000 sat to be drawn again\.<\/p>/);
  assert.deepEqual(low.calls.needs, [['bond', 'bad', 'Your bond is too small to be drawn for rounds. Add 30,000 sat.']]);
  assert.equal(bondAnswerOf({ standing: { ownBondSats: null }, capacity: null, bond: null }).drawn.text, 'Your bond is not counted yet: this node is not drawn for rounds until it is.');
  assert.deepEqual([daysHours(26 * 3600000), daysHours(5 * 3600000)], ['1 day 2 h', '5 h']);
});

test('the capacity plea: the seat\'s words when a federation fills; nothing when calm or carried by the offer', () => {
  const h = renderToStaticMarkup(React.createElement(CapacityPlea, { capacity: { ok: true, plea: { addSats: '36667', says: 'Federation aaaaaaaa holds 87 % of what its bonds cover (PRESSURE). Increase your bond by 36,667 sat (Add to bond) to bring it to 86,667 sat.' } } }));
  assert.match(h, /^<div class="card"><h3>A federation you guard is filling up<\/h3><p class="warnline">Federation aaaaaaaa holds 87 %.*Increase your bond by 36,667 sat \(Add to bond\)/);
  assert.match(h, /take more deposits/);
  for (const capacity of [null, { ok: true }, { ok: true, plea: null }, { plea: { says: 'x' }, mine: [m] }]) assert.equal(renderToStaticMarkup(React.createElement(CapacityPlea, { capacity })), '');
});
