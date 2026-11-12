// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 a44 refute-87-s1-2 (kanban #2184): THE SAME, WITH TAB A FROZEN PAST CLAIM_INTENT_CLEAR_MS - tab B clears the record, A keeps its notes at a spill record.
// Tab A writes its intent and awaits sendAllEcash (the notes leave the shared wallet store); its answer comes back after 120 s (a frozen or
// throttled background tab). Tab B finds A's intent older than CLAIM_INTENT_LIVE_MS, drops it, its wallet holds nothing, and it clears the
// record. A's `kept` step now fails the compare-and-set, receiveEcash cannot take them back (the federation is halted), the notes are kept
// in memory only and posted once to a door that answers 503: closing the tab loses them. Safe: a note that left a wallet is kept somewhere.
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
const keptNotes = (store, notes) => notes.filter((n) => [...store.values()].some((v) => typeof v === 'string' && v.includes(n)));
test('wf1489-a44-refute-87-s1-2: tab A frozen past CLAIM_INTENT_CLEAR_MS - its notes go to a spill record, never memory only, and a later pass presents them', async () => {
  const { store, base, posted } = world();
  let rel; const slow = new Promise((r) => { rel = r; });
  let pool = ['notes-X'];
  const handed = [];
  const wal = (s) => ({ sendAllEcash: async () => { const n = pool.join('|'); pool = []; if (s) await s; if (n) handed.push(n); return JSON.stringify({ ecash: n || null }); }, receiveEcash: async () => { throw new Error('the federation is halted'); }, pendingOutputs: async () => '[]' });
  const a = presentNotes({ ...base, walletFor: async () => wal(slow), payoutPk: PX, nowMs: 1000 });
  await new Promise((r) => setTimeout(r, 10));
  await presentNotes({ ...base, walletFor: async () => wal(null), payoutPk: PX, nowMs: 1000 + 2 * 3600000 });
  assert.equal(store.get(pendingClaimKey(FED)), undefined, 'an intent older than the write-back window is cleared');
  rel(); const outA = await a;
  assert.ok(!outA.some((x) => x.memoryOnly), 'kept in storage, not in memory only');
  const spill = JSON.parse(store.get(spillClaimKey(pendingClaimKey(FED), 0)));
  assert.deepEqual([spill.state, spill.ecash, spill.payoutPk], ['kept', 'notes-X', PX]);
  assert.equal(posted.length, 1);
  // the next start (a door that answers now) presents the spill record again and marks it posted
  const ok = world(true);
  for (const [k, v] of store) ok.store.set(k, v);
  await presentNotes({ ...ok.base, walletFor: async () => wal(null), payoutPk: PX, nowMs: 1000 + 3 * 3600000 });
  assert.deepEqual(ok.posted.map((p) => p.ecash), ['notes-X']);
  assert.equal(JSON.parse(ok.store.get(spillClaimKey(pendingClaimKey(FED), 0))).state, 'posted');
  console.log('FACTS ' + JSON.stringify({ a: outA.map((x) => x.why), store: [...ok.store.keys()] }));
});
