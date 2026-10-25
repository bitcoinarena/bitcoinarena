// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S STANDING, CAPACITY PLEA AND BOND OFFER: the standing is drawn only by React since kanban #564 (2026-10-21: "no
// fall backs") - its figures and warnings are arena-web's (test/standing.test.mjs) - so the page is checked for what it hands the screen;
// the capacity plea and the bond offer are still the page's own, run on the doors' answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeStanding } from '../src/node-standing.js';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
// the panels' places are React's (kanban #564, arena-web OwnerArea): each a <Place id=…/> the page draws its panel into
const AREA = readFileSync(new URL('../../arena-web/src/owner/OwnerArea.jsx', import.meta.url), 'utf8');
const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const me = 'aa'.repeat(32);
const rounds = (bondMin, bonds) => [{ atMs: 2, bondMinSats: bondMin, entries: bonds.map(([k, b]) => ({ pubkey: k, bondSats: b })), excluded: [] }];
const block = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); let i = HTML.indexOf('{', a), d = 0; for (; i < HTML.length; i++) { if (HTML[i] === '{') d++; else if (HTML[i] === '}' && !--d) break; } return HTML.slice(a, i + 1); };
const line = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); return HTML.slice(a, HTML.indexOf('\n', a)); };

test('the standing: the React screen alone, reading the doors as they answer; missed draws marked red on the Overview, under Services', async () => {
  assert.ok(AREA.includes('<Place id="standing" />') && /\n {2}standingPanel\(\);\n/.test(HTML));
  const mounted = [], needs = [];
  const fetch = async (u) => ({ json: async () => ({ asked: u }) });
  new Function('at', 'fetch', 'mount', 'need', `${line('const getJson')}; ${block('function standingPanel()')}; return standingPanel;`)(
    (p) => `https://seat${p}`, fetch, (id, how, props) => mounted.push({ id, how, props }), (...a) => needs.push(a))();
  const [m] = mounted;
  assert.deepEqual([m.id, m.how], ['standing', 'mountStanding']);
  assert.deepEqual(await m.props.api.get('/owner/seatings'), { asked: 'https://seat/owner/seatings' });
  m.props.onMissed(3);
  assert.deepEqual(needs, [['missed', 'bad', 'Your node missed 3 draws in a row: check its services.', 'services']]);
  assert.doesNotMatch(HTML, /Draws missed in a row|Recent rounds your bond qualified for/, 'no old panel left in the page');
});

// THE CAPACITY PLEA AND THE BOND OFFER are React's too (kanban #564: CapacityPlea, BondAnswer - their words and figures are arena-web's,
// test/bond-offer.test.mjs): the page reads the doors once and hands the answers over with the signed requests and need()
const fnOf = (start, name) => { const c = HTML.indexOf(start); return HTML.slice(c, HTML.indexOf('\n}\n', HTML.indexOf(`async function ${name}() {`)) + 2); };
test('the capacity plea and the bond offer: the page hands the doors\' answers, the bond wallet\'s address, the plan and the add, and need()', async () => {
  const all = `${line('const getJson')}\n${line('let standingRead = null;')}\n${line('const readStanding')}\n` + fnOf('let pleaRead = null;', 'capacityPlea') + fnOf('let bondRead = null;', 'bondAnswer');
  const mounted = [], needs = [], posted = [], asked = [];
  const fetch = async (u) => { asked.push(u); return { json: async () => (u.includes('/capacity') ? { plea: { says: 'filling' } } : u.endsWith('/owner/bond') ? { bond: { sats: '1' } } : { ownBondSats: '1' }) }; };
  const post = async (path, body) => { posted.push([path, await body]); return path.endsWith('/add-bond') ? { plan: { planned: true } } : { address: 'tb1p' }; };
  const signed = (action, args) => ({ action, args });
  const [plea, answer] = new Function('at', 'fetch', 'mount', 'need', 'post', 'signed', 'C', `${all}; return [capacityPlea, bondAnswer];`)(
    (p2) => `https://seat${p2}`, fetch, (id, how, props) => mounted.push({ id, how, props }), (...a) => needs.push(a), post, signed, { textQrSvg: (t) => `<qr ${t}>` });
  await plea(); await answer();
  assert.deepEqual(mounted.map((m) => [m.id, m.how]), [['capacity-plea', 'mountPlea'], ['bond-answer', 'mountBondAnswer']]);
  assert.deepEqual(mounted[0].props.capacity, { plea: { says: 'filling' } });
  assert.equal(asked.filter((u) => u.includes('/capacity')).length, 1, 'the plea read once for both');
  const b = mounted[1].props;
  assert.deepEqual([b.standing, b.capacity, b.bond], [{ ownBondSats: '1' }, { plea: { says: 'filling' } }, { bond: { sats: '1' } }]);
  assert.equal(b.qr('bitcoin:x'), '<qr bitcoin:x>');
  assert.deepEqual(await b.address(), { address: 'tb1p' });
  assert.deepEqual(await b.plan(383334), { planned: true });
  await b.add(383334);
  assert.deepEqual(posted, [['/owner/bond-wallet/address', { action: 'bond-wallet/address', args: undefined }],
    ['/owner/add-bond', { action: 'add-bond', args: { sats: '383334', post: false } }], ['/owner/add-bond', { action: 'add-bond', args: { sats: '383334', post: true } }]]);
  b.onNeed('earn', 'warn', 'Earn up to 6.5× more');
  assert.deepEqual(needs, [['earn', 'warn', 'Earn up to 6.5× more', 'bond']]);
  assert.doesNotMatch(HTML, /Earn up to|No federation you guard pays extra|A federation you guard is filling up/, 'no old words left in the page');
});
