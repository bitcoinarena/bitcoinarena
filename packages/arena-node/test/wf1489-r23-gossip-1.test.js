// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r23 gossip 1: server.js learnRoundApps asks the census / dev-client seats GET /entry?id=<eid> for the player of a
// donation row that names none, and keeps the first decodable answer (entryPlayers.set) - it never checks that the bytes hash to the
// id it asked for. One seat answers with ANY entry (its own, under a player key of its choosing) and the owner's donations table shows
// that key as the donor of the row, for good (entryPlayers is never asked again). The same holds for GET /round (roundApps: the bytes
// are not checked to be the round asked for).
// SAFE: an answer whose bytes are not the entry asked for is not taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HOSTED } from './plugins/hosted.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';

const z = () => new Uint8Array(32);
const b = (x) => new Uint8Array(32).fill(x);
const toHex = (u) => Buffer.from(u).toString('hex');

test('wf1489-r23-gossip-1: a peer\'s GET /entry answer for another entry does not name the donor of a donation row', async () => {
  const forged = {
    roundId: b(0x11), playerPubkey: b(0x77), sessionPubkey: b(0x22), stakeCommitment: z(), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
    joinTick: 0, worldSecret: z(), vssSharesRef: z(), stakePoint: new Uint8Array(33), feePreimage: z(),
    stakeLockOutpoint: { txid: z(), outIdx: 0n }, feeLockOutpoint: { txid: z(), outIdx: 0n }, claimKeyAttestationRef: z(),
  };
  const bytes = encodeEntryContract(forged);
  const asked = 'ab'.repeat(32);
  assert.notEqual(toHex(entryId(forged)), asked);
  const bad = createServer((req, res) => {
    if (!req.url.startsWith('/entry')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from(bytes));
  });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  const badBase = `http://127.0.0.1:${bad.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'r23g1-'));
  writeFileSync(join(dir, 'donations.jsonl'), JSON.stringify({ entryId: asked, roundId: 'cd'.repeat(32), msat: '1000', outpoint: 'ee'.repeat(32) + ':0', verifiedMs: 1 }) + '\n');
  const m = { owner: null, code: null };
  const store = { read: () => m.owner, write: (o) => { m.owner = o; }, writeCode: (c) => { m.code = c; } };
  const devClients = { keyOf: () => null, list: () => [], rowsAndSeats: () => ({ rows: [], seats: [badBase] }),
    clientOf: (s) => (s === 'x' ? { dir, pk: 'aa'.repeat(32) } : null), fiatFor: async () => null };
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, owner: { store }, devClients });
  try {
    const r = await fetch(`http://127.0.0.1:${node.port}/owner/dev/donations?slug=x`);
    const j = await r.json();
    const rows = j.rows || j.donations || j.items || [];
    const shown = JSON.stringify(j);
    console.log(`  FACTS: GET /owner/dev/donations ${r.status}; rows ${rows.length}; forged player 77..77 shown: ${shown.includes('77'.repeat(32))}; entry asked ${asked.slice(0, 8)}.., entry answered ${toHex(entryId(forged)).slice(0, 8)}..`);
    assert.equal(r.status, 200);
    assert.ok(!shown.includes('77'.repeat(32)), 'the donation row is shown with the player key of an entry the seat was never asked for');
  } finally { await node.close(); bad.closeAllConnections?.(); bad.close(); }
});
