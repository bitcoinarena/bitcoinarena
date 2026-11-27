// kanban #1489 r40 hosting-3: A HOSTED GAME'S DEVELOPER FILLS EVERY HOSTING SEAT'S DISK, ONE FREE SIGNED VERSION PER SWEEP.
// autoUpdateSweep (server.js, always on) takes the developer's next signed version of every hosted game each sweep (10 min), unattended and
// free for the developer (a manifest signature; any one network seat lists it). adoptPackage -> installPackage writes each version as a new
// directory: every core and client file, plus package.json holding all of them again as base64 - and nothing ever removes a superseded version
// (removeGame is the owner's, by hand). The same client bytes, unchanged between versions, are written again for each one. A 12 MB client
// (a package fits PEER_PACKAGE_BYTES, 16 MB of JSON) is ~28 MB of disk per version: 144 versions a day, ~4 GB a day on every seat hosting the
// game, until the disk is full and the seat's store and chain stop.
// SAFE: versions arriving one after another, each with the very same client bytes, do not grow the seat's disk by one full copy per version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey, testDonationSet } from './plugins/sign.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'wf1489-r40-hosting-3-'));
const src = `export const DECIDE = { name: 'g', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
const coreFile = join(srcDir, 'decide.mjs'); writeFileSync(coreFile, src);
const coreHash = sha(Buffer.from(src)), cfg = '22'.repeat(32);
// ONE CLIENT, THE SAME BYTES IN EVERY VERSION: 3 MB
const client = Buffer.from(randomBytes(2.25 * 1048576).toString('base64'));
const clientFile = join(srcDir, 'client.html'); writeFileSync(clientFile, client);
function game({ version, parent = NO_PARENT }) {
  const set = testDonationSet('fill dev'), key = testDevKey('fill dev');
  const manifest = signManifest({ gameName: 'fill', gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(coreHash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [Buffer.from(sha(client), 'hex')], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: 'fill', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [pathToFileURL(clientFile).href],
    cores: new Map([[coreHash, { name: 'g', hash: coreHash, url: pathToFileURL(coreFile).href, configs: new Map([[cfg, {}]]) }]]) };
}
const du = (p) => { const s = statSync(p); if (!s.isDirectory()) return s.size; let n = 0; for (const f of readdirSync(p)) n += du(join(p, f)); return n; };

test('r40-hosting-3: each unattended version of a hosted game writes the same client bytes to the seat\'s disk again, without bound', async () => {
  const VERSIONS = 6;
  const v = [game({ version: 1 })];
  for (let i = 2; i <= VERSIONS; i++) v.push(game({ version: i, parent: v[i - 2].gameId }));
  // C: any network seat listing the developer's versions v2..vN
  const c = await serve(openStore(), { plugins: v.slice(1).map((g, i) => (i === 0 ? { ...g, ancestors: [v[0].manifest] } : g)), port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r40-hosting-3-b-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(9));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: [v[0]], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const st = await fetch(`${B}/owner/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req('settings', { autoUpdate: true, sources: [`http://127.0.0.1:${c.port}`] })) });
    assert.equal(st.status, 200);
    const want = new Set(v.slice(1).map((g) => toHex(g.gameId)));
    let ids = [];
    for (let i = 0; i < 150 && ids.filter((x) => want.has(x)).length < VERSIONS - 1; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      ids = (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id);
    }
    const taken = ids.filter((x) => want.has(x)).length;
    assert.equal(taken, VERSIONS - 1, `the seat took the developer's versions unattended (${taken} of ${VERSIONS - 1})`);
    const versionDirs = readdirSync(dir).filter((f) => /^[0-9a-f]{64}$/.test(f));
    const bytes = du(dir), clientMb = client.length / 1048576;
    console.log('  FACTS:', JSON.stringify({ versionsTaken: taken, versionDirsOnDisk: versionDirs.length, diskMb: +(bytes / 1048576).toFixed(1), clientMb: +clientMb.toFixed(1),
      mbPerVersion: +(bytes / 1048576 / taken).toFixed(1), atOneVersionPer10MinGbPerDay: +((bytes / taken) * 144 / 1073741824).toFixed(2) }));
    assert.ok(bytes < 3 * client.length, `${taken} unattended versions of one game, each with the same ${clientMb.toFixed(1)} MB client, put ${(bytes / 1048576).toFixed(1)} MB on the seat's disk (${versionDirs.length} version directories, none ever removed): one full copy and more per version`);
  } finally { await b.close(); await c.close(); }
});
