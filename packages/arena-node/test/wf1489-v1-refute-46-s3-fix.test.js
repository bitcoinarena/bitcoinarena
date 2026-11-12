// kanban #2058, #2078 (#1489 refute, skeptic 3, of #1538): the fix's own test for the 'does not load' refusal in autoUpdate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { packageOf } from '../src/plugin-package.js';
import { sandboxFor } from '../src/core-sandbox.js';
import { ownerSecretFromSeed } from '../src/owner.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf, encodeManifest } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'arena-s3c-'));
function game({ version, parent = NO_PARENT, src, tag }) {
  const file = join(srcDir, `decide-${tag}.mjs`); writeFileSync(file, src);
  const hash = sha(Buffer.from(src)), cfg = '22'.repeat(32), set = testDonationSet('tic'), key = testDevKey('tic dev');
  const manifest = signManifest({ gameName: 'tic', gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: 'tic', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: `tic ${tag}`, hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) }]]) };
}
const honest = `export const DECIDE = { name: 'tic', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };\n`;
const honest2 = `export const DECIDE = { name: 'tic', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } }; // v2\n`;

// THE OTHER REFUSAL PATH, reached for sure: v2 is honest (the trial passes it) and its install load is refused - its core's
// sandbox was refused in this thread before its file was there (sandboxFor keeps a refusal). That is adoptPackage's status 500
// after the checks: the sweep is done with it (`checked`), the refusal is remembered on its id (`loads: false`), and the
// package is moved aside, not kept on disk to be loaded at every start.
test('#1489-v1-refute-46-s3-fix: a version that passes the checks but does not load is taken once, remembered, and not kept on disk', async () => {
  const v1 = game({ version: 1, src: honest, tag: 'h1' });
  const v2 = game({ version: 2, parent: v1.gameId, src: honest2, tag: 'h2' });
  const id2 = toHex(v2.gameId), pkg2 = JSON.stringify(packageOf(v2));
  const LINES = 6;
  let gamesHits = 0, pluginHits = 0;
  const peer = createServer((req, res) => {
    if (req.url.startsWith('/games')) { gamesHits++; res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ games: Array.from({ length: LINES }, () => ({ id: id2, manifest: toHex(encodeManifest(v2.manifest)) })) })); }
    if (req.url.startsWith('/plugin')) { pluginHits++; res.setHeader('content-type', 'application/json'); return res.end(pkg2); }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  const P = `http://127.0.0.1:${peer.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const [hash2] = [...v2.cores.keys()];
  // the install load of v2 refuses: its core's sandbox was asked for before its file existed
  assert.throws(() => sandboxFor({ url: pathToFileURL(join(dir, id2, `core-${hash2}.mjs`)).href, hash: hash2 }));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1, settings: { autoUpdate: true, sources: [P] } };
  process.env.ARENA_AUTO_UPDATE_MS = '2000';
  const b = await serve(openStore(), { plugins: [v1], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const t0 = Date.now();
    while (gamesHits < 3 && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
    const listing = readdirSync(dir);
    console.log(`sweeps ${gamesHits}, fetched ${pluginHits}, plugins dir: ${listing.join(', ')}`);
    assert.ok(gamesHits >= 3, 'three sweeps ran');
    assert.equal(pluginHits, 1, `one version that passed the checks and does not load, listed ${LINES} times in ${gamesHits} sweeps, was fetched ${pluginHits} times`);
    assert.equal(existsSync(join(dir, id2)), false, 'the package that does not load is not kept where a start loads it');
    assert.ok(listing.some((n) => n.startsWith('.removed-') && n.endsWith(id2)), 'it is moved aside, not deleted');
  } finally { await b.close(); peer.close(); }
});
