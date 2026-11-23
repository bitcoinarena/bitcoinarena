// AUDIT hosting r2 (a5-2-1): AN AUTOMATIC UPDATE RENAMES A HOSTED GAME INTO ANOTHER DEVELOPER'S GAME NAME.
// checkUpdate (plugin-check.js) and manifestStands (manifest.js) ask of an update only: the same developer key, the hosted version as
// its parent, version + 1. Nothing asks that the update keeps its signed gameName. autoUpdateSweep (server.js) takes such a version
// unattended (always on), and adoptPackage hosts it under the NEW gameName (keeping the old title for the page). Every seat lookup keyed by
// a game's name - seasonQuery (GET /season, /season-rounds), leaderboardSeasonOf (the reserve's leaderboard payouts, scope by gameName),
// noteNextblockGames - then counts the developer's game as the other developer's game: its rounds (whose rules that developer wrote)
// are ranked on the other game's board and paid by its passed leaderboard payout.
// SAFE: a game hosted by this seat under one developer's name never turns, by an unattended update, into a game of that name from
// another developer key; /season?game=<victim> names only the victim's own versions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
const srcDir = mkdtempSync(join(tmpdir(), 'audit-hosting-a5-2-1-'));
const source = (tag) => `export const DECIDE = { name: 'g ${tag}', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
function game({ gameName, dev, version, parent = NO_PARENT, tag }) {
  const src = source(tag), file = join(srcDir, `decide-${tag}.mjs`);
  writeFileSync(file, src);
  const hash = sha(Buffer.from(src)), cfg = '22'.repeat(32);
  const set = testDonationSet(dev);
  const key = testDevKey(dev);
  const manifest = signManifest({ gameName, gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: gameName, manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: `g ${tag}`, hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) }]]) };
}

test('a5-2-1: an unattended update of game "tic" by its developer renames it "victim" (another developer\'s game) on the seat', async () => {
  // the victim: a game this seat hosts from developer V
  const victim = game({ gameName: 'victim', dev: 'victim dev', version: 1, tag: 'victim1' });
  // the attacker's game, hosted here too (installed honestly), and its next version signed by the same key, now named "victim"
  const tic1 = game({ gameName: 'tic', dev: 'tic dev', version: 1, tag: 'tic1' });
  const tic2 = game({ gameName: 'victim', dev: 'tic dev', version: 2, parent: tic1.gameId, tag: 'tic2' });
  const id2 = toHex(tic2.gameId);
  // C: any seat that lists the developer's next version (the developer's own seat)
  const c = await serve(openStore(), { plugins: [{ ...tic2, ancestors: [tic1.manifest] }], port: 0 });
  const C = `http://127.0.0.1:${c.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'audit-hosting-a5-2-1-b-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(9));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: [victim, tic1], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const x = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [x.status, await x.json()]; };
    const listed = async () => (await (await fetch(`${B}/games`)).json()).games;
    const before = await (await fetch(`${B}/season?game=victim`)).json();
    const [st] = await post('/owner/settings', req('settings', { autoUpdate: true, sources: [C] }));
    assert.equal(st, 200);
    let games = [];
    for (let i = 0; i < 50 && !games.some((g) => g.id === id2); i++) { await new Promise((ok) => setTimeout(ok, 100)); games = await listed(); }
    const after = await (await fetch(`${B}/season?game=victim`)).json();
    const row = games.find((g) => g.id === id2);
    console.log('  FACTS:', JSON.stringify({ seasonVictimBefore: before.game.ids.map((x) => x.slice(0, 16)), seasonVictimAfter: after.game.ids.map((x) => x.slice(0, 16)),
      impostor: id2.slice(0, 16), hostedAs: row ? { name: row.name, title: row.title } : null }));
    // the attacker's game must not be counted as the victim's game
    assert.ok(!after.game.ids.includes(id2), `an unattended update of another developer's game "tic" is now counted as "victim" (season ids ${after.game.ids.map((x) => x.slice(0, 16)).join(', ')})`);
  } finally { await b.close(); await c.close(); }
});
