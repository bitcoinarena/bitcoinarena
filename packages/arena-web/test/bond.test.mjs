// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BOND SCREEN IN REACT (kanban #564): the amount (in parts), the lock and its end, the bond wallet, the outputs; the withdrawal only
// once unlocked, asked with the owner's signature after a confirmation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BondPanel, daysHours, lockText } from '../dist/test/bond.mjs';

const T = 1_800_000_000_000;
const locked = { network: 'testnet4', total: '100000', bond: { txid: 'aa'.repeat(32), vout: 0, sats: '50000' }, outputs: [{ txid: 'aa'.repeat(32), vout: 0, sats: '50000' }, { txid: 'bb'.repeat(32), vout: 1, sats: '50000' }],
  lock: { withdrawable: false, blocksLeft: 251, estimatedMs: T + (3 * 24 + 4) * 3600000 }, wallet: { spendableSats: '312380' } };

test('what it shows: the bond in parts, locked with the blocks and time left, the wallet, the outputs; Withdraw off while locked', () => {
  const html = renderToStaticMarkup(React.createElement(BondPanel, { nowMs: () => T, initial: { loaded: true, bond: locked } }));
  // stat cards, as the overview (kanban #565): the amount and its parts, the lock, the wallet
  assert.match(html, /<div class="stat"><span>Bond<\/span><b>100,000 sat<\/b><small>in 2 parts on the chain<\/small><\/div>/);
  assert.match(html, /<span>Lock<\/span><b>Locked<\/b><small>251 blocks left · about 3 d 4 h<\/small>/);
  assert.match(html, /<span>Bond wallet<\/span><b>312,380 sat<\/b>/);
  assert.equal((html.match(/<td class="n">50,000 sat<\/td>/g) || []).length, 2, 'the outputs on the chain, one row each');
  assert.match(html, /<div class="withdraw off">[\s\S]*<button type="button" disabled="">Withdraw<\/button>/, 'withdrawing waits for the lock');
  assert.match(html, /<p class="bond-state ok" id="bond-state"[^>]*><span aria-hidden="true">✓ <\/span>Bond 100,000 sat, counts<\/p>/, 'the state on top, green (kanban #728)');
  assert.match(renderToStaticMarkup(React.createElement(BondPanel, { initial: { loaded: true, bond: { network: 'testnet4' } } })), /No bond: this node is not drawn for rounds/);
  assert.deepEqual([daysHours(90 * 60000), daysHours(5 * 60000), lockText({ withdrawable: true })], ['1 h 30 min', '5 min', 'unlocked']);
});

// THE FIRST BOND FROM THE OWNER AREA (kanban #728, 2026-10-27: "Du hast die Option es zu skippen und dann später einzurichten, was aber nicht
// geht - Bug"): red on top, the wallet's address and what to send, what arrived, Post once it is there - signed; then its confirmations
test('no bond: red on top, the address and the amount, what arrived, Post the bond once enough is there; then its confirmations', async () => {
  const plan = { address: 'tb1pfirstbond', bondSats: '50000', parts: { bond: 50000, fees: 2000 }, needSats: 52000, walletSats: 20000, confirmingSats: 20000,
    shortSats: 32000, enough: false, tip: 157800, lock: { estimatedMs: T + 30 * 86400000 }, countsAfter: 6 };
  const none = { network: 'testnet4', bond: null, oldBonds: [] };
  const draw = (initial) => renderToStaticMarkup(React.createElement(BondPanel, { nowMs: () => T, initial: { loaded: true, bond: none, ...initial } }));
  const waiting = draw({ first: plan });
  assert.match(waiting, /<p class="bond-state bad" id="bond-state"[^>]*><span aria-hidden="true">! <\/span>No bond: this node is not drawn for rounds<\/p>/);
  assert.match(waiting, /<b>Send 52,000 sat<\/b> to your node wallet \(bond 50,000 sat, the rest for fees\)/);
  assert.match(waiting, /<code id="first-bond-address">tb1pfirstbond<\/code>/);
  assert.match(waiting, /id="first-bond-arrived">20,000 of 52,000 sat arrived \(20,000 sat not confirmed yet\)/);
  // THE ADDRESS AS A QR TOO (kanban #728): a bitcoin: link with the amount, drawn by the page's QR helper
  const asked = [];
  const qrd = renderToStaticMarkup(React.createElement(BondPanel, { nowMs: () => T, qr: (t) => { asked.push(t); return '<svg data-qr="1"></svg>'; }, initial: { loaded: true, bond: none, first: plan } }));
  assert.deepEqual(asked, ['bitcoin:tb1pfirstbond?amount=0.00052000']);
  assert.match(qrd, /<div class="qr"><svg data-qr="1"><\/svg><\/div><div class="bar" role="progressbar"/);
  assert.match(waiting, /<button type="button" class="primary" disabled="">Post the bond<\/button>/, 'off until the coins are there');
  assert.doesNotMatch(waiting, /[Ff]ederation|founding/, 'no federation info without a bond');
  assert.match(draw({ first: { ...plan, walletSats: 52000, confirmingSats: 0, shortSats: 0, enough: true } }), /<button type="button" class="primary">Post the bond<\/button>/);
  assert.match(draw({ firstWhy: 'this node was not set up by the installer: its bond is posted where it runs' }), /Can&#x27;t set up the bond here: this node was not set up by the installer/);
  // posted, not counted yet: amber, its confirmations
  const sb = { txid: 'b0'.repeat(32), sats: '50000', seen: true, confirmations: 2, needed: 6, confirmBy: 157900 };
  const conf = draw({ setup: { ok: true, bond: sb } });
  assert.match(conf, /bond-state wait[\s\S]*Bond 50,000 sat posted, 2 of 6 confirmations/);
  assert.match(conf, /id="bond-confirming"[\s\S]*It counts at 6\./);
  assert.doesNotMatch(conf, /Post the bond/);
  // what it does: the plan asked (signed, post: false), and on Post the bond posted (signed, post: true), then read again
  const sent = [];
  let posted = false;
  const api = { get: async (p) => (p === '/owner/bond' ? none : { ok: true, bond: posted ? sb : null }), signed: async (a, args) => ({ a, args }),
    post: async (p, b) => { sent.push([p, b.a, b.args]); if (b.args.post) { posted = true; return { ok: true, bond: { txid: 'b0'.repeat(32), sats: '50000' } }; } return { ok: true, plan: { ...plan, enough: true, walletSats: 52000 } }; } };
  const c = new BondPanel({ api, confirm: () => true, everyMs: 3600000 });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.componentDidMount();
  assert.equal(c.state.first.enough, true);
  await c.postFirst();
  assert.deepEqual(sent, [['/owner/first-bond', 'first-bond', { post: false }], ['/owner/first-bond', 'first-bond', { post: true }]]);
  assert.equal(c.state.setup.bond.confirmations, 2, 'read again: the posted bond and its confirmations');
  c.componentWillUnmount();
});

test('what it does: unlocked, an address, confirmed - the withdrawal signed and sent; refused shown; no address asked for', async () => {
  const sent = [];
  const api = { get: async () => ({ ...locked, lock: { withdrawable: true } }), signed: async (a, args) => ({ a, args }),
    post: async (p, b) => { sent.push([p, b.a, b.args]); return { ok: true, txid: 'cc'.repeat(32), value: 99700 }; } };
  const c = new BondPanel({ api, confirm: () => true });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.componentDidMount();
  await c.withdraw();
  assert.equal(c.state.message, 'Type the address the bond goes to.');
  c.setState({ address: ' tb1qexample ' });
  await c.withdraw();
  assert.deepEqual(sent, [['/owner/bond-withdraw', 'bond-withdraw', { address: 'tb1qexample', feeRate: 2 }]]);
  assert.match(c.state.message, /^Sent: c{64} \(99,700 sat\)$/);
  const no = new BondPanel({ api, confirm: () => false }); no.setState = c.setState.bind(no); no.state.address = 'tb1q'; no.state.loaded = true;
  await no.withdraw(); assert.equal(sent.length, 1, 'not confirmed: nothing sent');
});

test('old bonds after a key switch (kanban #650): listed with their lock; an unlocked one taken back to an address, signed', async () => {
  const olds = [{ txid: 'dd'.repeat(32), vout: 1, sats: '50000', maturity: 157700, held: true, lock: { withdrawable: true, blocksLeft: 0 } },
    { txid: 'ee'.repeat(32), vout: 0, sats: '20000', maturity: 157900, held: true, lock: { withdrawable: false, blocksLeft: 200 } }];
  const html = renderToStaticMarkup(React.createElement(BondPanel, { nowMs: () => T, initial: { loaded: true, bond: { ...locked, oldBonds: olds } } }));
  assert.match(html, /id="old-bonds"[\s\S]*<b>50,000 sat<\/b> · unlocked[\s\S]*Take it back[\s\S]*<b>20,000 sat<\/b> · locked for 200 more blocks \(until block 157,900\)/);
  assert.equal((html.match(/Take it back/g) || []).length, 1, 'only the unlocked one');
  const sent = [];
  const api = { get: async () => ({ ...locked, oldBonds: olds }), signed: async (a, args) => ({ a, args }),
    post: async (p, b) => { sent.push([p, b.a, b.args]); return { ok: true, txid: 'cc'.repeat(32), value: 49738 }; } };
  const c = new BondPanel({ api, confirm: () => true });
  c.setState = (u) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); };
  await c.componentDidMount();
  const k = `${olds[0].txid}:1`;
  await c.takeBack(olds[0]);
  assert.equal(c.state.oldSaid[k], 'Type the address it goes to.');
  c.setState({ oldTo: { [k]: ' tb1qold ' } });
  await c.takeBack(olds[0]);
  assert.deepEqual(sent, [['/owner/old-bond-withdraw', 'old-bond-withdraw', { txid: olds[0].txid, vout: 1, address: 'tb1qold', feeRate: 2 }]]);
  assert.match(c.state.oldSaid[k], /^Sent: c{64} \(49,738 sat\)$/);
});
