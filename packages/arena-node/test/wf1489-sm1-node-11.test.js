// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit sm1 (node lifecycle: bond add on a seat set up by hand). Gap in #2182: the fix builds the seat's own
// check and the roles change on top of the newest advertisement SENT (advertInForce: sentUpdates + the owner's roles change in
// owner_actions while it is in the mempool). The owner page's Add to bond (POST /owner/add-bond -> addBondFromWallet) still builds the
// added output's body from inForceOf(bondsOf) - mined markers only - and postBond gives it a NEW timestamp. Owner turns custody off
// (roles update U1 in the mempool), then adds to the bond: the added output carries the old roles and guardian_capable = true with the
// newest timestamp. Mined one block after U1, the census (newestPerNode: higher block wins; #2426 freshOwn: strictly newer timestamp)
// reads the added output's body - the owner's change is undone on chain, and owner_actions answers "already" for 30 min.
// Run with --experimental-test-module-mocks (the bond tool is stubbed, as in wf1489-sm8-node-2.test.js).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const bytes = (b) => new Uint8Array(32).fill(b);
const NODE = bytes(2);
const B1 = { txid: 'a1'.repeat(32), vout: 0, sats: 100000, height: 100,
  advert: { nodePubkey: NODE, roles: ['game', 'verify'], guardianCapable: true, guardianEndpoint: 'https://g.example', guardianOf: [], hostedGames: [], protocolVersions: [1], operatorId: 'op', timestamp: 1n } };
const posted = [];
const added = [];
let n = 0;
mock.module('../tools/regtest-bond.mjs', { namedExports: { regtest: () => ({
  bondsOf: () => [B1],
  newestUpdateOf: () => null,   // the owner's roles update is still in the mempool
  prepareAdvertUpdate: (_s, advert) => ({ spk: bytes(0x99), advert }),
  postAdvertUpdate: (prepared) => { const txid = (++n).toString(16).padStart(2, '0').repeat(32); posted.push({ txid, advert: prepared.advert }); return { hex: `ad${n}`, txid }; },
  postBond: (_s, { advert }) => { added.push(advert); throw new Error('CAPTURED'); },
}) } });
const { changeRolesFromWallet, addBondFromWallet } = await import('../src/add-bond-wallet.js');

const mempool = new Set();
const cli = (m, ...a) => {
  if (m === 'decodescript') return JSON.stringify({ address: 'tb1p-carrier' });
  if (m === '-named') return JSON.stringify({ psbt: 'p', fee: 0.00000500 });
  if (m === 'walletprocesspsbt') return JSON.stringify({ psbt: 'p' });
  if (m === 'finalizepsbt') return JSON.stringify({ complete: true, hex: 'f0' });
  if (m === 'decoderawtransaction') return JSON.stringify({ txid: 'fe'.repeat(32), vout: [{ n: 0, scriptPubKey: { hex: '99'.repeat(32) } }] });
  if (m === 'testmempoolaccept') return JSON.stringify([{ allowed: true }, { allowed: true }]);
  if (m === 'sendrawtransaction') { const p = posted.find((x, i) => `ad${i + 1}` === a[0]); if (p) mempool.add(p.txid); return 'ok'; }
  if (m === 'getmempoolentry') { if (mempool.has(a[0])) return '{}'; throw new Error('error code: -5\nNo such mempool or blockchain transaction'); }
  if (m === 'getblockcount') return '100';
  throw new Error(`no ${m}`);
};
const store = new Map();
const journal = { last: (k) => store.get(k) || null, keep: (k, r) => store.set(k, r) };

test('wf1489-sm1-node-11: Add to bond sent while the owner\'s roles change is unconfirmed keeps the owner\'s change', async () => {
  const secret = bytes(1);
  // 1. the owner turns custody off and drops verify: kept in owner_actions and broadcast, in the mempool
  const owner = await changeRolesFromWallet({ cli, network: 'regtest', secret, pubkey: NODE, roles: ['game'], custody: false, post: true, journal, nowMs: 1_000 });
  assert.equal(owner.ok, true, owner.why);
  assert.ok(mempool.has(owner.update.txid));
  // 2. minutes later, the owner adds 20,000 sat to the bond from the same page
  await addBondFromWallet({ cli, network: 'regtest', secret, pubkey: NODE, addSats: '20000', post: true, journal, now: 2_000 })
    .catch((e) => { if (e.message !== 'CAPTURED') throw e; });
  assert.equal(added.length, 1, 'the added output was built');
  const body = added[0];
  console.log(`  MEASURED: owner's update roles=${posted[0].advert.roles.join(',')} custody=${posted[0].advert.guardianCapable}; the added output's body (newer timestamp, sent after) roles=${body.roles.join(',')} custody=${body.guardianCapable}`);
  // THE INVARIANT (#2182): every advertisement the seat sends while the owner's change is unconfirmed carries that change
  assert.deepEqual([...body.roles].sort(), ['game'], 'the added bond advertises the roles from before the owner\'s change');
  assert.equal(body.guardianCapable, false, 'the added bond makes the node guardian-capable again');
});
