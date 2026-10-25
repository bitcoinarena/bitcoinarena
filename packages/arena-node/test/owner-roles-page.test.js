// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S ROLES (kanban #563 tiles, drawn only by React since kanban #564, 2026-10-21: "Delete the old html code of those
// components you have ported, no fall backs"): what the page hands the React screen - its element, the node, the doors it reads and the
// owner's signed requests. The tiles, the switches and the save bar themselves are arena-web's (test/roles.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
// the panels' places are React's (kanban #564, arena-web OwnerArea): each a <Place id=…/> the page draws its panel into
const AREA = readFileSync(new URL('../../arena-web/src/owner/OwnerArea.jsx', import.meta.url), 'utf8');
/** A function of the page, from its name to its closing brace. */
const block = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); let i = HTML.indexOf('{', a), d = 0; for (; i < HTML.length; i++) { if (HTML[i] === '{') d++; else if (HTML[i] === '}' && !--d) break; } return HTML.slice(a, i + 1); };
const doors = HTML.slice(HTML.indexOf('const getJson'), HTML.indexOf('\n', HTML.indexOf('const fetchJson')));

function run(answers) {
  const mounted = [];
  const fetch = async (u) => { if (answers[u] instanceof Error) throw answers[u]; return { ok: answers[u] != null, json: async () => answers[u] }; };
  const post = async () => ({ ok: true }), signed = async () => ({});
  new Function('at', 'fetch', 'mount', 'post', 'signed', 'state', `${doors}; ${block('function rolesPanel()')}; return rolesPanel;`)(
    (p) => p, fetch, (id, how, props) => mounted.push({ id, how, props }), post, signed, { node: 'me' })();
  return { mounted, post, signed };
}

test('the roles card is the React screen alone: mounted with the node, the page\'s owner requests and its doors', async () => {
  assert.ok(AREA.includes('<Place id="roles" />') && /\n {2}rolesPanel\(\);\n/.test(HTML), 'the card, and drawn with the others');
  const { mounted: [m], post, signed } = run({ '/roles': { nodes: [{ node: 'me', roles: ['game'] }] }, '/guardian': null, '/gateway-claim': new Error('down') });
  assert.deepEqual([m.id, m.how, m.props.node], ['roles', 'mountRoles', 'me']);
  assert.equal(m.props.api.post, post); assert.equal(m.props.api.signed, signed);
  assert.deepEqual(await m.props.api.get('/roles'), { nodes: [{ node: 'me', roles: ['game'] }] });
  assert.equal(await m.props.api.get('/guardian'), null, 'a door that refused: null');
  assert.equal(await m.props.api.get('/gateway-claim'), null, 'a door that did not answer: null, never a throw');
});

test('no old panel is left: no tiles drawn by the page, no switch wiring', () => {
  assert.doesNotMatch(HTML, /function wireRoles|ROLE_SWITCHES|id="rl-bar"|data-open=/);
});
