// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute of #1849 (variant 2): THE DOOR SAYS "NOT BEING LIQUIDATED" WHILE THE FEDERATION IS STILL HALTED.
// The arbitration door answers 409 "that federation is not being liquidated: no seat holds it HALTED" also before the seats take the
// HALTED record (gatherAll every 10 min; kanban #1264 names this answer). #1849 then calls the wallet's receiveEcash on the kept notes,
// assuming "a federation still halted cannot reissue, and the record stays" - but the lock client's receiveEcash (lib.rs receive_ecash)
// submits the reissue and awaits await_final_receive_operation_state, which a halted federation never reaches: it does not throw,
// it never answers. The whole presentNotes pass hangs there, with no timeout, and every other held federation's claim (and this
// one's pending outputs) is never presented in that pass - the page's claims stop until the tab is reloaded, and stop again each pass.
// Invariant: a federation the door does not list cannot keep another federation's notes from being presented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventMessage } from '../../arena-protocol/src/arbitration-event.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { presentNotes } from '../../arena-client/src/liquidation-claim.js';

const FED1 = 'ab'.repeat(32), FED2 = 'cd'.repeat(32);
const SET = (() => {
  const secrets = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const keys = secrets.map((x) => toHex(schnorr.getPublicKey(x)));
  return { terms: { keys, k: 2 }, verify: (sig, msg, key) => schnorr.verify(sig, msg, key),
    sign: (event) => ({ event, signatures: secrets.slice(0, 2).map((x, i) => ({ key: keys[i], sig: toHex(schnorr.sign(eventMessage(event), x)) })) }) };
})();

test('#1489 a44-refute-94-s1-2 a still-halted federation the door does not list yet does not stall the other federations\' claims', async () => {
  const posted = [];
  // FED1: halted, the door's seats have not taken its HALTED record yet; FED2: listed, its claims taken
  const fetcher = async (_url, o) => {
    const b = JSON.parse(o.body); posted.push(b.federation);
    const r = b.federation === FED1 ? { ok: false, status: 409, why: 'that federation is not being liquidated: no seat holds it HALTED' }
      : { ok: true, status: 200, accepted: [{ nonce: 'n', amountMsat: '1000' }], refused: [] };
    return { ok: r.ok, status: r.status, json: async () => r };
  };
  const walletOf = (fid) => ({
    sendAllEcash: async () => JSON.stringify({ msat: 1000, ecash: `notes-of-${fid.slice(0, 4)}` }),
    // a halted federation: the reissue is submitted and its final state is never reached
    receiveEcash: async () => new Promise(() => {}),
    pendingOutputs: async () => '[]',
  });
  const wallets = { [FED1]: walletOf(FED1), [FED2]: walletOf(FED2) };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const ev = (fid) => SET.sign({ kind: 'liquidation', network: 'regtest', federation: fid, status: 'claims open', halt: { height: 1000, proof: null },
    door: 'http://arb.example', firstMs: 1, atMs: 1 });
  const run = presentNotes({ events: [ev(FED1), ev(FED2)], network: 'regtest', arbitration: SET.terms, verify: SET.verify, held: [FED1, FED2],
    walletFor: async (f) => wallets[f], payoutPk: '02' + '33'.repeat(32), height: 1012, storage, fetcher, put: (s, k, v) => s.setItem(k, v), nowMs: 1_000_000 });
  const out = await Promise.race([run, new Promise((r) => setTimeout(() => r('STALLED'), 5000))]);
  console.log('  FACTS:', JSON.stringify({ out, posted }));
  assert.notEqual(out, 'STALLED', `the pass hangs in FED1's receiveEcash: presented only ${JSON.stringify(posted)}, FED2's notes never reach the door`);
  assert.ok(posted.includes(FED2));
});
