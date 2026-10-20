// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THE PAGE DOES UNDER A FEDERATION'S SIGNED STATUS (spec §23A.1 / §23A.4), on the page's own code
// (page-script.js): CRITICAL leaves Withdraw and Move only - Deposit refused by name, its buttons hidden; DRAINING closes
// Deposit and nothing else; HALTED closes everything; OPEN and "unverified" change nothing. And the client's own
// federationStatus: a record signed by the threshold of the census' bonded guardians is believed, anything else is
// "unverified".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { pageFunction } from './page-script.js';
import { federationStatus, federationStatuses, federationSays, loadSays, loadRefusesDeposit, moveOffer, moveSays, FEDERATION_ALLOWS } from '../src/federations.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, from.slice(0, 40)); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const PAINT = slice('    window.ARENA_PAINT_FEDERATION = () => {', '\n    };\n');
const OPEN = slice('    function openMoney(which, say = ', '\n      })();\n    }\n');

function page(status, extra = {}) {
  const els = {}; const classes = new Set();
  const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {} });
  for (const id of ['arena-fed-note', 'arena-money-why', 'arena-settings']) el(id);
  const document = { getElementById: (id) => els[id] || null, body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) } } };
  const { move, wallet, ...fields } = extra;
  // the wallet's own federation (its chip) holds the round's status unless a test names another
  const st = status ? { status, allows: FEDERATION_ALLOWS[status], ...fields } : undefined;
  const mine = wallet || (st ? st.federation || 'f'.repeat(64) : undefined);
  const window = { ARENA_FED_STATUS: st, ARENA_FED_MOVE: move, ARENA_LEDGER_FEDERATION: mine, ARENA_FED_LOADS: new Map(st && !wallet ? [[mine, st]] : []) };
  const did = [];
  const ARENACLIENT = { federationSays, loadSays, moveSays, depositDonationMsat: () => 0n, marketForRound: () => null, settingsDepositOffer: async () => { did.push('offer'); return {}; } };
  const fn = pageFunction(PAGE, ['document', 'window', 'ARENACLIENT', 'moneyContext', 'openWithdraw', 'showDepositOffer', 'donationBps', 'vault'],
    [PAINT, OPEN], 'return { paint: window.ARENA_PAINT_FEDERATION, openMoney };');
  const api = fn(document, window, ARENACLIENT, () => ({ ok: true, round: { stakeMsat: 1n }, invite: 'fed1', seed: 's', gateways: [] }),
    () => did.push('withdraw'), () => did.push('modal'), () => 0, () => ({}));
  return { ...api, els, classes, did, window };
}

test('CRITICAL: Withdraw and Move only - Deposit refused by name, the note shown, its buttons hidden by the body class', async () => {
  const p = page('CRITICAL');
  p.paint();
  assert.equal(p.els['arena-fed-note'].style.display, '');
  assert.match(p.els['arena-fed-note'].textContent, /only Withdraw and Move are open/);
  assert.ok(p.classes.has('arena-fed-critical'));
  assert.deepEqual(await p.openMoney('deposit', () => {}), { ok: false, why: federationSays('CRITICAL') });
  assert.deepEqual(await p.openMoney('withdraw', () => {}), { ok: true });
  assert.ok(p.did.includes('withdraw'));
  const css = slice('    body.arena-fed-draining #arena-deposit-go', '{ display: none; }');
  assert.match(css, /body\.arena-fed-critical #arena-deposit-go, body\.arena-fed-critical #arena-wb-deposit/);
});

test('DRAINING closes Deposit only; HALTED closes Withdraw too; OPEN and unverified change nothing', async () => {
  assert.equal((await page('DRAINING').openMoney('deposit', () => {})).ok, false);
  assert.equal((await page('DRAINING').openMoney('withdraw', () => {})).ok, true);
  const h = page('HALTED');
  assert.deepEqual(await h.openMoney('withdraw', () => {}), { ok: false, why: federationSays('HALTED') });
  for (const s of ['OPEN', 'unverified', null]) assert.equal((await page(s).openMoney('withdraw', () => {})).ok, true, String(s));
  assert.deepEqual({ ...FEDERATION_ALLOWS.CRITICAL }, { deposit: false, join: false, withdraw: true, move: true });
});

test('the client believes a record its census\' bonded guardians signed, and calls anything else unverified', async () => {
  const FED = new Uint8Array(32).fill(0x37);
  const invite = inviteForGuardians(FED, [{ url: 'wss://g.example/', peer: 0 }]);
  const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
  const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(i), vout: 0, bondSats: 50000n, advert: { guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } }));
  const r = buildFederationRecord({ federationId: FED, networkId: new Uint8Array(32).fill(0x10), invite, nominal: 7, height: 156036,
    guardians: census.map((e) => ({ peerKey: e.advert.guardianOf[0].guardianKey, nodePubkey: e.pubkey, operatorId: '', bondTxid: e.txid, bondVout: 0, endpoint: '', bondSats: 50000n })),
    gone: [{ peerKey: nodes[0].guardianKey, sinceHeight: 156036, kind: 1, proofRef: new Uint8Array(32) }, { peerKey: nodes[1].guardianKey, sinceHeight: 156036, kind: 1, proofRef: new Uint8Array(32) }] });
  const id = federationRecordId(r);
  const signed = joinSignedRecord(encodeFederationRecord(r), nodes.slice(2).map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })));
  const hex = Buffer.from(signed).toString('hex');
  const fetcher = async () => new Response(JSON.stringify({ federations: [{ federation: Buffer.from(FED).toString('hex'), record: hex }] }), { status: 200 });
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const got = await federationStatus({ federationIdHex: Buffer.from(FED).toString('hex'), nodes: ['https://seat.example'], census, verify, fetcher });
  assert.deepEqual([got.status, got.signers, got.allows.deposit, got.allows.withdraw], ['CRITICAL', 5, false, true]);
  const none = await federationStatus({ federationIdHex: Buffer.from(FED).toString('hex'), nodes: ['https://seat.example'], census: census.slice(3), verify, fetcher });
  assert.equal(none.status, 'unverified', 'a census without its guardians: 4 bonded signers, short of 5');
});

// THE LOAD, SHOWN AND NOT REFUSED (§23A.3refusing waits for the owner's ruling): an OPEN federation holding more
// than its guardians' bonds cover says so in the note, and a deposit still goes on
test('an OPEN federation at load 4.33 says so in the note, and the deposit still goes on', async () => {
  const p = page('OPEN', { reserveSats: '650000', exposureCapSats: '150000', load: 4.3333 });
  p.paint();
  assert.equal(p.els['arena-fed-note'].style.display, '');
  assert.equal(p.els['arena-fed-note'].textContent, 'Federation ffffffff · Load 4.33: this federation holds 650,000 sat, more than the 150,000 sat its guardians\' bonds cover.');
  // the deposit goes the way it goes with no load at all: the load refuses nothing
  const r = await p.openMoney('deposit', () => {});
  const plain = page('OPEN'); const r0 = await plain.openMoney('deposit', () => {});
  assert.deepEqual([r, p.did], [r0, plain.did], 'the load changed what a deposit does');
  const under = page('OPEN', { reserveSats: '100000', exposureCapSats: '150000', load: 0.6666 });
  under.paint();
  assert.equal(under.els['arena-fed-note'].style.display, 'none', 'a load under 1 says nothing');
});

// THE NOTE SAYS THE WALLET'S FEDERATION (2026-10-17): the lobby checks rounds of A (load 4.33) and B (0.72) in
// turn; the note followed whichever came last and came and went. It now says the one on the wallet's chip, and a round of another
// federation changes nothing - not its words, not whether it is shown.
test('the note follows the wallet\'s federation; rounds of another federation checked in turn leave it as it is', async () => {
  const A = '337ae01a'.padEnd(64, '0'), B = 'b18947f0'.padEnd(64, '0');
  const a = { status: 'OPEN', allows: FEDERATION_ALLOWS.OPEN, reserveSats: '650000', exposureCapSats: '150000', load: 4.3333 };
  const b = { status: 'OPEN', allows: FEDERATION_ALLOWS.OPEN, reserveSats: '108000', exposureCapSats: '150000', load: 0.72 };
  const p = page(null, { wallet: A });
  p.window.ARENA_FED_LOADS = new Map([[A, a], [B, b]]);
  const seen = [];
  let writes = 0; const note = p.els['arena-fed-note']; let text = '';
  Object.defineProperty(note, 'textContent', { get: () => text, set: (v) => { writes++; text = v; } });
  for (const [fed, st] of [[A, a], [B, b], [A, a], [B, b], [B, b]]) {
    p.window.ARENA_FED_STATUS = { ...st, federation: fed };
    p.paint();
    seen.push([note.style.display, note.textContent]);
  }
  const want = ['', 'Federation 337ae01a · Load 4.33: this federation holds 650,000 sat, more than the 150,000 sat its guardians\' bonds cover.'];
  assert.deepEqual(seen, Array(5).fill(want));
  assert.equal(writes, 1, 'the note was written once, not once per round');
  // a wallet in B: the same rounds, no note
  const q = page(null, { wallet: B }); q.window.ARENA_FED_LOADS = new Map([[A, a], [B, b]]);
  for (const [fed, st] of [[A, a], [B, b]]) { q.window.ARENA_FED_STATUS = { ...st, federation: fed }; q.paint(); assert.notEqual(q.els['arena-fed-note'].style.display, ''); }
  // no chip yet: nothing said, whatever round was checked
  const r = page('OPEN', { wallet: A }); r.window.ARENA_LEDGER_FEDERATION = undefined; r.window.ARENA_FED_STATUS = { ...a, federation: A }; r.paint();
  assert.equal(r.els['arena-fed-note'].textContent, '');
});

// RULED A (2026-10-12): a deposit at load >= 1 is refused on mainnet only - a test network shows and warns
test('load >= 1 refuses a deposit on a network that is not a test network, and on regtest and testnet4 refuses nothing', async () => {
  const MAIN = new Uint8Array(32).fill(0x6d);
  assert.equal(loadRefusesDeposit({ load: 4.3333, networkId: MAIN }), true);
  assert.equal(loadRefusesDeposit({ load: 1, networkId: MAIN }), true);
  assert.equal(loadRefusesDeposit({ load: 0.9999, networkId: MAIN }), false);
  assert.equal(loadRefusesDeposit({ load: 4.3333, networkId: NETWORK_ID_TESTNET4 }), false);
  assert.equal(loadRefusesDeposit({ load: 4.3333, networkId: NETWORK_ID_REGTEST }), false);
  assert.equal(loadRefusesDeposit({ load: null, networkId: MAIN }), false, 'no cap named: nothing to compare');
  // the page: an OPEN federation over its cover on mainnet refuses the deposit, naming the load; Withdraw still opens
  const fed = { reserveSats: '650000', exposureCapSats: '150000', load: 4.3333, loadRefusesDeposit: true };
  const p = page('OPEN', { ...fed, allows: { ...FEDERATION_ALLOWS.OPEN, deposit: false } });
  const r = await p.openMoney('deposit', () => {});
  assert.deepEqual(r, { ok: false, why: 'Load 4.33: this federation holds 650,000 sat, more than the 150,000 sat its guardians\' bonds cover. No deposit goes into it; play in another federation.' });
  assert.equal((await p.openMoney('withdraw', () => {})).ok, true);
});

// MOVE, OFFERED FROM THE OTHERS' SIGNED LOADS (§23A.3): every federation the seats list is checked against the
// census in one read (federationStatuses); the player's at 93 % and another at 40 % - Move is offered and the note says so
test('two signed federations: the one above 90 % offers Move to the one below 50 %, and the note says it', async () => {
  const A = new Uint8Array(32).fill(0x37), B = new Uint8Array(32).fill(0x38);
  const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret),
    guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]), guardianKeyB: Uint8Array.from([2, ...new Uint8Array(32).fill(0x70 + i)]) }; });
  const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(i), vout: 0, bondSats: 50000n,
    advert: { guardianOf: [{ federationId: A, guardianKey: n.guardianKey }, { federationId: B, guardianKey: n.guardianKeyB }] } }));
  const recordOf = (fed, key, reserveSats) => {
    const r = buildFederationRecord({ federationId: fed, networkId: NETWORK_ID_TESTNET4, invite: inviteForGuardians(fed, [{ url: 'wss://g.example/', peer: 0 }]), nominal: 7,
      height: 156200, reserveSats, guardians: census.map((e, i) => ({ peerKey: nodes[i][key], nodePubkey: e.pubkey, operatorId: '', bondTxid: e.txid, bondVout: 0, endpoint: '', bondSats: 50000n })) });
    const id = federationRecordId(r);
    return Buffer.from(joinSignedRecord(encodeFederationRecord(r), nodes.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })))).toString('hex');
  };
  const listed = [{ federation: Buffer.from(A).toString('hex'), record: recordOf(A, 'guardianKey', 140000n) },
    { federation: Buffer.from(B).toString('hex'), record: recordOf(B, 'guardianKeyB', 60000n) }];
  const fetcher = async () => new Response(JSON.stringify({ federations: listed }), { status: 200 });
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const all = await federationStatuses({ nodes: ['https://seat.example'], census, verify, fetcher });
  const a = all.get(listed[0].federation), b = all.get(listed[1].federation);
  assert.deepEqual([a.status, a.exposureCapSats, a.load, b.status, b.load], ['OPEN', '150000', 0.9333, 'OPEN', 0.4]);
  assert.deepEqual(await federationStatus({ federationIdHex: listed[1].federation, nodes: ['https://seat.example'], census, verify, fetcher }), b);
  const offer = moveOffer(a, [...all.values()]);
  assert.deepEqual(offer, { from: listed[0].federation, to: listed[1].federation, fromLoad: 0.9333, toLoad: 0.4 });
  assert.equal(moveOffer(b, [...all.values()]), null, 'the one at 40 % is offered nothing');
  const p = page('OPEN', { federation: listed[0].federation, load: 0.9333, move: offer });
  p.paint();
  assert.equal(p.els['arena-fed-note'].textContent, `Federation ${listed[0].federation.slice(0, 8)} · This federation is at 93 % load; federation ${listed[1].federation.slice(0, 16)} is at 40 %. Move is offered: your money can go there.`);
  const other = page('OPEN', { federation: listed[1].federation, load: 0.4, move: offer });
  other.paint();
  assert.equal(other.els['arena-fed-note'].style.display, 'none', 'an offer for another federation is not this one\'s note');
});

// THE DEPOSIT SCREEN'S SUMMARY (2026-10-12): funds, how many, health and capacity over all federations
test('custodySummary: funds, count, health band and free capacity over the verified federations; the line and tooltip say them', async () => {
  const { custodySummary, custodySays } = await import('../src/federations.js');
  const a = { federation: 'aa', status: 'OPEN', reserveSats: '650000', exposureCapSats: '150000', load: 4.3333 };
  const b = { federation: 'bb', status: 'OPEN', reserveSats: '0', exposureCapSats: '150000', load: 0 };
  const u = { federation: 'cc', status: 'unverified' };
  const s = custodySummary([a, b, u], { networkTest: true });
  assert.deepEqual([s.federations, s.open, s.reserveSats, s.capSats, s.freeSats, s.load, s.band], [2, 2, '650000', '300000', '150000', 2.1666, 'red']);
  const said = custodySays(s);
  assert.equal(said.line, '2 federations · 650,000 sat held · health 217 % · capacity 300,000 sat (150,000 sat free)');
  assert.match(said.tip, /Still free before deposits stop: 150,000 sat\..*This is a test network/);
  assert.equal(custodySummary([{ ...b, reserveSats: '100000' }]).band, 'green', '0.6666');
  assert.equal(custodySummary([{ ...b, reserveSats: '120000' }]).band, 'yellow', '0.8');
  assert.equal(custodySays(custodySummary([])).line, 'Federations: none verified yet');
});
