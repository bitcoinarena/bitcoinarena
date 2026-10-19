// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND THAT TAKES A STAKE MUST NAME A PUBLICATION RELAY, OR IT TAKES NO STAKE.
//
// Since P2 (v4.6.2 §13A) no result is FINAL until the round's settlement signer nodes
// have posted its transcript to the contract's `publication_relays[]` - and a
// contract that names none can never be posted to, so none of its results can
// ever be final and no stake in it can ever settle.
//
// MEASURED BEFORE (TASKBOOK, e76cc61): two daemons opened such a round (201,
// 201), joined, quoted and held both players' stakes on both signer nodes, and 4.5 s
// after the close every stake was still HELD and every result provisional,
// with 0 Lightning acts. Now the round is refused where it is opened, and a
// stake is refused where it would be joined - before any hold is issued.
// A PAYING ROUND OPENS ONLY ON A SIGNER NODE THAT REACHES A FEDERATION (RULED 2026-09-25): this file's paying-round
// daemons get the lock fixture's port - the test federation, two gateways, zero base fee. Contracts unchanged.
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { b32, WINDOW_MS, contractFor, opts } from './window-fixture.js';
import { HOSTED } from './plugins/hosted.js';

const open = (d, c) => fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });

test('the same paying round naming a relay opens, and a free round naming none opens', async () => {
  // ON A CHAIN THAT BONDS THE ROUND'S TWO NODES (RULED 2026-09-25): the one daemon and a keyless placeholder, so the claim
  // key is claimKeyFor's. A node with a chain view checks every round's census; only censusRoot changes.
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, stakeLocks: slot.port, chainFor: slot.chainFor, randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const bonded = (c) => ({ ...c, censusRoot: bondedChainFor(c.nodes, c, slot, { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot });
    const paying = bonded(contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS), [`http://127.0.0.1:${d.port}`]));
    assert.equal((await open(d, paying)).status, 201, 'a paying round naming a relay was refused');
    const free = bonded({ ...contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS), []), stakeMsat: 0n });
    const r = await open(d, free);
    assert.equal(r.status, 201, `a free round naming no relay was refused: ${await r.text()}`);
  } finally { await d.close(); }
});

// THE OTHER DOOR THAT TAKES MONEY INTO A ROUND: `/federation-invoice` asks the federation for a round's
// stake invoice. It reads what is stored, so a round kept before the rule reaches it. MEASURED BEFORE
// (TASKBOOK, 0872735): 200 with the federation asked once. Now it refuses.
test('a stored paying round naming no relay is given no federation stake invoice, and the federation is not asked', async () => {
  const fed = { asked: 0, amountMsat: null };
  const federation = { async receive({ amountMsat }) { fed.asked++; fed.amountMsat = amountMsat; return { request: 'lnbcrt-federation' }; } };
  const lightning = { async decode() { return { paymentHash: b32(0x44), amountMsat: fed.amountMsat }; } };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, lightning, federation });
  try {
    const c = contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS), []);
    const rid = d.round.open(c);
    assumeAssigned(d.round, rid, c.nodes);
    const r = await fetch(`http://127.0.0.1:${d.port}/federation-invoice?round=${Buffer.from(rid).toString('hex')}`);
    const why = await r.text();
    const facts = { status: r.status, federationAsked: fed.asked };
    console.log('  FACTS (/federation-invoice, no relay):', JSON.stringify(facts), '|', why.slice(0, 100));
    assert.deepEqual(facts, { status: 409, federationAsked: 0 });
    assert.match(why, /no stake invoice is made for that round: that round takes a stake and names no publication relay/);
  } finally { await d.close(); }
});
