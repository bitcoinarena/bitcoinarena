// kanban #1489 / #1541 refute variant 2: a package.json kept by a pre-fix build keeps the relaying seat's title after the upgrade (loadInstalled trusts the disk title), and every later update inherits it.
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
test('reload path: a package.json kept before the fix keeps the relayer\'s title after restart', async () => {
  const a = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r43c-'));
  try {
    const pkg = await (await fetch(`http://127.0.0.1:${a.port}/plugin?game=${RPS}`)).json();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, RPS), { recursive: true });
    for (const c of pkg.cores) writeFileSync(join(dir, RPS, `core-${c.hash}.mjs`), Buffer.from(c.source, 'base64'));
    for (const k of pkg.clients || []) writeFileSync(join(dir, RPS, `client-${k.hash}.html`), Buffer.from(k.body, 'base64'));
    writeFileSync(join(dir, RPS, 'package.json'), JSON.stringify({ ...pkg, name: 'next-block', title: FORGED }));
    const re = await loadInstalled(dir, { verify: verifyEd25519 });
    console.log('reloaded', JSON.stringify(re.registrations.map((r) => [r.name, r.title])));
    assert.equal(re.registrations[0].name, 'rock-paper-scissors');
    assert.notEqual(re.registrations[0].title, FORGED, 'a pre-fix kept package still shows the relayer\'s title');
  } finally { await a.close(); }
});
