// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 a44 refute-87-s2-1 (refute of kanban #2184 on eba26f708): A SPILL RECORD IS SCANNED ONLY UNDER THE CLAIM KEY OF THE PASS THAT READS IT.
// spillClaimKey(eKey, n) hangs off claimSlot(storage, base, pk), and claimSlot moves with storage: the plain key while it is free or this
// phrase's, <base>.<hex> while another phrase (the second phrase of this browser) holds it. Notes spilled under one slot are never scanned
// after a reload under the other, and the other phrase skips them (its payoutPk) - kept, but never presented while the window is open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { presentNotes, pendingClaimKey, spillClaimKey } from '../src/liquidation-claim.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const FED = 'ab'.repeat(32);
const secrets = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
const SET = { keys, k: 2 };
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const event = { kind: 'liquidation', network: 'regtest', federation: FED, status: 'claims open', halt: { height: 1000, proof: null },
  door: 'http://arb.example', firstMs: 1, atMs: 1 };
const events = [{ event, signatures: [0, 1].map((i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(event), secrets[i])) })) }];
const PX = '02' + '11'.repeat(32), PY = '02' + '22'.repeat(32);

function world(fetchOk = false) {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: (k) => { store.delete(k); } };
  const put = (s, k, v) => s.setItem(k, v);
  const posted = [];
  const fetcher = async (u, o) => { posted.push(JSON.parse(o.body)); return fetchOk ? { ok: true, status: 200, json: async () => ({ accepted: [] }) } : { ok: false, status: 503, json: async () => ({ why: 'restarting' }) }; };
  const base = { events, network: 'regtest', arbitration: SET, verify, held: [FED], height: 1012, storage, fetcher, put };
  return { store, storage, base, posted };
}
const wal = (pool, s) => ({ sendAllEcash: async () => { const n = pool.splice(0).join('|'); if (s) await s; return JSON.stringify({ ecash: n || null }); }, receiveEcash: async () => { throw new Error('the federation is halted'); }, pendingOutputs: async () => '[]' });
const tick = () => new Promise((r) => setTimeout(r, 10));

test('wf1489-a44-refute-87-s2-1: X spills at <base>~0, phrase Y then takes the plain key - X reloads and never presents its notes', async () => {
  const { store, base } = world();
  let rel; const slow = new Promise((r) => { rel = r; });
  const poolX = ['notes-X'];
  const a = presentNotes({ ...base, walletFor: async () => wal(poolX, slow), payoutPk: PX, nowMs: 1000 });
  await tick();
  await presentNotes({ ...base, walletFor: async () => wal(poolX, null), payoutPk: PX, nowMs: 1000 + 2 * 3600000 });
  rel(); await a;
  const spillKey = spillClaimKey(pendingClaimKey(FED), 0);
  assert.equal(JSON.parse(store.get(spillKey)).ecash, 'notes-X', 'setup: X spilled at <base>~0');
  // phrase Y of the same browser starts and hands its notes over at the plain key, which is free now
  const ok = world(true); for (const [k, v] of store) ok.store.set(k, v);
  await presentNotes({ ...ok.base, walletFor: async () => wal(['notes-Y'], null), payoutPk: PY, nowMs: 1000 + 3 * 3600000 });
  // X reloads: the door answers now - its spilled notes must be presented
  ok.posted.length = 0;
  await presentNotes({ ...ok.base, walletFor: async () => wal([], null), payoutPk: PX, nowMs: 1000 + 4 * 3600000 });
  console.log('FACTS ' + JSON.stringify({ posted: ok.posted.map((p) => [p.ecash, p.payoutPk.slice(0, 6)]), keys: [...ok.store.keys()] }));
  assert.ok(ok.posted.some((p) => p.ecash === 'notes-X' && p.payoutPk === PX), 'X\'s spilled notes are presented after a reload');
});

test('wf1489-a44-refute-87-s2-1b: X spills at <base>.<hex>~0 while Y holds the plain key; Y\'s record clears - X reloads and never presents', async () => {
  const { store, base } = world();
  // phrase Y writes its intent at the plain key and awaits its (empty) hand-over
  let relY; const slowY = new Promise((r) => { relY = r; });
  const y = presentNotes({ ...base, walletFor: async () => wal([], slowY), payoutPk: PY, nowMs: 1000 });
  await tick();
  // phrase X, two tabs: A frozen past the write-back window, B clears the record - A spills under X's own slot
  let rel; const slow = new Promise((r) => { rel = r; });
  const poolX = ['notes-X'];
  const a = presentNotes({ ...base, walletFor: async () => wal(poolX, slow), payoutPk: PX, nowMs: 1000 });
  await tick();
  await presentNotes({ ...base, walletFor: async () => wal(poolX, null), payoutPk: PX, nowMs: 1000 + 2 * 3600000 });
  rel(); await a;
  const spilled = [...store.entries()].filter(([k, v]) => k.includes('~') && v.includes('notes-X')).map(([k]) => k);
  assert.equal(spilled.length, 1, 'setup: X spilled once'); assert.ok(spilled[0] !== spillClaimKey(pendingClaimKey(FED), 0), 'setup: under X\'s own slot');
  relY(); await y;   // Y's wallet held nothing: its record goes to none, the plain key is free
  const ok = world(true); for (const [k, v] of store) ok.store.set(k, v);
  await presentNotes({ ...ok.base, walletFor: async () => wal([], null), payoutPk: PX, nowMs: 1000 + 3 * 3600000 });
  console.log('FACTS ' + JSON.stringify({ spilled, posted: ok.posted.map((p) => p.ecash), keys: [...ok.store.keys()] }));
  assert.ok(ok.posted.some((p) => p.ecash === 'notes-X'), 'X\'s spilled notes are presented after a reload');
});
