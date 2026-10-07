// A ROUND POSTED AHEAD OF ITS BEACON OUTLIVES A RESTART (ORDER-2116, measured on the free pair 2026-10-01). The free opener
// posts each round ~15 min ahead; a node stores it (202) and assigns its signer nodes once the beacon is on its chain. The
// rounds waiting for that lived in memory only, so every round posted before a node's restart stayed unassigned and no
// player could join it. Here: a free round posted while the beacon is not on the node's chain - 202, unassigned; the node
// restarted on its store; the beacon on the chain - assigned by the restarted node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { b32, contractFor, wait } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { beaconFromChain } from '../../protocol/src/beacon.js';
import { toHex } from '../../protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

test('a free round posted before its beacon (202) is assigned by the node after a restart, once the beacon is on its chain', async () => {
  const slot = bondedChainSlot(lockPort());
  // BEFORE THE BEACON: the node's chain names none for the round yet ("this node has no beacon for that round"), as the
  // free pair's nodes said of every round posted ahead; after, the beacon is there.
  let short = true;
  const view = () => (slot.bonds ? slot.chainWith(null) : undefined);
  const randomnessFor = ({ contract } = {}) => {
    const v = view();
    if (short || !v || !contract) return undefined;
    const named = beaconFromChain(contract, { headers: v.blocks.map((b) => b.header), firstHeight: v.firstHeight });
    return named.ok ? { hash: named.hash, height: named.height, timeMs: named.timeMs } : undefined;
  };
  const path = join(mkdtempSync(join(tmpdir(), 'posted-ahead-')), 'node.sqlite');
  const start = () => serve(openStore(path), { plugins: HOSTED, port: 0, stakeLocks: slot.port, funded: () => true, chainFor: () => view(),
    randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  let d = await start();
  try {
    const now = BigInt(Date.now());
    const c0 = { ...contractFor([d.round.pubkey, b32(0x33)], 0n, [`http://127.0.0.1:${d.port}`]), committeeTimeMs: now - 1000n,
      startTimeMs: now + 59000n, entryCloseMs: now + 179000n, stakeMsat: 0n };
    const c = { ...c0, censusRoot: bondedChainFor(c0.nodes, c0, slot, { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot };
    const rid = toHex(roundId(c));
    const posted = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    const postedWhy = (await posted.clone().text()).replace(/[^\x20-\x7e]/g, ".").slice(0, 160);
    const before = d.round.signerNodes(roundId(c)).length;
    await d.close();
    short = false;
    d = await start();
    let listed = null;
    for (const stop = Date.now() + 20000; Date.now() < stop; await wait(500)) {
      listed = (await (await fetch(`http://127.0.0.1:${d.port}/rounds`)).json()).rounds.find((x) => x.id === rid);
      if (listed && listed.assignedHere) break;
    }
    console.log('  FACTS (posted ahead, restart):', JSON.stringify({ posted: posted.status, postedWhy, before, assignedHere: listed && listed.assignedHere, committee: listed && listed.committee && listed.committee.drawn }));
    assert.equal(posted.status, 202, 'the round was not stored as posted ahead of its beacon');
    assert.equal(before, 0, 'signer nodes were assigned before the beacon was on the chain');
    assert.equal(listed && listed.assignedHere, true, 'the restarted node never assigned the round posted before its restart');
  } finally { await d.close(); }
});
