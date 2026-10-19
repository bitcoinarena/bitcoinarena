// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S LIQUIDITY CARD (§23A.10): the free coins against the deposit minimum - below it, no share - the channels
// given, and the top-up address; a node that is no provider is told how to become one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const a = HTML.indexOf('const LIQUIDITY_DEPOSIT');
const body = HTML.slice(a, HTML.indexOf('\n}\n', HTML.indexOf('async function liquidityPanel() {', a)) + 2);
const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
async function render(claim) {
  const el = { innerHTML: '' };
  const fetch = async () => ({ ok: !!claim, json: async () => claim });
  await new Function('$', 'at', 'fetch', 'esc', `${body}; return liquidityPanel;`)(() => el, (p) => `https://seat${p}`, fetch, esc)();
  return el.innerHTML;
}

test('a provider: free vs the deposit minimum, the channels it gave, the top-up address; below the minimum, no share said', async () => {
  const claim = { freeSats: '320000', depositAddress: 'tb1pdeposit', channels: [{ peer: '03' + 'aa'.repeat(32), capacitySats: '100000' }] };
  const low = await render(claim);
  assert.match(low, /Free for new channels<\/span><b>320,000 sat/); assert.match(low, /Deposit minimum \(free \+ channels given\)<\/span><b>500,000 sat/);
  assert.match(low, /earns no share of the liquidity pool<\/b> until it is topped up by 80,000 sat/, '320,000 free + 100,000 given: 80,000 short');
  assert.match(await render({ ...claim, freeSats: '496150' }), /Above the deposit minimum/, 'LND D after its first channel: 496,150 + 100,000 given');
  assert.match(low, /Channels given to new nodes<\/span><b>1 \(100,000 sat\)/); assert.match(low, /tb1pdeposit/);
  assert.match(await render(null), /no liquidity provider[\s\S]*Liquidity provider/);
  assert.ok(/liquidityPanel\(\);/.test(HTML) && HTML.includes('<div class="card" id="liquidity">'));
});

test('"New address": the owner\'s signed ask, then the card shows the provider\'s new top-up address (Alice: "a button generate a new address for the lp wallet")', async () => {
  const els = new Map(); const $ = (id) => { if (!els.has(id)) els.set(id, { innerHTML: '', textContent: '', disabled: false }); return els.get(id); };
  let claim = { freeSats: '600000', depositAddress: 'tb1pold', channels: [] };
  const posted = [];
  const fetch = async () => ({ ok: true, json: async () => claim });
  const post = async (path, body) => { posted.push([path, await body]); claim = { ...claim, depositAddress: 'tb1pnew' }; return { ok: true, address: 'tb1pnew' }; };
  const signed = async (action) => ({ action, signature: 'sig' });
  const panel = new Function('$', 'at', 'fetch', 'esc', 'post', 'signed', `${body}; return liquidityPanel;`)($, (p) => `https://seat${p}`, fetch, esc, post, signed);
  await panel();
  assert.match($('liquidity').innerHTML, /tb1pold[\s\S]*<button id="liq-new-address">New address<\/button>/);
  await $('liq-new-address').onclick({ target: $('liq-new-address') });
  assert.deepEqual(posted, [['/owner/liquidity/new-address', { action: 'liquidity/new-address', signature: 'sig' }]], 'signed by the owner for this action');
  assert.match($('liquidity').innerHTML, /tb1pnew/, 'the card re-read: the new address');
  assert.equal($('liq-msg').textContent, 'New address: tb1pnew');
});
