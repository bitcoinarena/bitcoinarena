// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S ADDRESS CARD (kanban #563 / #562 2C), drawn only by React since kanban #564 (2026-10-21: "no fall backs"):
// what the page hands the screen - the owner's signed requests to /owner/reach. How the node is reached, the warning while it changes at
// every restart, the ways to switch and the Cloudflare login link are arena-web's (test/address.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
// the panels' places are React's (kanban #564, arena-web OwnerArea): each a <Place id=…/> the page draws its panel into
const AREA = readFileSync(new URL('../../arena-web/src/owner/OwnerArea.jsx', import.meta.url), 'utf8');
const block = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); let i = HTML.indexOf('{', a), d = 0; for (; i < HTML.length; i++) { if (HTML[i] === '{') d++; else if (HTML[i] === '}' && !--d) break; } return HTML.slice(a, i + 1); };

test('the address: the React screen alone, in the Services section, with the page\'s owner requests', () => {
  assert.ok(AREA.includes('<Place id="address" />') && /\n {2}addressPanel\(\);\n/.test(HTML));
  const mounted = [];
  const post = async () => ({}), signed = async () => ({});
  new Function('mount', 'post', 'signed', `${block('function addressPanel()')}; return addressPanel;`)((id, how, props) => mounted.push({ id, how, props }), post, signed)();
  assert.deepEqual(mounted.map((m) => [m.id, m.how, m.props.api.post === post, m.props.api.signed === signed]), [['address', 'mountAddress', true, true]]);
  assert.doesNotMatch(HTML, /id="rc-mode"|id="rc-go"/, 'no old panel left in the page');
});
