// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S LIQUIDITY CARD (§23A.10), drawn only by React since kanban #564 (2026-10-21: "no fall backs"): what the page
// hands the screen - the claim door and the owner's signed requests, which "New address" (Alice: "a button generate a new address for the
// lp wallet") sends. The free coins against the deposit minimum, the channels and the new address are arena-web's (test/custody.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
// the panels' places are React's (kanban #564, arena-web OwnerArea): each a <Place id=…/> the page draws its panel into
const AREA = readFileSync(new URL('../../arena-web/src/owner/OwnerArea.jsx', import.meta.url), 'utf8');
const block = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); let i = HTML.indexOf('{', a), d = 0; for (; i < HTML.length; i++) { if (HTML[i] === '{') d++; else if (HTML[i] === '}' && !--d) break; } return HTML.slice(a, i + 1); };
const doors = HTML.slice(HTML.indexOf('const getJson'), HTML.indexOf('\n', HTML.indexOf('const fetchJson')));

test('liquidity: the React screen alone; the claim read through the page (null when the node is no provider), New address signed by the owner', async () => {
  assert.ok(/liquidityPanel\(\);/.test(HTML) && AREA.includes('<Place id="liquidity" />'));
  let claim = { freeSats: '320000', depositAddress: 'tb1pold', channels: [] };
  const mounted = [], posted = [];
  const fetch = async () => ({ ok: !!claim, json: async () => claim });
  const post = async (path, body) => { posted.push([path, await body]); return { ok: true, address: 'tb1pnew' }; };
  const signed = async (action) => ({ action, signature: 'sig' });
  new Function('at', 'fetch', 'mount', 'post', 'signed', `${doors}; ${block('function liquidityPanel()')}; return liquidityPanel;`)(
    (p) => `https://seat${p}`, fetch, (id, how, props) => mounted.push({ id, how, props }), post, signed)();
  const [m] = mounted;
  assert.deepEqual([m.id, m.how], ['liquidity', 'mountLiquidity']);
  assert.deepEqual(await m.props.api.get('/liquidity-claim'), claim);
  claim = null;
  assert.equal(await m.props.api.get('/liquidity-claim'), null, 'no provider: no claim');
  // the screen's New address goes out as the page's own signed request
  await m.props.api.post('/owner/liquidity/new-address', m.props.api.signed('liquidity/new-address'));
  assert.deepEqual(posted, [['/owner/liquidity/new-address', { action: 'liquidity/new-address', signature: 'sig' }]]);
  assert.doesNotMatch(HTML, /LIQUIDITY_DEPOSIT|id="liq-new-address"/, 'no old panel left in the page');
});
