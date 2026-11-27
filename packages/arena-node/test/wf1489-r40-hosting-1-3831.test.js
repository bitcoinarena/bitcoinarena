// kanban #1489 r40 hosting-1: A HOSTED GAME'S DEVELOPER MAKES EVERY HOSTING SEAT PAY FOR AN ADVERTISEMENT UPDATE PER VERSION, FOR GOOD.
// autoUpdateSweep (server.js, always on) takes every next version the developer of a hosted game signs (same key, parent the hosted
// version, a higher version) - unattended, free for the developer (a manifest signature, no chain fee, any seat lists it). Every taken
// version is a new hosted game id, and the seat's own advertisement check (server.js createAdvertSelf -> advert-self.js ownAdvertDue ->
// add-bond-wallet.js guardianOfFromWallet) posts an advertisement update from the BOND WALLET whenever the census entry lacks one hosted
// id: a funding tx (2 sat/vB) + 330 sat marker dust + 1200 sat fee per update. READ_AGAIN_MS (6 h) only holds back the SAME wanted set;
// a new version is a new set, so it is due again at the next 10-minute check once the last update is mined. Nothing removes a version
// from the advertisement ("none removed"), so each update also names every version ever taken.
// SAFE: versions of a game the seat already advertises, arriving one after another, do not make the seat pay for more than one
// advertisement update per READ_AGAIN_MS.
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
import { ownAdvertDue, wantedKey, READ_AGAIN_MS } from '../src/advert-self.js';
import { ownAdvertAfter } from '../src/add-bond-wallet.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey, testDonationSet } from './plugins/sign.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'wf1489-r40-hosting-1-'));
const source = (tag) => `export const DECIDE = { name: 'g ${tag}', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
function game({ version, parent = NO_PARENT, tag }) {
  const src = source(tag), file = join(srcDir, `decide-${tag}.mjs`);
  writeFileSync(file, src);
  const hash = sha(Buffer.from(src)), cfg = '22'.repeat(32);
  const set = testDonationSet('tic dev');
  const key = testDevKey('tic dev');
  const manifest = signManifest({ gameName: 'tic', gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: 'tic', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: `g ${tag}`, hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) }]]) };
}

test('r40-hosting-1: a developer\'s stream of signed versions makes the seat pay for one advertisement update per version', async () => {
  const VERSIONS = 6;
  const v = [game({ version: 1, tag: 'v1' })];
  for (let i = 2; i <= VERSIONS; i++) v.push(game({ version: i, parent: v[i - 2].gameId, tag: `v${i}` }));
  // C: the developer's own seat (any network seat), listing v2..vN
  const c = await serve(openStore(), { plugins: v.slice(1).map((g, i) => (i === 0 ? { ...g, ancestors: [v[0].manifest] } : g)), port: 0 });
  const C = `http://127.0.0.1:${c.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r40-hosting-1-b-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(9));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: [v[0]], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const st = await fetch(`${B}/owner/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req('settings', { autoUpdate: true, sources: [C] })) });
    assert.equal(st.status, 200);
    const want = new Set(v.map((g) => toHex(g.gameId)));
    let ids = [];
    for (let i = 0; i < 100 && ids.filter((x) => want.has(x)).length < VERSIONS; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      ids = (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id);
    }
    // what server.js hands createAdvertSelf as hostedGames(): every hosted game id (the /games ids)
    const taken = v.map((g) => toHex(g.gameId)).filter((x) => ids.includes(x));
    assert.equal(taken.length, VERSIONS, `the seat took the developer's versions unattended (${taken.length} of ${VERSIONS})`);

    // THE SEAT'S OWN ADVERTISEMENT CHECK, every 10 min (server.js selfRun), as versions arrive: the census entry names what was advertised
    // before; after a paid update is mined (testnet4 ~10 min a block) `last` is the update it posted (.advert-self.json)
    const pubkey = new Uint8Array(32).fill(7);
    const t0 = 1_800_000_000_000;
    let advertised = [taken[0]], last = null, paid = 0;
    const sets = [];
    for (let k = 1; k < VERSIONS; k++) {
      const nowMs = t0 + k * 600000;
      const hostedGames = taken.slice(0, k + 1);
      const entries = [{ pubkey, advert: { hostedGames: advertised.map((x) => fromHex(x)), guardianOf: [] }, hostedGames: advertised.map((x) => fromHex(x)) }];
      const d = ownAdvertDue({ entries, pubkey, mine: [], hostedGames, last, lastRead: null, nowMs });
      if (d.due) {
        paid++;
        const after = ownAdvertAfter({ hostedGames: advertised.map((x) => fromHex(x)), guardianOf: [] }, { guardianOf: [], hostedGames: hostedGames.map((x) => fromHex(x)), nowMs });
        sets.push(after.advert.hostedGames.length);
        last = { txid: 'aa'.repeat(32), want: wantedKey({ mine: [], hostedGames }), atMs: nowMs };   // what check() writes after posting
        advertised = after.advert.hostedGames.map(toHex);   // the census takes it 6 deep; even sooner is the same
      }
    }
    const spanMin = ((VERSIONS - 1) * 600000) / 60000;
    const perUpdate = 1200 + 330 + 2 * 154;   // update fee + marker dust + funding tx at 2 sat/vB (~154 vB)
    console.log('  FACTS:', JSON.stringify({ versionsTaken: taken.length, paidUpdates: paid, inMinutes: spanMin, gamesNamedPerUpdate: sets,
      approxSatsPerUpdate: perUpdate, approxSatsPerDayAtOneVersionPerBlock: perUpdate * 144, readAgainHours: READ_AGAIN_MS / 3600000 }));
    assert.ok(paid <= 1, `the developer's ${VERSIONS - 1} new versions made the seat pay ${paid} advertisement updates from its bond wallet in ${spanMin} minutes (about ${perUpdate} sat each), where at most 1 per ${READ_AGAIN_MS / 3600000} h is safe`);
  } finally { await b.close(); await c.close(); }
});
