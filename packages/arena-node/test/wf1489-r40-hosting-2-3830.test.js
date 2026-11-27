// kanban #1489 r40 hosting-2: GET /plugin BUILDS THE WHOLE PACKAGE AGAIN FOR EVERY ASK, AND A STRANGER WHO DOES NOT READ KEEPS IT IN THE SEAT.
// server.js GET /plugin (public, no auth, no rate limit) calls packageOf(g) on every request: it reads every core and client file of the
// game synchronously, base64s them and JSON.stringifies the package on the seat's own thread, then res.end()s it. Nothing is cached
// on the seat (only `cache-control: max-age=60` for a polite browser). A game's package may be as large as a peer takes one
// (PEER_PACKAGE_BYTES, 16 MB) - a hosted game's developer ships that through an unattended update (clients are not compiled, only hashed).
// A stranger opens N connections, asks GET /plugin?game=<id> on each and never reads: every answer is built anew (main-thread time) and
// stays buffered in the seat's process until the socket drains - N x the package, so a few hundred sockets take the seat past its memory.
// SAFE: N concurrent asks for the same package do not hold N copies of it in the seat, and do not cost N full builds on its thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from 'node:net';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey, testDonationSet } from './plugins/sign.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const dir = mkdtempSync(join(tmpdir(), 'wf1489-r40-hosting-2-'));
const src = `export const DECIDE = { name: 'big', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;

test('r40-hosting-2: unread GET /plugin answers pile up in the seat, one full package build each', async () => {
  const coreFile = join(dir, 'core.mjs'); writeFileSync(coreFile, src);
  const coreHash = sha(Buffer.from(src)), cfg = '22'.repeat(32);
  // the game's client: 6 MB (a WebGL build is this size; a package may carry 16 MB)
  const client = Buffer.from(randomBytes(4.5 * 1048576).toString('base64'));
  const clientFile = join(dir, 'client.html'); writeFileSync(clientFile, client);
  const set = testDonationSet('big dev'), key = testDevKey('big dev');
  const manifest = signManifest({ gameName: 'big', gameDevPubkey: key.pubkey, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(coreHash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [Buffer.from(sha(client), 'hex')], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  const reg = { name: 'big', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [pathToFileURL(clientFile).href],
    cores: new Map([[coreHash, { name: 'big', hash: coreHash, url: pathToFileURL(coreFile).href, configs: new Map([[cfg, {}]]) }]]) };
  const s = await serve(openStore(), { plugins: [reg], port: 0 });
  const id = toHex(reg.gameId);
  const N = 40;
  const sockets = [];
  try {
    // one honest read: the package's size
    const one = await (await fetch(`http://127.0.0.1:${s.port}/plugin?game=${id}`)).text();
    global.gc && global.gc();
    await new Promise((ok) => setTimeout(ok, 200));
    const m0 = process.memoryUsage();
    const t0 = Date.now();
    // N strangers: ask, never read
    await Promise.all(Array.from({ length: N }, () => new Promise((ok, no) => {
      const k = connect(s.port, '127.0.0.1', () => { k.write(`GET /plugin?game=${id} HTTP/1.1\r\nHost: x\r\n\r\n`); k.pause(); ok(); });
      k.on('error', no); sockets.push(k);
    })));
    // let the seat answer every one of them
    let lagMax = 0;
    for (let i = 0; i < 30; i++) { const a = Date.now(); await new Promise((ok) => setTimeout(ok, 50)); lagMax = Math.max(lagMax, Date.now() - a - 50); }
    const m1 = process.memoryUsage();
    const grewMb = Math.round(((m1.rss - m0.rss)) / 1048576);
    const extMb = Math.round(((m1.external + m1.heapUsed) - (m0.external + m0.heapUsed)) / 1048576);
    const pkgMb = +(one.length / 1048576).toFixed(1);
    console.log('  FACTS:', JSON.stringify({ packageMb: pkgMb, unreadAsks: N, rssGrewMb: grewMb, heapPlusExternalGrewMb: extMb, eventLoopLagMaxMs: lagMax, ms: Date.now() - t0 }));
    assert.ok(grewMb < 4 * pkgMb, `${N} unread GET /plugin asks of one ${pkgMb} MB package grew the seat by ${grewMb} MB RSS (heap+external ${extMb} MB): every ask built and kept its own copy`);
  } finally { for (const k of sockets) k.destroy(); await s.close(); }
});
