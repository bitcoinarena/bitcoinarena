// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAYING ROUND DOES NOT OPEN ON A SIGNER NODE THAT CANNOT READ THE CHAIN (RULED 2026-09-25).
//
// MEASURED before this test (2026-09-25, a scratch probe): a node with the lock fixture's port and no chain view answered
// a named paying round 201, stored and listed it with 0 signer nodes, and its /claim-key answered 409 "this node is not
// assigned to that round, so it attests no claim key for it" - nobody could lock a stake to a key the round does not
// have. Refused now before round.open with the census's own sentence (roster.js NO_CHAIN_VIEW_WHY).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { NO_CHAIN_VIEW_WHY } from '../src/roster.js';
import { contractFor, opts, b32, presentDay } from './window-fixture.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const { windowChain, ...noChain } = opts;
const CLAIM = new Uint8Array(33).fill(2);

async function opened({ stakeMsat, bonded = false } = {}) {
  const slot = bonded ? bondedChainSlot(lockPort()) : null;
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...noChain, stakeLocks: slot ? slot.port : lockPort(),
    ...(slot ? { chainFor: slot.chainFor, randomnessFor: slot.randomnessFor, claimKeyFor: () => CLAIM } : {}) });
  try {
    const drafted = presentDay({ ...contractFor([d.round.pubkey, b32(0x33)], 3000n, ['wss://r.example']),
      ...(stakeMsat !== undefined ? { stakeMsat } : {}) }, Date.now() + 300000);
    const c = slot ? { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
      { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot } : drafted;
    const rid = roundId(c);
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    const why = (await r.text()).trim();
    const listed = (await (await fetch(`http://127.0.0.1:${d.port}/rounds`)).text()).toLowerCase().includes(toHex(rid));
    return { status: r.status, why, stored: !!d.round.get(rid), listed, signerNodes: d.round.signerNodes(rid).length };
  } finally { await d.close(); }
}

test('1. a lock port and no chain view: a paying round is 409 with the census\'s sentence', async () => {
  const got = await opened();
  console.log('  FACTS (no chain view, paying):', JSON.stringify({ status: got.status, stored: got.stored, listed: got.listed, signerNodes: got.signerNodes }));
  assert.equal(got.status, 409, got.why);
  assert.equal(got.why, NO_CHAIN_VIEW_WHY);
});

test('2. that refused round is absent: not stored, not listed', async () => {
  const got = await opened();
  assert.deepEqual({ stored: got.stored, listed: got.listed }, { stored: false, listed: false });
});

test('3. the same node opens a free round, and lists it', async () => {
  const got = await opened({ stakeMsat: 0n });
  assert.equal(got.status, 201, got.why);
  assert.deepEqual({ stored: got.stored, listed: got.listed }, { stored: true, listed: true });
});

test('4. with a chain that bonds the round\'s committee, the paying round opens, is stored and assigned two signer nodes', async () => {
  const got = await opened({ bonded: true });
  assert.equal(got.status, 201, got.why);
  assert.deepEqual({ stored: got.stored, signerNodes: got.signerNodes }, { stored: true, signerNodes: 2 });
});

test('5. POST /round refuses a paying round with no chain view before round.open(contract)', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf("if (req.method === 'POST' && url.pathname === '/round')");
  const open = server.indexOf('round.open(contract)', start);
  const refusal = server.indexOf('if (contract.stakeMsat > 0n && !chainFor)', start);
  assert.ok(start >= 0 && open > start, 'no POST /round handler that opens a round');
  assert.ok(refusal > start && refusal < open, 'POST /round does not refuse a paying round with no chain view before round.open(contract)');
});
