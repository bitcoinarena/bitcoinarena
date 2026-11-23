// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 fix-refute a44 item 74 (kanban #1776), skeptic 2, retry path: the key move now sends 2 + 2n chained transactions (funding,
// bond, then per old bond a step-out funding and a step-out). If a step-out funding is refused as "missing inputs" (an Electrum backend
// behind a balancer that has not seen the bond yet, or any chained child sent before its parent propagated) and is not seen anywhere,
// settleOpen voids the WHOLE action - while the new bond it just sent is in the mempool. VOID: no key swap, no ops (state never records the
// new bond), and the next ask builds a SECOND new bond under the words' key. Invariant: a key move whose new bond the chain accepted is
// never void; it stays open and its step-outs are sent again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { switchToSeedKey } from '../src/identity-switch.js';
import { nodeState } from '../src/state.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('wf1489-a44-refute-74-s2-1: a refused step-out never voids a key move whose new bond is already accepted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-a44-74-s2-1-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const random = new Uint8Array(32).fill(6);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB, pubkey BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?, ?)').run(random, schnorr.getPublicKey(random)); db.close();
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 170000 } });
  const accepted = new Map();   // txid -> index in its call
  let n = 0;
  const txidOf = (hex) => toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse());
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 200000 }] }),
    broadcast: async (_c, hex) => {
      n += 1;
      // the third transaction of the first move - the step-out funding, spending the bond's change - reaches a backend without the bond
      if (n === 3) throw new Error('bad-txns-inputs-missingorspent');
      const id = txidOf(hex); accepted.set(id, n); return id;
    },
    seen: async (_c, txid) => accepted.has(txid) };

  const r1 = await switchToSeedKey({ home, release: home, state, chainKit, post: true, nowMs: 1000 });
  const s1 = state.read();
  const last1 = Object.values((s1.onchain && s1.onchain.last) || {})[0];
  const newBond = last1 ? last1.txids[1] : null;
  assert.ok(!newBond || accepted.has(newBond), 'the new bond was sent');
  assert.ok(!(last1 && last1.phase === 'void' && accepted.has(newBond)),
    `the move went VOID (${r1.why}) while its new bond ${String(newBond).slice(0, 16)} is in the mempool: no key swap, no record of that bond`);

  // and the next ask (the owner page reloads) must not build a second bond
  const before = accepted.size;
  await switchToSeedKey({ home, release: home, state, chainKit, post: true, nowMs: 2000 });
  const bondsSent = [...accepted.keys()].slice(before).length;
  assert.equal(bondsSent, 0, 'a reload after the refused step-out built and sent a second new bond');
});

// kanban #2291: the same when the backend refuses the step-out funding again at once - the move stays OPEN (never void), and the next ask
// sends the SAME step-outs and finishes the key swap; nothing new is built
test('wf1489-a44-refute-74-s2-1b: a step-out refused twice keeps the key move open; the next ask sends the same bytes, no second bond', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-a44-74-s2-1b-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const random = new Uint8Array(32).fill(6);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB, pubkey BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?, ?)').run(random, schnorr.getPublicKey(random)); db.close();
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 170000 } });
  const accepted = new Set();
  let n = 0;
  const txidOf = (hex) => toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse());
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 200000 }] }),
    broadcast: async (_c, hex) => { n += 1; if (n === 3 || n === 4) throw new Error('bad-txns-inputs-missingorspent'); const id = txidOf(hex); accepted.add(id); return id; },
    seen: async (_c, txid) => accepted.has(txid) };
  const r1 = await switchToSeedKey({ home, release: home, state, chainKit, post: true, nowMs: 1000 });
  assert.equal(r1.ok, false); assert.equal(r1.pending, true, `kept open, not void: ${r1.why}`);
  const open = state.read().onchain.open;
  assert.equal(open.phase, 'built'); assert.equal(open.txs.length, 4);
  const txids = open.txs.map((t) => t.txid);
  const r2 = await switchToSeedKey({ home, release: home, state, chainKit, post: true, nowMs: 2000 });
  assert.equal(r2.ok, true, String(r2.why));
  const s2 = state.read();
  assert.equal(s2.onchain.open, null);
  const last = Object.values(s2.onchain.last)[0];
  assert.equal(last.phase, 'done'); assert.deepEqual(last.txids, txids, 'the same action, the same bytes');
  assert.equal(s2.bond.txid, txids[1], 'the new bond recorded');
  for (const id of accepted) assert.ok(txids.includes(id), `only the move's own transactions were sent (${id.slice(0, 16)} is not one)`);
  assert.equal(accepted.size, 4);
});
