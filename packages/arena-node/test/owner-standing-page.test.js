// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S STANDING PANEL: the page's own standingPanel, run on the doors' answers - the missed
// seatings' warning with the serving = false update, and the bond's standing with each warning in the seat's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeStanding } from '../src/node-standing.js';
import { seatingWarning } from '../src/seatings.js';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
// from the shared read (kanban #553: the Bond answer reads the same) to the end of standingPanel
const a = HTML.indexOf('let standingRead = null;');
const body = HTML.slice(a, HTML.indexOf('\n}\n', HTML.indexOf('async function standingPanel() {')) + 2);
const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function render(seatings, standing) {
  const el = { innerHTML: '' };
  const fetch = async (u) => ({ json: async () => (u.endsWith('/owner/seatings') ? seatings : standing) });
  const fn = new Function('$', 'at', 'fetch', 'esc', 'need', `${body}; return standingPanel;`)(() => el, (p) => `https://seat${p}`, fetch, esc, () => {});
  await fn();
  return el.innerHTML;
}
const me = 'aa'.repeat(32);
const rounds = (bondMin, bonds) => [{ atMs: 2, bondMinSats: bondMin, entries: bonds.map(([k, b]) => ({ pubkey: k, bondSats: b })), excluded: [] }];

test('three seatings missed and a bond under the common bracket: both warnings, the update named', async () => {
  const st = nodeStanding({ me, rounds: rounds(200000n, [[me, 150000n], ['bb'.repeat(32), 300000n]]) });
  const html = await render({ missedInARow: 3, warning: seatingWarning(3) }, st);
  // kanban #553: plain names for each figure and warning
  assert.match(html, /Draws missed in a row<\/span><b>3/);
  assert.match(html, /Missed draws/); assert.match(html, /serving = false/); assert.match(html, /ARENA_ADVERT_SERVING=false/);
  assert.match(html, /Bond below the minimum/); assert.match(html, /0\.75× of 200,000 sat/);
  assert.match(html, /Bond<\/span><b>150,000 sat/);
});

test('seated when drawn and a bond above the margin: no warning', async () => {
  const st = nodeStanding({ me, rounds: rounds(100000n, [[me, 1000000n]]) });
  const html = await render({ missedInARow: 0, warning: null }, st);
  assert.match(html, /No warning/); assert.doesNotMatch(html, /class="err"/);
});

test('the bond_min in force and a pending rise, with its escalation in the warnings', async () => {
  const st = { ...nodeStanding({ me, rounds: rounds(100000n, [[me, 1000000n]]) }), bondMin: { inForce: '50000', noticeBlocks: 144, pending: { value: '80000', crossedAt: 300, effectiveAt: 444 } } };
  st.warnings = [{ kind: 'bond_min rise (T-3d)', urgent: true, says: 'bond_min rises to 80000 sat at block 444' }];
  const html = await render({ missedInARow: 0, warning: null }, st);
  assert.match(html, /Network minimum bond now<\/span><b>50,000 sat · rising to 80,000 sat at block 444 if it holds \(notice 144 blocks\)/);
  assert.match(html, /bond_min rise \(T-3d\)/);
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
  const all = fnOf('let standingRead = null;', 'standingPanel') + fnOf('let pleaRead = null;', 'capacityPlea') + fnOf('let bondRead = null;', 'bondAnswer')
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
