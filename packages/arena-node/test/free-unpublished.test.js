// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FREE ROUND IS NOT POSTED ON THE CHAIN IN ADVANCE (2026-10-01 15:25, HARD). §5A.5's publication rule keeps a
// round's author from grinding committees over money; a free round moves none. On a bonded chain whose blocks carry no
// publication at all, a free round opens on the node and its committee is drawn - and a paying round on the same chain is
// still refused for want of its publication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { b32, contractFor, STAKE } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

test('on a chain with no publication, a free round opens and its committee is drawn; a paying round there is refused', async () => {
  const slot = bondedChainSlot(lockPort());
  // THE CHAIN AS IT IS FOR AN UNPUBLISHED ROUND: the slot's bonded blocks, no publication in them.
  const bare = () => (slot.bonds ? slot.chainWith(null) : undefined);
  const chainFor = () => bare();
  const randomnessFor = ({ contract } = {}) => {
    const view = bare();
    if (!view || !contract) return undefined;
    const named = beaconFromChain(contract, { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
    return named.ok ? { hash: named.hash, height: named.height, timeMs: named.timeMs } : undefined;
  };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, funded: () => true, chainFor, randomnessFor,
    claimKeyFor: () => new Uint8Array(33).fill(2) });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    const now = BigInt(Date.now());
    const round = (extra) => {
      const c = { ...contractFor([d.round.pubkey, b32(0x33)], 0n, [base]), committeeTimeMs: now - 1000n, startTimeMs: now + 59000n,
        entryCloseMs: now + 179000n, ...extra };
      return { ...c, censusRoot: bondedChainFor(c.nodes, c, slot, { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot };
    };
    const free = round({ stakeMsat: 0n });
    const paying = round({ stakeMsat: STAKE, custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, slashMinimumServed: 21 });
    const opened = {};
    for (const [name, c] of Object.entries({ free, paying })) {
      const r = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) });
      opened[name] = `${r.status} ${(await r.text()).replace(/[^\x20-\x7e]/g, '.').slice(0, 100)}`;
    }
    const listed = (await (await fetch(`${base}/rounds`)).json()).rounds.find((x) => x.id === toHex(roundId(free)));
    console.log('  FACTS (free unpublished):', JSON.stringify({ opened, committee: listed && listed.committee, assignedHere: listed && listed.assignedHere }));
    assert.match(opened.free, /^201 /, `the unpublished free round was refused: ${opened.free}`);
    assert.equal(listed && listed.committee.drawn, true, `the free round's committee was not drawn: ${JSON.stringify(listed && listed.committee)}`);
    assert.doesNotMatch(opened.paying, /^201 /, 'a paying round with no publication opened');
    assert.match(opened.paying, /no publication transaction to read|publication/);
  } finally { await d.close(); }
});
