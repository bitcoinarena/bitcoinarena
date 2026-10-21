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
  assert.match(renderToStaticMarkup(React.createElement(BondPanel, { initial: { loaded: true, bond: { network: 'testnet4' } } })), /No bond yet/);
  assert.deepEqual([daysHours(90 * 60000), daysHours(5 * 60000), lockText({ withdrawable: true })], ['1 h 30 min', '5 min', 'unlocked']);
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
