// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S CUSTODY CARD (2026-10-18: "if custody is setup later in the UI we need the same screens"), drawn only by React since
// kanban #564 (2026-10-21: "no fall backs"): what the page hands the screen. What it says - how to add custody, a guardian's
// endpoint - is arena-web's (test/custody.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
// the panels' places are React's (kanban #564, arena-web OwnerArea): each a <Place id=…/> the page draws its panel into
const AREA = readFileSync(new URL('../../arena-web/src/owner/OwnerArea.jsx', import.meta.url), 'utf8');
const block = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); let i = HTML.indexOf('{', a), d = 0; for (; i < HTML.length; i++) { if (HTML[i] === '{') d++; else if (HTML[i] === '}' && !--d) break; } return HTML.slice(a, i + 1); };
const doors = HTML.slice(HTML.indexOf('const getJson'), HTML.indexOf('\n', HTML.indexOf('const fetchJson')));

test('custody: the React screen alone, with the page\'s doors (null for a refused one) and its owner requests', async () => {
  assert.ok(AREA.includes('<Place id="custody" />') && /custodyPanel\(\);\n\s+liquidityPanel\(\);\n\s+releasePanel\(\);/.test(HTML), 'the card, and drawn with the others');
  const mounted = [], asked = [];
  const fetch = async (u) => { asked.push(u); return { ok: u.endsWith('/guardian'), json: async () => ({ guardian: true, endpoint: 'wss://node.example.com/guardian' }) }; };
  const post = async () => ({}), signed = async () => ({});
  new Function('at', 'fetch', 'mount', 'post', 'signed', `${doors}; ${block('function custodyPanel()')}; return custodyPanel;`)(
    (p) => `https://seat${p}`, fetch, (id, how, props) => mounted.push({ id, how, props }), post, signed)();
  const [m] = mounted;
  assert.deepEqual([m.id, m.how], ['custody', 'mountCustody']);
  assert.equal(m.props.api.post, post); assert.equal(m.props.api.signed, signed);
  assert.deepEqual(await m.props.api.get('/guardian'), { guardian: true, endpoint: 'wss://node.example.com/guardian' });
  assert.equal(await m.props.api.get('/gateway-claim'), null);
  assert.deepEqual(asked, ['https://seat/guardian', 'https://seat/gateway-claim']);
  assert.doesNotMatch(HTML, /holds no custody|arena-install --add-custody/, 'no old panel text left in the page');
});
