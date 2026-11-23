// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r22-hosting-1 (bypass of #1902 / #1810): GET /network-games takes each peer listing's manifest when it merely hashes to the
// id beside it - its developer signature is never checked. #1902 lends a hosted game's title and `updateOf` only when checkUpdate takes the
// row, but checkUpdate reads devKey, parent and version from that same unsigned manifest. So one peer (any address in the census, or a
// peer) lists a manifest with a zero signature that names the hosted game as parent, the hosted developer's key and version + 1: the
// owner page shows it under the hosted game's own title as "update available". Safe: a manifest its developer did not sign is no update.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';

test('#1489 r22-hosting-1: an unsigned manifest naming a hosted game as parent is listed as its update', async () => {
  const rps = ROCK_PAPER_SCISSORS;
  const forged = { ...rps.manifest, parentManifestId: rps.gameId, version: rps.manifest.version + 1, gameName: 'free-sats-update', signature: new Uint8Array(64) };
  const fid = toHex(gameIdOf(forged));
  const liar = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ node: 'ab'.repeat(32), games: [{ id: fid, name: 'x', title: 'x', manifest: toHex(encodeManifest(forged)) }] }));
  }).listen(0);
  await new Promise((r) => liar.once('listening', r));
  const b = await serve(openStore(), { plugins: [rps], port: 0, peers: [`http://127.0.0.1:${liar.address().port}`] });
  try {
    const ng = await (await fetch(`http://127.0.0.1:${b.port}/network-games?fresh=1`)).json();
    const row = ng.games.find((g) => g.id === fid);
    console.log('  FACTS r22-hosting-1:', JSON.stringify(row ? { title: row.title, version: row.version, updateOf: row.updateOf, devKey: row.devKey.slice(0, 16) } : null));
    assert.ok(!row || row.updateOf === null, `an unsigned manifest is listed as an update of the hosted ${toHex(rps.gameId).slice(0, 16)} under the title "${row && row.title}"`);
  } finally { await b.close(); liar.close(); }
});
