// kanban #1489 r40 hosting-3: ONE DEVELOPER'S 64 VERSIONS HIDE EVERY OTHER GAME'S UPDATE FROM THE NETWORK (count twin of #3847).
// Every reader of a seat's GET /games walks only its first PEER_LISTING_GAMES (64) rows (peer-read.js listedGames): autoUpdateSweep,
// readNetworkApps (the App Store's "found on the network") and the duty poster's catalog (duty-day.js seatCatalog). A seat lists every
// version it hosts, in the order it took them, and autoUpdateSweep takes every next version a hosted game's developer signs, none ever
// dropped. So the developer of ANY hosted game signs 64 tiny versions (free, one key, each naming the last as parent): every hosting seat
// takes them and lists them, and every version taken after that - an honest developer's update, the next Next Block or RPS version -
// sits past row 64 of that seat's listing, where no other seat ever reads it. #3847 hid a listing by its bytes (one 4 MB manifest);
// this one needs only the count, with manifests of a few hundred bytes.
// SAFE: a seat that hosts an honest game's newer version hands it to the network's automatic updates, however many versions of
// another developer's game it also hosts.
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
import { PEER_LISTING_GAMES } from '../src/peer-read.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey, testDonationSet } from './plugins/sign.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'wf1489-r40-hosting-3-'));
const coreOf = (tag) => {
  const src = `export const DECIDE = { name: 'g ${tag}', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
  const file = join(srcDir, `decide-${tag}.mjs`);
  writeFileSync(file, src);
  return { hash: sha(Buffer.from(src)), url: pathToFileURL(file).href };
};
const CFG = '22'.repeat(32);
function game({ name, dev, version, parent = NO_PARENT, core }) {
  const set = testDonationSet(dev), key = testDevKey(dev);
  const manifest = signManifest({ gameName: name, gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(core.hash, 'hex'), configs: [Buffer.from(CFG, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name, manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[core.hash, { name: `g ${name}`, hash: core.hash, url: core.url, configs: new Map([[CFG, {}]]) }]]) };
}

test('r40-hosting-3: 64 versions of one developer\'s game hide an honest game\'s update from every other seat\'s automatic update', async () => {
  // the flooding developer's game "spam": v1 .. v64, one core for all of them
  const spamCore = coreOf('spam');
  const spam = [game({ name: 'spam', dev: 'spam dev', version: 1, core: spamCore })];
  for (let v = 2; v <= PEER_LISTING_GAMES; v++) spam.push(game({ name: 'spam', dev: 'spam dev', version: v, parent: spam[v - 2].gameId, core: spamCore }));
  // the honest developer's game "aitch": v1 hosted everywhere, v2 signed later and taken by seat C after the flood
  const aCore = coreOf('aitch');
  const a1 = game({ name: 'aitch', dev: 'aitch dev', version: 1, core: aCore });
  const a2 = game({ name: 'aitch', dev: 'aitch dev', version: 2, parent: a1.gameId, core: aCore });
  // seat C: took the spam versions first (in the order its sweep took them), then aitch v2 - its GET /games lists them in that order
  const c = await serve(openStore(), { plugins: [...spam, { ...a2, ancestors: [a1.manifest] }], port: 0 });
  const C = `http://127.0.0.1:${c.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r40-hosting-3-b-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(11));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: [a1], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const listing = (await (await fetch(`${C}/games`)).json()).games.map((g) => g.id);
    const at = listing.indexOf(toHex(a2.gameId));
    assert.ok(at >= 0, 'seat C hosts and lists aitch v2');
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const st = await fetch(`${B}/owner/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req('settings', { autoUpdate: true, sources: [C] })) });
    assert.equal(st.status, 200);
    let ids = [];
    for (let i = 0; i < 60 && !ids.includes(toHex(a2.gameId)); i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      ids = (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id);
    }
    console.log('  FACTS:', JSON.stringify({ sourceListsGames: listing.length, aitchV2Row: at + 1, readersWalk: PEER_LISTING_GAMES, seatBTookAitchV2: ids.includes(toHex(a2.gameId)) }));
    assert.ok(ids.includes(toHex(a2.gameId)), `seat C hosts aitch v2 (row ${at + 1} of its ${listing.length}-row GET /games), but seat B's automatic update reads only the first ${PEER_LISTING_GAMES} rows - another developer's ${PEER_LISTING_GAMES} versions hid the honest update for good`);
  } finally { await b.close(); await c.close(); }
});
