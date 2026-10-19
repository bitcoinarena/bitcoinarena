// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION NOT ON THE KNOWN-GOOD LIST, ON THE PAGE'S OWN CODE (spec §23.6): a deposit or paid join into it
// opens the modal first - its id, its signed status, every guardian from the census this client checked -
// and is refused until "I trust this federation"; the answer is kept per browser and per federation, Forget asks again; a
// listed federation is never asked about; an invite naming another federation is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import * as fed from '../src/federations.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, from.slice(0, 40)); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const GATE = slice('    window.ARENA_FEDERATION_GATE = async', '\n    };\n');
const CONFIRMED = slice('    window.ARENA_PAINT_CONFIRMED = () => {', '\n    };\n');
const OPEN = slice('    function openMoney(which, say = ', '\n      })();\n    }\n');

const hex = (b) => Buffer.from(b).toString('hex');
const UNKNOWN = new Uint8Array(32).fill(0x37);
const OTHER = new Uint8Array(32).fill(0x38);
const TN4 = Uint8Array.from(Buffer.from('337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e', 'hex'));
const invite = (f) => inviteForGuardians(f, [{ url: 'wss://g.example/', peer: 0 }]);
const census = (f) => Array.from({ length: 7 }, (_, i) => ({ pubkey: new Uint8Array(32).fill(0x10 + i), txid: new Uint8Array(32).fill(i), vout: 0, bondSats: 50000n + BigInt(i),
  advert: { operatorId: `op-${i}`, guardianEndpoint: `wss://g${i}.example/`, guardianOf: [{ federationId: f, guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }] } }));

function memStorage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function node(tag) {
  const n = { tag, textContent: '', style: {}, dataset: {}, children: [], className: '', listeners: {},
    append: (...c) => n.children.push(...c), appendChild: (c) => n.children.push(c), addEventListener: (ev, f) => { n.listeners[ev] = f; },
    contains: (c) => c === n || n.children.some((k) => k === c || (k && typeof k.contains === 'function' && k.contains(c))) };   // the page asks it (waitBox.el.contains)
  let html = '';
  Object.defineProperty(n, 'innerHTML', { get: () => html, set: (v) => { html = v; n.parts = { b: node('b'), span: node('span'), code: [node('code'), node('code')] }; } });
  n.querySelector = (s) => n.parts[s];
  n.querySelectorAll = (s) => n.parts[s];
  return n;
}

function page({ storage = memStorage(), status = null, checked = null } = {}) {
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || node(id)), createElement: node };
  // the browser's store through the page's one door, window.ARENA_BROWSER_STORE: the same fake as `localStorage`
  const window = { ARENA_FED_STATUS: status, BLWP_CURVE: {}, ARENA_LEDGER_LOBBY: { nodes: ['https://seat.example'] }, ARENA_BROWSER_STORE: () => storage };
  const asked = [];
  const BLWPCLIENT = { ...fed, federationStatus: async () => (asked.push('status'), { status: 'OPEN', signers: 6, nominal: 7 }), checkedCensusFor: () => checked, clientCommittee: async () => { asked.push('committee'); }, federationSays: fed.federationSays,
    depositDonationMsat: () => 0n, marketForRound: () => null, settingsDepositOffer: async () => ({}) };
  const did = [];
  const fn = pageFunction(PAGE, ['document', 'window', 'BLWPCLIENT', 'localStorage', 'moneyContext', 'openWithdraw', 'showDepositOffer', 'donationBps', 'vault'],
    [GATE, CONFIRMED, OPEN], 'return { gate: window.ARENA_FEDERATION_GATE, paintConfirmed: window.ARENA_PAINT_CONFIRMED, openMoney };');
  let ctx = null;
  const api = fn(document, window, BLWPCLIENT, storage, () => ctx, () => did.push('withdraw'), () => did.push('modal'), () => 0, () => ({}));
  const shown = () => !!els['arena-fed-confirm'] && els['arena-fed-confirm'].style.display === 'flex';
  const answer = async (trust) => { for (let i = 0; i < 50 && !shown(); i++) await new Promise((r) => setImmediate(r)); assert.ok(shown(), 'the modal is open'); els[trust ? 'afc-trust' : 'afc-cancel'].onclick(); };
  return { ...api, els, window, storage, did, asked, shown, answer, setCtx: (c) => { ctx = c; } };
}
const round = (f) => ({ federationId: f, stakeMsat: 1n });

test('an unknown federation is refused until trusted, and the modal lists every guardian from the checked census', async () => {
  const fid = hex(UNKNOWN);
  const p = page({ checked: census(UNKNOWN), status: { federation: fid, status: 'OPEN', signers: 7, nominal: 7 } });
  const asking = p.gate({ round: round(UNKNOWN), invite: invite(UNKNOWN), roundIdHex: 'ab', nodes: ['https://seat.example'] });
  await p.answer(false);
  const no = await asking;
  assert.equal(no.ok, false);
  assert.match(no.why, /not on this page's known-good list and was not confirmed/);
  assert.equal(p.els['afc-id'].textContent, fid);
  assert.equal(p.els['afc-status'].textContent, 'OPEN · 7 of 7 guardians signed');
  const rows = p.els['afc-guardians'].children;
  assert.equal(rows.length, 7, 'every guardian');
  assert.deepEqual(rows.map((r) => r.parts.b.textContent), ['op-0', 'op-1', 'op-2', 'op-3', 'op-4', 'op-5', 'op-6']);
  assert.equal(rows[0].parts.code[0].textContent, 'node ' + '10'.repeat(32));
  assert.equal(rows[0].parts.code[1].textContent, 'wss://g0.example/');
  assert.equal(rows[6].parts.span.textContent, '50,006');
  assert.equal(p.shown(), false, 'closed after Cancel');
  assert.equal(fed.federationConfirmed(p.storage, fid), false, 'Cancel keeps nothing');
});

test('a deposit into an unknown federation opens the modal first and is refused on Cancel', async () => {
  const p = page({ checked: census(UNKNOWN) });
  p.setCtx({ ok: true, round: round(UNKNOWN), roundIdHex: 'ab', invite: invite(UNKNOWN), seed: 's', gateways: [] });
  const said = [];
  const going = p.openMoney('deposit', (t) => said.push(t));
  await p.answer(false);
  const r = await going;
  assert.equal(r.ok, false);
  assert.match(said.at(-1), /was not confirmed: nothing is deposited or staked/);
  assert.ok(!p.did.includes('modal'), 'no deposit offer opened');
});

test('after "I trust this federation": allowed, kept per browser, and not asked again', async () => {
  const fid = hex(UNKNOWN);
  const storage = memStorage();
  const p = page({ storage, checked: census(UNKNOWN) });
  const asking = p.gate({ round: round(UNKNOWN), invite: invite(UNKNOWN), roundIdHex: 'ab', nodes: [] });
  await p.answer(true);
  assert.deepEqual(await asking, { ok: true, confirmed: true, asked: true });
  assert.equal(fed.federationConfirmed(storage, fid), true);
  const again = page({ storage, checked: census(UNKNOWN) });
  assert.deepEqual(await again.gate({ round: round(UNKNOWN), invite: invite(UNKNOWN), roundIdHex: 'ab', nodes: [] }), { ok: true, confirmed: true });
  assert.equal(again.shown(), false, 'not asked again');
  const other = page({ storage, checked: census(OTHER) });
  const asking2 = other.gate({ round: round(OTHER), invite: invite(OTHER), roundIdHex: 'ab', nodes: [] });
  await other.answer(false);
  assert.equal((await asking2).ok, false, 'confirmed per federation, not for every one');
});

test('Settings lists the confirmed federation; after Forget it is asked again', async () => {
  const fid = hex(UNKNOWN);
  const storage = memStorage();
  fed.confirmFederation(storage, fid, 1);
  const p = page({ storage, checked: census(UNKNOWN) });
  p.paintConfirmed();
  const list = p.els['arena-fed-confirmed'].children;
  assert.equal(list.length, 1);
  const [label, forget] = list[0].children;
  assert.equal(label.textContent, fid.slice(0, 16) + '…');
  assert.equal(forget.textContent, 'Forget');
  forget.listeners.click();
  assert.equal(fed.federationConfirmed(storage, fid), false);
  assert.match(p.els['arena-fed-confirmed'].innerHTML, /none/);
  const asking = p.gate({ round: round(UNKNOWN), invite: invite(UNKNOWN), roundIdHex: 'ab', nodes: [] });
  await p.answer(false);
  assert.equal((await asking).ok, false, 'asked again');
});

test('a known federation shows no modal: 337ae01a and the regtest test federation', async () => {
  for (const f of [TN4, TEST_FEDERATION_ID]) {
    const p = page();
    assert.deepEqual(await p.gate({ round: round(f), invite: invite(f), roundIdHex: 'ab', nodes: ['https://seat.example'] }), { ok: true, known: true });
    assert.equal(p.shown(), false);
    assert.deepEqual(p.asked, [], 'no census read for a listed federation');
  }
});

test('an invite naming a different federation is refused, known or not, before anything is asked', async () => {
  for (const f of [TN4, UNKNOWN]) {
    const p = page({ checked: census(f) });
    const r = await p.gate({ round: round(f), invite: invite(OTHER), roundIdHex: 'ab', nodes: [] });
    assert.equal(r.ok, false);
    assert.match(r.why, /invite names another federation than the round's/);
    assert.equal(p.shown(), false);
  }
});

test('the census is read by the client itself when it has none yet, and the paid join is gated before anything is locked', async () => {
  const p = page({ checked: null });
  const asking = p.gate({ round: round(UNKNOWN), invite: invite(UNKNOWN), roundIdHex: 'ab', nodes: ['https://seat.example'] });
  await p.answer(false);
  await asking;
  assert.deepEqual(p.asked, ['committee']);
});

test('with no status read by a join yet, the modal asks the seats for the signed one itself', async () => {
  const p = page({ checked: census(UNKNOWN) });
  const asking = p.gate({ round: round(UNKNOWN), invite: invite(UNKNOWN), roundIdHex: 'ab', nodes: ['https://seat.example'] });
  await p.answer(false);
  await asking;
  assert.deepEqual(p.asked, ['status']);
  assert.equal(p.els['afc-status'].textContent, 'OPEN \u00b7 6 of 7 guardians signed');
  const join = HTML.indexOf("const gate = await window.ARENA_FEDERATION_GATE({ round: named.round, invite: named.federation");
  const lock = HTML.indexOf("signerNodes = await joinStep('clientSettlementSignerNodes'");
  assert.ok(join > 0 && join < lock, 'the join asks before the signer nodes and the lock');
  assert.match(HTML.slice(join, lock), /if \(!gate\.ok\) throw new Error\(gate\.why\)/);
});
