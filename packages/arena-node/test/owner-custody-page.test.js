// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S CUSTODY CARD (2026-10-18: "if custody is setup later in the UI we need the same screens"): a node
// without custody is told how to add it - "Add custody" or arena-install --add-custody opens the installer's custody screens and updates
// the bond; a guardian shows its endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const a = HTML.indexOf('async function custodyPanel() {');
const body = HTML.slice(a, HTML.indexOf('\n}\n', a) + 2);
const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
async function render(answer) {
  const el = { innerHTML: '' }; const asked = [];
  const fetch = async (u) => { asked.push(u); return { json: async () => answer }; };
  await new Function('$', 'at', 'fetch', 'esc', `${body}; return custodyPanel;`)(() => el, (p) => `https://seat${p}`, fetch, esc)();
  return { html: el.innerHTML, asked };
}

test('no custody: how to add it, the same screens, no second bond; a guardian: on, its endpoint', async () => {
  assert.ok(HTML.includes('<div class="card" id="custody">') && /custodyPanel\(\);\n\s+liquidityPanel\(\);\n\s+releasePanel\(\);/.test(HTML), 'the card, and drawn with the others');
  const off = await render({ guardian: false });
  assert.deepEqual(off.asked, ['https://seat/guardian']);
  assert.match(off.html, /holds no custody/);
  assert.match(off.html, /Add custody/); assert.match(off.html, /arena-install --add-custody/); assert.match(off.html, /no second bond/);
  const on = await render({ guardian: true, endpoint: 'wss://node.example.com/guardian' });
  assert.match(on.html, /on - this node is a guardian/); assert.match(on.html, /wss:\/\/node\.example\.com\/guardian/);
});
