// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAYING ROUND DOES NOT OPEN ON A SIGNER NODE THAT REACHES NO FEDERATION (§23.6; RULED 2026-09-25: "a paying round
// on a node with no lock port is refused with 409 before round.open ... Nothing stored or listed.").
//
// MEASURED before this test (2026-09-25, a scratch probe): POST /round's federation checks - the two-gateway count and the
// base-fee guard - sat inside `if (contract.stakeMsat > 0n && stakeLocks)`, so on a node with no lock port neither ran: a
// named paying round was 201, stored and listed, under the fixture's funding and under the launcher's own operatorFunding,
// and then every entry into it was 402 ("this node stores nothing for an entry nobody has funded") - the node reaches no
// federation, so it could take no stake. A paying round nobody can join, listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { operatorFunding, freeOrOperatorFunding } from '../src/funding.js';
import { contractFor, opts, b32, presentDay } from './window-fixture.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

// guardiansBonded's own no-port sentence (server.js): the one refusal a node with no federation gives.
const NO_FEDERATION = 'this signer node reaches no federation to read the guardians of, so it signer nodes no round that takes a stake into one (§23.6)';

async function opened({ stakeMsat, port = null, launcher = false, daily = false } = {}) {
  const d0 = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  const pk = d0.round.pubkey;
  await d0.close();
  const base = contractFor([pk, b32(0x33)], 3000n, ['wss://r.example']);
  const drafted = presentDay({ ...base, ...(stakeMsat !== undefined ? { stakeMsat } : {}) }, Date.now() + 300000);
  // WITH A LOCK PORT, A CHAIN THAT BONDS THE ROUND'S TWO NODES (RULED 2026-09-25: every paying-round test gets a bonded
  // chain view); with none, no chain either - the refusal asked here comes first.
  const slot = port ? bondedChainSlot(port) : null;
  const c = slot ? { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot).censusRoot } : drafted;
  const rid = roundId(c);
  // `launcher`: the operator's rule (a paying round only when named); `daily`: the Daily's, a free round beside it.
  const funded = daily ? freeOrOperatorFunding({ named: () => [toHex(rid)] })
    : launcher ? operatorFunding({ named: () => [toHex(rid)] }) : opts.funded;
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, funded, ...(slot ? { stakeLocks: slot.port, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) } : {}) });
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    const why = (await r.text()).trim();
    const listed = (await (await fetch(`http://127.0.0.1:${d.port}/rounds`)).text()).toLowerCase().includes(toHex(rid));
    return { status: r.status, why, stored: !!d.round.get(rid), listed };
  } finally { await d.close(); }
}

test('1. no lock port, the launcher\'s funding naming the round: a paying round is 409 with the no-federation sentence', async () => {
  const got = await opened({ launcher: true });
  console.log('  FACTS (no lock port, paying):', JSON.stringify(got));
  assert.equal(got.status, 409, got.why);
  assert.equal(got.why, NO_FEDERATION);
});

test('2. that refused round is absent: not stored, not listed', async () => {
  const got = await opened({ launcher: true });
  assert.deepEqual({ stored: got.stored, listed: got.listed }, { stored: false, listed: false });
});

test('3. the same node opens a free round, and lists it (the Daily launcher\'s rule: a free round beside the paying one)', async () => {
  const got = await opened({ stakeMsat: 0n, daily: true });
  assert.equal(got.status, 201, got.why);
  assert.deepEqual({ stored: got.stored, listed: got.listed }, { stored: true, listed: true });
});

test('4. with the lock fixture\'s port (two gateways, zero base fee) the paying round opens', async () => {
  const got = await opened({ port: lockPort() });
  assert.equal(got.status, 201, got.why);
});

test('5. with a lock port whose fee rule cannot be read, the paying round is 503', async () => {
  const port = lockPort();
  port.fees = async () => { throw new Error('the federation did not answer'); };
  const got = await opened({ port });
  assert.equal(got.status, 503, got.why);
  assert.equal(got.stored, false);
});

test('6. POST /round refuses a paying round with no lock port before round.open(contract)', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf("if (req.method === 'POST' && url.pathname === '/round')");
  const open = server.indexOf('round.open(contract)', start);
  const refusal = server.indexOf('if (contract.stakeMsat > 0n && !stakeLocks)', start);
  assert.ok(start >= 0 && open > start, 'no POST /round handler that opens a round');
  assert.ok(refusal > start && refusal < open, 'POST /round does not refuse a paying round with no lock port before round.open(contract)');
});
