// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 refute of kanban #3064, variant 1: the fix reads the explorer's tip, and WITHOUT it the LOWEST federation record height. A record's
// height has an upper bound only (CENSUS_TIP_SLACK), no lower one. pendingTip() answers null on its first call (its fetch is async; the
// first claimLiquidations run is the page's load, line ~10055) and for good when the explorer is off ('arena.explorer' = off) or
// unreachable. One bonded seat's record of a made-up one-guardian federation at height 1 then makes the page's tip 1, and presentNotes
// answers 'claims open at ...' - the notes are never presented in the signed window, the same effect as the original attack, downward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationStatuses } from '../src/federations.js';
import { presentNotes } from '../src/liquidation-claim.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
// the page's own tip expression, as claimLiquidations computes it
const tipLine = HTML.split('\n').find((l) => l.includes('const tip = (() => {') && l.includes('ARENA_FED_LOADS'));

test('wf1489-r1120b-refute-2-s1-1: with no explorer tip, one seat\'s self-made federation record at height 1 holds the player\'s liquidation claim window', async () => {
  assert.ok(tipLine, 'claimLiquidations tip line found');
  const NET = new Uint8Array(32).fill(0x10);
  const CENSUS_H = 150000, REAL_TIP = 150020, HALT = 149980;   // halted 20 blocks before the census; the honest record (150000) alone is inside the window (149992..150124)
  // honest federation H: 4 guardians, bonded
  const H = new Uint8Array(32).fill(0x37), hHex = toHex(H);
  const honest = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
  // the attacker seat: one bonded census node; its own advert names a federation F of its own making
  const F = new Uint8Array(32).fill(0x99), fHex = toHex(F);
  const evil = { secret: new Uint8Array(32).fill(0x42) }; evil.pubkey = schnorr.getPublicKey(evil.secret); evil.guardianKey = Uint8Array.from([3, ...new Uint8Array(32).fill(0x77)]);
  const census = [
    ...honest.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(i), vout: 0, bondSats: 50000n, advert: { guardianOf: [{ federationId: H, guardianKey: n.guardianKey }] } })),
    { pubkey: evil.pubkey, txid: new Uint8Array(32).fill(9), vout: 0, bondSats: 50000n, advert: { guardianOf: [{ federationId: F, guardianKey: evil.guardianKey }] } },
  ];
  const recordOf = (fid, signers, entries, height, status) => {
    const r = buildFederationRecord({ federationId: fid, networkId: NET, invite: inviteForGuardians(fid, [{ url: 'wss://g.example/', peer: 0 }]), nominal: signers.length, height, status,
      guardians: entries.map((e) => ({ peerKey: e.advert.guardianOf[0].guardianKey, nodePubkey: e.pubkey, operatorId: '', bondTxid: e.txid, bondVout: 0, endpoint: '', bondSats: 50000n })) });
    const id = federationRecordId(r);
    return toHex(joinSignedRecord(encodeFederationRecord(r), signers.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }))));
  };
  const hRec = recordOf(H, honest, census.slice(0, 4), CENSUS_H, undefined);
  const fRec = recordOf(F, [evil], census.slice(4), 1, undefined);
  const fetcher = async (u) => new Response(JSON.stringify(String(u).includes('evil')
    ? { federations: [{ federation: hHex, record: hRec }, { federation: fHex, record: fRec }] }
    : { federations: [{ federation: hHex, record: hRec }] }), { status: 200 });
  const verifyRec = (sig, msg, key) => schnorr.verify(sig, msg, key);
  const all = await federationStatuses({ nodes: ['https://a.example', 'https://b.example', 'https://evil.example'], census, verify: verifyRec, fetcher, censusHeight: CENSUS_H });
  console.log('FACTS: statuses', JSON.stringify([...all].map(([k, v]) => [k.slice(0, 8), v.status, v.height])));
  // the page's tip, by its own expression
  const window = { ARENA_FED_LOADS: all };
  const pendingTip = () => ({ tipHeight: null });   // the explorer not read yet (first call) / off / unreachable
  // kanban #3144: the page's liq - the federations the arbitration set's signed liquidation events name (here H only)
  const liq = [{ federation: hHex }];
  const tip = new Function('window', 'pendingTip', 'liq', tipLine.trim() + '\nreturn tip;')(window, pendingTip, liq);
  console.log(`FACTS: page tip = ${tip}, real tip = ${REAL_TIP}`);
  // the arbitration set's signed liquidation of H (testnet4 clocks: opens halt+12, last paid halt+144)
  const secrets = [1, 2, 3].map((n) => new Uint8Array(32).fill(0x20 + n));
  const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
  const ev = { kind: 'liquidation', network: 'testnet4', federation: hHex, status: 'claims open', halt: { height: HALT, proof: null }, door: 'https://arb.example', firstMs: 1, atMs: 1 };
  const events = [{ event: ev, signatures: [0, 1].map((i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(ev), secrets[i])) })) }];
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const posted = [];
  const wallet = { sendAllEcash: async () => JSON.stringify({ msat: 768000, ecash: 'notes-1' }), receiveEcash: async () => '{}', pendingOutputs: async () => '[]' };
  const out = await presentNotes({ events, network: 'testnet4', arbitration: { keys, k: 2 }, verify: (s, m, k) => schnorr.verify(s, m, k), held: [hHex],
    walletFor: async () => wallet, payoutPk: '02' + '11'.repeat(32), height: tip, storage, put: (s, k, v) => s.setItem(k, v),
    fetcher: async (url, o) => { posted.push(url); return { ok: true, status: 200, json: async () => ({ accepted: [1] }) }; } });
  console.log('FACTS: presentNotes', JSON.stringify(out));
  assert.ok(tip >= HALT + 12, `the page judged the claim window at height ${tip}, ${REAL_TIP - tip} blocks before the real tip (the honest record alone says ${CENSUS_H}), because one seat's own federation record says so`);
  assert.ok(posted.length > 0, `the player's notes were never presented inside the signed window: ${out.map((x) => x.why).join('; ')}`);
});

// kanban #3144: the explorer's tip is READ AND WAITED FOR before the window is judged - pendingTip's first answer is null (its fetch is async)
test('wf1489-r1120b-refute-2-s1-1b: claimLiquidations waits for the explorer tip before it judges the claim window', async () => {
  const lines = HTML.split('\n');
  const at = (needle) => lines.findIndex((l) => l.includes(needle));
  const decl = lines[at('let pendingChain = {')];
  const a = HTML.indexOf('    function pendingTip() {'), b = HTML.indexOf('    async function pendingTipNow()');
  const now = lines[at('    async function pendingTipNow()')];
  assert.ok(decl && a > 0 && b > a && now, 'pendingTip / pendingTipNow found');
  let resolveTip; const fetched = [];
  const fetch = (u) => { fetched.push(u); return new Promise((res) => { resolveTip = () => res({ text: async () => '150020' }); }); };
  const ARENACLIENT = { explorerBaseFor: () => 'https://mempool.example/testnet4/api' };
  const window = { ARENA_BROWSER_STORE: () => ({ getItem: () => null }) };
  const fns = new Function('window', 'ARENACLIENT', 'fetch', 'AbortSignal', decl + '\n' + HTML.slice(a, b) + now + '\nreturn { pendingTip, pendingTipNow };')(window, ARENACLIENT, fetch, { timeout: () => null });
  const p = fns.pendingTipNow();
  await new Promise((r) => setTimeout(r, 5));
  resolveTip();
  const got = await p;
  assert.equal(got.tipHeight, 150020, 'the awaited read answers the explorer tip on the first call');
  assert.equal(fetched.length, 1);
  // and claimLiquidations awaits it before its tip line
  const cl = HTML.indexOf('    async function claimLiquidations() {');
  const body = HTML.slice(cl, HTML.indexOf('\n    }\n', cl));
  assert.ok(body.indexOf('await pendingTipNow()') > 0 && body.indexOf('await pendingTipNow()') < body.indexOf('const tip = (() => {'), 'claimLiquidations awaits the explorer tip before the tip line');
});
