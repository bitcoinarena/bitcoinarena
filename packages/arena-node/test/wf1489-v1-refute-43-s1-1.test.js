// kanban #1489 / #1541 refute variant 1: GET /network-games (public; the owner page's store) lists a genuine signed game under the title the relaying seat chose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { loadInstalled } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { GAME as RPS_V2 } from '../../rock-paper-scissors/plugin/rock-paper-scissors-v2.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const FORGED = 'Next Block - free sats, deposit here';
const RPS = toHex(ROCK_PAPER_SCISSORS.gameId), V2 = toHex(RPS_V2.gameId);

// a seat that relays A's genuine packages and listings with the name and title it likes
function liarOf(A) {
  return createServer(async (req, res) => {
    const r = await fetch(A + req.url); const j = await r.json();
    if (j.games) for (const g of j.games) { g.name = 'next-block'; g.title = FORGED; }
    else if (j.manifest) { j.name = 'next-block'; j.title = FORGED; }
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
  }).listen(0);
}
const ownerOf = () => { const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7)); return { secret, rec: { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 } }; };
test('GET /network-games: a seat listing a genuine signed game shows the title IT chose', async () => {
  const a = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0 });
  const A = `http://127.0.0.1:${a.port}`; const liar = liarOf(A); const L = `http://127.0.0.1:${liar.address().port}`;
  const b = await serve(openStore(), { plugins: [], port: 0, peers: [L] });
  try {
    const ng = await (await fetch(`http://127.0.0.1:${b.port}/network-games?fresh=1`)).json();
    const g = ng.games.find((x) => x.id === RPS);
    console.log('network-games row', JSON.stringify({ name: g.name, title: g.title, infoSigned: g.infoSigned }));
    assert.equal(g.name, 'rock-paper-scissors');
    assert.notEqual(g.title, FORGED, 'the store lists the signed Rock Paper Scissors under the relaying seat\'s title');
  } finally { await a.close(); await b.close(); liar.close(); }
});

