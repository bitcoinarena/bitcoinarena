// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S STANDING, CAPACITY PLEA AND BOND OFFER: the standing is drawn only by React since kanban #564 (the owner 2026-10-21: "no
// fall backs") - its figures and warnings are arena-web's (test/standing.test.mjs) - so the page is checked for what it hands the screen;
// the capacity plea and the bond offer are still the page's own, run on the doors' answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeStanding } from '../src/node-standing.js';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const me = 'aa'.repeat(32);
const rounds = (bondMin, bonds) => [{ atMs: 2, bondMinSats: bondMin, entries: bonds.map(([k, b]) => ({ pubkey: k, bondSats: b })), excluded: [] }];
const block = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); let i = HTML.indexOf('{', a), d = 0; for (; i < HTML.length; i++) { if (HTML[i] === '{') d++; else if (HTML[i] === '}' && !--d) break; } return HTML.slice(a, i + 1); };
const line = (start) => { const a = HTML.indexOf(start); assert.ok(a >= 0, start); return HTML.slice(a, HTML.indexOf('\n', a)); };

test('the standing: the React screen alone, reading the doors as they answer; missed draws marked red on the Overview, under Services', async () => {
  assert.ok(HTML.includes('<div class="card" id="standing">') && /\n {2}standingPanel\(\);\n/.test(HTML));
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

// THE CAPACITY PLEA (kanban #543): the page's own capacityPlea, run on GET /capacity?node=me - the seat's words shown, nothing while CALM
const fnOf = (start, name) => { const c = HTML.indexOf(start); return HTML.slice(c, HTML.indexOf('\n}\n', HTML.indexOf(`async function ${name}() {`)) + 2); };
test('the capacity plea: the seat\'s words for this node when a federation fills; nothing when the seat says no plea', async () => {
  const fnBody = fnOf('let pleaRead = null;', 'capacityPlea');
  const show = async (answer) => {
    const el = { innerHTML: '' }, asked = [];
    const fetch = async (u) => { asked.push(u); return { json: async () => answer }; };
    await new Function('$', 'at', 'fetch', 'esc', `${fnBody}; return capacityPlea;`)(() => el, (p) => `https://seat${p}`, fetch, esc)();
    return { html: el.innerHTML, asked };
  };
  const { html, asked } = await show({ ok: true, plea: { level: 'warn', band: 'PRESSURE', addSats: '36667', says: 'Federation aaaaaaaa holds 87 % of what its bonds cover (PRESSURE). Increase your bond by 36,667 sat (Add to bond) to bring it to 86,667 sat.' } });
  assert.deepEqual(asked, ['https://seat/capacity?node=me']);
  assert.match(html, /filling up.*Increase your bond by 36,667 sat \(Add to bond\)/s);
  assert.match(html, /lowers its load/);
  assert.equal((await show({ ok: true, plea: null })).html, '');
  assert.equal((await show({ ok: true })).html, '');
});

// THE BOND AS AN OFFER (kanban #553, the owner 2026-10-20: "The operator does not need to add a bond, he can if he wants to earn more ... more
// direct instructions how to deposit ... I need to calculate myself"; "earn 350% more e.g"): headline, bar, two steps with the numbers worked out
test('the bond offer: "Earn up to N× more", the sat to send (worked out from the wallet and the fees) and one button; nothing to earn: no offer', async () => {
  const all = `${line('const getJson')}\n${line('let standingRead = null;')}\n${line('const readStanding')}\n` + fnOf('let pleaRead = null;', 'capacityPlea') + fnOf('let bondRead = null;', 'bondAnswer')
    + "\nconst fedLabel = (fid) => `Federation ${String(fid).slice(0, 8)}`;\n";
  const offer = async (capacity, standing, bond) => {
    const els = {}, needs = [];
    const $ = (id) => (els[id] = els[id] || { innerHTML: '', value: '', textContent: '' });
    const fetch = async (u) => ({ json: async () => (u.includes('/capacity') ? capacity : u.endsWith('/owner/seatings') ? { missedInARow: 0, warning: null } : u.endsWith('/owner/bond') ? bond : standing) });
    const post = async () => ({ ok: true, address: 'tb1ptopup' });
    const C = { textQrSvg: () => '<svg/>' };
    await new Function('$', 'at', 'fetch', 'esc', 'need', 'window', 'post', 'signed', 'C', 'daysHours', `${all}; return bondAnswer;`)($, (p) => `https://seat${p}`, fetch, esc, (...a) => needs.push(a), {}, post, () => ({}), C, () => '1 h')();
    return { html: els['bond-answer'].innerHTML, addr: els['ab-addr'] && els['ab-addr'].innerHTML, needs };
  };
  const st = nodeStanding({ me, rounds: rounds(50000n, [[me, 50000n]]) });
  const m = { federation: '337ae01ad1e9bb35' + '0'.repeat(48), band: 'FULL', load: 4.333, guardians: 7, bondSats: '50000', targetBondSats: '433334', addSats: '383334', even: 1 / 7, now: 1 / 7, ifRaised: 0.926, underPressure: 0.926 };
  const bond = { bond: { sats: '50000' }, wallet: { spendableSats: '16004', confirmingSats: '0', addOverheadSats: '4830' } };
  const o = await offer({ ok: true, plea: null, mine: [m] }, st, bond);
  assert.match(o.html, /Earn up to 6\.5× more/);
  assert.match(o.html, /Federation 337ae01a is 433 % full/); assert.match(o.html, /Optional/);
  assert.match(o.html, /Send 372,160 sat<\/b> to your bond wallet/, '383,334 + 4,830 - 16,004');
  assert.match(o.html, /Add 383,334 sat to my bond/);
  assert.match(o.html, /✓ Your bond is enough: this node is drawn for rounds/);
  assert.match(o.addr, /tb1ptopup/); assert.match(o.addr, /16,004 sat/);
  assert.ok(o.needs.some(([k, l, t]) => k === 'earn' && l === 'warn' && /Earn up to 6\.5× more/.test(t)), 'an offer, never red');
  const rich = await offer({ ok: true, plea: null, mine: [m] }, st, { ...bond, wallet: { ...bond.wallet, spendableSats: '400000' } });
  assert.match(rich.html, /✓ Your bond wallet has enough/); assert.doesNotMatch(rich.html, /Send \d/);
  const calm = await offer({ ok: true, plea: null, mine: [{ ...m, band: 'CALM', load: 0.4 }] }, st, bond);
  assert.match(calm.html, /No federation you guard pays extra/); assert.doesNotMatch(calm.html, /Earn up to/);
});
