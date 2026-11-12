// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 / #1682 skeptic 2, a different attacker: ONE bonded census node. It advertises (its own signed advert, so the trusted census names
// it) the same endpoint as an honest node of the committee. seatBaseOf then maps that address to null ("one address, two nodes: neither") and the
// honest node is no witness any more: one bonded stranger takes the bounty away from an honest committee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
const SECRET = new Uint8Array(32).fill(0x51), NODE = toHex(schnorr.getPublicKey(SECRET)), RID = toHex(new Uint8Array(32).fill(0x77));
const fin = toHex(signFinalSig({ roundId: fromHex(RID), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: fromHex(NODE), signedAtMs: BigInt(NOW - 1000) }, (d) => schnorr.sign(d, SECRET)));
const A = 'a1'.repeat(32), B = 'b1'.repeat(32), D = 'd1'.repeat(32), EVIL = 'ee'.repeat(32);
const TRUSTED = 'https://trusted.example';
// kanban #2015, #2049: three census nodes OTHER than the node (A, B, D) witness, and the trusted seat holds the round too
const S = { [NODE]: 'https://n.example', [A]: 'https://a.example', [B]: 'https://b.example', [D]: 'https://d.example' };

const check = (roles) => nodeBountyCheck({ node: NODE, seats: [], nowMs: NOW, censusSeats: [TRUSTED], fetchJson: async (url) => {
  if (url.endsWith('/owner')) return { node: 'dd'.repeat(32), claimed: false };
  if (url.endsWith('/roles')) return url.startsWith(TRUSTED) ? { nodes: roles } : { nodes: [] };
  if (url.startsWith(`${TRUSTED}/`)) return { node: 'f0'.repeat(32), held: [{ roundId: RID, committee: [NODE, A, B, D], finals: [fin] }] };
  const who = Object.entries(S).find(([, d]) => url.startsWith(`${d}/`));
  return { node: who && who[0], held: who ? [{ roundId: RID, committee: [NODE, A, B, D], finals: [fin] }] : [] };
} });

test('#1682 s2-2: one bonded node advertising an honest witness\'s endpoint does not take the honest node\'s bounty away', async () => {
  const honest = Object.entries(S).map(([node, endpoint]) => ({ node, endpoint, bondSats: '5000000' }));
  const before = await check(honest);
  assert.equal(before.passes, true, 'control: the honest committee passes');
  const after = await check([...honest, { node: EVIL, endpoint: S[A], bondSats: '1' }]);
  console.log('  MEASURED s2-2:', JSON.stringify(after.checks.map((c) => [c.key, c.ok, c.says])));
  assert.equal(after.passes, true, 'a squatter on A\'s address must not cancel A as a witness');
});

// kanban #1866, #1888: the shared address is not a way in either - its door's `node` must be one advertised there, and with several there it must say
test('#1682 s2-2: at a shared address the door names its witness; a node not advertised there, or no name, counts for none', async () => {
  const roles = [...Object.entries(S).map(([node, endpoint]) => ({ node, endpoint, bondSats: '5000000' })), { node: EVIL, endpoint: S[A], bondSats: '1' }];
  const asked = (nodeAtA) => nodeBountyCheck({ node: NODE, seats: [], nowMs: NOW, censusSeats: [TRUSTED], fetchJson: async (url) => {
    if (url.endsWith('/owner')) return { node: 'dd'.repeat(32), claimed: false };
    if (url.endsWith('/roles')) return url.startsWith(TRUSTED) ? { nodes: roles } : { nodes: [] };
    if (url.startsWith(`${TRUSTED}/`)) return { node: 'f0'.repeat(32), held: [{ roundId: RID, committee: [NODE, A, B, D, EVIL, 'cc'.repeat(32)], finals: [fin] }] };
    const who = Object.entries(S).find(([, d]) => url.startsWith(`${d}/`));
    return { node: who && who[0] === A ? nodeAtA : who && who[0], held: who ? [{ roundId: RID, committee: [NODE, A, B, D, EVIL, 'cc'.repeat(32)], finals: [fin] }] : [] };
  } });
  const r = { asA: (await asked(A)).passes, asEvil: (await asked(EVIL)).passes, asStranger: (await asked('cc'.repeat(32))).passes, unnamed: (await asked(undefined)).passes };
  console.log('  MEASURED s2-2 shared:', JSON.stringify(r));
  // as A: A, B, D are three witnesses (kanban #2015, #2049: NODE is not its own). As EVIL: EVIL is a census node advertised there and in the
  // committee, so still three - no gain over running its own door. A stranger key, or no name at a shared address: only two, the round does not count
  assert.deepEqual(r, { asA: true, asEvil: true, asStranger: false, unnamed: false });
});

// kanban #1866, #1888: a node that moved (its newest signed address announcement, GET /roles `announced`) is asked where it answers now
test('#1682 s2-2: a census node that moved off its advert is found at its announced address', async () => {
  const roles = Object.entries(S).map(([node, endpoint]) => (node === B ? { node, endpoint: 'wss://old-b.example', announced: endpoint.replace(/^https:/, 'wss:'), bondSats: '5000000' }
    : { node, endpoint, bondSats: '5000000' }));
  const r = await check(roles);
  assert.equal(r.passes, true);
  const noMove = await check(roles.map((e) => ({ ...e, announced: undefined })));
  assert.equal(noMove.passes, false, 'control: at its old advert alone B is not found');
});
