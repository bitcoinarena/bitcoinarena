// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 / #1682: the node bounty's census and witness binding, each way around it. The census is read only from the seats the caller
// trusts (censusSeats); a round counts only held by NODE_BOUNTY_AGREE census nodes of its committee, each at its own advertised endpoint, each
// node key once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
const SECRET = new Uint8Array(32).fill(0x51), NODE = toHex(schnorr.getPublicKey(SECRET)), RID = toHex(new Uint8Array(32).fill(0x77));
const fin = toHex(signFinalSig({ roundId: fromHex(RID), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: fromHex(NODE), signedAtMs: BigInt(NOW - 1000) }, (d) => schnorr.sign(d, SECRET)));
const A = 'a1'.repeat(32), B = 'b1'.repeat(32), C = 'c1'.repeat(32);
const TRUSTED = 'https://trusted.example';
const entry = (node, endpoint) => ({ node, endpoint, bondSats: '5000000' });

// holders answer /served with the round (committee given), `roles` is what TRUSTED answers at /roles, `liarRoles` what every other seat answers
const world = ({ holders, committee, roles, liarRoles = null, nodeOf = {} }) => async (url) => {
  if (url.endsWith('/owner')) return { node: 'dd'.repeat(32), claimed: false };
  if (url.endsWith('/roles')) return url.startsWith(TRUSTED) ? { nodes: roles } : liarRoles ? { nodes: liarRoles } : { nodes: [] };
  const base = new URL(url).origin.toLowerCase();
  const held = holders.some((h) => url.toLowerCase().startsWith(h.toLowerCase())) ? [{ roundId: RID, committee, finals: [fin] }] : [];
  return { node: nodeOf[base], held };
};
const run = (w, seats) => nodeBountyCheck({ node: NODE, seats, fetchJson: w, nowMs: NOW, censusSeats: [TRUSTED] });
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.key);

test('#1682 the honest path: three census nodes of the committee at their own endpoints pass', async () => {
  const S = ['https://n.example', 'https://a.example', 'https://b.example'];
  // the adverts as live seats advertise them, wss:// (kanban #1866, #1888: an https:// fixture hid that wss:// adverts had no witness address)
  const roles = [entry(NODE, S[0].replace(/^https:/, 'wss:')), entry(A, S[1].replace(/^https:/, 'wss:')), entry(B, S[2].replace(/^https:/, 'wss:'))];
  const r = await run(world({ holders: S, committee: [NODE, A, B], roles, nodeOf: { [S[0]]: NODE, [S[1]]: A, [S[2]]: B } }), []);
  console.log('  MEASURED #1682 honest:', JSON.stringify(r.checks.map((c) => [c.key, c.ok, c.says])));
  assert.equal(r.passes, true, 'census endpoints are asked even when no seat is listed');
});

test('#1682 ways around: a fresh key, seats outside the census, one seat under three spellings, a door answering as another node, a seat lying at /roles', async () => {
  const EVIL = ['https://evil1.example', 'https://evil2.example', 'https://evil3.example'];
  const cases = {
    // the three colluding seats ARE bonded census nodes, the fresh key is not
    freshKey: await run(world({ holders: EVIL, committee: [NODE, A, B, C], roles: [entry(A, EVIL[0]), entry(B, EVIL[1]), entry(C, EVIL[2])] }), EVIL),
    // the key is in the census, the three seats answering are not census endpoints
    unboundSeats: await run(world({ holders: EVIL, committee: [NODE, A, B], roles: [entry(NODE, 'https://n.example'), entry(A, 'https://a.example'), entry(B, 'https://b.example')] }), EVIL),
    // the three census nodes hold the round but are not in its committee
    notInCommittee: await run(world({ holders: EVIL, committee: [NODE], roles: [entry(NODE, 'https://n.example'), entry(A, EVIL[0]), entry(B, EVIL[1]), entry(C, EVIL[2])] }), EVIL),
    // one census seat listed under three spellings of its address
    spellings: await run(world({ holders: ['https://one.example'], committee: [NODE, A], roles: [entry(NODE, 'https://n.example'), entry(A, 'https://one.example')] }),
      ['https://ONE.example', 'https://one.example:443', 'https://one.example/']),
    // a census endpoint answering /served as another node
    asOther: await run(world({ holders: EVIL, committee: [NODE, A, B, C], roles: [entry(NODE, EVIL[0]), entry(A, EVIL[1]), entry(B, EVIL[2])], nodeOf: { [EVIL[0]]: C, [EVIL[1]]: C, [EVIL[2]]: C } }), EVIL),
    // three listed seats answer /roles naming the fresh key at their own endpoints; only the trusted seat's census counts
    lyingRoles: await run(world({ holders: EVIL, committee: [NODE, A, B], roles: [], liarRoles: [entry(NODE, EVIL[0]), entry(A, EVIL[1]), entry(B, EVIL[2])] }), EVIL),
  };
  console.log('  MEASURED #1682 ways around:', JSON.stringify(Object.fromEntries(Object.entries(cases).map(([k, r]) => [k, [r.passes, failed(r)]]))));
  for (const [k, r] of Object.entries(cases)) assert.equal(r.passes, false, k);
  assert.equal(cases.freshKey.checks.find((c) => c.key === 'census').says, 'not a bonded node of the census');
  // no census given at all: nobody passes
  const none = await nodeBountyCheck({ node: NODE, seats: EVIL, fetchJson: world({ holders: EVIL, committee: [NODE], roles: [] }), nowMs: NOW });
  assert.equal(none.passes, false);
});
