// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit, node lifecycle (sm1-node-4): A CUSTODY NODE'S FIRST BOND IS RECORDED BEFORE ITS CUSTODY AGENT IS INSTALLED,
// AND NOTHING EVER INSTALLS THE AGENT AFTERWARDS. POST /owner/first-bond (add-bond.js firstBond) runs the bond as an on-chain action: BUILT ->
// SENT -> DONE writes state.bond; only then is the custody agent installed (startAgent) and custodyAgent.installedMs saved. When the seat dies
// between the two (a restart, the owner page's own "restart node", the machine) - or the install answers a failure once - every later ask
// returns { done: true } at the top ("bondsOf(s).length"), before the agent step: the custody / liquidity node keeps a posted bond and no agent
// for good (no guardian_of, no peg-in, no deposit). Invariant: a custody or liquidity node with a recorded bond either has its agent installed
// or the next first-bond ask installs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { firstBond } from '../src/add-bond.js';
import { nodeState } from '../src/state.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

function custodyNode() {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-sm1-node-4-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), toHex(new Uint8Array(32).fill(9)));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)');
  db.prepare('INSERT INTO identity (one, secret) VALUES (0, ?)').run(new Uint8Array(32).fill(4));
  db.close();
  state.save({ chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, roles: ['verify', 'settlement', 'custody'], reach: { url: 'https://node.example.com' },
    done: { service: 1 }, custody: { pegInSats: 0 } });
  return { home, state };
}
const kit = (sent) => ({ coinsOf: async () => ({ tip: 157070, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 400000, height: 157000 }] }),
  broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); },
  seen: async () => true });

test('the seat dies after the first bond is recorded, before the custody agent is installed: the next ask installs the agent', async () => {
  const { home, state } = custodyNode();
  const sent = [];
  // the first post: the bond goes out and is recorded; the agent's install never answers (the seat is killed while systemctl runs)
  let installs = 0;
  const hanging = () => { installs++; return new Promise(() => {}); };
  const first = firstBond({ state, chainKit: kit(sent), askMinimum: null, startAgent: hanging, post: true });
  for (let i = 0; i < 200 && installs === 0; i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(installs, 1, 'the first post reached the agent step');
  void first;
  const after = nodeState(home);   // the restarted seat: the state as the disk holds it
  assert.ok(after.read().bond && after.read().bond.txid, 'the bond is recorded');
  assert.equal(after.read().custodyAgent, undefined, 'and no agent was recorded');
  // the owner asks again after the restart (the Bond panel asks every 30 s)
  const started = [];
  const r = await firstBond({ state: after, chainKit: kit(sent), askMinimum: null, startAgent: async () => { started.push(1); return { ok: true }; }, post: true });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 2, 'no second bond was sent');
  assert.equal(started.length, 1, 'the custody agent of a custody node with a posted bond is installed by the next ask');
  assert.ok((after.read().custodyAgent || {}).installedMs, 'and recorded installed');
});

test('the agent install fails once: a later first-bond ask tries it again', async () => {
  const { state } = custodyNode();
  const sent = [];
  const r1 = await firstBond({ state, chainKit: kit(sent), askMinimum: null, startAgent: async () => ({ ok: false, why: 'Failed to connect to bus' }), post: true });
  assert.equal(r1.ok, true);
  assert.equal(r1.agent.ok, false);
  const started = [];
  await firstBond({ state, chainKit: kit(sent), askMinimum: null, startAgent: async () => { started.push(1); return { ok: true }; }, post: true });
  assert.equal(started.length, 1, 'the failed agent install is tried again');
  assert.ok((state.read().custodyAgent || {}).installedMs, 'and recorded installed');
});
