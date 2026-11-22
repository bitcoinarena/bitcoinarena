// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MOVE WINDOW (kanban #598): From - the federations holding funds, the fullest first -, To - every other that takes deposits -, the amount
// filled with all that From can send; a move of all of it sends null (exactly all), an edited amount its msat; one over what From can send
// is refused before anything is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MovePanel, moveAmountCheck } from '../dist/test/move.mjs';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const feds = [{ id: B, label: 'Federation bbbbbbbb', sats: 996, from: true, to: true }, { id: A, label: 'Federation aaaaaaaa', sats: 2199, from: true, to: true },
  { id: C, label: 'Federation cccccccc (draining)', sats: 0, from: false, to: false }];
const panel = (props) => { const p = new MovePanel(props); p.setState = (u) => Object.assign(p.state, typeof u === 'function' ? u(p.state) : u); return p; };
const html = (p) => renderToStaticMarkup(React.createElement(React.Fragment, null, p.render()));

test('From is the fullest federation, To another open one, the amount all From can send', async () => {
  const p = panel({ feds, canOf: async (id) => (id === A ? 2190500n : 990000n), move: async () => ({ ok: true }) });
  assert.deepEqual([p.state.from, p.state.to], [A, B]);
  await p.read(A);
  assert.equal(p.state.amount, '2190');
  const h = html(p);
  assert.match(h, /<select id="arena-mv-from"[^>]*><option value="a{64}"[^>]*>Federation aaaaaaaa · 2,199 sat<\/option><option value="b{64}">Federation bbbbbbbb · 996 sat<\/option><\/select>/);
  assert.doesNotMatch(h, /cccccccc/, 'a federation that takes no deposit is offered');
  assert.match(h, /All it can send after the fees: 2,190 sat\./);
  assert.match(h, /<button type="button" id="arena-mv-go">Move 2,190 sat<\/button>/);
});

test('all of it is moved as null (exactly all); an edited amount as its msat; too much refused before the move', async () => {
  const asked = [];
  const p = panel({ feds, canOf: async () => 2190500n, move: async (m) => { asked.push(m.amountMsat); return { ok: true, movedMsat: m.amountMsat ?? 2190500n, feeMsat: 1000n }; } });
  await p.read(A);
  await p.go();
  assert.deepEqual(asked, [null]);
  assert.match(p.state.status.words, /^Moved 2,190 sat from federation aaaaaaaa to federation bbbbbbbb \(fee 1 sat\)\.$/);
  await p.read(A); p.set({ amount: '500', edited: true }); await p.go();
  assert.deepEqual(asked, [null, 500000n]);
  await p.read(A); p.set({ amount: '3000', edited: true }); await p.go();
  assert.equal(asked.length, 2, 'a move over what it can send was asked');
  assert.match(p.state.status.words, /can send 2,190 sat after the fees/);
});

test('nothing held anywhere: says so, offers no move', () => {
  assert.match(html(panel({ feds: [{ id: A, label: 'x', sats: 0, from: false, to: true }], canOf: async () => 0n, move: async () => ({}) })), /nothing to move/);
});

test('#2959 the Move amount is checked as typed: no sign, no letters, never above what can be sent', () => {
  const can = 3000000n;   // 3,000 sat
  assert.deepEqual(moveAmountCheck('-1', can), { ok: false, words: 'Enter a whole number of sat (digits only).' });
  assert.deepEqual(moveAmountCheck('abc', can), { ok: false, words: 'Enter a whole number of sat (digits only).' });
  assert.deepEqual(moveAmountCheck('', can), { ok: false, words: '' });
  assert.deepEqual(moveAmountCheck('0', can), { ok: false, words: 'A move is more than 0 sat.' });
  assert.deepEqual(moveAmountCheck('999999', can), { ok: false, words: 'At most 3,000 sat can be sent after the fees.' });
  assert.deepEqual(moveAmountCheck('3,000', can), { ok: true, sat: 3000, words: '' });
  assert.deepEqual(moveAmountCheck('1200', null), { ok: true, sat: 1200, words: '' });
});
