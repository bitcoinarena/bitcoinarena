// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CLIENT'S CENSUS OBJECTION (§5A.4, kanban #299): the seat checks it on its own chain against the named explorer. Upheld - the explorer
// names another block at the census height - the round takes no new entry and its row says census_objected; an explorer that agrees, or
// cannot be asked, does not uphold it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { displayHash } from '../../arena-client/src/explorer-check.js';
import { HOSTED } from './plugins/hosted.js';

test('a census objection is upheld only when this seat\'s own census block is not the explorer\'s; then no new entry, and the row says so', async () => {
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  let mode = 'agree';
  const explorer = createServer((req, res) => {
    const h = Number((/\/block-height\/(\d+)$/.exec(req.url) || [])[1]);
    const view = slot.chainFor({ contract: free });
    const at = view.blocks[h - view.firstHeight];
    if (mode === 'down' || !at) { res.writeHead(503); return res.end('down'); }
    res.writeHead(200); res.end(mode === 'agree' ? displayHash(blockHashOf(at.header)) : 'ee'.repeat(32));
  });
  await new Promise((r) => explorer.listen(0, '127.0.0.1', r));
  let free;
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const nodes = [d.round.pubkey, b32(0x33)];
    const drafted = { ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID };
    const named = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot, { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot };
    free = { ...named, federationId: new Uint8Array(32), stakeMsat: 0n, configHash: TRUCK_V3_CONFIG_HASH, slashMinimumServed: 22 };
    assert.equal((await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(free) })).status, 201);
    const rh = toHex(roundId(free));
    const object = async () => { const r = await fetch(`${base}/census-objection`, { method: 'POST', body: JSON.stringify({ round: rh, explorer: `http://127.0.0.1:${explorer.address().port}` }) }); return { status: r.status, text: await r.text() }; };
    const agree = await object();
    assert.equal(agree.status, 409); assert.match(agree.text, /not upheld: the explorer names the same block/);
    mode = 'down';
    assert.match((await object()).text, /not upheld: the explorer answered 503/);
    mode = 'other';
    const upheld = await object();
    assert.equal(upheld.status, 200, upheld.text); assert.equal(JSON.parse(upheld.text).upheld, true);
    const row = (await (await fetch(`${base}/rounds`)).json()).rounds.find((x) => x.id === rh);
    assert.ok(!row || row.free || row.warnings.includes('census_objected'), 'a paying row says census_objected');
    const entry = await fetch(`${base}/entry`, { method: 'POST', body: new Uint8Array(200) });
    assert.notEqual(entry.status, 200);
    assert.equal((await fetch(`${base}/census-objection`, { method: 'POST', body: JSON.stringify({ round: rh, explorer: 'ftp://x' }) })).status, 400);
  } finally { await d.close(); await new Promise((r) => explorer.close(r)); }
});
