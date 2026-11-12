// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489, state machine audit round 9 (node lifecycle): A KEY MOVE FINISHED BY ANOTHER DOOR NEVER RESTARTS THE SEAT.
// POST /owner/key-from-words restarts the seat only when switchToSeedKey answers a `bond` (server.js: `if (r.bond)` spawns the restart);
// the seat reads its key from node.db once, at start. The key-switch is an on-chain action (onchain-action.js): broadcast, SENT, then the
// effect swaps node.db's identity in a BEGIN IMMEDIATE - which throws SQLITE_BUSY at once (no busy timeout) whenever the running seat holds
// a write transaction at that moment. The action stays open ("sent again at the next try"), and EVERY door of the wallet finishes it first
// (resumeOpen: the owner page's Add-to-bond plan, the roles change, the update's games refresh, the custody agent's tick) - none of which
// restarts the seat. From then on switchToSeedKey answers { already } (node.db holds the words' key), so no door ever restarts it: the
// running seat keeps signing as the old key while node.db and state.json name the new key and the new bond, which the census then draws
// with nobody answering as it (and the next update's "same node" check sees another key and rolls back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { switchToSeedKey } from '../src/identity-switch.js';
import { addBond } from '../src/add-bond.js';
import { nodeState } from '../src/state.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('a key move whose node.db swap was busy and is finished by another door still answers the move, so the seat is restarted on the new key', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-sm9-node-2-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const random = new Uint8Array(32).fill(6);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB, pubkey BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?, ?)').run(random, schnorr.getPublicKey(random));
  db.exec('CREATE TABLE rounds (id INTEGER)');
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 }, done: { service: 1 } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 200000 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };

  // THE RUNNING SEAT WRITES (its connection `db` holds a write transaction) at the moment of the owner's move
  db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO rounds VALUES (1)').run();
  const moved = await switchToSeedKey({ home, release: home, state, chainKit, post: true });
  db.exec('COMMIT');
  assert.equal(sent.length, 2, 'the new bond went to the chain');
  assert.equal(moved.ok, false, 'the key swap was busy: the move stays open');
  assert.equal(!!moved.bond, false, 'no bond answered: server.js does not restart the seat');

  // the owner opens Add to bond (its plan finishes any open action of the wallet first) - or the roles, the update's games refresh, the agent
  await addBond({ state, addSats: 20000, chainKit, softwareHash: new Uint8Array(32) });
  const now = toHex(new Uint8Array(db.prepare('SELECT pubkey FROM identity WHERE one = 0').get().pubkey));
  assert.notEqual(now, toHex(schnorr.getPublicKey(random)), 'node.db now holds the words\' key (the effect ran inside the add-bond plan)');
  db.close();

  // the owner page's key panel asks again on its next load: the move it finished must be answered as one, so the seat restarts on it
  const again = await switchToSeedKey({ home, release: home, state, chainKit });
  assert.ok(again.bond, `the finished move is never answered with its bond (${JSON.stringify(again)}): POST /owner/key-from-words restarts the seat only on r.bond, `
    + 'so the running seat keeps signing as the old key while node.db and state.json name the new one');
});
