// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DONATE BOX IN REACT (kanban #564): the same lines while the set and the balance are read (kanban #551), then the shares and the
// balance; an amount over what one federation holds is refused in words with Donate off; Donate asks to confirm, the second tap gives,
// the thanks and the balance read again; a refusal is said; Custom takes a typed amount by the page's rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DonateBox } from '../dist/test/donate.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));
function box({ bestSat = 3000n, setOk = true, give = async () => ({ ok: true, txid: 'ab'.repeat(32) }) } = {}) {
  const calls = { read: 0, give: [], closed: 0 };
  const m = new DonateBox({ who: 'the Bitcoin Arena protocol developers', choices: [1000, 5000, 21000],
    amountOf: (t) => (/^\d+$/.test(t.trim()) ? { ok: true, sat: Number(t) } : { ok: false, why: 'Whole sats only.' }),
    read: async () => { calls.read++; return { sharesLine: '', setOk, bestSat }; },
    give: async (sat) => { calls.give.push(sat); return give(sat); }, onClose: () => { calls.closed++; } });
  m.setState = (u) => Object.assign(m.state, typeof u === 'function' ? u(m.state) : u);
  return { m, calls, html: () => renderToStaticMarkup(m.render()) };
}

test('while reading: the same lines with placeholders; then the shares and the balance; no wallet says so', async () => {
  const b = box();
  const h = b.html();
  assert.match(h, /^<div class="box"><div class="top"><h3>Donate to the developers<\/h3><button type="button" class="x" aria-label="Close">×<\/button><\/div><p class="to">To the Bitcoin Arena protocol developers, in e-cash from your wallet\.<\/p><p class="split muted"><\/p>/);
  assert.match(h, /<button type="button" data-sat="1000" aria-pressed="false">1,000 sat<\/button>.*21,000 sat/);
  assert.match(h, /<p class="bal muted">Your wallet: … sat \(checking\)<\/p><div class="row"><button type="button" class="go primary" disabled="">Donate<\/button><\/div>/);
  await b.m.componentDidMount();
  // no developer's share in the box (kanban #672: only the owner area's Donations shows them)
  assert.match(b.html(), /<p class="split muted"><\/p>.*<p class="bal muted">Your wallet: 3,000 sat<\/p>/);
  assert.doesNotMatch(b.html(), /Shares|%/);
  const none = box({ bestSat: null });
  await none.m.componentDidMount();
  assert.match(none.html(), /<p class="bal muted">Open your wallet and deposit first\.<\/p>/);
});

test('over the balance: said, Donate off; Custom by the page\'s rule', async () => {
  const b = box();
  await b.m.componentDidMount();
  b.m.pick(5000);
  assert.match(b.html(), /aria-pressed="true">5,000 sat.*<button type="button" class="go primary" disabled="">Donate 5,000 sat<\/button>.*<p class="say bad" role="status">Your wallet holds 3,000 sat in one federation: that is the most you can give\.<\/p>/);
  b.m.typed('2x');
  assert.deepEqual([b.m.state.chosen, b.m.state.said, b.m.state.bad], [null, 'Whole sats only.', true]);
  b.m.typed('2100');
  assert.match(b.html(), /value="2100".*<button type="button" class="go primary">Donate 2,100 sat<\/button>/);
});

test('Donate asks to confirm, the second tap gives, then thanks and reads again; a refusal is said', async () => {
  const b = box();
  await b.m.componentDidMount();
  b.m.pick(1000);
  await b.m.go();
  assert.equal(b.calls.give.length, 0);
  assert.match(b.html(), />Confirm: give 1,000 sat<\/button>.*Tap again to send 1,000 sat to the Bitcoin Arena protocol developers\./);
  await b.m.go(); await tick();
  assert.deepEqual(b.calls.give, [1000]);
  assert.equal(b.calls.read, 2, 'the balance read again');
  assert.match(b.html(), />Donate<\/button>.*<p class="say" role="status">Thank you! 1,000 sat sent · transaction abababababab…<\/p>/);
  const no = box({ give: async () => ({ ok: false, step: 'seats', why: 'no seat kept it' }) });
  await no.m.componentDidMount();
  no.m.pick(1000); await no.m.go(); await no.m.go();
  assert.match(no.html(), /<button type="button" class="go primary">Donate 1,000 sat<\/button>.*<p class="say bad" role="status">Not sent \(seats\): no seat kept it<\/p>/);
  const nokey = box({ give: async () => ({ ok: false, tell: 'Open your wallet first.' }) });
  await nokey.m.componentDidMount();
  nokey.m.pick(1000); await nokey.m.go(); await nokey.m.go();
  assert.equal(nokey.m.state.said, 'Open your wallet first.');
});
