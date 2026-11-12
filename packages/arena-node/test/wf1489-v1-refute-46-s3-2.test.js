// kanban #1489 refute (skeptic 3) of #1538 / #1880 / #1913: the per-sweep memory (seen, trialedParent, trialRefused) is fed only by
// `r.ok || r.trial || r.retry`. adoptPackage's OTHER refusal after the trial - "kept, but it does not load" (status 500, from
// registrationFromPackage loading the same bytes again) - carries neither flag, so a version that passes the trial and refuses
// at install is fetched, trialed, written to disk and loaded again for every line of a peer's listing, in every sweep: the
// same N x trial of s2-2, by another refusal. The core tells the two loads apart by its file name in a plain stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { packageOf } from '../src/plugin-package.js';
import { ownerSecretFromSeed } from '../src/owner.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf, encodeManifest } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'arena-s3b-'));
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
// passes the scan (no while(true), no for(;;)); spins every call until the trial's deadline ends it
// passes the scan; ~250 ms of work (measured slower in the sandbox) in the trial's load (inside TRIAL_MS), refuses to load as installed (core-<hash>.mjs)
function perMs() { const spin = (k) => { let x = 0; for (let i = 0; i < k; i++) x = (x + i) | 0; return x; }; spin(5e7); const k = 3e8; const t = Date.now(); spin(k); return k / Math.max(1, Date.now() - t); }
const K = Math.round(perMs() * 250);
const spinning = 'const inTrial = String(new Error("w").stack).includes("core:/core.mjs");\n' +
  'function burn(k) { let x = 0; for (let i = 0; i < k; i++) x = (x + i) | 0; return x; }\n' +
  'if (!inTrial) throw new RangeError("not here");\n' +
  `const w = burn(${K});\n` +
  'export const DECIDE = { name: "tic" + (w & 0), decide(moves) { const out = {}; for (const m of moves) out[m.key] = "DRAW"; return out; } };\n';

test('#1489-v1-refute-46-s3-2: a version the trial passes but the install refuses is fetched and trialed again for every line of one sweep', async () => {
  const v1 = game({ version: 1, src: honest, tag: 'h1' });
  const v2 = game({ version: 2, parent: v1.gameId, src: spinning, tag: 's2' });
  const id2 = toHex(v2.gameId), pkg2 = JSON.stringify(packageOf(v2));
  const LINES = 6;
  let gamesHits = 0, pluginHits = 0;
  // THE PEER SEAT: lists the one signed, refused v2 LINES times; hands its package over each time it is asked
  const peer = createServer((req, res) => {
    if (req.url.startsWith('/games')) { gamesHits++; res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ games: Array.from({ length: LINES }, () => ({ id: id2, manifest: toHex(encodeManifest(v2.manifest)) })) })); }
    if (req.url.startsWith('/plugin')) { pluginHits++; res.setHeader('content-type', 'application/json'); return res.end(pkg2); }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  const P = `http://127.0.0.1:${peer.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1, settings: { autoUpdate: true, sources: [P] } };
  process.env.ARENA_AUTO_UPDATE_MS = '60000';
  const b = await serve(openStore(), { plugins: [v1], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  // the seat's own thread (this process): the longest stretch it could not run a timer
  let last = Date.now(), worstLag = 0, blocked = 0;
  const tick = setInterval(() => { const now = Date.now(), lag = now - last - 20; if (lag > worstLag) worstLag = lag; if (lag > 200) blocked += lag; last = now; }, 20);
  try {
    // one sweep, as the timer would run it (10 minutes on a seat); exposed for the test through the interval it is on
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 62000 + LINES * 1600));
    clearInterval(tick);
    console.log(`sweeps (GET /games) ${gamesHits}, trials (GET /plugin) ${pluginHits}, the seat's thread blocked ${blocked} ms in ${Date.now() - t0} ms, worst stretch ${worstLag} ms`);
    assert.ok(gamesHits >= 1, 'the sweep ran');
    assert.ok(pluginHits <= gamesHits, `one version (trial passed, install refused) listed ${LINES} times was fetched and trialed ${pluginHits} times in ${gamesHits} sweep(s): the seat's thread was held ${blocked} ms`);
  } finally { clearInterval(tick); await b.close(); peer.close(); }
});
