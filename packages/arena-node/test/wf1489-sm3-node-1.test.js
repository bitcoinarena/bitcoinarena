// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 sm3 node-1 (state machine audit, node lifecycle: stepping out with serving = false).
// A node with two bond outputs (its first 50,000 sat, an added 32,000 sat output posted later - kanban #544) steps out with the
// step-out tool (testnet4-step-out.mjs / testnet4-advert-update.mjs ARENA_ADVERT_SERVING=false), which updates the LARGEST output.
// From protocol 19 the census lets the node's newest advertisement over all its outputs decide (census.js newestPerNode): the node is out.
// The seat's own code reads "the advertisement in force" from bondsOf(...)[0] - the NEWEST-BY-HEIGHT output, here the added one, whose
// own advertisement still says serving. Each of the seat's own posts then builds on that stale body, and as the newest advertisement it
// decides: the node is back in every census, never asked.
//   - the seat's automatic advertisement check (advert-self.js -> guardianOfFromWallet; due every 6 h for a stepped-out seat, since the
//     census never holds its entry),
//   - the owner page's roles change (changeRolesFromWallet),
//   - the owner page's Add to bond (addBondFromWallet).
// Run with --experimental-test-module-mocks (the bond tool is stubbed: its chain reads are the wallet's, as owner-action-once-1374 does).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { newestPerNode } from '../../arena-protocol/src/census.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x01);
const G1 = b32(0x10), G2 = b32(0x20), G3 = b32(0x30);
const base = { nodePubkey: NODE, operatorId: 'op-seat7', protocolVersions: [19], roles: ['game', 'verify'], endpoint: 'wss://seat7.invalid',
  guardianOf: [], guardianCapable: false, guardianEndpoint: '', timestamp: 1n };
// the first bond (height 100, 50,000 sat): its newest update (height 300) is the step-out, serving = false, naming G1 and G2
const STEPPED_OUT = { ...base, hostedGames: [G1, G2], serving: false, timestamp: 3n };
const LARGE = { txid: 'aa'.repeat(32), vout: 0, height: 100, sats: 50000, advert: STEPPED_OUT, bondAdvert: { ...base, hostedGames: [G1] }, updatedBy: { txid: 'cc'.repeat(32), height: 300 } };
// the added output (height 200, 32,000 sat): its own body, posted before the step-out, serving
const ADDED_BODY = { ...base, hostedGames: [G1, G2], timestamp: 2n };
const SMALL = { txid: 'bb'.repeat(32), vout: 0, height: 200, sats: 32000, advert: ADDED_BODY, bondAdvert: ADDED_BODY };

const captured = [];
mock.module('../tools/regtest-bond.mjs', { namedExports: { regtest: () => ({
  // bondsOf answers newest first, by height (regtest-bond.mjs 215)
  bondsOf: () => [SMALL, LARGE],
  newestUpdateOf: (b) => (b.txid === LARGE.txid ? { advert: STEPPED_OUT, height: 300, txidHex: 'cc'.repeat(32) } : null),
  prepareAdvertUpdate: (_s, advert) => { captured.push({ door: 'update', advert }); throw new Error('CAPTURED'); },
  postBond: (_s, { advert }) => { captured.push({ door: 'add-bond', advert }); throw new Error('CAPTURED'); } }) } });
const { guardianOfFromWallet, changeRolesFromWallet, addBondFromWallet } = await import('../src/add-bond-wallet.js');

const cli = (m) => { if (m === 'getblockcount') return '400'; throw new Error(`no ${m}`); };
const key = (t) => Array.from(Buffer.from(t, 'hex'));
// the census's own rule (§5A, protocol 19): which advertisement decides for this node, with these outputs and updates
function inForce(updatesExtra = []) {
  const eligible = [LARGE, SMALL].map((b) => ({ txid: Uint8Array.from(key(b.txid)), vout: b.vout, height: b.height, pubkey: NODE, advert: b.bondAdvert }));
  const updates = new Map([[`${key(LARGE.txid).join(',')}:0`, { advert: STEPPED_OUT, height: 300, position: 1, txid: 'cc'.repeat(32) }]]);
  for (const u of updatesExtra) updates.set(`${key(u.of).join(',')}:0`, { advert: u.advert, height: u.height, position: 1, txid: 'dd'.repeat(32) });
  const d = newestPerNode(eligible, updates).get(`${toHex(NODE)}|op-seat7`);
  return d.u ? d.u.advert : d.own.advert;
}

test('wf1489-sm3-node-1: a stepped-out node stays out after the seat posts its own advertisement (check, roles, add to bond)', async () => {
  assert.equal(inForce().serving, false, 'before: the census has the node stepped out');
  const seen = [];
  // 1. the seat's automatic check: a game it loaded since (G3) is missing from what it reads as its advertisement
  await guardianOfFromWallet({ cli, network: 'regtest', secret: b32(7), guardianOf: [], hostedGames: [G3], post: true, keep: true }).catch((e) => { if (e.message !== 'CAPTURED') throw e; });
  // 2. the owner changes the roles
  await changeRolesFromWallet({ cli, network: 'regtest', secret: b32(7), pubkey: NODE, roles: ['game', 'verify', 'settlement'], post: true }).catch((e) => { if (e.message !== 'CAPTURED') throw e; });
  // 3. the owner adds to the bond
  await addBondFromWallet({ cli, network: 'regtest', secret: b32(7), pubkey: NODE, addSats: '20000', post: true }).catch((e) => { if (e.message !== 'CAPTURED') throw e; });
  assert.equal(captured.length, 3, 'each door built its transaction');
  for (const c of captured) {
    // the update is posted on the output bondsOf put first (height 400 > 300: the newest), the added bond is a newer output still
    const after = c.door === 'update' ? inForce([{ of: SMALL.txid, advert: c.advert, height: 400 }]) : c.advert;
    seen.push(`${c.door}: serving ${after.serving === false ? 'false' : 'true'}, games ${(after.hostedGames || []).length}`);
  }
  console.log(`  MEASURED: in force before = serving false; after each seat post: ${seen.join(' | ')}`);
  for (const s of seen) assert.match(s, /serving false/, `the node stepped back into the census without being asked (${s})`);
});
