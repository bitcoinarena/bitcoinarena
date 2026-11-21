// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit round 8 (node): a seat set up by hand (ARENA_BOND_CLI) builds every advertisement update from the
// advertisement CONFIRMED on the chain (regtest-bond.mjs newestUpdateOf reads mined markers only). The owner page's roles change
// (POST /owner/roles -> changeRolesFromWallet) is kept in owner_actions and broadcast; while it is unconfirmed the seat's own check
// (advert-self.js -> guardianOfFromWallet: a new guardian seat or a new hosted game version - apps update by themselves) builds its update
// from the advertisement before the owner's change, with the old roles and custody, and broadcasts it after. The census reads the update
// mined last (newestUpdates: later block / later position): the owner's change - custody off, a role dropped, stepping out - is undone
// on the chain, and asked again within 30 min it is answered "already" from owner_actions (its transaction is mined), nothing sent.
// Run with --experimental-test-module-mocks (the bond tool is stubbed, as in owner-action-once-1374.test.js).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const bytes = (b) => new Uint8Array(32).fill(b);
const GAME_OLD = bytes(0x41), GAME_NEW = bytes(0x42);
// the advertisement confirmed on the chain: game + verify, guardian-capable
const B1 = { txid: 'a1'.repeat(32), vout: 0, sats: 100000, height: 100,
  advert: { roles: ['game', 'verify'], guardianCapable: true, guardianEndpoint: 'https://g.example', guardianOf: [], hostedGames: [GAME_OLD], protocolVersions: [1], operatorId: 'op', timestamp: 1n } };
const posted = [];   // every advertisement update broadcast, in order
let n = 0;
mock.module('../tools/regtest-bond.mjs', { namedExports: { regtest: () => ({
  bondsOf: () => [B1],
  newestUpdateOf: () => null,          // the owner's update is still in the mempool: no mined marker names it
  prepareAdvertUpdate: (_secret, advert) => ({ spk: bytes(0x99), advert }),
  postAdvertUpdate: (prepared) => { const txid = (++n).toString(16).padStart(2, '0').repeat(32); posted.push({ txid, advert: prepared.advert }); return { hex: `ad${n}`, txid }; },
}) } });
const { changeRolesFromWallet, guardianOfFromWallet } = await import('../src/add-bond-wallet.js');

const mempool = new Set(), mined = new Set();
const cli = (m, ...a) => {
  if (m === 'decodescript') return JSON.stringify({ address: 'tb1p-carrier' });
  if (m === '-named') return JSON.stringify({ psbt: 'p', fee: 0.00000500 });
  if (m === 'walletprocesspsbt') return JSON.stringify({ psbt: 'p' });
  if (m === 'finalizepsbt') return JSON.stringify({ complete: true, hex: 'f0' });
  if (m === 'decoderawtransaction') return JSON.stringify({ txid: 'fu'.repeat(32), vout: [{ n: 0, scriptPubKey: { hex: '99'.repeat(32) } }] });
  if (m === 'testmempoolaccept') return JSON.stringify([{ allowed: true }, { allowed: true }]);
  if (m === 'sendrawtransaction') { const p = posted.find((x) => `ad${posted.indexOf(x) + 1}` === a[0]); if (p) mempool.add(p.txid); return 'ok'; }
  if (m === 'getmempoolentry') { if (mempool.has(a[0])) return '{}'; throw new Error('error code: -5\nNo such mempool or blockchain transaction'); }
  if (m === 'gettransaction') { if (mined.has(a[0])) return JSON.stringify({ confirmations: 3 }); throw new Error('error code: -5\nInvalid or non-wallet transaction id'); }
  throw new Error(`no ${m}`);
};
const store = new Map();
const journal = { last: (k) => store.get(k) || null, keep: (k, r) => store.set(k, r) };

test('wf1489-sm8-node-2: the seat\'s own advertisement update sent while the owner\'s roles change is unconfirmed keeps the owner\'s change', async () => {
  const secret = bytes(1);
  // 1. the owner steps the node out of custody and drops verify: the update is kept and broadcast, in the mempool
  const owner = await changeRolesFromWallet({ cli, network: 'regtest', secret, pubkey: bytes(2), roles: ['game'], custody: false, post: true, journal, nowMs: 1_000 });
  assert.equal(owner.ok, true, owner.why);
  assert.ok(mempool.has(owner.update.txid));
  // 2. the seat's own check (advert-self) a few minutes later: a new version of a hosted game to announce
  const self = await guardianOfFromWallet({ cli, network: 'regtest', secret, guardianOf: [], keep: true, hostedGames: [GAME_NEW], post: true });
  assert.equal(self.ok, true, self.why);
  const last = posted[posted.length - 1];
  console.log(`  MEASURED: owner's update ${posted[0].advert.roles.join(',')} custody=${posted[0].advert.guardianCapable}; the seat's update sent after it ${last.advert.roles.join(',')} custody=${last.advert.guardianCapable}`);
  // THE INVARIANT: the update broadcast last (the one the census reads once both are mined in that order) carries the owner's change
  assert.deepEqual([...last.advert.roles].sort(), ['game'], 'the seat\'s update advertises the roles from before the owner\'s change');
  assert.equal(last.advert.guardianCapable, false, 'the seat\'s update makes the node guardian-capable again');
});
