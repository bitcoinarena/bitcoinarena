// AUDIT r41 hosting-1: ONE HOSTED GAME'S OVERSIZED SIGNED MANIFEST HIDES EVERY OTHER GAME OF THE SEAT FROM THE NETWORK.
// A manifest's clients[] (and each core's configs[]) is a u16 vec of 32-byte hashes with no other bound, and checkPackage does not ask
// that the package carries the clients it names - so a game's developer signs a version naming 65535 client hashes (2 MiB of manifest,
// 4 MiB of hex) in a package of a few MiB, under PEER_PACKAGE_BYTES. verifyPackage passes it and every seat hosting the game takes it by
// the unattended update sweep. GET /games then serves each hosted game's whole manifest hex, uncached, and passes PEER_LISTING_BYTES
// (4 MiB): every other seat's autoUpdateSweep and readNetworkApps drop that seat's WHOLE listing - every honest game it hosts.
// SAFE: seat B takes the honest developer's next version of game H from source seat C, whatever another developer's game C also hosts.
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
import { packageOf, verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { PEER_LISTING_BYTES } from '../src/peer-read.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'wf1489-r41-hosting-1-'));
const source = (tag) => `export const DECIDE = { name: 'g ${tag}', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
function game({ gameName, dev, version, parent = NO_PARENT, tag, clients = [] }) {
  const src = source(tag), file = join(srcDir, `decide-${tag}.mjs`);
  writeFileSync(file, src);
  const hash = sha(Buffer.from(src)), cfg = '22'.repeat(32);
  const set = testDonationSet(dev);
  const key = testDevKey(dev);
  const manifest = signManifest({ gameName, gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients, gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: gameName, manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: `g ${tag}`, hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) }]]) };
}
// 65535 client hashes, sorted (the encoder asserts the order): bytes 0..1 a counter, the rest 0x11
const manyClients = () => Array.from({ length: 65535 }, (_, i) => { const b = new Uint8Array(32).fill(0x11); b[0] = i >> 8; b[1] = i & 0xff; return b; });

test('r41-hosting-1: one game\'s signed manifest naming 65535 clients hides every other game of the seats that host it', async () => {
  // the attacker: developer T, whose game seats host; its next version names 65535 clients it never ships
  const t1 = game({ gameName: 'tee', dev: 'tee dev', version: 1, tag: 'tee1' });
  const t2 = game({ gameName: 'tee', dev: 'tee dev', version: 2, parent: t1.gameId, tag: 'tee2', clients: manyClients() });
  // that version passes a seat's checks and trial as the update sweep runs them (the package carries none of the clients)
  const pkgT2 = { ...packageOf(t2), ancestors: [] };
  const pkgBytes = Buffer.byteLength(JSON.stringify(pkgT2));
  const v = verifyPackage(pkgT2, { verify: verifyEd25519, want: toHex(t2.gameId), parentOf: (id) => (toHex(id) === toHex(t1.gameId) ? t1.manifest : null) });
  // an honest developer H: B hosts v1, C hosts v2 (H's next version, which B's automatic update should take)
  const h1 = game({ gameName: 'aitch', dev: 'aitch dev', version: 1, tag: 'h1' });
  const h2 = game({ gameName: 'aitch', dev: 'aitch dev', version: 2, parent: h1.gameId, tag: 'h2' });
  const idH2 = toHex(h2.gameId);
  // C: an honest seat that took tee v2 (as its own sweep would) and hosts aitch v2
  const c = await serve(openStore(), { plugins: [{ ...t2, ancestors: [t1.manifest] }, { ...h2, ancestors: [h1.manifest] }], port: 0 });
  const C = `http://127.0.0.1:${c.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r41-hosting-1-b-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: [h1], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const listingBytes = Buffer.byteLength(await (await fetch(`${C}/games`)).text());
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const x = await fetch(`${B}/owner/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req('settings', { autoUpdate: true, sources: [C] })) });
    assert.equal(x.status, 200);
    let ids = [];
    for (let i = 0; i < 60 && !ids.includes(idH2); i++) { await new Promise((ok) => setTimeout(ok, 100)); ids = (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id); }
    const net = await (await fetch(`${B}/network-games?fresh=1`)).json();
    console.log('  FACTS:', JSON.stringify({ teeV2PackageBytes: pkgBytes, teeV2PassesVerifyPackage: v.ok, why: v.why, sourceListingBytes: listingBytes,
      peerListingBytes: PEER_LISTING_BYTES, bHostsAitchV2: ids.includes(idH2), networkGamesSeenByB: (net.games || []).length }));
    assert.ok(ids.includes(idH2), `seat B never took aitch v2 from C: C's GET /games is ${listingBytes} bytes (one other developer's manifest), past the ${PEER_LISTING_BYTES} a seat reads`);
  } finally { await b.close(); await c.close(); }
});
