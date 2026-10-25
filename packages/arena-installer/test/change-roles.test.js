// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN INSTALLED NODE CHANGES ITS ROLES (kanban #563): the plan (before, after, fee), then the advertisement update from the node's own
// wallet - signed against the bond, the roles asked, the endpoint, guardian seat and emergency key kept; custody refused here; the
// installer's 'verify' standing for the advertisement's game and verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { changeRolesOnNode, stateRolesFor } from '../src/change-roles.js';
import { nodeState } from '../src/state.js';
import { emergencyOf } from '../src/seed.js';
import { readAdvertUpdate, checkAgainstBond } from '../../arena-protocol/src/advert-update.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

function node(roles) {
  const home = mkdtempSync(join(tmpdir(), 'roles-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const nodeSecret = new Uint8Array(32).fill(6);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(nodeSecret); db.close();
  state.save({ roles, chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 20000 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  return { home, state, nodeSecret, sent, chainKit };
}

test('game / verify and settlement to settlement and relay: the plan, then the update signed against the bond, with everything else kept', async () => {
  const n = node(['verify', 'settlement']);
  const plan = await changeRolesOnNode({ home: n.home, release: n.home, state: n.state, roles: ['settlement', 'relay'], chainKit: n.chainKit });
  assert.equal(plan.ok, true, plan.why);
  assert.deepEqual([plan.plan.before.roles, plan.plan.after.roles], [['game', 'settlement', 'verify'], ['relay', 'settlement']]);
  assert.ok(Number(plan.plan.feeSats) > 0 && Number(plan.plan.feeSats) < 2000, plan.plan.feeSats);
  assert.equal(n.sent.length, 0, 'the plan sends nothing');
  const r = await changeRolesOnNode({ home: n.home, release: n.home, state: n.state, roles: ['settlement', 'relay'], post: true, chainKit: n.chainKit });
  assert.equal(r.ok, true, r.why);
  assert.equal(n.sent.length, 2, 'the funding and the update');
  const read = readAdvertUpdate(fromHex(n.sent[1]), { network: 'testnet4' });
  const ok = await checkAgainstBond(read, { txid: fromHex('77'.repeat(32)).reverse(), vout: 0, nodePubkey: schnorr.getPublicKey(n.nodeSecret) }, (s, m, k) => schnorr.verify(s, m, k));
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual([...read.advert.roles].sort(), ['relay', 'settlement']);
  assert.equal(read.advert.endpoint, 'https://node.example.com');
  assert.equal(read.advert.bondMaturityHeight, 157057);
  assert.equal(toHex(read.advert.emergencyPubkey), emergencyOf(fromHex('11'.repeat(32))).pubkey, 'the emergency key kept');
  assert.deepEqual(n.state.read().roles, ['settlement', 'relay']);
  assert.equal(n.state.read().rolesUpdate.txid, r.update.txid);
});

test('refused: custody switched here, an unknown role, no role at all, the roles it has, no bond', async () => {
  const n = node(['verify', 'custody']);
  const go = (o) => changeRolesOnNode({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit, ...o });
  assert.match((await go({ roles: ['verify'], custody: false })).why, /custody is left with LEAVE/);
  assert.match((await go({ roles: ['verify', 'mining'] })).why, /mining: not a role an advertisement names/);
  assert.match((await go({ roles: ['game', 'verify'] })).why, /already advertises/);
  const p = node(['verify']);
  assert.match((await changeRolesOnNode({ home: p.home, release: p.home, state: p.state, chainKit: p.chainKit, roles: [] })).why, /no role at all/);
  assert.match((await changeRolesOnNode({ home: p.home, release: p.home, state: p.state, chainKit: p.chainKit, roles: ['settlement'], custody: true })).why, /installer's custody step/);
  p.state.save({ bond: null });
  assert.match((await changeRolesOnNode({ home: p.home, release: p.home, state: p.state, chainKit: p.chainKit, roles: ['settlement'] })).why, /no bond/);
  assert.equal(n.sent.length + p.sent.length, 0);
  assert.deepEqual(stateRolesFor(['game', 'settlement'], ['verify', 'custody', 'liquidity']), ['verify', 'settlement', 'custody', 'liquidity']);
});

// THE NEWEST GAMES IN THE ADVERTISEMENT (2026-10-25: "Make sure the installer and the nodes use the newest versions of games"):
// a node whose advertisement names Next Block's first version alone gets an update naming every version of its apps; once named, nothing
test('an update names every game of the node\'s apps when its advertisement does not, and nothing when it does', async () => {
  const { refreshHostedGames } = await import('../src/change-roles.js');
  const { hostedGameIdsOf } = await import('../src/apps.js');
  const repo = join(import.meta.dirname, '..', '..', '..');
  const n = node(['verify', 'settlement']);
  n.state.save({ apps: ['nextblock', 'btc-updown', 'rock-paper-scissors'] });
  const want = await hostedGameIdsOf(repo, ['nextblock', 'btc-updown', 'rock-paper-scissors']);
  assert.ok(want.length > 30, `every version: ${want.length}`);
  const plan = await refreshHostedGames({ home: n.home, release: repo, state: n.state, chainKit: n.chainKit });
  assert.deepEqual([plan.ok, plan.plan.before, plan.plan.after], [true, 1, want.length], plan.why);
  const r = await refreshHostedGames({ home: n.home, release: repo, state: n.state, chainKit: n.chainKit, post: true });
  assert.equal(r.ok, true, r.why);
  const read = readAdvertUpdate(fromHex(n.sent[1]), { network: 'testnet4' });
  assert.deepEqual(read.advert.hostedGames.map((g) => toHex(g)), want, 'the advertisement names them, sorted');
  assert.deepEqual([...read.advert.roles].sort(), ['game', 'settlement', 'verify'], 'the roles kept');
  assert.deepEqual(n.state.read().hostedGames, want);
  const { SUPPORTED_PROTOCOL_VERSIONS } = await import('../../arena-protocol/src/constants.js');
  assert.deepEqual([...read.advert.protocolVersions], [...SUPPORTED_PROTOCOL_VERSIONS], 'and the newest protocols');
  assert.deepEqual(n.state.read().advertProtocols, [...SUPPORTED_PROTOCOL_VERSIONS]);
  assert.deepEqual(await refreshHostedGames({ home: n.home, release: repo, state: n.state, chainKit: n.chainKit, post: true }), { ok: true, unchanged: true });
  assert.equal(n.sent.length, 2, 'nothing more sent');
});

test('a node that names its games but declares older protocols is updated to the newest ones', async () => {
  const { refreshHostedGames } = await import('../src/change-roles.js');
  const { hostedGameIdsOf } = await import('../src/apps.js');
  const repo = join(import.meta.dirname, '..', '..', '..');
  const n = node(['verify']);
  const want = await hostedGameIdsOf(repo, ['nextblock']);
  n.state.save({ apps: ['nextblock'], hostedGames: want, advertProtocols: [1, 2, 3] });
  const r = await refreshHostedGames({ home: n.home, release: repo, state: n.state, chainKit: n.chainKit, post: true });
  assert.deepEqual([r.ok, r.plan.added, r.plan.protocolsBefore], [true, 0, 3], r.why);
  assert.equal(n.sent.length, 2);
});
