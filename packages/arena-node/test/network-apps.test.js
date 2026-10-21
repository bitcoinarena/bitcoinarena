// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK'S GAMES AND MARKETS, FOUND BY A SEAT ITSELF (2026-10-11: "Es soll automatisch nach anderen
// Spielen suchen nicht manuell ... games/market found on the Network ... Name/Typ/Version und der Action Install. Mach eine
// Art hello world game/market die nur eine node hat ... Das Manifest soll auch eine Description und Webseite haben die
// signiert wird"; ~06:55Z: "beide hashes akzeptiert - mit URL und ohne URL, mit Description und ohne").
// Measured: the description and website stand only under the manifest's developer key and leave every game id where it
// was; a seat lists another seat's games with name, type, version and the signed info - an info another seat altered is
// shown unsigned - and installs the one-seat Hello World market from that list; then it is hosted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { gameInfoStands, gameInfoFits, gameTypeOf } from '../../arena-protocol/src/game-info.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { UPDOWN_TN4 } from '../../btc-updown/plugin/btc-updown.js';
import { HELLO_WORLD } from '../../hello-world/plugin/hello-world.js';

const HELLO = toHex(HELLO_WORLD.gameId);
const stands = (g, info = g.info) => gameInfoStands(info, { gameId: g.gameId, manifest: g.manifest, verify: verifyEd25519 });

test('each game\'s description and website stand under its developer key, and its id is the one the seats advertise', () => {
  for (const [g, id] of [[NEXTBLOCK, '495516ae'], [ROCK_PAPER_SCISSORS, '1e9ab4b7'], [UPDOWN_TN4, '672415c8'], [HELLO_WORLD, '32ee1aa4']]) {
    assert.equal(toHex(g.gameId).slice(0, 8), id, `${g.name}: the id did not move`);
    const s = stands(g);
    assert.equal(s.ok, true, `${g.name}: ${s.why}`);
    assert.ok(s.description.length > 20 && /^https:\/\//.test(s.website));
  }
  assert.match(stands(NEXTBLOCK, { ...NEXTBLOCK.info, description: 'Free bitcoin' }).why, /not signed by the developer key/, 'an altered description');
  assert.match(stands(NEXTBLOCK, { ...NEXTBLOCK.info, website: 'https://evil.example/' }).why, /not signed/, 'an altered website');
  assert.match(stands(ROCK_PAPER_SCISSORS, NEXTBLOCK.info).why, /not signed/, 'another game\'s info');
  assert.equal(stands(NEXTBLOCK, null).ok, false, 'none at all: the game is the same, its info is just not shown');
  assert.equal(gameInfoFits({ website: 'http://plain.example' }).ok, false, 'https only');
  assert.deepEqual([NEXTBLOCK, ROCK_PAPER_SCISSORS, UPDOWN_TN4, HELLO_WORLD].map((g) => gameTypeOf(g.manifest)), ['game', 'head-to-head game', 'market', 'market']);
});

test('a seat finds the network\'s games itself, lists name/type/version/info, and installs the one-seat Hello World from the list', async () => {
  const a = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS, HELLO_WORLD], port: 0 });
  // a seat that serves Hello World with a description it rewrote: listed, never as signed
  const liar = createServer(async (req, res) => {
    const g = (await (await fetch(`http://127.0.0.1:${a.port}/games`)).json());
    for (const x of g.games) if (x.info) x.info.description = 'Rewritten by another seat';
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(g));
  }).listen(0);
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const A = `http://127.0.0.1:${a.port}`, L = `http://127.0.0.1:${liar.address().port}`;
  const b = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0, pluginsDir: dir, peers: [L, A],
    owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const own = (await (await fetch(`${A}/games`)).json()).games.find((g) => g.id === HELLO);
    assert.deepEqual([own.type, own.version, own.info.website], ['market', 1, 'https://bitcoin-arena.io/'], '/games carries type, version and the signed info');
    const ng = await (await fetch(`${B}/network-games?fresh=1`)).json();
    assert.deepEqual(ng.seats.map((s) => s.answered), [true, true], 'both seats it was given were asked');
    const hello = ng.games.find((g) => g.id === HELLO);
    assert.deepEqual([hello.title, hello.type, hello.version, hello.hostedHere, hello.infoSigned], ['Hello World', 'market', 1, false, true]);
    assert.match(hello.description, /^The smallest market/, 'the signed description, not the rewritten one');
    assert.deepEqual(hello.seats.sort(), [A, L].sort(), 'both seats list it');
    assert.equal(ng.games.find((g) => g.id === toHex(ROCK_PAPER_SCISSORS.gameId)).hostedHere, true);
    // only the liar: listed, not as signed
    const only = await serve(openStore(), { plugins: [], port: 0, peers: [L] });
    try {
      const h = (await (await fetch(`http://127.0.0.1:${only.port}/network-games?fresh=1`)).json()).games.find((g) => g.id === HELLO);
      assert.deepEqual([h.infoSigned, h.description], [false, null], 'a description another seat rewrote is not shown');
    } finally { await only.close(); }
    // INSTALL, from the seat the list names
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const body = signOwnerRequest({ node, action: 'install', args: { game: HELLO, from: A }, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const r = await fetch(`${B}/owner/plugins/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    assert.equal(r.status, 200, j.why);
    assert.ok(j.checks.some((c) => /description and website are signed/.test(c.check) && c.ok));
    const mine = await (await fetch(`${B}/owner/plugins`)).json();
    const h = mine.hosted.find((g) => g.id === HELLO);
    assert.deepEqual([h.type, h.info && h.info.website], ['market', 'https://bitcoin-arena.io/'], 'installed, with its signed info');
    const again = await (await fetch(`${B}/network-games?fresh=1`)).json();
    assert.equal(again.games.find((g) => g.id === HELLO).hostedHere, true, 'now hosted here');
  } finally { await a.close(); await b.close(); liar.close(); }
});
