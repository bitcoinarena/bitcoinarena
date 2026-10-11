// WHAT THE PAGE DOES UNDER A FEDERATION'S SIGNED STATUS (spec §23A.1 / §23A.4, kanban #321), on the page's own code
// (page-script.js): CRITICAL leaves Withdraw and Move only - Deposit refused by name, its buttons hidden; DRAINING closes
// Deposit and nothing else; HALTED closes everything; OPEN and "unverified" change nothing. And the client's own
// federationStatus: a record signed by the threshold of the census' bonded guardians is believed, anything else is
// "unverified".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { pageFunction } from './page-script.js';
import { federationStatus, federationSays, FEDERATION_ALLOWS } from '../src/federations.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, from.slice(0, 40)); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const PAINT = slice('    window.ARENA_PAINT_FEDERATION = () => {', '\n    };\n');
const OPEN = slice('    function openMoney(which, say = ', '\n      })();\n    }\n');

function page(status) {
  const els = {}; const classes = new Set();
  const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {} });
  for (const id of ['arena-fed-note', 'blwp-money-why', 'blwp-settings']) el(id);
  const document = { getElementById: (id) => els[id] || null, body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) } } };
  const window = { ARENA_FED_STATUS: status ? { status, allows: FEDERATION_ALLOWS[status] } : undefined };
  const did = [];
  const BLWPCLIENT = { federationSays, depositDonationMsat: () => 0n, marketForRound: () => null, settingsDepositOffer: async () => { did.push('offer'); return {}; } };
  const fn = pageFunction(PAGE, ['document', 'window', 'BLWPCLIENT', 'moneyContext', 'openWithdraw', 'showDepositOffer', 'donationBps', 'vault'],
    [PAINT, OPEN], 'return { paint: window.ARENA_PAINT_FEDERATION, openMoney };');
  const api = fn(document, window, BLWPCLIENT, () => ({ ok: true, round: { stakeMsat: 1n }, invite: 'fed1', seed: 's', gateways: [] }),
    () => did.push('withdraw'), () => did.push('modal'), () => 0, () => ({}));
  return { ...api, els, classes, did };
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
  const css = slice('    body.arena-fed-draining #blwp-deposit-go', '{ display: none; }');
  assert.match(css, /body\.arena-fed-critical #blwp-deposit-go, body\.arena-fed-critical #arena-wb-deposit/);
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
