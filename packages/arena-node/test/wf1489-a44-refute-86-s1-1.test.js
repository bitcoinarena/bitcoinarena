// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a44 refute 86 (kanban #1836 fix facd00cc5, checked on 90d57151a): inForceOf does NOT read the advertisement in force as the
// census does when two updates of the node (on two of its outputs) land in ONE block. census.js newestPerNode decides that by the
// transaction's POSITION in the block (the later one wins); inForceOf gives every update pos 0 and lets the larger txid decide - and
// that txid is bitcoind's display hex, where the census would use the internal byte order anyway.
// Timing edge: the operator's step-out (serving = false, on the largest output) and the seat's own check (a game loaded, on the output
// that was in force before, serving true) are both in the mempool and mined in the same block, the step-out after the check.
// The census: stepped out. The seat: reads the check's body as "in force", and its next own post (Add to bond, roles, a new game)
// puts the node back in every census, never asked - the #1836 effect again.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { newestPerNode } from '../../arena-protocol/src/census.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x01);
const G1 = b32(0x10), G2 = b32(0x20), G3 = b32(0x30), G4 = b32(0x40);
const base = { nodePubkey: NODE, operatorId: 'op-seat7', protocolVersions: [19], roles: ['game', 'verify'], endpoint: 'wss://seat7.invalid',
  guardianOf: [], guardianCapable: false, guardianEndpoint: '', timestamp: 1n };
// block 300: the seat's own check on SMALL (serving, adds G3) at position 1, then the operator's step-out on LARGE at position 2
const CHECK = { ...base, hostedGames: [G1, G2, G3], timestamp: 3n };
const STEPPED_OUT = { ...base, hostedGames: [G1, G2], serving: false, timestamp: 4n };
const U_CHECK = 'ff'.repeat(32), U_STEP = '11'.repeat(32);     // display hex as bitcoind prints them
const LARGE = { txid: 'aa'.repeat(32), vout: 0, height: 100, sats: 50000, advert: STEPPED_OUT, bondAdvert: { ...base, hostedGames: [G1] }, updatedBy: { txid: U_STEP, height: 300 } };
const SMALL = { txid: 'bb'.repeat(32), vout: 0, height: 200, sats: 32000, advert: CHECK, bondAdvert: { ...base, hostedGames: [G1, G2], timestamp: 2n }, updatedBy: { txid: U_CHECK, height: 300 } };

const captured = [];
mock.module('../tools/regtest-bond.mjs', { namedExports: { regtest: () => ({
  bondsOf: () => [SMALL, LARGE],
  newestUpdateOf: (b) => (b.txid === LARGE.txid ? { advert: STEPPED_OUT, height: 300, txidHex: U_STEP } : b.txid === SMALL.txid ? { advert: CHECK, height: 300, txidHex: U_CHECK } : null),
  prepareAdvertUpdate: (_s, advert) => { captured.push({ door: 'update', advert }); throw new Error('CAPTURED'); },
  postBond: (_s, { advert }) => { captured.push({ door: 'add-bond', advert }); throw new Error('CAPTURED'); } }) } });
const { guardianOfFromWallet, changeRolesFromWallet, addBondFromWallet, inForceOf } = await import('../src/add-bond-wallet.js');

const cli = (m) => { if (m === 'getblockcount') return '400'; throw new Error(`no ${m}`); };
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const internal = (h) => bytes(h).reverse();
const okey = (b) => `${Array.from(internal(b.txid)).join(',')}:${b.vout}`;
// the census's own rule, with the real positions in block 300
function census(extra = []) {
  const eligible = [LARGE, SMALL].map((b) => ({ txid: internal(b.txid), vout: b.vout, height: b.height, pubkey: NODE, advert: b.bondAdvert }));
  const updates = new Map([[okey(LARGE), { advert: STEPPED_OUT, height: 300, position: 2, txid: internal(U_STEP) }],
    [okey(SMALL), { advert: CHECK, height: 300, position: 1, txid: internal(U_CHECK) }]]);
  for (const u of extra) updates.set(okey(u.of), { advert: u.advert, height: u.height, position: 1, txid: b32(0xdd) });
  const d = newestPerNode(eligible, updates).get(`${toHex(NODE)}|op-seat7`);
  return d.u ? d.u.advert : d.own.advert;
}

test('wf1489-a44-refute-86-s1-1: two updates in one block - the seat reads the one the census does not, and steps the node back in', async () => {
  assert.equal(census().serving, false, 'the census: stepped out (the step-out is later in block 300)');
  const picked = inForceOf([SMALL, LARGE]);
  console.log(`  MEASURED: census in force = serving ${census().serving}; inForceOf picks ${picked === LARGE ? 'LARGE (step-out)' : 'SMALL (the check, serving)'}`);
  const seen = [];
  await guardianOfFromWallet({ cli, network: 'regtest', secret: b32(7), guardianOf: [], hostedGames: [G4], post: true, keep: true }).catch((e) => { if (e.message !== 'CAPTURED') throw e; });
  await changeRolesFromWallet({ cli, network: 'regtest', secret: b32(7), pubkey: NODE, roles: ['game', 'verify', 'settlement'], post: true }).catch((e) => { if (e.message !== 'CAPTURED') throw e; });
  await addBondFromWallet({ cli, network: 'regtest', secret: b32(7), pubkey: NODE, addSats: '20000', post: true }).catch((e) => { if (e.message !== 'CAPTURED') throw e; });
  assert.equal(captured.length, 3);
  for (const c of captured) {
    const of = picked;   // the update goes on the output inForceOf chose, at 400 (the newest)
    const after = c.door === 'update' ? census([{ of, advert: c.advert, height: 400 }]) : c.advert;
    seen.push(`${c.door}: serving ${after.serving === false ? 'false' : 'true'}`);
  }
  console.log(`  MEASURED after each seat post: ${seen.join(' | ')}`);
  for (const s of seen) assert.ok(/serving false/.test(s), `the node stepped back into the census without being asked (${s})`);
  assert.ok(picked === LARGE, 'inForceOf must pick the update the census counts (later position in the block)');
});
